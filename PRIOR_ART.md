# Prior Art & Differentiation

This documentation lists the projects in the AI agent ecosystem that inspired the development of `jules-orchestrator-kit`, and clarifies how this kit differs.

## Core Inspirations

- **Inspiration:** The concept of a "Human Escalation Bridge" via chat channels (like Telegram or Slack), handling states where agents get stuck in `AWAITING_USER_FEEDBACK` waiting for asynchronous human input.
- **Our Difference:** We build the asynchronous escalation into the core `jules-queue-runner.mjs` so it becomes built-in state management, without requiring an external supervisor tool spinning alongside it.

- **Inspiration:** Local CI Verification Container Runner (e.g., via Nektos Act). Packaging execution in isolated environments before a PR is created to ensure an agent does not introduce environment-specific bugs.
- **Our Difference:** We are currently focusing on `npm test` in the host environment to keep dependencies at zero (according to our strict Zero Dependencies policy), but we are keeping an eye on how they orchestrate secure sandboxes.

- **Inspiration:** Exposing Jules functionality via the Model Context Protocol (MCP), particularly over HTTP streams (Streamable MCP Bridge) for tools like n8n and Hermes Agent.
- **Our Difference:** We plan to build a **0-dependency stdio MCP server** (`src/mcp-server.mjs`) instead of a full-fledged HTTP/Express server, to enable direct embedding inside Claude Desktop, Cursor, and Antigravity without port conflicts and unnecessary overhead.

- **Inspiration:** Cloud Build Auto-Fix Webhooks. A pattern where webhook endpoints receive failed deployment builds from Vercel/Cloudflare and automatically dispatch Jules on a "fix-session".
- **Our Difference:** Our kit exposes the OODA loop in the CLI, making it possible to build the exact same logic locally or via bash scripts, before an HTTP server even needs to be involved.

## What makes jules-orchestrator-kit unique?

The honest answer to what *this* kit does that the others don't is **the gate**:

- **Verification & OODA-loop:** Automatic repairs with test runs (up to 3 attempts) before giving up.
- **Scope Control (Agent Scope Guard):** Strict control ensuring Jules cannot modify command files (`package.json`, `.github/`) unless explicitly allowed.
- **Secret Scanning:** Built-in redaction of AWS, GitHub, and npm keys (both high and low confidence) directly in the log stream, *before* it gets saved to disk.
- **Atomic Budgeting:** A local ledger system (`.agent/state/sessions/YYYY-MM-DD.jsonl`) that manages daily session budgets and blocks runaway loops (e.g., Jules accidentally burning your token budget).

These mechanisms are the core of `jules-orchestrator-kit` and the reason we can deliver stability.
