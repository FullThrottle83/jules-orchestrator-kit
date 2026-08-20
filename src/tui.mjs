import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";

// ANSI Styling & Escapes
export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  white: "\u001b[37m",
  bgCyan: "\u001b[46m",
  bgBlue: "\u001b[44m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clearLine: "\u001b[2K\r",
  cursorUp: (n = 1) => `\u001b[${n}A`,
  cursorDown: (n = 1) => `\u001b[${n}B`,
};

/**
 * Check if the given input stream is an interactive TTY terminal.
 * @param {import("node:stream").Readable} [stream]
 * @returns {boolean}
 */
export function isTTY(stream = process.stdin) {
  return Boolean(stream && (stream.isTTY || isatty(stream.fd)));
}

/**
 * Format string with ANSI styling if stream supports TTY.
 * @param {string} text
 * @param {string} style
 * @returns {string}
 */
export function styleText(text, style) {
  if (!style) return text;
  return `${style}${text}${ANSI.reset}`;
}

import { WizardCancelledError } from "./ux/terminal-session.mjs";
import { createKeyDecoder } from "./ux/key-decoder.mjs";
export { WizardCancelledError };

/**
 * Read keypress in raw mode from TTY input stream without destroying stream on early return.
 * @param {import("node:stream").Readable} stream
 * @returns {AsyncGenerator<string, void, unknown>}
 */
async function* readKeypresses(stream = process.stdin) {
  const wasRaw = stream.isRaw;
  if (stream.setRawMode) {
    stream.setRawMode(true);
  }

  const decoder = createKeyDecoder();
  const queue = [];
  let waiting = null;
  let error = null;

  const onData = (chunk) => {
    const events = decoder.push(chunk);
    for (const ev of events) {
      const str = ev.sequence;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: str, done: false });
      } else {
        queue.push(str);
      }
    }
  };

  const onEnd = () => {
    const flushed = decoder.flush();
    for (const ev of flushed) {
      queue.push(ev.sequence);
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      if (queue.length > 0) {
        resolve({ value: queue.shift(), done: false });
      } else {
        resolve({ done: true });
      }
    }
  };

  const onError = (err) => {
    error = err;
    if (waiting) {
      const reject = waiting;
      waiting = null;
      reject(err);
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onError);

  stream.resume();
  stream.setEncoding("utf-8");

  try {
    while (true) {
      if (error) throw error;
      let nextVal;
      if (queue.length > 0) {
        nextVal = queue.shift();
      } else {
        const res = await new Promise((resolve) => {
          waiting = resolve;
        });
        if (res.done) break;
        nextVal = res.value;
      }

      if (nextVal === "\u0003") {
        // Ctrl+C SIGINT
        process.stdout.write(ANSI.showCursor + "\n");
        throw new WizardCancelledError("Wizard operation cancelled by user (SIGINT).");
      }
      yield nextVal;
    }
  } finally {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.pause();
    if (stream.setRawMode) {
      stream.setRawMode(Boolean(wasRaw));
    }
  }
}

/**
 * Single-select interactive menu using TTY raw mode.
 * @param {Array<{ label: string, value: any, description?: string }>} options
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function select(options, prompt, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;

  if (options.length === 0) {
    throw new Error("select() requires at least one option.");
  }

  const defaultIdx = opts.defaultIdx ?? 0;
  let currentIdx = Math.max(0, Math.min(options.length - 1, defaultIdx));

  if (!isTTY(stdin)) {
    // Non-TTY Headless fallback
    if (opts.fallbackValue !== undefined) {
      return opts.fallbackValue;
    }
    const val = options[currentIdx].value;
    stdout.write(`[Headless Select] ${prompt}: Auto-selected default [${options[currentIdx].label}]\n`);
    return val;
  }

  function render(isFinal = false) {
    let out = `${ANSI.bold}${ANSI.cyan}?${ANSI.reset} ${ANSI.bold}${prompt}${ANSI.reset}\n`;
    options.forEach((opt, idx) => {
      const isSelected = idx === currentIdx;
      const cursor = isSelected ? `${ANSI.cyan}❯${ANSI.reset}` : " ";
      const label = isSelected ? `${ANSI.bold}${ANSI.cyan}${opt.label}${ANSI.reset}` : opt.label;
      const desc = opt.description ? ` ${ANSI.dim}(${opt.description})${ANSI.reset}` : "";
      out += `  ${cursor} ${label}${desc}\n`;
    });
    if (!isFinal) {
      out += `${ANSI.dim}  (Use arrow keys or 1-${Math.min(9, options.length)} to select, Enter to confirm)${ANSI.reset}`;
    }
    return out;
  }

  stdout.write(ANSI.hideCursor);
  let renderedLines = options.length + 2;
  stdout.write(render());

  try {
    for await (const key of readKeypresses(stdin)) {
      if (key === "\r" || key === "\n") {
        // Confirm selection
        stdout.write(ANSI.cursorUp(renderedLines) + ANSI.clearLine);
        for (let i = 0; i < renderedLines; i++) {
          stdout.write(ANSI.clearLine + ANSI.cursorDown(1));
        }
        stdout.write(ANSI.cursorUp(renderedLines));
        stdout.write(`${ANSI.green}✔${ANSI.reset} ${ANSI.bold}${prompt}${ANSI.reset} ${ANSI.cyan}${options[currentIdx].label}${ANSI.reset}\n`);
        return options[currentIdx].value;
      }

      let moved = false;
      if (key === "\u001b[A" || key === "k") {
        // Up
        currentIdx = (currentIdx - 1 + options.length) % options.length;
        moved = true;
      } else if (key === "\u001b[B" || key === "j") {
        // Down
        currentIdx = (currentIdx + 1) % options.length;
        moved = true;
      } else if (/^[1-9]$/.test(key)) {
        const num = parseInt(key, 10) - 1;
        if (num < options.length) {
          currentIdx = num;
          moved = true;
        }
      }

      if (moved) {
        stdout.write(ANSI.cursorUp(renderedLines));
        stdout.write(render());
      }
    }
  } finally {
    stdout.write(ANSI.showCursor);
  }
}

/**
 * Multi-select checkbox menu using TTY raw mode.
 * @param {Array<{ label: string, value: any, checked?: boolean, description?: string }>} options
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<Array<any>>}
 */
