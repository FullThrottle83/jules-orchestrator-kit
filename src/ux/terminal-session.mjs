import { detectTerminalCapabilities } from "./capabilities.mjs";
import { createKeyDecoder } from "./key-decoder.mjs";

export class WizardCancelledError extends Error {
  /**
   * @param {string} [message]
   * @param {"escape" | "ctrl-c" | "quit" | "stream-closed"} [reason="ctrl-c"]
   */
  constructor(message = "Wizard operation cancelled by user", reason = "ctrl-c") {
    super(message);
    this.name = "WizardCancelledError";
    this.code = 130;
    this.reason = reason;
  }
}

/**
 * @typedef {import("./capabilities.mjs").TerminalCapabilities} TerminalCapabilities
 * @typedef {import("./capabilities.mjs").TerminalSessionOptions} TerminalSessionOptions
 * @typedef {import("./key-decoder.mjs").KeyEvent} KeyEvent
 * @typedef {import("./renderer.mjs").RenderFrame} RenderFrame
 */

/**
 * @typedef {Object} TerminalSession
 * @property {TerminalCapabilities} capabilities
 * @property {() => Promise<void>} enter
 * @property {(frame: RenderFrame) => Promise<void>} render
 * @property {<T>(operation: () => Promise<T>) => Promise<T>} suspend
 * @property {() => Promise<void>} restore
 * @property {() => Promise<void>} close
 * @property {(listener: (key: KeyEvent) => void) => () => void} onKey
 * @property {(listener: (size: { columns: number, rows: number }) => void) => () => void} onResize
 */

/**
 * Create terminal raw-mode session manager.
 * @param {TerminalSessionOptions} [options]
 * @returns {TerminalSession}
 */
export function createTerminalSession(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  const capabilities = detectTerminalCapabilities(options);
  const keyDecoder = createKeyDecoder();

  let isEntered = false;
  let isClosed = false;
  let wasRaw = Boolean(input && input.isRaw);

  const keyListeners = new Set();
  const resizeListeners = new Set();

  let winchScheduled = false;

  const handleData = (chunk) => {
    if (isClosed) return;
    const events = keyDecoder.push(chunk);
    for (const event of events) {
      if (event.name === "ctrl-c") {
        session.close().catch(() => {});
        throw new WizardCancelledError("Wizard operation cancelled by user (SIGINT).", "ctrl-c");
      }
      for (const listener of keyListeners) {
        try {
          listener(event);
        } catch (err) {
          if (err instanceof WizardCancelledError) {
            session.close().catch(() => {});
            throw err;
          }
        }
      }
    }
  };

  const handleSigwinch = () => {
    if (winchScheduled || isClosed) return;
    winchScheduled = true;
    queueMicrotask(() => {
      winchScheduled = false;
      if (isClosed) return;
      capabilities.columns = Math.max(10, output.columns || input.columns || process.stdout.columns || 80);
      capabilities.rows = Math.max(5, output.rows || input.rows || process.stdout.rows || 24);
      for (const listener of resizeListeners) {
        listener({ columns: capabilities.columns, rows: capabilities.rows });
      }
    });
  };

  const handleSigint = () => {
    session.close().catch(() => {});
    throw new WizardCancelledError("Wizard operation cancelled by user (SIGINT).", "ctrl-c");
  };

  const session = {
    capabilities,

    async enter() {
      if (isEntered || isClosed) return;
      isEntered = true;

      if (capabilities.inputIsTTY && typeof input.setRawMode === "function") {
        wasRaw = Boolean(input.isRaw);
        input.setRawMode(true);
        input.resume();
        if (typeof input.setEncoding === "function") {
          input.setEncoding("utf-8");
        }
      }

      if (capabilities.ansi && capabilities.outputIsTTY) {
        if (capabilities.alternateScreen) {
          output.write("\u001b[?1049h"); // Enter alternate screen
        }
        output.write("\u001b[?25l"); // Hide cursor
      }

      input.on("data", handleData);
      process.on("SIGWINCH", handleSigwinch);
      process.on("SIGINT", handleSigint);
    },

    async render(frame) {
      if (isClosed || !capabilities.ansi) return;
      // Delegated to renderer ANSI builder
      const { renderFrameToAnsi } = await import("./renderer.mjs");
      const ansiText = renderFrameToAnsi(frame, capabilities);
      output.write(ansiText);
    },

    async suspend(operation) {
      if (!isEntered || isClosed) return operation();

      // Temporarily restore cooked mode
      input.removeListener("data", handleData);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", handleSigint);

      if (capabilities.ansi && capabilities.outputIsTTY) {
        output.write("\u001b[?25h"); // Show cursor
        if (capabilities.alternateScreen) {
          output.write("\u001b[?1049l"); // Leave alternate screen
        }
      }

      if (capabilities.inputIsTTY && typeof input.setRawMode === "function") {
        input.setRawMode(wasRaw);
      }

      try {
        return await operation();
      } finally {
        // Re-enter raw mode
        if (capabilities.inputIsTTY && typeof input.setRawMode === "function") {
          input.setRawMode(true);
        }
        if (capabilities.ansi && capabilities.outputIsTTY) {
          if (capabilities.alternateScreen) {
            output.write("\u001b[?1049h");
          }
          output.write("\u001b[?25l");
        }
        input.on("data", handleData);
        process.on("SIGWINCH", handleSigwinch);
        process.on("SIGINT", handleSigint);
      }
    },

    async restore() {
      await session.close();
    },

    async close() {
      if (isClosed) return;
      isClosed = true;
      isEntered = false;

      input.removeListener("data", handleData);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", handleSigint);

      if (capabilities.ansi && capabilities.outputIsTTY) {
        output.write("\u001b[?25h"); // Show cursor
        if (capabilities.alternateScreen) {
          output.write("\u001b[?1049l"); // Leave alternate screen
        }
      }

      if (capabilities.inputIsTTY && typeof input.setRawMode === "function") {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // Ignore state restoration failures on teardown
        }
      }

      keyListeners.clear();
      resizeListeners.clear();
    },

    onKey(listener) {
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },

    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
  };

  return session;
}
