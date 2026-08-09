# `v0.30.0` Interactive UX, Guided Diagnostics & Swarm Management Specification
**Project:** `jules-orchestrator-kit`  
**Baseline implementation:** `v0.29.1`  
**Target:** `v0.29.2+` / `v0.30.0`  
**Date:** 2026-08-10  
**Status:** Normative architecture and UX specification  
**Audience:** CLI engineers, systems architects, security reviewers, release engineers, and enterprise platform operators
---
## 0. Normative language and scope
The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are normative.
This specification defines the interactive and headless operations layer for:
```text
agentctl
agentctl doctor --interactive
agentctl doctor --fix
agentctl queue --interactive
agentctl swarm --interactive
```
It extends the `v0.29.1` foundation:
- `src/tui.mjs`;
- `src/wizard-oracle.mjs`;
- `src/wizard-init.mjs`;
- `src/wizard-task.mjs`;
- canonical `.agent/jules-queue/` task files;
- canonical `<!-- JULES_TASK_ENVELOPE: ... -->` metadata;
- atomic write helpers;
- working-tree gate mode;
- hash-chained telemetry and state ledgers;
- VFS locks and worktree state.
The target is not merely a prettier CLI. It is a deterministic operations console whose interactive views are adapters over the same pure plans, state machines, and transactional effects used by headless CI.
---
## 1. Executive architecture
### 1.1 Core rule
```text
Terminal input is not business logic.
Rendering is not state.
A keypress never mutates the repository directly.
```
Every operation follows:
```text
Input source
  ├── CLI flags
  ├── JSON answers
  ├── environment references
  ├── TTY events
  └── existing state
        │
        ▼
Pure parser / reducer / planner
        │
        ▼
Immutable Plan + Preconditions + Risk
        │
        ├── preview as text/diff/JSON
        ├── reject/cancel
        └── confirm
              │
              ▼
Transactional executor
  lock -> journal intent -> temp write -> fsync -> rename
       -> command effect -> verify -> journal done -> unlock
              │
              ▼
Event + receipt + refreshed snapshot
```
### 1.2 Layer diagram
```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLI ROUTER                                     │
│ node:util parseArgs │ command registry │ headless policy │ exit contract    │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INTERACTION ADAPTERS                              │
│ TTY Session │ JSON/Flags │ Non-TTY │ HTTP Dashboard Link │ Plain Text       │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ UserIntent / KeyEvent / CommandRequest
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PURE APPLICATION CORE                               │
│ reducers │ selectors │ planners │ validators │ state transition guards      │
│ doctor registry │ task actions │ swarm actions │ command palette registry   │
└───────┬──────────────────────┬───────────────────────┬──────────────────────┘
        │                      │                       │
        ▼                      ▼                       ▼
┌───────────────┐    ┌────────────────────┐   ┌──────────────────────────────┐
│ Snapshot      │    │ Preview Models     │   │ Immutable Action Plans       │
│ Builders      │    │ diff/log/table     │   │ preconditions + risk + hash  │
└───────┬───────┘    └──────────┬─────────┘   └──────────────┬───────────────┘
        │                       │                            │
        ▼                       ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NATIVE TUI RENDERER                                  │
│ key decoder │ virtual screen │ layout │ ANSI policy │ resize coordinator    │
└─────────────────────────────────────────────────────────────────────────────┘
                                                             │ confirmed plan
                                                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      TRANSACTIONAL EFFECT EXECUTOR                           │
│ VFS mutex │ intent journal │ atomic files │ subprocesses │ rollback          │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REPOSITORY STATE                                     │
│ queue sidecars │ task files │ locks │ worktrees │ telemetry │ receipts       │
└─────────────────────────────────────────────────────────────────────────────┘
```
### 1.3 New module boundaries
```text
src/ux/
├── capabilities.mjs          # TTY, ANSI, dimensions, platform capabilities
├── key-decoder.mjs           # incremental terminal sequence decoder
├── terminal-session.mjs      # raw/alternate screen lifecycle and cleanup
├── renderer.mjs              # virtual screen and minimal ANSI patching
├── layout.mjs                # responsive panes, tables, clipping, widths
├── widgets.mjs               # lists, inputs, tabs, dialogs, status bars
├── diff-viewer.mjs           # unified diff parser/model/reducer
├── log-viewer.mjs            # bounded log model/reducer
├── palette.mjs               # command palette model and fuzzy filtering
├── doctor-model.mjs          # diagnostic snapshots and view state
├── queue-model.mjs           # queue dashboard snapshots and view state
├── swarm-model.mjs           # slot dashboard snapshots and view state
└── accessibility.mjs         # color/reduced-motion/plain-symbol policies
src/ops/
├── command-registry.mjs      # one registry for help, palette, parsing metadata
├── snapshot.mjs              # repository operational snapshot builder
├── doctor-registry.mjs       # diagnostic check definitions
├── doctor-planner.mjs        # pure fix proposal planner
├── task-actions.mjs          # retry/edit/delete/quarantine plans
├── swarm-actions.mjs         # pause/cancel/cleanup plans
├── transaction.mjs           # locks, journal, atomic apply, rollback
├── receipts.mjs              # operation receipt schema and persistence
├── event-reader.mjs          # telemetry/event tail and reconciliation
└── json-contract.mjs         # JSON success/error output
```
`src/tui.mjs` remains a compatibility facade. Existing `select`, `multiSelect`, `input`, `confirm`, `secretInput`, and `spinner` delegate to the new engine.
---
## 2. Cross-cutting invariants
### 2.1 Zero third-party runtime dependencies
All implementation MUST use Node.js 20+ built-ins and repository-local modules only. In particular:
- no `inquirer`;
- no `chalk`;
- no `blessed`;
- no `ink`;
- no `commander`;
- no `yaml`;
- no `node-pty`;
- no terminal-width package;
- no diff/parser package.
External repository tools such as `git`, `docker`, `cargo`, `go`, or package managers MAY be invoked as explicit operational commands. They are not runtime library dependencies and MUST be capability-checked.
### 2.2 Dual-mode determinism
For the same explicit input and same repository snapshot:
```text
interactive plan hash == headless plan hash
```
The TUI MAY change presentation, focus, filters, and preview navigation. It MUST NOT change planner defaults silently.
### 2.3 Input precedence
```text
explicit CLI flag
> explicit JSON input / --answers
> approved environment reference
> existing configuration
> safe deterministic default
> interactive prompt
> missing-input error in headless mode
```
A CLI flag MUST suppress the corresponding prompt.
### 2.4 Structured output isolation
When `--json` is active:
- stdout contains exactly one JSON document or JSONL stream defined by the command;
- TUI, progress, diagnostics, and warnings go to stderr;
- ANSI is disabled on stdout unconditionally;
- no spinner writes to stdout;
- cancellation produces a JSON error unless the process is terminated externally.
### 2.5 Transaction rule
No TUI event handler may call `writeFileSync`, `renameSync`, `unlinkSync`, `spawn`, `git`, provider APIs, or state mutators. It emits an `ActionIntent`; the planner returns an `ActionPlan`; the executor applies a confirmed plan.
### 2.6 State privacy
The UI MUST redact:
- API keys and exact environment secret values;
- Authorization headers;
- private keys;
- untrusted ANSI/control sequences;
- configured PII fields;
- sensitive command output according to the existing secret scanner.
A task prompt or log line is data. It cannot inject terminal control sequences.
---
# 3. Shared data contracts
## 3.1 Terminal capabilities
```ts
export interface TerminalCapabilities {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  columns: number;
  rows: number;
  colorDepth: 0 | 4 | 8 | 24;
  ansi: boolean;
  unicode: boolean;
  alternateScreen: boolean;
  mouse: false;
  platform: NodeJS.Platform;
  term: string;
  noColor: boolean;
  forceColor: boolean;
  reducedMotion: boolean;
}
```
Mouse input is intentionally out of scope for `v0.30.0`. Keyboard behavior remains deterministic across terminals.
## 3.2 Key events
```ts
export type KeyName =
  | "up" | "down" | "left" | "right"
  | "page-up" | "page-down"
  | "home" | "end"
  | "space" | "enter"
  | "tab" | "shift-tab"
  | "escape" | "ctrl-c"
  | "backspace" | "delete"
  | "character" | "unknown";
export interface KeyEvent {
  name: KeyName;
  sequence: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  timestampMs: number;
}
```
## 3.3 Render frame
The pure renderer produces logical cells without ANSI:
```ts
export interface TextStyle {
  fg?: "default" | "red" | "green" | "yellow" | "blue" | "cyan" | "white";
  bg?: "default" | "blue" | "cyan";
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
}
export interface CellRun {
  text: string;
  style: TextStyle;
}
export interface ScreenLine {
  runs: CellRun[];
  key: string;
}
export interface RenderFrame {
  width: number;
  height: number;
  lines: ScreenLine[];
  cursor?: { row: number; column: number; visible: boolean };
  title?: string;
}
```
ANSI encoding happens only after frame validation and clipping.
## 3.4 Action plan
```ts
export type RiskLevel = "low" | "moderate" | "high" | "destructive";
export interface PlanPrecondition {
  kind: "file-hash" | "state-revision" | "pid-alive" | "lock-free" | "git-head" | "custom";
  target: string;
  expected: string | number | boolean;
}
export interface FileMutation {
  operation: "create" | "replace" | "move" | "delete";
  path: string;
  fromPath?: string;
  expectedOldHash?: string;
  newContent?: string;
  newMode?: number;
}
export interface CommandEffect {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  envAllowlist: string[];
}
export interface ActionPlan {
  schema: "agentctl/action-plan-v1";
  id: string;
  kind: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  repository: string;
  createdAt: string;
  preconditions: PlanPrecondition[];
  fileMutations: FileMutation[];
  commandEffects: CommandEffect[];
  stateTransitions: Array<{ taskId?: string; from: string; to: string }>;
  preview: {
    unifiedDiff: string;
    warnings: string[];
    estimatedImpact: string[];
  };
  confirmation: ConfirmationPolicy;
  planHash: string;
}
```
## 3.5 Confirmation policy
```ts
export interface ConfirmationPolicy {
  mode: "none" | "keypress" | "typed-phrase" | "typed-repository" | "typed-task-id";
  prompt: string;
  expected?: string;
  requireReason?: boolean;
}
```
## 3.6 Error contract
```ts
export interface AgentctlErrorPayload {
  ok: false;
  command: string;
  code: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string[];
  cancelled?: boolean;
}
```
---
# 4. Module A — Advanced Terminal UI and keyboard engine
## 4.1 Terminal session state machine
```text
                    capability failure
 DETACHED ───────► NEGOTIATING ─────────────────► PLAIN_MODE
    │                  │
    │                  │ TTY + ANSI
    │                  ▼
    │              COOKED_TTY
    │                  │ enter interactive surface
    │                  ▼
    │              RAW_INLINE or RAW_ALTERNATE
    │                  │
    │       SIGWINCH ──┤ schedule redraw; remain in state
    │                  │
    │       SIGTSTP ──►SUSPENDING ─► COOKED_SUSPENDED
    │                                      │ SIGCONT
    │                                      ▼
    │                               RESTORING_RAW
    │                                      │
    │                                      ▼
    │                              RAW_INLINE/ALTERNATE
    │
    └──────────────────────────────────────────────────┐
                                                       ▼
 any state ── success/error/cancel/Ctrl+C ──► RESTORING ──► CLOSED
                                              │
                                              └─ restoration error -> CLOSED_WITH_WARNING
```
### 4.1.1 Lifecycle requirements
A `TerminalSession` MUST capture before mutation:
- `stdin.isRaw`;
- paused/resumed state;
- output stream;
- cursor visibility assumption;
- alternate-screen state;
- signal listeners installed by the session.
Cleanup MUST occur in a `finally` block and MUST be idempotent.
The TUI library MUST never call `process.exit()`.
### 4.1.2 Alternate screen policy
Use the alternate screen buffer for:
- bare `agentctl` home/palette;
- queue dashboard;
- swarm dashboard;
- diff viewer;
- log viewer;
- interactive doctor matrix.
Use inline rendering for:
- one-off select/input/confirm prompts;
- short fix confirmation dialogs when no full-screen surface is active.
On exit, the alternate screen MUST restore the previous terminal content, avoiding scrollback pollution.
## 4.2 ANSI policy
ANSI is enabled only when:
```text
output is TTY
AND TERM != dumb
AND NO_COLOR is absent
AND FORCE_COLOR != 0
```
`FORCE_COLOR=1|2|3` MAY enable color on a TTY-disabled output only for explicitly human-oriented output. It MUST never enable ANSI on JSON stdout.
Priority:
```text
--no-color > NO_COLOR > FORCE_COLOR=0 > --color > FORCE_COLOR > capability detection
```
### 4.2.1 Symbol policy
Unicode symbols have ASCII fallbacks:
| Semantic | Unicode | ASCII |
|---|---|---|
| selected | `❯` | `>` |
| checked | `●` | `[x]` |
| unchecked | `○` | `[ ]` |
| success | `✓` | `OK` |
| warning | `!` | `WARN` |
| failure | `✗` | `ERR` |
| spinner | Braille frames | `-\|/` |
| branch | `├─`/`└─` | `+-`/``-` |
## 4.3 Incremental key decoder
### 4.3.1 Decoder requirements
The key decoder MUST:
- accept arbitrary chunk boundaries;
- buffer incomplete escape sequences;
- emit multiple events from a combined chunk;
- distinguish standalone Escape from an escape sequence using a 25–40 ms timeout;
- support common CSI and SS3 variants;
- cap buffer length to prevent unbounded input;
- convert unknown sequences to escaped diagnostic text, never render raw controls.
### 4.3.2 Required sequences
| Key | Common sequences |
|---|---|
| Up | `ESC [ A`, `ESC O A` |
| Down | `ESC [ B`, `ESC O B` |
| Right | `ESC [ C`, `ESC O C` |
| Left | `ESC [ D`, `ESC O D` |
| Home | `ESC [ H`, `ESC O H`, `ESC [ 1 ~`, `ESC [ 7 ~` |
| End | `ESC [ F`, `ESC O F`, `ESC [ 4 ~`, `ESC [ 8 ~` |
| PageUp | `ESC [ 5 ~` |
| PageDown | `ESC [ 6 ~` |
| Shift+Tab | `ESC [ Z` |
| Delete | `ESC [ 3 ~` |
| Enter | CR or LF |
| Ctrl+C | ETX |
| Escape | standalone ESC after timeout |
## 4.4 Global keyboard matrix
| Key | Global behavior |
|---|---|
| `Ctrl+C` | Throw `WizardCancelledError`; restore terminal; no mutation. |
| `Escape` | Close modal; otherwise navigate back; at root request exit. |
| `?` | Toggle context help overlay. |
| `Ctrl+L` | Force complete redraw. |
| `Tab` | Move focus to next focusable pane/widget. |
| `Shift+Tab` | Move focus to previous focusable pane/widget. |
| `q` | Quit read-only viewer/dashboard; confirmation if a pending edit exists. |
| `:` | Open command palette while in a dashboard. |
| `/` | Enter explicit search mode. |
| `F1` | Help, where terminal supports function-key decoding. |
### 4.4.1 List/navigation matrix
| Key | List/table behavior |
|---|---|
| Up/Down | Move one selectable row. |
| Left/Right | Change column, tab, or sibling pane according to focus context. |
| PageUp/PageDown | Move viewport by `max(1, viewportRows - 2)`. |
| Home/End | First/last filtered item. |
| Space | Toggle highlighted item in multi-select. |
| Enter | Activate/confirm highlighted item. |
| Printable text | Append to filter buffer when list supports filter-as-you-type. |
| Backspace | Remove last filter character. |
| `Ctrl+U` | Clear filter. |
| `a` | Select all visible eligible rows in multi-select mode. |
| `n` | Clear visible selections in multi-select mode. |
Key bindings MUST be context-discoverable in the sticky footer. A printable shortcut such as `r` MUST not trigger while focus is in a text/filter input unless combined with Alt or the input is exited.
## 4.5 Focus model
```ts
export interface FocusTarget {
  id: string;
  kind: "list" | "table" | "tabs" | "text-input" | "button-row" | "viewer";
  disabled: boolean;
  order: number;
}
export interface FocusState {
  activeId: string;
  history: string[];
  modalStack: string[];
}
```
Rules:
1. A modal traps focus.
2. Hidden/disabled controls are excluded.
3. Resize preserves focus by stable ID.
4. If the focused control disappears after filtering, focus moves to the nearest surviving row.
5. Tab order is deterministic and declared by layout, not DOM-like geometry inference.
## 4.6 Virtual screen renderer
### 4.6.1 Render pipeline
```text
Application state
  -> responsive layout tree
  -> logical lines/cells
  -> sanitize controls
  -> width calculation and clipping
  -> style capability reduction
  -> frame diff against previous frame
  -> minimal ANSI writes
```
### 4.6.2 Frame rules
- The model contains no ANSI.
- Every logical line is clipped to terminal width.
- Newlines, carriage returns, tabs, C0/C1 controls, OSC, CSI, and device-control sequences from external data are replaced or escaped.
- Rendering MUST not scroll the alternate screen.
- Full redraw occurs on initial render, SIGWINCH, capability change, or detected desynchronization.
- Otherwise only changed rows are rewritten.
- The renderer MUST restore cursor position/visibility after each frame.
### 4.6.3 Width calculation
Without a dependency, use a documented conservative width function:
- combining marks: width 0;
- control characters: escaped before width calculation;
- common East Asian Wide/Fullwidth ranges: width 2;
- emoji presentation ranges: width 2 where known;
- all other Unicode scalar values: width 1.
When uncertain, clip early rather than allow wrapping. A `--ascii` option avoids ambiguous glyph width.
## 4.7 SIGWINCH resize handling
The terminal session installs one `SIGWINCH` listener.
The listener MUST only:
1. read new `columns`/`rows` safely;
2. update a pending size value;
3. schedule one redraw on the next microtask/timer tick.
It MUST NOT render synchronously inside the signal handler.
Resize reducer:
```ts
export function reduceResize(
  state: ApplicationState,
  size: { columns: number; rows: number },
): ApplicationState;
```
Resize behavior:
- preserve selected task/file/hunk by stable ID;
- recompute page size;
- clamp viewport offset;
- collapse split panes below breakpoints;
- show a minimum-size message below 40×10;
- never throw because rows/columns are undefined or zero;
- trigger full frame redraw.
## 4.8 Responsive layouts
### 4.8.1 Breakpoints
| Width | Layout |
|---:|---|
| `< 60` | Single pane; compact columns; inspector opened as separate screen. |
| `60–99` | Single main pane plus tabbed details. |
| `100–139` | 55/45 split pane. |
| `>= 140` | 50/50 split with extended metadata columns. |
Height rules:
```text
header rows: 2–4
footer rows: 2
body rows: terminal rows - header - footer
minimum list viewport: 4
```
### 4.8.2 Sticky header and footer
Header remains fixed and includes title, repository, mode, filter, and health badge. Footer remains fixed and includes contextual keys. Only body viewport scrolls.
## 4.9 Multi-column paginated list
```ts
export interface ListColumn<T> {
  id: string;
  title: string;
  minimumWidth: number;
  preferredWidth: number;
  priority: number;
  align: "left" | "right";
  render(item: T): string;
}
export interface ListState {
  selectedId?: string;
  selectedIds: string[];
  offset: number;
  pageSize: number;
  filter: string;
  sort: { column: string; direction: "asc" | "desc" };
  filterMode: "implicit" | "explicit" | "off";
}
```
Columns are removed by lowest priority when width shrinks. Identity/title/status columns are never removed.
### 4.9.1 Scroll indicators
```text
↑ 3 more items above
...
↓ 12 more items below
```
Indicators consume viewport rows and update after filtering, sorting, or resize.
### 4.9.2 Filter-as-you-type
Two supported policies:
- **Implicit filter:** printable characters immediately append while list focus is active and no conflicting shortcut exists.
- **Explicit search:** `/` opens a search field; all printable characters go there until Enter/Escape.
Queue and command palette use implicit filtering. Diff/log viewers use explicit search to preserve navigation shortcuts.
Filtering MUST be deterministic, case-insensitive by default, and use token/subsequence matching without regex execution. A query beginning with `re:` MAY enable regex only after bounded compilation and with a user-visible regex mode indicator; regex mode is OPTIONAL.
## 4.10 TUI wireframe — long list
```text
┌ agentctl · Presets ─────────────────────────── acme/platform · 120×32 ┐
│ Filter: secur_                                      4 of 63 matches   │
├────┬─────────────────────────────┬───────────┬──────────┬──────────────┤
│    │ Preset                      │ Version   │ Enabled  │ Risk         │
├────┼─────────────────────────────┼───────────┼──────────┼──────────────┤
│  ❯ │ nightly-security-audit      │ 1.2.0     │ yes      │ R2           │
│    │ api-security-hardening      │ 2.0.1     │ no       │ R2           │
│    │ dependency-security-scan    │ 1.0.0     │ yes      │ R3           │
│    │ secret-rotation-advisory    │ 1.1.3     │ no       │ R3           │
│    │                             │           │          │              │
│    │                             │           │          │              │
├────┴─────────────────────────────┴───────────┴──────────┴──────────────┤
│ ↑/↓ move  PgUp/PgDn page  Space toggle  Enter inspect  Ctrl+U clear  │
└────────────────────────────────────────────────────────────────────────┘
```
## 4.11 Diff viewer
### 4.11.1 Parsing model
The viewer parses unified diff into:
```ts
export interface DiffDocument {
  files: DiffFile[];
  truncated: boolean;
  totalBytes: number;
}
export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}
export interface DiffLine {
  kind: "context" | "add" | "delete" | "header" | "no-newline";
  oldLine?: number;
  newLine?: number;
  text: string;
}
```
It is a renderer, not an AST parser. It MUST treat content as untrusted text and strip terminal controls.
### 4.11.2 Colors
| Line | Style |
|---|---|
| `diff --git`, file header | bold cyan |
| `@@ ... @@` | cyan |
| added `+` | green |
| deleted `-` | red |
| context | default |
| warnings/truncation | yellow |
| binary | dim yellow |
Color is supplementary; signs and labels preserve meaning without color.
### 4.11.3 Diff keys
| Key | Action |
|---|---|
| Up/Down | Scroll line |
| PgUp/PgDn | Scroll page |
| Home/End | Start/end current file |
| `[` / `]` | Previous/next file |
| `n` / `N` | Next/previous hunk |
| `/` | Search text |
| `w` | Toggle wrap/truncate |
| `l` | Toggle line numbers |
| `p` | Export sanitized plain diff to stdout/file after leaving alternate screen |
| `q` / Esc | Return to inspector |
### 4.11.4 Diff wireframe
```text
┌ Diff · TASK-204 · 3 files · +84 −21 ──────────────────────────── 132×35 ┐
│ [1/3] src/provider.mjs      modified      +31 −8     Hunk 2/4           │
├───────┬───────┬──────────────────────────────────────────────────────────┤
│ old   │ new   │ @@ -118,7 +121,15 @@ async dispatch(task, ctx)          │
│ 121   │ 121   │   const source = resolveSource(task, config);           │
│ 122   │       │ - const retries = 1;                                    │
│       │ 122   │ + const retries = config.retryAttempts ?? 3;            │
│       │ 123   │ + if (retries < 1 || retries > 5) {                     │
│       │ 124   │ +   throw new ConfigError("retryAttempts out of range");│
│       │ 125   │ + }                                                     │
│ 123   │ 126   │   return send(request);                                 │
├───────┴───────┴──────────────────────────────────────────────────────────┤
│ [/] search  [/] file  n/N hunk  PgUp/PgDn  w wrap  p export  q back    │
└──────────────────────────────────────────────────────────────────────────┘
```
## 4.12 Log viewer
### 4.12.1 Model
```ts
export interface LogDocument {
  lines: LogLine[];
  source: string;
  truncatedBefore: number;
  truncatedAfter: number;
  followable: boolean;
}
export interface LogLine {
  number: number;
  timestamp?: string;
  stream?: "stdout" | "stderr" | "system";
  level?: "debug" | "info" | "warn" | "error";
  text: string;
}
```
The default cap is 200 visible retained lines per task view. Full logs remain in bounded state files according to retention policy. The UI does not load unbounded files into memory.
### 4.12.2 Log keys
| Key | Action |
|---|---|
| Up/Down | One line |
| PgUp/PgDn | One page |
| Home/End | First/last retained line |
| `f` | Toggle follow mode |
| `/` | Search |
| `n` / `N` | Next/previous match |
| `e` | Errors only |
| `a` | All levels |
| `w` | Wrap/truncate |
| `c` | Copy/export sanitized current line or selection |
| `q` / Esc | Back |
### 4.12.3 Failure log wireframe
```text
┌ Failure Log · Attempt 2/3 · npm test ───────────────────────────── 118×28 ┐
│ Filter: error  Follow: off  Showing 87–106 of 200  14 matches             │
├──────┬────────┬────────────────────────────────────────────────────────────┤
│   87 │ stderr │ AssertionError: expected status 200, received 500          │
│   88 │ stderr │   at test/webhook.test.mjs:184:14                          │
│   89 │ stdout │ # Subtest: retries transient webhook failure               │
│   90 │ stdout │ not ok 3 - retries transient webhook failure               │
│   91 │ stderr │ Error fingerprint: 5c12b83a90d4e712                        │
│      │        │                                                            │
├──────┴────────┴────────────────────────────────────────────────────────────┤
│ ↑/↓ scroll  PgUp/PgDn  / search  e errors  f follow  w wrap  q back       │
└────────────────────────────────────────────────────────────────────────────┘
```
## 4.13 Input and secret fields
### 4.13.1 Input state
```ts
export interface InputState {
  value: string;
  cursor: number;
  selection?: { start: number; end: number };
  error?: string;
  valid: boolean;
  touched: boolean;
  visible: boolean;
}
```
### 4.13.2 Real-time validation
Validators MAY be synchronous or asynchronous. Async validation MUST be debounced and cancellable. The UI displays:
```text
API source: sources/github/acme/platform
            ✓ Source exists and main branch is available
```
or:
```text
Verification command: npm test
                      ✗ Probe failed (exit 1); press Enter for diagnostics
```
Validation MUST NOT perform file writes.
### 4.13.3 Secret masking
Secrets display `•` or `*` according to Unicode capability. Visibility toggle:
- `F2` or `Ctrl+V`: reveal while held/toggled;
- status footer clearly says `SECRET VISIBLE` in red/yellow;
- switching focus hides again;
- screenshot/export/plain rendering always masks;
- the value is never included in telemetry, action plan, command history, or error details;
- validators receive the value but return redacted findings only.
### 4.13.4 Secret wireframe
```text
Jules API key: ••••••••••••••••••••••••
               ✓ Key accepted; account has 3 connected Sources
               F2 reveal temporarily · value will not be saved
```
## 4.14 Public function signatures
```ts
export class WizardCancelledError extends Error {
  code: 130;
  reason: "escape" | "ctrl-c" | "quit" | "stream-closed";
}
export interface TerminalSessionOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
  jsonMode?: boolean;
  alternateScreen?: boolean;
  color?: "auto" | "always" | "never";
  unicode?: "auto" | "always" | "never";
  reducedMotion?: boolean;
}
export declare function detectTerminalCapabilities(
  options?: TerminalSessionOptions,
): TerminalCapabilities;
export declare function createTerminalSession(
  options?: TerminalSessionOptions,
): TerminalSession;
export interface TerminalSession {
  capabilities: TerminalCapabilities;
  enter(): Promise<void>;
  render(frame: RenderFrame): Promise<void>;
  suspend<T>(operation: () => Promise<T>): Promise<T>;
  restore(): Promise<void>;
  close(): Promise<void>;
}
export declare function createKeyDecoder(options?: {
  escapeTimeoutMs?: number;
  maxBufferBytes?: number;
}): {
  push(chunk: Buffer | string, nowMs?: number): KeyEvent[];
  flush(nowMs?: number): KeyEvent[];
};
export declare function parseUnifiedDiff(text: string, options?: {
  maxBytes?: number;
  maxFiles?: number;
  maxLines?: number;
}): DiffDocument;
export declare function renderDiffView(
  document: DiffDocument,
  state: Record<string, unknown>,
  capabilities: TerminalCapabilities,
): RenderFrame;
export declare function renderLogView(
  document: LogDocument,
  state: Record<string, unknown>,
  capabilities: TerminalCapabilities,
): RenderFrame;
```
---
# 5. Module B — Guided diagnostics and auto-remediation
## 5.1 Commands
```text
agentctl doctor
agentctl doctor --json
agentctl doctor --interactive
agentctl doctor --probe
agentctl doctor --fix safe
agentctl doctor --fix config,locks --interactive
agentctl doctor --fix config,locks --yes --json
agentctl doctor --receipt <path>
```
Semantics:
- `doctor`: passive one-shot human summary; no writes; no expensive probes by default.
- `doctor --json`: one deterministic JSON result; no ANSI.
- `doctor --interactive`: full-screen matrix and guided fixes.
- `doctor --probe`: permits bounded active verification/API probes.
- `doctor --fix`: creates fix plans; interactive confirmation when TTY unless `--yes`; headless requires explicit fix IDs and `--yes`.
`--fix` MUST NOT mean “apply every possible fix.”
## 5.2 Diagnostic result schema
```ts
export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip" | "unknown";
export type DiagnosticSeverity = "info" | "low" | "medium" | "high" | "critical";
export interface DiagnosticEvidence {
  label: string;
  value: string | number | boolean;
  sensitive: boolean;
}
export interface FixDescriptor {
  id: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  automatic: boolean;
  requiresProbe: boolean;
}
export interface DiagnosticResult {
  schema: "agentctl/diagnostic-result-v1";
  id: string;
  category: string;
  title: string;
  status: DiagnosticStatus;
  severity: DiagnosticSeverity;
  summary: string;
  durationMs: number;
  passive: boolean;
  evidence: DiagnosticEvidence[];
  fixes: FixDescriptor[];
  error?: { code: string; message: string };
}
export interface DoctorReport {
  schema: "agentctl/doctor-report-v1";
  repository: string;
  headSha?: string;
  generatedAt: string;
  activeProbe: boolean;
  summary: Record<DiagnosticStatus, number>;
  results: DiagnosticResult[];
  reportHash: string;
}
```
## 5.3 Diagnostic matrix
| ID | Category | Passive check | Active probe | Typical fix |
|---|---|---|---|---|
| `runtime.node` | System | Node version satisfies engine | none | explain supported version; never self-install Node |
| `runtime.git` | System | Git executable/version | `git status` timeout | none or PATH guidance |
| `runtime.disk` | System | state/worktree free-space estimate via `statfsSync` | optional worktree size scan | prune safe caches; never delete live worktree |
| `repo.root` | Repository | root and remote | resolve base SHA | configure root/base |
| `repo.dirty` | Repository | staged/unstaged/untracked summary | secret scan selected mode | show files; no auto discard |
| `config.present` | Config | files exist | parse/validate | create missing config plan |
| `config.schema` | Config | schema supported | migration preview | migrate with backup |
| `config.drift` | Config | sync manifest hashes | three-way merge | managed update plan |
| `oracle.detected` | Verification | stack candidates/evidence | tool metadata probes | select/customize oracle |
| `oracle.test` | Verification | command configured | execute bounded test probe | switch command after preview |
| `oracle.build` | Verification | command configured | bounded build/list probe | update command |
| `gate.rules` | Safety | trusted base rules load | test known fixture in temp repo | regenerate managed projection |
| `gate.working-tree` | Safety | current gate result | full gate | inspect violations; no blind bypass |
| `secret.detectors` | Safety | detector version/signature | self-test synthetic fixtures | update managed detector metadata |
| `secret.working-tree` | Safety | known pattern scan | selected gate mode | show redacted location; no auto deletion |
| `state.ledger` | State | hash-chain integrity | bounded full verify | quarantine corrupt file; never reset silently |
| `state.telemetry` | State | segment/head integrity | full day verify | rebuild head from valid tail with preview |
| `state.journal` | State | unfinished intents | PID/start-time check | reap dead owner only |
| `locks.active` | State | list owners/PIDs | liveness/start time | remove stale lock with proof |
| `worktrees.registry` | Isolation | Git worktree list vs state | disk/PID reconciliation | prune only orphaned worktrees |
| `queue.integrity` | Queue | task/state sidecar consistency | parse all envelopes | repair index/move malformed task to quarantine |
| `queue.stuck` | Queue | age/state deadline | provider session lookup | defer/retry/reconcile plan |
| `flaky.ledger` | Verification | readable/window size | verdict recompute | rotate/archive malformed entries |
| `provider.key` | Jules | env key present (hidden) | authenticated Sources GET | environment guidance only |
| `provider.source` | Jules | configured Source | Source/branch lookup | choose valid Source/branch |
| `provider.connectivity` | Jules | endpoint syntax | bounded API ping/list | retry/network guidance; no credential print |
| `webhook.config` | Integration | secret env/reference/allowlist | loopback health | patch config |
| `mcp.protocol` | Integration | configured server version | local initialize/discover test | compatibility guidance |
| `dashboard.bind` | Integration | loopback default | loopback health | patch unsafe host |
## 5.4 Diagnostic execution model
Checks form a DAG:
```text
runtime.node ─┐
runtime.git ──┼─► repo.root ─► config.present ─► config.schema ─► oracle.*
              │       │                 │                │
              │       ├─► state.*       ├─► gate.rules   └─► provider.*
              │       └─► queue.*       └─► presets
              └─► runtime.disk ─► worktrees.registry
```
A failed prerequisite produces `skip`, not a misleading failure cascade.
Passive checks MUST avoid:
- provider network calls;
- test/build execution;
- destructive cleanup;
- unbounded recursive scans.
Active probes require `--probe`, interactive approval, or a fix whose preconditions explicitly include the probe.
## 5.5 Doctor UI wireframe
```text
┌ agentctl doctor ─────────────────────────────── acme/platform · main ┐
│ Health: 18 pass · 3 warn · 2 fail      Probe: passive      [?] help │
├───────────────┬───────────────────────────────────────┬──────────────┤
│ Category      │ Check                                 │ Status       │
├───────────────┼───────────────────────────────────────┼──────────────┤
│ System        │ Node.js v22.22.3                      │ ✓ PASS       │
│ Repository    │ Working tree                          │ ! WARN 4     │
│ Config        │ agentctl/config-v3                    │ ✓ PASS       │
│ Verification  │ Test oracle: npm test                │ ✗ FAIL       │
│ Safety        │ Secret detectors                     │ ✓ PASS       │
│ State         │ VFS locks                            │ ! WARN 1     │
│ Jules         │ API connectivity                     │ ○ NOT PROBED │
│ Queue         │ Envelope/state consistency            │ ✓ PASS       │
├───────────────┴───────────────────────────────────────┴──────────────┤
│ Enter inspect  f fixes  p probe  / filter  r rerun  e export  q quit│
└──────────────────────────────────────────────────────────────────────┘
```
Inspector:
```text
┌ Verification · Test oracle ──────────────────────────────────────────┐
│ Status: FAIL · Severity: HIGH · 1.82s                                │
│                                                                      │
│ Command: npm test                                                    │
│ Exit: 1                                                              │
│ Evidence: package.json has script "test": "vitest"                  │
│ Candidate: npm test                                                  │
│ Alternative: npm exec --no -- vitest run                             │
│                                                                      │
│ Fixes                                                                │
│  ❯ Use repository script via npm test and inspect failure            │
│    Set custom command                                                 │
│    Mark workspace non-dispatchable                                    │
│    Open failure log                                                   │
└───────────────────────────────────────────────────────────────────────┘
```
The example in the request uses `npx vitest run`. The implementation SHOULD prefer a repository script or local binary and MUST NOT allow `npx` to download implicitly. If `node_modules/.bin/vitest` exists, the proposal may use `npm exec --no -- vitest run` or the package script.
## 5.6 Fix plan lifecycle
```text
DIAGNOSTIC_FAILED
      │ select fix
      ▼
FIX_PLANNING
      ├─ invalid/no longer applicable -> STALE
      ▼
FIX_PLANNED
      │ preview
      ▼
AWAITING_CONFIRMATION
      ├─ reject/cancel -> CANCELLED
      └─ confirm
           ▼
CHECK_PRECONDITIONS
      ├─ changed -> STALE, re-plan
      ▼
ACQUIRE_LOCKS
      ▼
JOURNAL_INTENT
      ▼
APPLY_TEMP/COMMAND_EFFECTS
      ├─ failure -> ROLLBACK -> FAILED
      ▼
VERIFY_FIX
      ├─ failure -> ROLLBACK or KEEP_WITH_FAILURE per plan
      ▼
JOURNAL_DONE
      ▼
RELEASE_LOCKS
      ▼
FIXED + RECEIPT
```
## 5.7 Fix classes
### Safe automatic fixes
May be selected by `--fix safe --yes` in headless mode:
- rebuild telemetry `.head` from a verified log tail;
- remove a proven stale lock owned by a dead/recycled PID;
- create missing managed directories;
- normalize generated manifest metadata when user content is unchanged;
- prune Git’s own stale worktree metadata, not worktree directories;
- rewrite a generated compatibility projection from canonical valid config.
### Review-required fixes
Require unified diff preview and keypress/typed confirmation:
- create or modify `.agent/config.yml`;
- change test/build/lint/typecheck command;
- migrate schema;
- update protected-path policy;
- move malformed task to quarantine;
- change Jules Source/base branch;
- modify schedule/preset registry.
### Never automatic
The doctor MUST NOT automatically:
- delete or rewrite source code;
- delete uncommitted files;
- remove a live worktree;
- revoke/rotate secrets;
- override a quarantined flaky test;
- weaken a test command;
- reset a user-owned config;
- force push/rebase;
- purge queue/history;
- enable external bind addresses;
- install dependencies/toolchains.
## 5.8 Exact preview requirement
Every file-changing fix displays:
```text
path
old hash
new hash
unified diff
risk
preconditions
rollback strategy
```
Wireframe:
```text
┌ Fix Preview · config.test-command ────────────────────────────────┐
│ Risk: MODERATE     Files: 1     Reversible: yes                  │
├───────────────────────────────────────────────────────────────────┤
│ --- a/.agent/config.yml                                           │
│ +++ b/.agent/config.yml                                           │
│ @@ verification.test @@                                          │
│ - executable: "npm"                                              │
│ - args: ["test"]                                                 │
│ + executable: "npm"                                              │
│ + args: ["exec", "--no", "--", "vitest", "run"]              │
├───────────────────────────────────────────────────────────────────┤
│ Preconditions                                                     │
│ ✓ config hash = sha256:4b1a…                                     │
│ ✓ local vitest binary exists                                     │
│ ! probe currently exits 1                                        │
│                                                                   │
│ [a] apply  [b] back  [v] full diff  [?] help                     │
└───────────────────────────────────────────────────────────────────┘
```
## 5.9 Doctor planner signatures
```ts
export interface DoctorOptions {
  root: string;
  activeProbe: boolean;
  selectedChecks?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface FixPlanningContext {
  root: string;
  report: DoctorReport;
  selectedFixIds: string[];
  answers: Record<string, unknown>;
}
export declare function runDoctorChecks(
  options: DoctorOptions,
): Promise<DoctorReport>;
export declare function planDiagnosticFixes(
  context: FixPlanningContext,
): Promise<ActionPlan[]>;
export declare function applyActionPlan(
  plan: ActionPlan,
  options: { root: string; signal?: AbortSignal },
): Promise<OperationReceipt>;
```
## 5.10 Doctor JSON output
```json
{
  "ok": false,
  "command": "doctor",
  "schema": "agentctl/doctor-report-v1",
  "summary": {
    "pass": 18,
    "warn": 3,
    "fail": 2,
    "skip": 1
  },
  "results": [
    {
      "id": "oracle.test",
      "status": "fail",
      "severity": "high",
      "summary": "Configured test command exited 1",
      "fixes": [
        {
          "id": "config.test-command",
          "risk": "moderate",
          "automatic": false
        }
      ]
    }
  ],
  "reportHash": "sha256:..."
}
```
Exit policy:
- 0: no fail/critical warn under configured policy;
- 1: one or more failed checks;
- 3/5/6/8: preserve gate-specific classification when the primary failing check is that gate condition;
- 64: incomplete headless fix input;
- 130: interactive cancellation.
---
# 6. Module C — Interactive queue and swarm manager
## 6.1 Canonical task lifecycle
### 6.1.1 States
```ts
export type TaskState =
  | "pending"
  | "dispatching"
  | "remote-queued"
  | "planning"
  | "awaiting-plan-approval"
  | "awaiting-user-feedback"
  | "running"
  | "output-ready"
  | "verifying"
  | "deferred"
  | "quarantined"
  | "failed"
  | "completed"
  | "cancelled";
```
### 6.1.2 Transition diagram
```text
                         ┌──────────────────────────────┐
                         │                              ▼
PENDING ─► DISPATCHING ─► REMOTE_QUEUED ─► PLANNING ─► AWAITING_PLAN_APPROVAL
   │           │                │             │                 │ approve
   │           │ transient      │             │                 ▼
   │           └──────────────► DEFERRED ◄─────┘              RUNNING
   │                              │ retry                       │
   │                              └──────────► DISPATCHING       ├─► AWAITING_USER_FEEDBACK
   │                                                           │        │ response
   │                                                           │        └─► RUNNING
   │                                                           ▼
   │                                                      OUTPUT_READY
   │                                                           │
   │                                                           ▼
   │                                                       VERIFYING
   │                                                       /    |    \
   │                                            deterministic   |     success
   │                                                failure     |        \
   │                                                   ▼        |         ▼
   │                                                FAILED      |      COMPLETED
   │                                                            |
   │                                                     flaky verdict
   │                                                            ▼
   ├──────────────────────────────────────────────────────► QUARANTINED
   │                                                            │ override + reason
   │                                                            └─► VERIFYING/RETRY
   │
   ├─ cancel ─► CANCELLED
   └─ malformed/security violation ─► QUARANTINED
```
Terminal states:
```text
completed, cancelled
```
`failed` is terminal for the attempt but retryable through an explicit new transition/event. History is never erased.
## 6.2 Task state sidecar schema
```json
{
  "schema": "agentctl/task-state-v1",
  "taskId": "TASK-204",
  "revision": 17,
  "state": "running",
  "taskFile": ".agent/jules-queue/TASK-204.md",
  "envelopeHash": "sha256:...",
  "baseSha": "...",
  "createdAt": "2026-08-10T09:00:00.000Z",
  "updatedAt": "2026-08-10T09:12:31.000Z",
  "attempt": 2,
  "maxAttempts": 3,
  "remote": {
    "provider": "jules",
    "sessionId": "3141592653",
    "state": "IN_PROGRESS",
    "url": "https://jules.google.com/session/3141592653"
  },
  "verification": {
    "command": "npm test",
    "lastExitCode": 1,
    "fingerprint": "5c12b83a90d4e712",
    "flakyVerdict": "REPAIRABLE_REGRESSION"
  },
  "slotId": "slot-02",
  "worktree": ".agent/worktrees/TASK-204-attempt-2",
  "pid": 18422,
  "processStartTime": "114972001",
  "lockIds": ["scope-services-api"],
  "lastEventHash": "sha256:..."
}
```
Writes use optimistic revision preconditions plus VFS mutex/atomic rename.
## 6.3 Queue snapshot
```ts
export interface QueueTaskSummary {
  id: string;
  title: string;
  state: TaskState;
  riskTier: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  source?: string;
  startingBranch?: string;
  autoPr: boolean;
  requirePlanApproval: boolean;
  verifyCmd?: string;
  slotId?: string;
  pid?: number;
  worktree?: string;
  errorSummary?: string;
  envelopeHash: string;
  stateRevision: number;
}
export interface QueueSnapshot {
  schema: "agentctl/queue-snapshot-v1";
  repository: string;
  generatedAt: string;
  revision: string;
  counts: Record<TaskState, number>;
  tasks: QueueTaskSummary[];
  warnings: string[];
}
```
## 6.4 Queue dashboard wireframe
```text
┌ agentctl queue ───────────────────────── acme/platform · main · LIVE ┐
│ Pending 8  Dispatching 1  Running 3  Quarantined 2  Failed 1  Done 42│
│ Filter: state:active retry_        Sort: updated desc      Health: ! │
├────┬────────────┬────────────────────────────┬───────────┬────────────┤
│    │ State      │ Task                       │ Attempt   │ Duration   │
├────┼────────────┼────────────────────────────┼───────────┼────────────┤
│ ❯  │ ● RUNNING  │ TASK-204 webhook retry     │ 2/3       │ 00:12:31   │
│    │ ◌ PENDING  │ TASK-211 doc sync          │ 0/2       │ —          │
│    │ ! QUARANT. │ TASK-199 flaky auth test   │ 1/3       │ 00:08:44   │
│    │ ✗ FAILED   │ TASK-187 schema migration  │ 3/3       │ 01:02:19   │
│    │ ✓ DONE     │ TASK-175 update examples   │ 1/3       │ 00:04:51   │
│    │            │                            │           │            │
├────┴────────────┴────────────────────────────┴───────────┴────────────┤
│ Enter inspect  r retry  q quarantine  / filter  : commands  ? help   │
└───────────────────────────────────────────────────────────────────────┘
```
Status indicators animate only when motion is enabled. In reduced-motion mode, static symbols update no faster than once per second.
## 6.5 Task inspector
### 6.5.1 Wide split-pane layout
```text
┌ TASK-204 · RUNNING · Attempt 2/3 ───────────────────────────────────────────┐
│ Source acme/platform  Branch main  Auto-PR yes  Plan approval no  Risk R1  │
├──────────────────────────────────┬──────────────────────────────────────────┤
│ Prompt / Envelope                │ Live Log                                 │
│                                  │                                          │
│ Add bounded retry handling to    │ 09:11:04 npm test                        │
│ webhook sender...                │ 09:11:09 not ok webhook retry            │
│                                  │ 09:11:09 AssertionError status 500       │
│ Write scope                      │ 09:11:11 OODA repair attempt 2/3         │
│ services/payments/**             │ 09:11:13 Jules session IN_PROGRESS       │
│                                  │                                          │
│ Verification                     │                                          │
│ npm test                         │                                          │
│ npm run typecheck                │                                          │
│                                  │                                          │
├──────────────────────────────────┴──────────────────────────────────────────┤
│ [R]etry [Q]uarantine override [E]dit [D]elete [V]Diff [L]ogs [O]pen URL    │
└─────────────────────────────────────────────────────────────────────────────┘
```
### 6.5.2 Narrow layout
Below 100 columns, prompt, envelope, logs, diff, and actions become tabs:
```text
[TASK] [ENVELOPE] [LOG] [DIFF] [ACTIONS]
```
Left/Right changes tabs. Focus is stable across resize.
## 6.6 Task inspector data
The inspector MUST show:
- immutable task ID/title;
- canonical state and state revision;
- risk tier;
- creation/update/duration;
- attempt/max attempts;
- Source, starting branch, auto-PR, plan approval, repoless;
- write/read/deny/protect scope;
- verification command references and last result;
- base SHA and envelope hash;
- remote session ID/URL/state;
- worktree/slot/PID/locks;
- latest failure fingerprint and flaky verdict;
- prompt with untrusted context visibly fenced;
- event timeline.
Secret-bearing fields are never shown.
## 6.7 Task actions
### 6.7.1 Retry
Allowed from:
```text
failed, deferred, quarantined (only after override plan), cancelled (new attempt)
```
Retry plan MUST:
- preserve prior attempt history;
- increment attempt;
- revalidate envelope/base/scope;
- honor max attempts unless elevated typed confirmation;
- respect provider `Retry-After`;
- not reuse a live slot or stale remote session blindly.
Shortcut: `r` opens a plan preview; it does not retry instantly.
### 6.7.2 Quarantine override
Requires:
- task ID typed confirmation;
- non-empty reason;
- reviewer/operator identity where available;
- retained flaky/security finding;
- a new event and receipt;
- optional one-attempt override, never permanent global suppression by default.
Shortcut: `q` opens override dialog.
### 6.7.3 Edit instructions
Allowed only for:
```text
pending, deferred, failed, quarantined
```
Not allowed in-place for dispatching/running/verification. Running task edits create a follow-up message plan or require cancellation/new revision.
Editing:
- opens `$EDITOR` only after leaving raw/alternate mode, if configured;
- otherwise uses a multiline native input screen;
- recalculates secret scan, prompt budget, envelope hash, risk, scope, criteria;
- creates a new task revision;
- shows diff before save.
### 6.7.4 Delete
- pending task: move atomically to `.agent/jules-queue/.trash/`, preserve tombstone/receipt;
- running task: delete disabled; offer cancel first;
- completed/failed: archive by default, purge only via destructive command;
- no immediate `unlinkSync` from a keypress.
### 6.7.5 View diff
Uses the native diff viewer. If no local worktree diff exists, inspect change-set artifact or PR diff only through a separately fetched, bounded, sanitized source.
## 6.8 Action menu wireframe
```text
┌ Actions · TASK-204 ────────────────────────────────────────────────┐
│  ❯ View git diff                          read-only                │
│    Open full failure log                  read-only                │
│    Retry task                             moderate · attempt 3/3   │
│    Edit instructions                      creates revision 4       │
│    Override quarantine                    high · reason required   │
│    Cancel remote session                  high                     │
│    Delete/archive task                    disabled while running    │
│                                                                    │
│ Enter plan  Esc back  ? explain risk                               │
└────────────────────────────────────────────────────────────────────┘
```
## 6.9 Live update architecture
Do not make the TUI the source of truth.
```text
fs.watch hint ─┐
telemetry tail ├─► debounce 100–250ms ─► rebuild bounded snapshot
500ms timer ───┘                         ├─ validate revisions
                                        └─ dispatch StateChanged
```
`fs.watch` is advisory and may coalesce/drop events. A periodic reconciliation rebuilds state. The default refresh interval is 500 ms for active dashboards and 2 s in reduced-motion/remote filesystems.
Telemetry/event tailing MUST:
- read only appended bytes from known offsets;
- detect rotation/date segment changes;
- cap per-read bytes;
- validate JSON and hash chain where required;
- handle torn final lines by retaining an incomplete buffer;
- never repeatedly read the entire log on every frame.
## 6.10 Queue event schema
```json
{
  "schema": "agentctl/task-event-v1",
  "eventId": "evt-...",
  "taskId": "TASK-204",
  "attempt": 2,
  "kind": "verification_failed",
  "fromState": "verifying",
  "toState": "failed",
  "timestamp": "2026-08-10T09:11:09.000Z",
  "summary": "npm test exited 1",
  "fingerprint": "5c12b83a90d4e712",
  "telemetryHash": "sha256:..."
}
```
## 6.11 Swarm slot model
```ts
export type SlotState =
  | "idle" | "reserved" | "preparing" | "running"
  | "verifying" | "draining" | "failed" | "stale";
export interface SwarmSlot {
  id: string;
  state: SlotState;
  taskId?: string;
  attempt?: number;
  worktree?: string;
  branch?: string;
  pid?: number;
  processStartTime?: string;
  startedAt?: string;
  durationMs?: number;
  lockIds: string[];
  writeScope: string[];
  cpuPercent?: number;
  rssBytes?: number;
  resourceSupport: "full" | "partial" | "unavailable";
  lastHeartbeat?: string;
  warning?: string;
}
```
Resource metrics are best effort:
- Linux MAY read bounded `/proc/<pid>/stat` and `/proc/<pid>/status` after PID start-time verification;
- macOS/Windows MAY expose unavailable unless an approved native command adapter is configured;
- never fabricate zero usage;
- label unavailable metrics explicitly.
## 6.12 Swarm dashboard wireframe
```text
┌ agentctl swarm ───────── acme/platform · 4/6 slots · Scheduler RUNNING ┐
│ Queue 8  Active 4  Locks 7  CPU 184%*  RSS 2.1 GB*   *partial metrics │
├────────┬────────────┬─────────────────────┬─────────┬─────────┬────────┤
│ Slot   │ State      │ Task                │ PID     │ Duration│ Locks  │
├────────┼────────────┼─────────────────────┼─────────┼─────────┼────────┤
│ 01     │ ● RUNNING  │ TASK-204 webhook    │ 18422   │ 12:31   │ 2      │
│ 02     │ ● VERIFY   │ TASK-205 auth tests │ 18476   │ 09:44   │ 1      │
│ 03     │ ! STALE    │ TASK-198 docs       │ 17302   │ 44:17   │ 1      │
│ 04     │ ● RUNNING  │ TASK-209 Rust lint  │ 18511   │ 03:08   │ 3      │
│ 05     │ ○ IDLE     │ —                   │ —       │ —       │ 0      │
│ 06     │ ○ IDLE     │ —                   │ —       │ —       │ 0      │
├────────┴────────────┴─────────────────────┴─────────┴─────────┴────────┤
│ Enter inspect  p pause scheduler  c cancel  k locks  w worktree  q quit│
└────────────────────────────────────────────────────────────────────────┘
```
## 6.13 Swarm controls
- `p`: plan scheduler pause/resume; running tasks continue unless separately cancelled.
- `c`: cancel selected task with confirmation; provider/local process cancellation are separate effects.
- `k`: inspect locks and ownership scopes.
- `w`: show worktree details; never `cd` the parent process. Offer copy path or spawn user shell only with explicit action.
- `x`: plan stale slot cleanup after PID/start-time/worktree/lock reconciliation.
- `+`/`-`: propose concurrency change within profile/provider policy; not immediate.
- `d`: open task diff.
- `l`: open logs.
## 6.14 Queue/swarm function signatures
```ts
export declare function buildQueueSnapshot(
  root: string,
  options?: { includeCompleted?: boolean; limit?: number },
): Promise<QueueSnapshot>;
export declare function buildSwarmSnapshot(
  root: string,
  options?: { sampleResources?: boolean },
): Promise<{ slots: SwarmSlot[]; warnings: string[]; revision: string }>;
export declare function reduceQueueEvent(
  state: Record<string, unknown>,
  event: KeyEvent | { type: string; payload?: unknown },
): Record<string, unknown>;
export declare function planTaskAction(
  snapshot: QueueSnapshot,
  intent: { kind: string; taskId: string; answers?: Record<string, unknown> },
): Promise<ActionPlan>;
export declare function planSwarmAction(
  snapshot: { slots: SwarmSlot[]; revision: string },
  intent: { kind: string; slotId?: string; taskId?: string; answers?: Record<string, unknown> },
): Promise<ActionPlan>;
```
---
# 7. Module D — Open architecture and UX decisions
## 7.1 Strategic question 1 — bare `agentctl` behavior
### Decision
#### Bare command in an interactive TTY
```bash
agentctl
```
MUST open the command palette/home screen in alternate-screen mode. It performs no mutation until a command is selected, planned, previewed, and confirmed.
#### Bare command in non-TTY/headless mode
It MUST NOT open a TUI or wait for input. Behavior:
- without `--json`: print concise help to stdout and exit 0;
- with `--json`: emit `{ "ok": true, "kind": "help", "commands": [...] }` and exit 0;
- with stdin containing JSON but no command: reject with exit 64 rather than guessing a command.
#### Subcommands
- read-only commands (`status`, `doctor`, `queue`, `swarm`) default to one-shot text/JSON output even on a TTY; `--interactive` opts into full-screen mode;
- intrinsically authoring commands (`task create`) MAY enter interactive mode automatically only when required flags are absent and both input/output are TTYs;
- mutating operational commands never become interactive merely because a TTY exists unless the command contract says so;
- `--no-interactive` always wins;
- `--json` implies no interactive prompts unless `--interactive --json` is explicitly supported with TUI on stderr and final JSON on stdout;
- headless missing inputs fail with exit 64 and a structured list.
This avoids scripts changing behavior when attached to a pseudo-TTY.
## 7.2 Strategic question 2 — command palette
### Decision: yes
A native command palette is RECOMMENDED for discoverability and speed.
### 7.2.1 Registry-driven architecture
One `COMMAND_REGISTRY` drives:
- `--help`;
- bare palette;
- completion metadata;
- risk labels;
- examples;
- required capabilities;
- headless flags;
- docs generation.
```ts
export interface CommandDescriptor {
  id: string;
  path: string[];
  title: string;
  description: string;
  category: "Create" | "Inspect" | "Operate" | "Repair" | "Configure";
  mutates: boolean;
  risk: RiskLevel;
  interactive: "never" | "optional" | "authoring-auto";
  requiresRepository: boolean;
  shortcuts: string[];
  examples: string[];
}
```
### 7.2.2 Palette wireframe
```text
┌ agentctl ─ Command Palette ───────────────────── acme/platform · HEALTH ! ┐
│ > doc_                                                                  │
├────────────┬─────────────────────────────────────────────────────────────┤
│ Inspect    │ doctor             Run repository diagnostics              │
│ Operate    │ queue --interactive Browse and manage task queue           │
│ Operate    │ swarm --interactive Inspect active worker slots            │
│ Create     │ task create        Author a scoped, falsifiable task        │
│ Configure  │ init --interactive Configure Stack Oracle and Jules         │
│ Inspect    │ dashboard          Start local web dashboard                │
├────────────┴─────────────────────────────────────────────────────────────┤
│ ↑/↓ move  Enter open  Tab category  / clear  ? details  Esc quit        │
└──────────────────────────────────────────────────────────────────────────┘
```
### 7.2.3 Palette behavior
- implicit subsequence search over command path/title/description/tags;
- categories and risk badges;
- disabled commands show missing capability reason;
- selecting a command opens its argument form, not an interpolated shell command;
- recent command IDs MAY be stored, never arguments or secrets;
- `!` shell escape is forbidden;
- planned CLI invocation is previewed in safely quoted form;
- user may press `c` to copy/print command without executing;
- mutating commands proceed through normal plan/confirmation flow.
## 7.3 Strategic question 3 — diff and error inspection
### Decision
Use alternate-screen, bounded, model-based viewers. Do not print 200 lines into scrollback by default.
#### Diff strategy
- file list/tab plus current file viewport;
- hunk navigation;
- line numbers optional;
- color + signs;
- binary/truncated notices;
- search;
- responsive split/tab layout;
- export plain diff on demand after leaving alternate screen.
#### Error strategy
- retain last 200 normalized lines in viewer model;
- start viewport around first/last error and failure fingerprint;
- errors-only filter;
- follow mode for live tasks;
- line numbers and source stream;
- search matches;
- full log path displayed, but full content loaded only in bounded chunks;
- never render raw ANSI from test logs.
#### Scrollback strategy
On viewer exit, print one concise receipt only if requested:
```text
Viewed TASK-204 failure: npm test exit 1, fingerprint 5c12b83a90d4e712
```
No full-screen content remains in scrollback.
## 7.4 Strategic question 4 — confirmation gates
### 7.4.1 Confirmation matrix
| Action | Risk | Required confirmation |
|---|---|---|
| Open viewer, rerun passive diagnostics | low | none |
| Apply safe generated head repair | low | simple keypress unless headless `--yes` |
| Retry failed task within attempt budget | moderate | simple keypress after plan preview |
| Edit pending task | moderate | simple keypress after diff preview |
| Change verification command/config | moderate/high | keypress plus exact diff preview |
| Cancel running task/session | high | type task ID |
| Override quarantine | high | type task ID + non-empty reason |
| Delete pending task to trash | moderate | type task ID when task has remote history; otherwise keypress |
| Permanently purge task/history | destructive | type `PURGE <repo-name>` |
| Reset `.agent/config.yml` | destructive | type repository `owner/name` |
| Force-remove worktree | destructive | type worktree basename + repository name |
| Remove lock with live/unknown PID | destructive | forbidden automatically; dedicated force command + typed repo/task |
| Reduce protected paths/disable secret gate | destructive | type repository name + reason; security receipt |
| Force attempt beyond max retries | high | type task ID + reason |
| Enable non-loopback dashboard/webhook | high | type bind host and acknowledge exposure |
| Auto-merge/force push | destructive | outside default wizard; explicit PR/branch typed confirmation |
### 7.4.2 Typed confirmation rules
- case-sensitive where shown;
- no paste prevention; pasted text is still explicit input;
- value never defaults;
- failure returns to preview, not action execution;
- headless requires exact `--confirm <token>` or signed policy input;
- reason is stored in receipt after secret/PII scrub;
- confirmation token is derived from current plan and expires if preconditions change.
## 7.5 Strategic question 5 — telemetry and web dashboard
### Decision
The TUI and HTTP dashboard consume the same snapshot/read-model services. The TUI MUST NOT scrape HTTP, and the HTTP dashboard MUST NOT parse TUI output.
```text
telemetry segments + queue sidecars + locks + worktrees
                         │
                         ▼
                 Snapshot Builder API
                    /             \
                   ▼               ▼
              Native TUI      HTTP Dashboard
```
### 7.5.1 Telemetry compatibility
The current implementation stores date/segment files such as:
```text
.agent/state/telemetry-YYYY-MM-DD.jsonl
.agent/state/telemetry-YYYY-MM-DD-N.jsonl
.agent/state/telemetry-YYYY-MM-DD.head
```
The UX reader MUST support this actual segmented format. A singular `.agent/state/telemetry.jsonl` MAY be accepted as a legacy alias but is not assumed.
### 7.5.2 TUI/dashboard actions
Queue/swarm TUI footer MAY offer:
```text
[w] web dashboard
```
Behavior:
1. inspect whether dashboard is already listening on configured loopback port;
2. if not, create a start-dashboard `ActionPlan`;
3. preview bind host/port;
4. start only on `127.0.0.1` by default;
5. print/copy URL;
6. do not automatically open a browser unless user explicitly enables `--open` and a platform adapter is configured.
### 7.5.3 Privacy
- dashboard and TUI share redacted view models;
- raw prompts/logs are not exposed through summary endpoints by default;
- lock payloads redact host/user data according to policy;
- telemetry event schemas classify fields as public/operator-sensitive/secret-forbidden;
- web dashboard external bind requires high-risk confirmation and authentication design outside this release.
## 7.6 Additional UX innovations
### 7.6.1 Safety mode banner
Every full-screen surface shows:
```text
SAFE MODE: ON
```
when destructive actions are unavailable. A temporary elevated mode is scoped to one confirmed plan, not a global toggle.
### 7.6.2 Operational receipts and undo
Every mutation produces a receipt:
```ts
export interface OperationReceipt {
  schema: "agentctl/operation-receipt-v1";
  id: string;
  planId: string;
  planHash: string;
  command: string;
  operator?: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  risk: RiskLevel;
  files: Array<{ path: string; oldHash?: string; newHash?: string }>;
  commands: Array<{ executable: string; exitCode: number; durationMs: number }>;
  stateTransitions: Array<{ taskId?: string; from: string; to: string }>;
  rollback?: { available: boolean; receiptId?: string };
}
```
The TUI exposes `u` only when a safe rollback plan can be generated and preconditions still match.
### 7.6.3 Diagnostic receipts in PRs
A task/PR may include a compact verification receipt generated from doctor/gate results, not raw full logs:
```text
agentctl receipt: test PASS, lint PASS, scope PASS, secrets PASS
report hash: sha256:...
```
### 7.6.4 Session resume
If a TUI crashes, it does not persist raw screen state. It MAY persist non-sensitive preferences:
```text
last view
filter expression
sort order
selected task ID
```
On restart, state is validated against current snapshot. No prompt text, secret, typed confirmation, or modal input is persisted.
### 7.6.5 Bookmarks and saved filters
Operators MAY save filters such as:
```text
state:failed workspace:api
state:active risk:R2|R3
owner:me updated:<1h
```
Filters are parsed by a bounded deterministic grammar, not `eval` or arbitrary regex.
### 7.6.6 Accessibility
Support:
- `NO_COLOR`;
- `--ascii`;
- `--reduced-motion`;
- no color-only meaning;
- stable text labels for icons;
- plain one-shot alternatives for every TUI;
- configurable key hints;
- terminal minimum-size fallback.
### 7.6.7 Offline mode
When provider connectivity is unavailable, TUI still supports:
- queue inspection;
- task authoring drafts;
- local gate/diff/log views;
- doctor passive checks;
- retry plans marked deferred.
It never pretends a remote action succeeded.
---
# 8. Configuration schema additions
The bounded YAML parser remains zero-dependency. Unknown keys are preserved according to migration policy.
```yaml
ux:
  bare_command: "palette"
  color: "auto"
  unicode: "auto"
  alternate_screen: true
  reduced_motion: false
  refresh_ms: 500
  refresh_reduced_motion_ms: 2000
  escape_timeout_ms: 30
  minimum_columns: 40
  minimum_rows: 10
  log_view_lines: 200
  diff_max_bytes: 10485760
  diff_max_files: 500
  filter_mode: "implicit"
  remember_view: true
headless:
  missing_input: "fail"
  require_yes_for_mutation: true
  json_stdout_only: true
  diagnostics_stream: "stderr"
doctor:
  passive_timeout_ms: 5000
  active_probe_timeout_ms: 120000
  safe_fix_ids: ["telemetry-head-rebuild", "dead-lock-reap", "managed-projection-sync"]
  disk_warning_mb: 2048
  disk_critical_mb: 512
  stale_lock_ms: 7200000
  stale_task_ms: 3600000
queue_ui:
  include_completed_default: false
  completed_limit: 100
  default_sort: "updated-desc"
  default_filter: ""
  live_refresh: true
  trash_retention_days: 7
swarm_ui:
  resource_sampling: true
  heartbeat_stale_ms: 30000
  show_worktree_paths: true
  allow_concurrency_plan: true
confirmations:
  cancel_running: "typed-task-id"
  quarantine_override: "typed-task-id-and-reason"
  purge_queue: "typed-repository"
  reset_config: "typed-repository"
  force_worktree_clean: "typed-repository-and-worktree"
telemetry_ui:
  read_segmented_daily_files: true
  verify_hash_chain_on_open: false
  verify_hash_chain_on_doctor_probe: true
  redact_operator_sensitive_fields: true
```
---
# 9. Error and cancellation contract
## 9.1 Error classes
```ts
export class WizardCancelledError extends Error {
  name: "WizardCancelledError";
  code: 130;
  reason: "escape" | "ctrl-c" | "quit" | "stream-closed";
}
export class HeadlessInputRequiredError extends Error {
  name: "HeadlessInputRequiredError";
  code: 64;
  missing: string[];
}
export class TerminalUnavailableError extends Error {
  name: "TerminalUnavailableError";
  code: 66;
}
export class StalePlanError extends Error {
  name: "StalePlanError";
  code: 65;
  failedPreconditions: PlanPrecondition[];
}
export class ConfirmationRequiredError extends Error {
  name: "ConfirmationRequiredError";
  code: 64;
  confirmation: ConfirmationPolicy;
}
```
## 9.2 Cancellation behavior
Ctrl+C and Escape do not share all semantics:
- Escape closes the nearest modal/view and may ultimately cancel at root;
- Ctrl+C cancels the entire interactive command immediately after cleanup;
- neither invokes a mutation;
- an in-progress transactional effect receives an `AbortSignal`, but atomic critical sections complete or rollback before returning cancellation;
- terminal restoration runs before CLI sets exit code 130;
- JSON mode emits one cancellation payload when possible.
## 9.3 JSON cancellation
```json
{
  "ok": false,
  "command": "queue --interactive",
  "code": 130,
  "error": "WIZARD_CANCELLED",
  "message": "Operation cancelled by user",
  "cancelled": true
}
```
## 9.4 Signal cleanup
The terminal session installs and removes only its own listeners for:
```text
SIGWINCH
SIGINT
SIGTERM
SIGTSTP/SIGCONT where supported
```
It does not remove application listeners. Cleanup is idempotent. Signal handlers set intent/abort state; they do not perform complex rendering or file mutation directly.
---
# 10. Transaction and concurrency model
## 10.1 Apply algorithm
```text
1. Verify plan schema/hash.
2. Verify every precondition.
3. Acquire deterministic ordered locks.
4. Re-verify preconditions after locks.
5. Append journal intent and fsync.
6. Materialize all temporary files in target directories.
7. fsync temporary files.
8. Execute bounded command effects in declared order.
9. Rename files atomically in deterministic order.
10. fsync containing directories where supported.
11. Apply state transitions with expected revision.
12. Run postconditions.
13. Append receipt and journal done.
14. Release locks in reverse order.
15. Refresh snapshot.
```
On failure, rollback uses recorded old content/hashes and emits a failed receipt. If rollback cannot complete, the doctor exposes a critical unfinished intent.
## 10.2 Lock ordering
Prevent deadlocks by ordering lock IDs lexicographically:
```text
config
queue-index
scope:<normalized-hash>
task:<task-id>
worktree:<slot-id>
```
A plan lists all locks before acquisition. No lock may be discovered ad hoc after mutations begin.
## 10.3 Optimistic state revision
Task/swarm actions include expected sidecar revision. If live events change it before apply:
```text
StalePlanError -> rebuild snapshot -> re-plan -> show updated preview
```
No action applies against stale state.
---
# 11. Verification and test plan
## 11.1 Pure unit tests
### Key decoder
- every required key sequence;
- chunk split at every byte boundary;
- multiple sequences in one chunk;
- standalone Escape timeout;
- malformed/oversized sequence;
- UTF-8 printable input;
- Ctrl+C;
- Shift+Tab;
- Page/Home/End variants.
### Reducers
- focus traversal;
- modal focus trap;
- filter and selection preservation;
- pagination boundaries;
- empty/no-match lists;
- resize clamping;
- task/slot event transitions;
- read-only actions do not create plans;
- all invalid state transitions rejected.
### Renderer
- ANSI-free model;
- exact plain snapshots at multiple sizes;
- color reduction;
- ASCII mode;
- long/CJK/combining/emoji strings;
- untrusted ANSI/OSC stripping;
- minimum terminal screen;
- sticky header/footer.
### Diff/log parser
- multi-file/hunk diffs;
- rename/delete/add/binary;
- no-newline marker;
- malformed/truncated diff;
- byte/file/line caps;
- 200-line logs;
- torn final line;
- control sequences and secrets;
- search and navigation.
## 11.2 Terminal session tests
Without third-party PTY dependencies, maximize pure testing by injecting fake streams and exported decoder/session adapters. Required tests:
- raw mode set/restored;
- cursor hide/show order;
- alternate screen enter/leave;
- exception cleanup;
- Ctrl+C throws, never calls process exit;
- SIGWINCH coalesces redraw;
- stream error/end cleanup;
- JSON stdout remains parseable;
- stderr receives UI;
- listener counts return to baseline.
Platform acceptance additionally runs manual/native-terminal smoke tests on:
- Linux terminals;
- macOS Terminal/iTerm;
- Windows Terminal PowerShell/cmd;
- `TERM=dumb`;
- redirected stdin/stdout;
- CI.
## 11.3 Doctor fixtures
Create isolated repositories for:
- missing config;
- malformed/unsupported config;
- failed and successful test probes;
- stale/live/recycled PID locks;
- corrupt telemetry head vs valid tail;
- broken hash chain;
- orphaned/live worktree;
- low disk;
- missing key;
- invalid Source/branch;
- uncommitted secret;
- malformed task envelope;
- stuck remote task;
- flaky ledger verdict.
Every fix test asserts:
```text
plan only -> no mutation
preview exact
confirmation policy
lock/journal usage
atomic write
postcondition
receipt
rollback
idempotent re-run
```
## 11.4 Queue/swarm state-machine tests
Enumerate all `(state, action)` pairs:
- allowed transitions produce expected plan;
- forbidden transitions produce stable error;
- retry increments attempt once;
- stale revision rejects;
- cancellation distinguishes local/remote;
- quarantine override requires reason;
- edit creates new revision/hash;
- delete uses trash/tombstone;
- concurrent actions serialize;
- completed history remains immutable;
- sidecar/task/envelope mismatch quarantines.
## 11.5 Headless contract tests
For every interactive command:
```text
stdin closed + no flags -> never waits
missing inputs -> exit 64 JSON
complete flags -> same plan hash as TUI answers
--json stdout -> exactly one parseable document
warnings/progress -> stderr
--yes absent -> no high-risk mutation
--confirm wrong -> fail
```
## 11.6 Security tests
- terminal ANSI/OSC injection through task title, preset, branch, and log;
- path traversal in task/receipt/export paths;
- symlink targets;
- malicious confirmation text;
- secret in log/diff/prompt/telemetry;
- API key never in snapshot/receipt;
- command arguments remain arrays;
- no shell interpolation from filter/task metadata;
- huge diff/log/filter input bounded;
- malicious JSONL line and torn write;
- PID reuse lock protection;
- stale plan race;
- dashboard bind confirmation.
## 11.7 Performance budgets
On a typical Node 22 environment:
| Operation | Target |
|---|---:|
| key decode/reduce/render planning | < 8 ms p95 |
| full 120×40 frame build | < 16 ms p95 |
| 1,000-task filter/sort | < 30 ms p95 |
| queue snapshot, 1,000 sidecars | < 250 ms warm |
| telemetry incremental refresh | < 50 ms for 500 new events |
| diff parse, 5 MB | < 500 ms and bounded memory |
| resize redraw | < 50 ms |
Rendering is throttled to at most 30 FPS; ordinary status refresh is 2 FPS.
## 11.8 Acceptance scenarios
### Scenario A — bare interactive launcher
```text
Given TTY input/output
When agentctl is invoked without a subcommand
Then command palette opens
And no repository state changes
And Escape restores terminal and exits 130 or cleanly quits per root dialog
```
### Scenario B — bare headless
```text
Given stdin/stdout are not TTY
When agentctl is invoked without a subcommand
Then help is printed and process exits 0
And no prompt or mutation occurs
```
### Scenario C — doctor fix
```text
Given test oracle probe fails
When doctor --interactive selects a candidate fix
Then exact patch and probe evidence are shown
And no file changes before confirmation
And apply uses locks/journal/atomic rename
And post-fix doctor result passes or rollback receipt exists
```
### Scenario D — queue retry
```text
Given TASK-204 is failed at attempt 2/3
When operator presses R
Then a retry ActionPlan is previewed
And state remains failed before confirmation
And confirmed apply creates attempt 3 with preserved history
```
### Scenario E — quarantine override
```text
Given task is quarantined
When operator selects override
Then task ID and reason are required
And finding remains visible
And override applies to one attempt only
And receipt records operator/reason/hash
```
### Scenario F — resize
```text
Given queue inspector at 140 columns
When terminal shrinks to 70 columns
Then selection and scroll position remain
And split pane becomes tabs
And no old frame artifacts remain
```
---
# 12. Delivery phases
## `v0.29.2` — terminal engine hardening
- incremental key decoder;
- terminal capabilities and color policy;
- terminal session cleanup;
- virtual renderer/layout;
- SIGWINCH;
- list pagination/filter;
- diff/log viewer models;
- TUI output on stderr in JSON mode;
- compatibility facade for existing primitives;
- pure tests for interactive path.
## `v0.29.3` — doctor planner
- diagnostic registry and DAG;
- passive/active checks;
- interactive matrix;
- fix plan/preview;
- safe fixes and receipts;
- headless JSON/fix contract.
## `v0.30.0-rc.1` — queue/swarm console
- canonical task sidecar state machine;
- queue snapshot/event reader;
- queue dashboard and inspector;
- task action planners;
- diff/log integration;
- swarm slot snapshot/console;
- state revisions and transaction executor.
## `v0.30.0` — stabilization
- cross-platform acceptance;
- packed-artifact tests;
- security review;
- performance budgets;
- documentation/help generated from command registry;
- external novice/operator beta;
- no unresolved P0/P1 findings in these modules.
---
# 13. Definition of done
## Module A
- [ ] Full keyboard matrix implemented and tested.
- [ ] Chunk-safe decoder.
- [ ] Raw/cursor/alternate screen restoration on every path.
- [ ] SIGWINCH responsive layout.
- [ ] Pagination, sticky headers, scroll indicators, filtering.
- [ ] Diff and log viewers bounded/sanitized.
- [ ] Secret masking and visibility policy.
- [ ] NO_COLOR/FORCE_COLOR/TERM behavior.
- [ ] JSON stdout never contains ANSI/UI.
## Module B
- [ ] Diagnostic DAG and result schema.
- [ ] Passive vs active probe distinction.
- [ ] Full requested health matrix.
- [ ] Fixes are immutable plans.
- [ ] Exact diff preview.
- [ ] Risk-based confirmations.
- [ ] Transactional apply/rollback/receipts.
- [ ] No unsafe automatic fixes.
- [ ] Headless `--fix` deterministic.
## Module C
- [ ] Canonical task state machine.
- [ ] Queue dashboard categories and live timers.
- [ ] Inspector prompt/envelope/log/diff.
- [ ] Retry/quarantine/edit/delete plans.
- [ ] Swarm slots/PID/lock/worktree view.
- [ ] Resource metrics honest/portable.
- [ ] Incremental telemetry/event refresh.
- [ ] Concurrent/stale actions rejected.
## Module D
- [ ] Bare TTY palette and bare headless help behavior.
- [ ] Registry-driven command palette.
- [ ] Alternate-screen diff/error UX.
- [ ] Confirmation matrix enforced.
- [ ] Shared TUI/dashboard snapshot services.
- [ ] Telemetry privacy classifications.
- [ ] Accessibility and offline behavior.
- [ ] Operational receipts and safe rollback.
---
# 14. Final architectural recommendation
The definitive UX should be built as three reusable engines, not as command-specific terminal loops:
```text
1. Terminal engine
   KeyEvent -> reducer -> RenderFrame -> ANSI patch
2. Operations planner
   Snapshot + Intent -> immutable ActionPlan
3. Transaction executor
   ActionPlan -> locks/journal/effects/postconditions -> receipt
```
`doctor`, `queue`, `swarm`, command palette, diff viewer, log viewer, and future interactive features become applications over those engines.
The primary safety property is not color, key handling, or layout. It is this:
> **The same plan is produced whether answers come from flags, JSON, or TTY, and no keypress can bypass preview, preconditions, confirmation, locking, journaling, or verification.**
That architecture gives terminal users a fast, discoverable, high-context operational experience while preserving deterministic CI behavior, zero runtime dependencies, and enterprise-grade auditability.

