#!/usr/bin/env node

/**
 * Stable CLI boundary.
 *
 * Keep verification and mutation explicit at the process boundary as well as
 * in the SDK. The pre-v1 implementation remains in agentctl-impl.mjs while
 * commands are contracted without rewriting unrelated handlers in one PR.
 */
import { KIT_VERSION } from "../src/version.mjs";

export const VERSION = KIT_VERSION;

const argv = process.argv.slice(2);
const command = argv[0] || "";
const gateCommands = new Set(["gate", "check", "audit"]);

if (gateCommands.has(command) && argv.includes("--fix")) {
  console.error("Error: `agentctl gate` is non-mutating; `--fix` no longer dispatches automated repairs.");
  console.error("Run the gate normally, then use `agentctl repair` explicitly with the failure trace you want repaired.");
  process.exit(2);
}

// `fix` remains a 0.x compatibility spelling. `repair` is the explicit v1
// direction and intentionally reuses the existing repair implementation.
if (command === "repair") {
  process.argv[2] = "fix";
}

await import("./agentctl-impl.mjs");
