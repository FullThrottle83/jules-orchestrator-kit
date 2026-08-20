# Prior Art & Differentiation

This documentation lists the projects in the AI agent ecosystem that inspired the development of `jules-orchestrator-kit`, and clarifies how this kit differs.

## Core Inspirations

- **Inspiration:** The concept of a "Human Escalation Bridge" via chat channels (like Telegram or Slack), handling states where agents get stuck in `AWAITING_USER_FEEDBACK` waiting for asynchronous human input.
- **Our Difference:** We build the asynchronous escalation into the core `jules-queue-runner.mjs` so it becomes built-in state management, without requiring an external supervisor tool spinning alongside it.

- **Inspiration:** Local CI Verification Container Runner (e.g., via Nektos Act). Packaging execution in isolated environments before a PR is created to ensure an agent does not introduce environment-specific bugs.
- **Our Difference:** We are currently focusing on `npm test` in the host environment to keep runtime dependencies at zero (according to our strict Zero Runtime Dependencies policy), but we are keeping an eye on how they orchestrate secure sandboxes.

- **Inspiration:** Exposing Jules functionality via the Model Context Protocol (MCP), particularly over HTTP streams (Streamable MCP Bridge) for tools like n8n and Hermes Agent.
- **Our Difference:** We plan to build a **0-dependency stdio MCP server** (`src/mcp-server.mjs`) instead of a full-fledged HTTP/Express server, to enable direct embedding inside Claude Desktop, Cursor, and Antigravity without port conflicts and unnecessary overhead.

- **Inspiration:** Cloud Build Auto-Fix Webhooks. A pattern where webhook endpoints receive failed deployment builds from Vercel/Cloudflare and automatically dispatch Jules on a "fix-session".
- **Our Difference:** Our kit exposes the OODA loop in the CLI, making it possible to build the exact same logic locally or via bash scripts, before an HTTP server even needs to be involved.

- **Inspiration (`jules-pr-reviewer`, `maxi-reviewer`):** Prompt injection defense (`UNTRUSTED` fencing) and pre-flight static analysis layering.
- **Our Difference:** We integrate random nonced `<UNTRUSTED_TASK_CONTEXT_${nonce}>` tags directly in `jules-dispatch.mjs` alongside pre-flight static check layering (`runPreflightStaticCheck()`), ensuring zero third-party dependencies.

- **Inspiration (`Jules-Companion`, `jules-supervisor`):** Safety Gate verification prior to merging multi-session swarm PRs and phase-branch guardrails.
- **Our Difference:** Built-in `checkSafetyGate()` in `scripts/jules-merge-swarm.mjs` that inspects active worker locks (`.agent/state/locks/*.json`) to prevent merging incomplete or active swarm branches.

- **Inspiration (`jules-agent-roster`, `jules-autonomous-agents`, `jules-prompts`):** Specialized prompt rosters (`Overseer`, `Bolt`, `Sentinel`) and machine-readable task templates.
- **Our Difference:** Pre-configured specialist prompt presets in `.agent/prompts/` that enforce atomic payload limits (< 75 KB) and zero-dependency refactoring rules out of the box.

- **Inspiration (`jules-me`):** Priority-based 3-bucket status classification.
- **Our Difference:** Native `categorizeTaskStatus()` in `scripts/jules-status.mjs` grouping active tasks into *🚨 Action Required*, *⏳ In Progress*, and *✅ Completed*.

- **Inspiration (Google Labs `/code` *Situationally Aware Agents* / Type III Taxonomy):** Deep telemetry ingestion and treating silence as an explicit, strategic decision to preserve developer focus.
- **Our Difference:** Zero-dependency, local sidecar state management (`.agent/jules-queue/*.state.json`) and quiet-by-default interruption budgeting directly in the orchestrator kernel, avoiding external surveillance SaaS or heavyweight daemons.

- **Inspiration (`TrueForge`, `DeepAgents`, `Claude Managed Agents`):** Self-hosted Agent Runtime Harnesses offering multi-provider model gateways, dynamic remote sandboxing (Daytona), context compaction ("Code Mode"), and embeddable web chat UIs.
- **Our Difference:** TrueForge builds heavy runtime infrastructure (Postgres, Redis, Docker, SaaS gateways) to turn raw LLMs into agents. In contrast, `jules-orchestrator-kit` is a sovereign **Zero-Dependency Governor & Orchestrator** for already-harnessed autonomous workers (Google Jules). We enforce terminal-first execution, strict payload limits (< 75 KB), local OODA auto-repair loops, and atomic secret/scope gates using only Node.js standard libraries.

- **Inspiration (`RouteLLM`, `LiteLLM`, `OpenRouter`, agent-router SaaS gateways):** Complexity-aware LLM routing — classifying a query's difficulty and dispatching it to the cheapest model that can still handle it, cutting inference cost 40–85% with near-identical quality.
- **Our Difference:** Those tools route raw chat completions through a hosted gateway. `agentctl`'s router (`src/router.mjs`, `router:` in `.agent/config.yml`, opt-in and disabled by default) routes whole *autonomous coding tasks* between locally-installed, already-harnessed agent CLIs (Jules, Claude Code, Codex, Gemini CLI) using a zero-dependency rule-based heuristic — no ML classifier, no third-party gateway, no data leaving the machine except to the provider the user already configured. Safety-sensitive paths (`auth/**`, `migrations/**`, secrets, `.github/**`) and the `sentinel` role always force the primary provider regardless of score, and any provider is user-swappable — the kit is not tied to Gemini, Jules, or any single vendor.

## What makes jules-orchestrator-kit unique?

The honest answer to what *this* kit does that the others don't is **the gate**:

- **Verification & OODA-loop:** Automatic repairs with test runs (up to 3 attempts) before giving up.
- **Scope Control (Agent Scope Guard):** Strict control ensuring Jules cannot modify command files (`package.json`, `.github/`) unless explicitly allowed.
- **Secret Scanning:** Built-in redaction of AWS, GitHub, and npm keys (both high and low confidence) directly in the log stream, *before* it gets saved to disk.
- **Atomic Budgeting:** A local ledger system (`.agent/state/sessions/YYYY-MM-DD.jsonl`) that manages daily session budgets and blocks runaway loops (e.g., Jules accidentally burning your token budget).

These mechanisms are the core of `jules-orchestrator-kit` and the reason we can deliver stability.
