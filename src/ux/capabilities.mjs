import { isatty } from "node:tty";

/**
 * @typedef {Object} TerminalCapabilities
 * @property {boolean} inputIsTTY
 * @property {boolean} outputIsTTY
 * @property {number} columns
 * @property {number} rows
 * @property {0 | 4 | 8 | 24} colorDepth
 * @property {boolean} ansi
 * @property {boolean} unicode
 * @property {boolean} alternateScreen
 * @property {false} mouse
 * @property {NodeJS.Platform} platform
 * @property {string} term
 * @property {boolean} noColor
 * @property {boolean} forceColor
 * @property {boolean} reducedMotion
 */

/**
 * @typedef {Object} TerminalSessionOptions
 * @property {import("node:stream").Readable} [input]
 * @property {import("node:stream").Writable} [output]
 * @property {import("node:stream").Writable} [errorOutput]
 * @property {boolean} [jsonMode]
 * @property {boolean} [alternateScreen]
 * @property {"auto" | "always" | "never"} [color]
 * @property {"auto" | "always" | "never"} [unicode]
 * @property {boolean} [reducedMotion]
 */

/**
 * Detect current terminal capabilities based on streams, environment variables, and CLI options.
 * @param {TerminalSessionOptions} [options]
 * @returns {TerminalCapabilities}
 */
export function detectTerminalCapabilities(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const env = process.env || {};
  const argv = process.argv || [];

  const inputIsTTY = Boolean(input && (input.isTTY || (typeof input.fd === "number" && isatty(input.fd))));
  const outputIsTTY = Boolean(output && (output.isTTY || (typeof output.fd === "number" && isatty(output.fd))));

  const term = String(env.TERM || "").toLowerCase();
  const colorTerm = String(env.COLORTERM || "").toLowerCase();

  // Environment color flags
  const envNoColor = Boolean(env.NO_COLOR !== undefined && env.NO_COLOR !== "");
  let envForceColor = false;
  let envDisableColor = false;

  if (env.FORCE_COLOR !== undefined) {
    if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") {
      envDisableColor = true;
    } else {
      envForceColor = true;
    }
  }

  // CLI argument overrides
  const cliNoColor = argv.includes("--no-color");
  const cliColor = argv.includes("--color");
  const cliAscii = argv.includes("--ascii");
  const jsonMode = Boolean(options.jsonMode || argv.includes("--json"));

  const noColor = envNoColor || cliNoColor || options.color === "never";
  const forceColor = (envForceColor || cliColor || options.color === "always") && !envDisableColor;

  // Priority evaluation for ANSI support:
  // --no-color / options.color === "never" > NO_COLOR > FORCE_COLOR=0 > jsonMode > --color / FORCE_COLOR > auto TTY capability
  let ansi = false;
  if (jsonMode) {
    ansi = false;
  } else if (noColor || envDisableColor) {
    ansi = false;
  } else if (forceColor) {
    ansi = true;
  } else {
    ansi = outputIsTTY && term !== "dumb";
  }

  // Color depth calculation
  /** @type {0 | 4 | 8 | 24} */
  let colorDepth = 0;
  if (ansi) {
    if (colorTerm === "truecolor" || colorTerm === "24bit" || env.FORCE_COLOR === "3") {
      colorDepth = 24;
    } else if (term.includes("256color") || colorTerm === "256color" || env.FORCE_COLOR === "2") {
      colorDepth = 8;
    } else {
      colorDepth = 4;
    }
  }

  // Unicode support detection
  let unicode = true;
  if (cliAscii || options.unicode === "never") {
    unicode = false;
  } else if (options.unicode === "always") {
    unicode = true;
  } else {
    const lang = String(env.LANG || env.LC_ALL || env.LC_CTYPE || "").toLowerCase();
    const isUtf8 = lang.includes("utf-8") || lang.includes("utf8");
    // Default to true on non-windows or utf-8 windows terminals
    unicode = isUtf8 || process.platform !== "win32" || Boolean(env.WT_SESSION);
  }

  // Terminal dimensions
  const columns = Math.max(10, output.columns || input.columns || process.stdout.columns || 80);
  const rows = Math.max(5, output.rows || input.rows || process.stdout.rows || 24);

  const reducedMotion = Boolean(
    options.reducedMotion ||
    env.REDUCED_MOTION === "1" ||
    env.REDUCED_MOTION === "true"
  );

  const alternateScreen = options.alternateScreen !== false && ansi && outputIsTTY;

  return {
    inputIsTTY,
    outputIsTTY,
    columns,
    rows,
    colorDepth,
    ansi,
    unicode,
    alternateScreen,
    mouse: false,
    platform: process.platform,
    term: env.TERM || "",
    noColor,
    forceColor,
    reducedMotion,
  };
}

/**
 * Get display symbol set based on unicode capability.
 * @param {TerminalCapabilities} caps
 */
export function getSymbols(caps) {
  if (caps.unicode) {
    return {
      select: "❯",
      checked: "●",
      unchecked: "○",
      success: "✓",
      warning: "!",
      failure: "✗",
      info: "ℹ",
      bullet: "•",
      ellipsis: "…",
      spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      branchMiddle: "├─",
      branchEnd: "└─",
      arrowUp: "↑",
      arrowDown: "↓",
    };
  }
  return {
    select: ">",
    checked: "[x]",
    unchecked: "[ ]",
    success: "OK",
    warning: "WARN",
    failure: "ERR",
    info: "INFO",
    bullet: "*",
    ellipsis: "...",
    spinner: ["-", "\\", "|", "/"],
    branchMiddle: "+-",
    branchEnd: "`-",
    arrowUp: "^",
    arrowDown: "v",
  };
}
