import { StringDecoder } from "node:string_decoder";

/**
 * @typedef {"up" | "down" | "left" | "right" | "page-up" | "page-down" | "home" | "end" | "space" | "enter" | "tab" | "shift-tab" | "escape" | "ctrl-c" | "backspace" | "delete" | "character" | "unknown"} KeyName
 */

/**
 * @typedef {Object} KeyEvent
 * @property {KeyName} name
 * @property {string} sequence
 * @property {string} [text]
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {number} timestampMs
 */

const SEQUENCE_MAP = new Map([
  // Arrow keys
  ["\x1b[A", { name: "up", ctrl: false, alt: false, shift: false }],
  ["\x1bOA", { name: "up", ctrl: false, alt: false, shift: false }],
  ["\x1b[B", { name: "down", ctrl: false, alt: false, shift: false }],
  ["\x1bOB", { name: "down", ctrl: false, alt: false, shift: false }],
  ["\x1b[C", { name: "right", ctrl: false, alt: false, shift: false }],
  ["\x1bOC", { name: "right", ctrl: false, alt: false, shift: false }],
  ["\x1b[D", { name: "left", ctrl: false, alt: false, shift: false }],
  ["\x1bOD", { name: "left", ctrl: false, alt: false, shift: false }],

  // Home / End
  ["\x1b[H", { name: "home", ctrl: false, alt: false, shift: false }],
  ["\x1bOH", { name: "home", ctrl: false, alt: false, shift: false }],
  ["\x1b[1~", { name: "home", ctrl: false, alt: false, shift: false }],
  ["\x1b[7~", { name: "home", ctrl: false, alt: false, shift: false }],
  ["\x1b[F", { name: "end", ctrl: false, alt: false, shift: false }],
  ["\x1bOF", { name: "end", ctrl: false, alt: false, shift: false }],
  ["\x1b[4~", { name: "end", ctrl: false, alt: false, shift: false }],
  ["\x1b[8~", { name: "end", ctrl: false, alt: false, shift: false }],

  // Navigation
  ["\x1b[5~", { name: "page-up", ctrl: false, alt: false, shift: false }],
  ["\x1b[6~", { name: "page-down", ctrl: false, alt: false, shift: false }],
  ["\x1b[Z", { name: "shift-tab", ctrl: false, alt: false, shift: true }],
  ["\x1b[3~", { name: "delete", ctrl: false, alt: false, shift: false }],

  // Single-byte controls
  ["\r", { name: "enter", ctrl: false, alt: false, shift: false }],
  ["\n", { name: "enter", ctrl: false, alt: false, shift: false }],
  ["\t", { name: "tab", ctrl: false, alt: false, shift: false }],
  ["\x03", { name: "ctrl-c", ctrl: true, alt: false, shift: false }],
  ["\x7f", { name: "backspace", ctrl: false, alt: false, shift: false }],
  ["\x08", { name: "backspace", ctrl: false, alt: false, shift: false }],
  [" ", { name: "space", text: " ", ctrl: false, alt: false, shift: false }],
]);

/**
 * Create an incremental sequence key decoder.
 * @param {Object} [options]
 * @param {number} [options.escapeTimeoutMs=30]
 * @param {number} [options.maxBufferBytes=1024]
 */