export async function multiSelect(options, prompt, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;

  const selections = new Set();
  options.forEach((opt, idx) => {
    if (opt.checked) selections.add(idx);
  });

  if (!isTTY(stdin)) {
    // Non-TTY Headless fallback
    const selectedVals = options.filter((_, idx) => selections.has(idx)).map((o) => o.value);
    stdout.write(`[Headless MultiSelect] ${prompt}: Auto-selected ${selectedVals.length} item(s)\n`);
    return selectedVals;
  }

  let currentIdx = 0;
  let renderedLines = options.length + 2;

  function render() {
    let out = `${ANSI.bold}${ANSI.cyan}?${ANSI.reset} ${ANSI.bold}${prompt}${ANSI.reset}\n`;
    options.forEach((opt, idx) => {
      const isHover = idx === currentIdx;
      const isChecked = selections.has(idx);
      const cursor = isHover ? `${ANSI.cyan}❯${ANSI.reset}` : " ";
      const box = isChecked ? `${ANSI.green}[x]${ANSI.reset}` : `${ANSI.dim}[ ]${ANSI.reset}`;
      const label = isHover ? `${ANSI.bold}${opt.label}${ANSI.reset}` : opt.label;
      const desc = opt.description ? ` ${ANSI.dim}(${opt.description})${ANSI.reset}` : "";
      out += `  ${cursor} ${box} ${label}${desc}\n`;
    });
    out += `${ANSI.dim}  (Space to toggle, 'a' select all, 'n' select none, Enter to confirm)${ANSI.reset}`;
    return out;
  }

  stdout.write(ANSI.hideCursor);
  stdout.write(render());

  try {
    for await (const key of readKeypresses(stdin)) {
      if (key === "\r" || key === "\n") {
        const resultVals = options.filter((_, idx) => selections.has(idx)).map((o) => o.value);
        stdout.write(ANSI.cursorUp(renderedLines));
        for (let i = 0; i < renderedLines; i++) {
          stdout.write(ANSI.clearLine + ANSI.cursorDown(1));
        }
        stdout.write(ANSI.cursorUp(renderedLines));
        stdout.write(`${ANSI.green}✔${ANSI.reset} ${ANSI.bold}${prompt}${ANSI.reset} ${ANSI.cyan}${resultVals.length} selected${ANSI.reset}\n`);
        return resultVals;
      }

      let redraw = false;
      if (key === "\u001b[A" || key === "k") {
        currentIdx = (currentIdx - 1 + options.length) % options.length;
        redraw = true;
      } else if (key === "\u001b[B" || key === "j") {
        currentIdx = (currentIdx + 1) % options.length;
        redraw = true;
      } else if (key === " ") {
        if (selections.has(currentIdx)) {
          selections.delete(currentIdx);
        } else {
          selections.add(currentIdx);
        }
        redraw = true;
      } else if (key === "a" || key === "A") {
        options.forEach((_, idx) => selections.add(idx));
        redraw = true;
      } else if (key === "n" || key === "N") {
        selections.clear();
        redraw = true;
      }

      if (redraw) {
        stdout.write(ANSI.cursorUp(renderedLines));
        stdout.write(render());
      }
    }
  } finally {
    stdout.write(ANSI.showCursor);
  }
}

/**
 * Text input prompt with validation.
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function input(prompt, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const defaultValue = opts.defaultValue ?? "";
  const validate = opts.validate || (() => true);

  if (!isTTY(stdin)) {
    if (opts.fallbackValue !== undefined) {
      return opts.fallbackValue;
    }
    stdout.write(`[Headless Input] ${prompt}: Auto-selected default [${defaultValue}]\n`);
    return defaultValue;
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const defaultHint = defaultValue ? ` ${ANSI.dim}(${defaultValue})${ANSI.reset}` : "";
      const query = `${ANSI.bold}${ANSI.cyan}?${ANSI.reset} ${ANSI.bold}${prompt}${defaultHint}: `;
      const rawAns = await rl.question(query);
      const ans = rawAns.trim() || defaultValue;

      const validRes = await validate(ans);
      if (validRes === true) {
        return ans;
      }

      const errMsg = typeof validRes === "string" ? validRes : "Invalid input";
      stdout.write(`${ANSI.red}✖ ${errMsg}${ANSI.reset}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Confirmation prompt (Y/n).
 * @param {string} prompt
 * @param {boolean} [defaultVal=true]
 * @param {object} [opts]
 * @returns {Promise<boolean>}
 */
export async function confirm(prompt, defaultVal = true, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;

  if (!isTTY(stdin)) {
    const val = opts.fallbackValue ?? defaultVal;
    stdout.write(`[Headless Confirm] ${prompt}: Auto-selected [${val ? "Yes" : "No"}]\n`);
    return val;
  }

  const hint = defaultVal ? "[Y/n]" : "[y/N]";
  const ans = await input(`${prompt} ${ANSI.dim}${hint}${ANSI.reset}`, {
    defaultValue: defaultVal ? "y" : "n",
    stdin,
    stdout,
  });

  return /^y(es)?$/i.test(ans.trim());
}

/**
 * Password / secret input prompt.
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function secretInput(prompt, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;

  if (!isTTY(stdin)) {
    return opts.fallbackValue || "";
  }

  stdout.write(`${ANSI.bold}${ANSI.cyan}?${ANSI.reset} ${ANSI.bold}${prompt}:${ANSI.reset} `);
  stdout.write(ANSI.hideCursor);

  let inputStr = "";
  try {
    for await (const key of readKeypresses(stdin)) {
      if (key === "\r" || key === "\n") {
        stdout.write("\n");
        return inputStr;
      }
      if (key === "\u007f" || key === "\b") {
        // Backspace
        if (inputStr.length > 0) {
          inputStr = inputStr.slice(0, -1);
          stdout.write("\b \b");
        }
      } else if (key.length === 1 && key >= " ") {
        inputStr += key;
        stdout.write("*");
      }
    }
  } finally {
    stdout.write(ANSI.showCursor);
  }
  return inputStr;
}

/**
 * Terminal activity spinner indicator.
 * @param {string} label
 * @param {object} [opts]
 * @returns {{ stop: (msg?: string) => void, fail: (msg?: string) => void }}
 */
export function spinner(label, opts = {}) {
  const stdout = opts.stdout || process.stdout;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIdx = 0;
  let timer = null;

  if (isTTY(stdout)) {
    stdout.write(ANSI.hideCursor);
    stdout.write(`${ANSI.cyan}${frames[0]}${ANSI.reset} ${label}`);

    timer = setInterval(() => {
      frameIdx = (frameIdx + 1) % frames.length;
      stdout.write(ANSI.clearLine);
      stdout.write(`${ANSI.cyan}${frames[frameIdx]}${ANSI.reset} ${label}`);
    }, 80);
  } else {
    stdout.write(`[Starting] ${label}...\n`);
  }

  return {
    stop(successMsg = `${label} complete`) {
      if (timer) clearInterval(timer);
      if (isTTY(stdout)) {
        stdout.write(ANSI.clearLine);
        stdout.write(`${ANSI.green}✔${ANSI.reset} ${successMsg}\n`);
        stdout.write(ANSI.showCursor);
      } else {
        stdout.write(`[Completed] ${successMsg}\n`);
      }
    },
    fail(errorMsg = `${label} failed`) {
      if (timer) clearInterval(timer);
      if (isTTY(stdout)) {
        stdout.write(ANSI.clearLine);
        stdout.write(`${ANSI.red}✖${ANSI.reset} ${errorMsg}\n`);
        stdout.write(ANSI.showCursor);
      } else {
        stdout.write(`[Failed] ${errorMsg}\n`);
      }
    },
  };
}