export function createKeyDecoder(options = {}) {
  const escapeTimeoutMs = options.escapeTimeoutMs ?? 30;
  const maxBufferBytes = options.maxBufferBytes ?? 1024;

  const utf8Decoder = new StringDecoder("utf8");
  let buffer = "";
  let lastTimeMs = 0;

  function appendChunk(chunk) {
    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
      buffer += utf8Decoder.write(chunk);
    } else if (chunk !== null && chunk !== undefined) {
      buffer += String(chunk);
    }

    while (Buffer.byteLength(buffer, "utf8") > maxBufferBytes) {
      const firstCodePoint = buffer.codePointAt(0);
      buffer = buffer.slice(firstCodePoint > 0xffff ? 2 : 1);
    }
  }

  /**
   * Process a single token from buffer.
   * @param {number} nowMs
   * @returns {{ event: KeyEvent, consumed: number } | null}
   */
  function tryDecodeToken(nowMs) {
    if (!buffer) return null;

    // Check exact sequence mappings
    for (const [seq, meta] of SEQUENCE_MAP.entries()) {
      if (buffer.startsWith(seq)) {
        return {
          event: {
            name: meta.name,
            sequence: seq,
            text: meta.text,
            ctrl: meta.ctrl,
            alt: meta.alt,
            shift: meta.shift,
            timestampMs: nowMs,
          },
          consumed: seq.length,
        };
      }
    }

    // Handle ESC prefix sequences
    if (buffer[0] === "\x1b") {
      if (buffer === "\x1b") {
        // Wait for timeout to distinguish standalone ESC
        if (nowMs - lastTimeMs >= escapeTimeoutMs) {
          return {
            event: {
              name: "escape",
              sequence: "\x1b",
              ctrl: false,
              alt: false,
              shift: false,
              timestampMs: nowMs,
            },
            consumed: 1,
          };
        }
        // Needs more input
        return null;
      }

      // CSI or SS3 sequence parsing: ESC [ ... or ESC O ...
      if (buffer[1] === "[" || buffer[1] === "O") {
        let idx = 2;
        while (idx < buffer.length) {
          const charCode = buffer.charCodeAt(idx);
          // Sequence terminator char is usually between 0x40 ('@') and 0x7E ('~')
          if (charCode >= 0x40 && charCode <= 0x7e) {
            const seq = buffer.slice(0, idx + 1);
            const matched = SEQUENCE_MAP.get(seq);
            if (matched) {
              return {
                event: {
                  name: matched.name,
                  sequence: seq,
                  text: matched.text,
                  ctrl: matched.ctrl,
                  alt: matched.alt,
                  shift: matched.shift,
                  timestampMs: nowMs,
                },
                consumed: seq.length,
              };
            }
            // Unknown CSI/SS3 sequence - sanitize and emit as unknown
            return {
              event: {
                name: "unknown",
                sequence: seq,
                text: seq.replace(/\x1b/g, "^["),
                ctrl: false,
                alt: false,
                shift: false,
                timestampMs: nowMs,
              },
              consumed: seq.length,
            };
          }
          idx++;
        }
        // Incomplete CSI/SS3 sequence in buffer, wait unless buffer exceeded cap
        if (Buffer.byteLength(buffer, "utf8") < maxBufferBytes) {
          return null;
        }
      }

      // Alt+Character (ESC followed by a single printable character)
      const altChar = Array.from(buffer.slice(1))[0];
      if (altChar && altChar.codePointAt(0) >= 0x20 && altChar.codePointAt(0) <= 0x7e) {
        const seq = `\x1b${altChar}`;
        return {
          event: {
            name: altChar === " " ? "space" : "character",
            sequence: seq,
            text: altChar,
            ctrl: false,
            alt: true,
            shift: false,
            timestampMs: nowMs,
          },
          consumed: seq.length,
        };
      }
    }

    // Ctrl+Key (ASCII 1..26 except TAB \t, CR \r, LF \n, ETX \x03)
    const code = buffer.charCodeAt(0);
    if (code >= 1 && code <= 26 && code !== 9 && code !== 10 && code !== 13) {
      const char = String.fromCharCode(code + 96);
      return {
        event: {
          name: "character",
          sequence: buffer[0],
          text: char,
          ctrl: true,
          alt: false,
          shift: false,
          timestampMs: nowMs,
        },
        consumed: 1,
      };
    }

    // Printable single character or Unicode scalar
    const firstCodePoint = buffer.codePointAt(0) || 0;
    const firstChar = String.fromCodePoint(firstCodePoint);
    if (firstCodePoint >= 0x20) {
      return {
        event: {
          name: firstChar === " " ? "space" : "character",
          sequence: firstChar,
          text: firstChar,
          ctrl: false,
          alt: false,
          shift: false,
          timestampMs: nowMs,
        },
        consumed: firstChar.length,
      };
    }

    // Fallback unknown control byte
    return {
      event: {
        name: "unknown",
        sequence: firstChar,
        ctrl: false,
        alt: false,
        shift: false,
        timestampMs: nowMs,
      },
      consumed: firstChar.length,
    };
  }

  return {
    /**
     * Push incoming chunk bytes/string and return decoded KeyEvents.
     * @param {Buffer | string} chunk
     * @param {number} [nowMs]
     * @returns {KeyEvent[]}
     */
    push(chunk, nowMs = Date.now()) {
      appendChunk(chunk);
      lastTimeMs = nowMs;

      const events = [];
      let result = tryDecodeToken(nowMs);
      while (result) {
        events.push(result.event);
        buffer = buffer.slice(result.consumed);
        result = tryDecodeToken(nowMs);
      }
      return events;
    },

    /**
     * Flush remaining buffer (e.g. after timeout).
     * @param {number} [nowMs]
     * @returns {KeyEvent[]}
     */
    flush(nowMs = Date.now()) {
      const events = [];
      let result = tryDecodeToken(nowMs + escapeTimeoutMs + 1);
      while (result) {
        events.push(result.event);
        buffer = buffer.slice(result.consumed);
        result = tryDecodeToken(nowMs + escapeTimeoutMs + 1);
      }
      buffer = "";
      return events;
    },
  };
}
