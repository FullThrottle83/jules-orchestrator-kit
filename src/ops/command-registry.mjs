/**
 * @typedef {"low" | "moderate" | "high" | "destructive"} RiskLevel
 * @typedef {"Create" | "Inspect" | "Operate" | "Repair" | "Configure"} CommandCategory
 *
 * @typedef {Object} CommandFlag
 * @property {string} name
 * @property {"boolean" | "string"} type
 * @property {string} description
 * @property {any} [default]
 *
 * @typedef {Object} CommandDescriptor
 * @property {string} id
 * @property {string[]} path
 * @property {string} title
 * @property {string} description
 * @property {CommandCategory} category
 * @property {boolean} mutates
 * @property {RiskLevel} risk
 * @property {"never" | "optional" | "authoring-auto"} interactive
 * @property {boolean} requiresRepository
 * @property {string[]} shortcuts
 * @property {string[]} examples
 * @property {CommandFlag[]} flags
 */

/** @type {CommandDescriptor[]} */
export const COMMAND_REGISTRY = [
  {
    id: "assert",
    path: ["assert"],
    title: "assert",
    description: "Run declarative zero-dependency verification assertion primitives",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: false,
    shortcuts: ["ast"],
    examples: [
      "agentctl assert --dir dist --max-mb 10 --gzip",
      "agentctl assert --file dist/server.js --max-kb 500",
      'agentctl assert --patterns "console.log" --targets "src/**/*.js"',
      "agentctl assert --config assert.json --json",
    ],
    flags: [
      { name: "dir", type: "string", description: "Target directory path for dir-size assertion (-d)" },
      { name: "file", type: "string", description: "Target file path for file-size assertion (-f)" },
      { name: "targets", type: "string", description: "Target glob/path for pattern matching (-t)" },
      { name: "patterns", type: "string", description: "Comma-separated patterns or regex to ban (-p)" },
      { name: "patterns-file", type: "string", description: "Path to JSON file containing banned patterns" },
      { name: "max-bytes", type: "string", description: "Maximum byte limit" },
      { name: "max-kb", type: "string", description: "Maximum KiB limit" },
      { name: "max-mb", type: "string", description: "Maximum MiB limit" },
      { name: "gzip", type: "boolean", description: "Measure gzip compressed byte size" },
      { name: "config", type: "string", description: "Path to assertion JSON/YAML config (-c)" },
      { name: "json", type: "boolean", description: "Output structured JSON assertion result (-j)" },
      { name: "json-report", type: "string", description: "Write structured JSON report to target path" },
    ],
  },
  {
    id: "doctor",
    path: ["doctor"],
    title: "doctor",
    description: "Run repository diagnostics and guided fixes",
    category: "Repair",
    mutates: false,
    risk: "low",
    interactive: "optional",
    requiresRepository: true,
    shortcuts: ["d", "doc"],
    examples: [
      "agentctl doctor",
      "agentctl doctor --probe",
      "agentctl doctor --json",
    ],
    // `--interactive`, `--fix` and `--yes` were listed here and implemented
    // nowhere: the report carries remediation entries, but nothing applies
    // them. Advertising a flag the command silently ignores is the same defect
    // as documenting `queue` as a read-only browser. They come back to this
    // list when an apply step exists.
    flags: [
      { name: "probe", type: "boolean", description: "Actively start the provider CLI to check it answers, rather than only finding it on PATH" },
      { name: "json", type: "boolean", description: "Output structured JSON doctor report (-j)" },
    ],
  },
  {
    id: "queue",
    // This described a passive viewer — "Browse and manage", `mutates: false`,
    // `risk: low` — while the handler runs the queue: it dispatches every task
    // to the provider and spends budget. Someone reading `--help` before their
    // first run was told the opposite of what the command does.
    path: ["queue"],
    title: "queue",
    description: "Execute pending task envelopes: dispatches each to the provider and moves it out of the queue",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "optional",
    requiresRepository: true,
    shortcuts: ["q"],
    examples: [
      "agentctl queue --dry-run",
      "agentctl queue",
      "agentctl queue --dag --concurrency 3",
      "agentctl queue --json",
    ],
    // `--interactive` and `--limit` were listed here and implemented nowhere:
    // the handler parses only --dag, --concurrency, --dry-run and --json.
    // Advertising flags the command silently ignores is the same defect as
    // documenting `queue` as a read-only browser. They come back when an
    // implementation exists.
    flags: [
      { name: "dag", type: "boolean", description: "Resolve depends-on order via Kahn's algorithm before running" },
      { name: "concurrency", type: "string", description: "Parallel worker slots (defaults to limits.concurrency) (-c)" },
      { name: "dry-run", type: "boolean", description: "Report what would run without dispatching or moving anything (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON queue snapshot (-j)" },
    ],
  },
  {
    id: "swarm",
    // Described as an inspector — `mutates: false`, `risk: low` — while the
    // handler dispatches every queued task in parallel and spends budget.
    // `--interactive` was advertised and implemented nowhere.
    path: ["swarm"],
    title: "swarm",
    description: "Dispatch every queued task in parallel across worker slots",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["s"],
    examples: [
      "agentctl swarm --dry-run",
      "agentctl swarm",
      "agentctl swarm --concurrency 3 --json",
    ],
    flags: [
      { name: "concurrency", type: "string", description: "Parallel worker slots (defaults to limits.concurrency) (-c)" },
      { name: "dry-run", type: "boolean", description: "Report what would run without dispatching (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON swarm result (-j)" },
    ],
  },
  {
    id: "task",
    path: ["task"],
    title: "task",
    description: "Manage task envelopes: create, template, or optimize prompts (see task create | task template | task optimize)",
    category: "Create",
    mutates: true,
    risk: "moderate",
    interactive: "authoring-auto",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      'agentctl task create --title "Fix webhook" --prompt "Add retry handling"',
      "agentctl task template --list",
      'agentctl task optimize "Refactor auth" --fix',
    ],
    flags: [],
  },
  {
    id: "task-create",
    path: ["task", "create"],
    title: "task create",
    description: "Author a scoped, falsifiable task",
    category: "Create",
    mutates: true,
    risk: "moderate",
    interactive: "authoring-auto",
    requiresRepository: true,
    shortcuts: ["tc"],
    examples: [
      'agentctl task create --title "Fix webhook" --prompt "Add retry handling" --verify-cmd "npm test"',
      "agentctl task create --interactive",
    ],
    flags: [
      { name: "title", type: "string", description: "Short title for task (-t)" },
      { name: "prompt", type: "string", description: "Detailed task instructions (-p)" },
      { name: "prompt-file", type: "string", description: "Read prompt from file (-f)" },
      { name: "role", type: "string", description: "Specialist role (auditor, performance, security, hygiene, resilience, types, debugger, testing, e2e, database, docs, a11y) (-r)" },
      { name: "tier", type: "string", description: "Execution tier override (fast | complex)" },
      { name: "template", type: "string", description: "Task template preset ID" },
      { name: "depends-on", type: "string", description: "Comma-separated task dependency IDs" },
      { name: "depends", type: "string", description: "Alias for --depends-on" },
      { name: "verify-cmd", type: "string", description: "Verification command override (-v)" },
      { name: "verify", type: "string", description: "Alias for --verify-cmd" },
      { name: "auto-pr", type: "boolean", description: "Automatically create GitHub PR upon completion" },
      { name: "require-plan-approval", type: "boolean", description: "Require approval of agent plan before execution" },
      { name: "repoless", type: "boolean", description: "Execute in repoless sandbox mode" },
      { name: "interactive", type: "boolean", description: "Launch interactive task wizard (-i)" },
      { name: "non-interactive", type: "boolean", description: "Bypass interactive prompts and use CLI flags" },
      { name: "no-interactive", type: "boolean", description: "Alias for --non-interactive" },
      { name: "yes", type: "boolean", description: "Accept default values non-interactively (-y)" },
      { name: "dry-run", type: "boolean", description: "Simulate task envelope creation without queueing (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON envelope (-j)" },
    ],
  },
  {
    id: "task-template",
    path: ["task", "template"],
    title: "task template",
    description: "List and synthesize web task template envelopes",
    category: "Create",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["tt"],
    examples: [
      "agentctl task template --list",
      "agentctl task template <id> --json",
    ],
    flags: [
      { name: "list", type: "boolean", description: "List available task templates (-l)" },
      { name: "verify-cmd", type: "string", description: "Verification command override (-v)" },
      { name: "verify", type: "string", description: "Alias for --verify-cmd" },
      { name: "dry-run", type: "boolean", description: "Simulate envelope synthesis (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON envelope (-j)" },
    ],
  },
  {
    id: "task-optimize",
    path: ["task", "optimize"],
    title: "task optimize",
    description: "Score task prompt falsifiability and static path resolution",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["to", "optimize"],
    examples: [
      'agentctl task optimize "Fix JWT token expiry in src/auth.js"',
      'agentctl task optimize "Refactor auth" --fix',
      'agentctl task optimize --file prompt.txt --json',
    ],
    flags: [
      { name: "fix", type: "boolean", description: "Synthesize optimized markdown task envelope (-f)" },
      { name: "prompt", type: "string", description: "Task prompt text to score (-p)" },
      { name: "prompt-file", type: "string", description: "Read prompt from file" },
      { name: "file", type: "string", description: "Alias for --prompt-file: path to text file containing task prompt" },
      { name: "dir", type: "string", description: "Target repository directory root (-d)" },
      { name: "web", type: "boolean", description: "Enable web-intent detection and optimization (-w)" },
      { name: "verify-cmd", type: "string", description: "Verification command override (-v)" },
      { name: "verify", type: "string", description: "Alias for --verify-cmd" },
      { name: "dry-run", type: "boolean", description: "Simulate scoring without side effects" },
      { name: "json", type: "boolean", description: "Output structured JSON prompt evaluation (-j)" },
    ],
  },
  {
    id: "init",
    path: ["init"],
    title: "init",
    description: "Configure Stack Oracle and Jules provider manifests",
    category: "Configure",
    mutates: true,
    risk: "moderate",
    interactive: "optional",
    requiresRepository: true,
    shortcuts: ["i"],
    examples: [
      "agentctl init",
      "agentctl init --interactive",
      "agentctl init --tier pro --yes",
    ],
    flags: [
      { name: "tier", type: "string", description: "Target configuration tier (free, pro, ultra, enterprise) (-t)" },
      { name: "provider", type: "string", description: "Provider preset to record in the manifest (jules, claude-code, codex, gemini-flash)" },
      { name: "profile", type: "string", description: "Verification profile to record (minimal, standard, max)" },
      { name: "interactive", type: "boolean", description: "Launch interactive onboarding wizard (-i)" },
      { name: "non-interactive", type: "boolean", description: "Run non-interactively with defaults" },
      { name: "no-interactive", type: "boolean", description: "Alias for --non-interactive" },
      { name: "yes", type: "boolean", description: "Accept auto-detected Stack Oracle defaults (-y)" },
      { name: "force", type: "boolean", description: "Force overwrite existing config and assets (-f)" },
      { name: "dry-run", type: "boolean", description: "Preview plan without writing files (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON manifest (-j)" },
    ],
  },
  {
    id: "dashboard",
    path: ["dashboard"],
    title: "dashboard",
    description: "Start local web dashboard server",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["dash"],
    examples: [
      "agentctl dashboard",
      "agentctl dashboard --port 3000",
      "agentctl dashboard 3000",
    ],
    flags: [
      { name: "port", type: "string", description: "HTTP server port (default 4100)" },
      { name: "host", type: "string", description: "Bind host address (default 127.0.0.1)" },
    ],
  },
  {
    id: "budget",
    path: ["budget"],
    title: "budget",
    description: "Show today's task budget, where its limit came from, and reconcile a wrong count",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["b"],
    examples: [
      "agentctl budget",
      "agentctl budget --json",
      "agentctl budget --by-user",
      "agentctl budget reset --dry-run",
      "agentctl budget reset --yes",
      "agentctl budget reset --yes --all",
    ],
    flags: [
      { name: "json", type: "boolean", description: "Output structured JSON budget snapshot" },
      { name: "by-user", type: "boolean", description: "Show per-author attribution table (-u)" },
      { name: "dry-run", type: "boolean", description: "Report what reset would release, write nothing" },
      { name: "yes", type: "boolean", description: "Confirm releasing open reservations (-y)" },
      { name: "all", type: "boolean", description: "Also release reservations that reached the provider (reset only)" },
    ],
  },
  {
    id: "status",
    path: ["status"],
    title: "status",
    description: "Show operating status and health summary",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: false,
    shortcuts: ["st"],
    examples: [
      "agentctl status",
      "agentctl status --json",
    ],
    flags: [
      { name: "json", type: "boolean", description: "Output status in JSON format" },
    ],
  },
  {
    id: "escalate",
    path: ["escalate"],
    title: "escalate",
    description: "Dispatch or manage webhook escalation incidents with Silence Governor",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["esc"],
    examples: [
      'agentctl escalate sess-123 --reason "AWAITING_USER_FEEDBACK"',
      "agentctl escalate --status",
      "agentctl escalate --flush",
      "agentctl escalate --clear",
    ],
    flags: [
      { name: "reason", type: "string", description: "Escalation reason category (-r)" },
      { name: "branch", type: "string", description: "Target git branch (-b)" },
      { name: "logs", type: "string", description: "Error logs text (-l)" },
      { name: "log-file", type: "string", description: "Read error logs from file" },
      { name: "critical", type: "boolean", description: "Bypass Silence Governor and alert immediately" },
      { name: "flush", type: "boolean", description: "Flush buffered escalation digest" },
      { name: "status", type: "boolean", description: "Inspect digest status and interruption budget" },
      { name: "clear", type: "boolean", description: "Clear pending digest buffer" },
      { name: "dry-run", type: "boolean", description: "Simulate dispatch without sending HTTP requests (-d)" },
      { name: "json", type: "boolean", description: "Output JSON structured response (-j)" },
    ],
  },
  {
    id: "flaky",
    path: ["flaky"],
    title: "flaky",
    description: "Manage Wilson-quarantined tests and dispatch healing swarm",
    category: "Repair",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["flk"],
    examples: [
      "agentctl flaky status",
      "agentctl flaky heal",
      'agentctl flaky heal "npm test"',
      "agentctl flaky reset",
    ],
    flags: [
      { name: "dispatch", type: "boolean", description: "Dispatch healing tasks directly to AI agents" },
      { name: "role", type: "string", description: "Agent persona role (default: hygiene) (-r)" },
      { name: "test-cmd", type: "string", description: "Target specific test command (-t)" },
      { name: "dry-run", type: "boolean", description: "Simulate healing swarm generation without writing (-d)" },
      { name: "json", type: "boolean", description: "Output JSON structured response (-j)" },
    ],
  },
  {
    id: "handover",
    path: ["handover"],
    title: "handover",
    description: "Inspect or generate Baton Pass session handover envelopes",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["ho"],
    examples: [
      "agentctl handover list",
      "agentctl handover show sess-123",
      'agentctl handover create sess-123 --intent "Refactor auth" --status rolled-back',
    ],
    flags: [
      { name: "intent", type: "string", description: "Task intent or goal description (-i)" },
      { name: "status", type: "string", description: "Handover status (aborted, rolled-back, escalated, failed) (-s)" },
      { name: "completed", type: "string", description: "Completed progress summary (-c)" },
      { name: "assumptions", type: "string", description: "Validated assumptions (-a)" },
      { name: "landmines", type: "string", description: "Obstacles or error summary (-l)" },
      { name: "next-steps", type: "string", description: "Actionable next steps for successor agent (-n)" },
      { name: "limit", type: "string", description: "Maximum handovers to list or keep on prune" },
      { name: "context", type: "boolean", description: "Print show output as injectable prompt context (show only)" },
      { name: "json", type: "boolean", description: "Output JSON structured response (-j)" },
    ],
  },
  {
    id: "mutate",
    path: ["mutate"],
    title: "mutate",
    description: "Run zero-dependency diff mutation testing harness",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl mutate",
      "agentctl mutate --min-score 80",
      'agentctl mutate --max-mutants 20 --cmd "npm test"',
    ],
    flags: [
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged) (-m)" },
      { name: "working-tree", type: "boolean", description: "Evaluate the working tree (default mode)" },
      { name: "staged", type: "boolean", description: "Evaluate staged changes" },
      { name: "committed", type: "boolean", description: "Evaluate committed changes" },
      { name: "min-score", type: "string", description: "Target minimum mutation score threshold (0-100)" },
      { name: "max-mutants", type: "string", description: "Maximum number of mutants to generate and test" },
      { name: "cmd", type: "string", description: "Test command override" },
      { name: "json", type: "boolean", description: "Output structured JSON mutation report (-j)" },
    ],
  },
  {
    id: "mutation",
    path: ["mutation"],
    title: "mutation",
    description: "Alias of mutate: run zero-dependency diff mutation testing harness",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl mutation",
      "agentctl mutation --min-score 80",
      'agentctl mutation --max-mutants 20 --cmd "npm test"',
    ],
    flags: [
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged) (-m)" },
      { name: "working-tree", type: "boolean", description: "Evaluate the working tree (default mode)" },
      { name: "staged", type: "boolean", description: "Evaluate staged changes" },
      { name: "committed", type: "boolean", description: "Evaluate committed changes" },
      { name: "min-score", type: "string", description: "Target minimum mutation score threshold (0-100)" },
      { name: "max-mutants", type: "string", description: "Maximum number of mutants to generate and test" },
      { name: "cmd", type: "string", description: "Test command override" },
      { name: "json", type: "boolean", description: "Output structured JSON mutation report (-j)" },
    ],
  },
  {
    id: "coverage",
    path: ["coverage"],
    title: "coverage",
    description: "Run native zero-dependency V8 diff coverage check",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["cov"],
    examples: [
      "agentctl coverage",
      "agentctl coverage --min 80",
      'agentctl coverage --cmd "node --test"',
    ],
    flags: [
      { name: "min", type: "string", description: "Minimum diff line coverage percentage required (-m)" },
      { name: "min-coverage", type: "string", description: "Alias for --min" },
      { name: "cmd", type: "string", description: "Test command override to run with V8 coverage (-c)" },
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged)" },
      { name: "json", type: "boolean", description: "Output structured JSON coverage report (-j)" },
    ],
  },
  {
    id: "gate",
    path: ["gate"],
    title: "gate",
    description: "Run CI security, rules, and stack verification gate",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl gate",
      "agentctl gate --mode working-tree",
      "agentctl gate --fix",
      "agentctl gate --json",
    ],
    flags: [
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged) (-m)" },
      { name: "working-tree", type: "boolean", description: "Evaluate the working tree (default mode)" },
      { name: "staged", type: "boolean", description: "Evaluate staged changes" },
      { name: "committed", type: "boolean", description: "Evaluate committed changes" },
      { name: "fix", type: "boolean", description: "Trigger automated OODA self-repair loop on failure" },
      { name: "allow-protected", type: "boolean", description: "Bypass protected path checks for authorized maintainers" },
      { name: "allow-unreadable-tests", type: "boolean", description: "Permit unreadable test dialects for this run" },
      { name: "allow-test-modifications", type: "boolean", description: "Waive every test-tampering check for this run" },
      { name: "allow-test-change", type: "string", description: "Waive one tampering check kind (repeatable)" },
      { name: "strict-locks", type: "boolean", description: "Enforce strict anti-tampering verification on test files" },
      { name: "dry-run", type: "boolean", description: "Simulate gate evaluation without persisting evidence (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON gate report (-j)" },
      { name: "json-report", type: "string", description: "Write structured JSON report to target path" },
    ],
  },
  {
    id: "check",
    path: ["check"],
    title: "check",
    description: "Alias of gate: run all-in-one CI security, rules, and stack verification gate",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl check",
      "agentctl check --base main --strict-locks",
      "agentctl gate --strict-locks  # canonical spelling; check is an alias",
      "agentctl check --fix",
      "agentctl check --json",
    ],
    flags: [
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged) (-m)" },
      { name: "working-tree", type: "boolean", description: "Evaluate the working tree (default mode)" },
      { name: "staged", type: "boolean", description: "Evaluate staged changes" },
      { name: "committed", type: "boolean", description: "Evaluate committed changes" },
      { name: "fix", type: "boolean", description: "Trigger automated OODA self-repair loop on failure" },
      { name: "allow-protected", type: "boolean", description: "Bypass protected path checks for authorized maintainers" },
      { name: "allow-unreadable-tests", type: "boolean", description: "Permit unreadable test dialects for this run" },
      { name: "allow-test-modifications", type: "boolean", description: "Waive every test-tampering check for this run" },
      { name: "allow-test-change", type: "string", description: "Waive one tampering check kind (repeatable)" },
      { name: "strict-locks", type: "boolean", description: "Enforce strict anti-tampering verification on test files" },
      { name: "dry-run", type: "boolean", description: "Simulate gate evaluation without persisting evidence (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON gate report (-j)" },
      { name: "json-report", type: "string", description: "Write structured JSON report to target path" },
    ],
  },
  {
    id: "audit",
    path: ["audit"],
    title: "audit",
    description: "Alias of gate: run CI security and verification gate against current branch",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl audit",
      "agentctl audit --mode working-tree",
      "agentctl audit --fix",
      "agentctl audit --json",
    ],
    flags: [
      { name: "base", type: "string", description: "Base comparison branch (default: main or config base_branch) (-b)" },
      { name: "mode", type: "string", description: "Evaluation mode (working-tree | committed | staged) (-m)" },
      { name: "working-tree", type: "boolean", description: "Evaluate the working tree (default mode)" },
      { name: "staged", type: "boolean", description: "Evaluate staged changes" },
      { name: "committed", type: "boolean", description: "Evaluate committed changes" },
      { name: "fix", type: "boolean", description: "Trigger automated OODA self-repair loop on failure" },
      { name: "allow-protected", type: "boolean", description: "Bypass protected path checks for authorized maintainers" },
      { name: "allow-unreadable-tests", type: "boolean", description: "Permit unreadable test dialects for this run" },
      { name: "allow-test-modifications", type: "boolean", description: "Waive every test-tampering check for this run" },
      { name: "allow-test-change", type: "string", description: "Waive one tampering check kind (repeatable)" },
      { name: "strict-locks", type: "boolean", description: "Enforce strict anti-tampering verification on test files" },
      { name: "dry-run", type: "boolean", description: "Simulate gate evaluation without persisting evidence (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON gate report (-j)" },
      { name: "json-report", type: "string", description: "Write structured JSON report to target path" },
    ],
  },
  {
    id: "probe",
    path: ["probe"],
    title: "probe",
    description: "Run test flakiness stability probe across N repetitions",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl probe",
      "agentctl probe --repeat 10",
      'agentctl probe --repeat 5 --cmd "pytest"',
    ],
    flags: [
      { name: "repeat", type: "string", description: "Number of probe executions (default: 5) (-r)" },
      { name: "iterations", type: "string", description: "Alias for --repeat (-n)" },
      { name: "min", type: "string", description: "Minimum pass rate 0-1 (alias for --min-pass-rate) (-m)" },
      { name: "min-pass-rate", type: "string", description: "Minimum pass rate 0-1 (default: 1.0)" },
      { name: "cmd", type: "string", description: "Test command to probe (-c)" },
      { name: "test-cmd", type: "string", description: "Alias for --cmd (-t)" },
      { name: "verify-cmd", type: "string", description: "Alias for --cmd" },
      { name: "record", type: "boolean", description: "Persist results to flaky quarantine ledger (default: true)" },
      { name: "no-record", type: "boolean", description: "Skip recording to flaky quarantine ledger" },
      { name: "json", type: "boolean", description: "Output structured JSON probe telemetry (-j)" },
    ],
  },
  {
    id: "stability",
    path: ["stability"],
    title: "stability",
    description: "Alias of probe: run test flakiness stability probe across N repetitions",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl stability",
      "agentctl stability --repeat 10",
      'agentctl stability --repeat 5 --cmd "pytest"',
    ],
    flags: [
      { name: "repeat", type: "string", description: "Number of probe executions (default: 5) (-r)" },
      { name: "iterations", type: "string", description: "Alias for --repeat (-n)" },
      { name: "min", type: "string", description: "Minimum pass rate 0-1 (alias for --min-pass-rate) (-m)" },
      { name: "min-pass-rate", type: "string", description: "Minimum pass rate 0-1 (default: 1.0)" },
      { name: "cmd", type: "string", description: "Test command to probe (-c)" },
      { name: "test-cmd", type: "string", description: "Alias for --cmd (-t)" },
      { name: "verify-cmd", type: "string", description: "Alias for --cmd" },
      { name: "record", type: "boolean", description: "Persist results to flaky quarantine ledger (default: true)" },
      { name: "no-record", type: "boolean", description: "Skip recording to flaky quarantine ledger" },
      { name: "json", type: "boolean", description: "Output structured JSON probe telemetry (-j)" },
    ],
  },
  {
    id: "perf",
    path: ["perf"],
    title: "perf",
    description: "Monitor Node.js event loop delay and Big-O performance lag",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl perf",
      'agentctl perf --max-ms 50 --cmd "npm test"',
    ],
    flags: [
      { name: "max-ms", type: "string", description: "Maximum allowable event loop delay threshold in ms (-m)" },
      { name: "threshold", type: "string", description: "Alias for --max-ms (-t)" },
      { name: "cmd", type: "string", description: "Command to execute during performance monitoring (-c)" },
      { name: "resolution", type: "string", description: "Sampling resolution in ms (default: 10) (-r)" },
      { name: "json", type: "boolean", description: "Output structured JSON performance report (-j)" },
    ],
  },
  {
    id: "event-loop",
    path: ["event-loop"],
    title: "event-loop",
    description: "Alias of perf: monitor Node.js event loop delay and Big-O performance lag",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl event-loop",
      'agentctl event-loop --max-ms 50 --cmd "npm test"',
    ],
    flags: [
      { name: "max-ms", type: "string", description: "Maximum allowable event loop delay threshold in ms (-m)" },
      { name: "threshold", type: "string", description: "Alias for --max-ms (-t)" },
      { name: "cmd", type: "string", description: "Command to execute during performance monitoring (-c)" },
      { name: "resolution", type: "string", description: "Sampling resolution in ms (default: 10) (-r)" },
      { name: "json", type: "boolean", description: "Output structured JSON performance report (-j)" },
    ],
  },
  {
    id: "dispatch",
    path: ["dispatch"],
    title: "dispatch",
    description: "Dispatch a single task to an AI agent",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      'agentctl dispatch --prompt "Add retry handling to src/webhook.js"',
      'agentctl dispatch -p "Fix type errors" --role types --tier fast',
      'agentctl dispatch --prompt-file task.md --dry-run',
    ],
    flags: [
      { name: "title", type: "string", description: "Task title (-t)" },
      { name: "prompt", type: "string", description: "Task prompt instructions (-p)" },
      { name: "prompt-file", type: "string", description: "Read prompt from file (-f)" },
      { name: "role", type: "string", description: "Specialist role (auditor, performance, security, hygiene, resilience, types, debugger, testing, e2e, database, docs, a11y) (-r)" },
      { name: "tier", type: "string", description: "Execution tier override (fast | complex)" },
      { name: "check-premise", type: "boolean", description: "Verify premise locally before dispatching" },
      { name: "idempotent", type: "boolean", description: "Alias for --check-premise" },
      { name: "author", type: "string", description: "Attribution author for the dispatch" },
      { name: "verify-cmd", type: "string", description: "Verification command override (-v)" },
      { name: "verify", type: "string", description: "Alias for --verify-cmd" },
      { name: "source", type: "string", description: "Jules repository source identifier (-s)" },
      { name: "branch", type: "string", description: "Starting branch for task execution (-b)" },
      { name: "repoless", type: "boolean", description: "Dispatch task in repoless execution mode" },
      { name: "auto-pr", type: "boolean", description: "Automatically create PR upon completion" },
      { name: "require-plan-approval", type: "boolean", description: "Require human approval for proposed plan" },
      { name: "auto-approve-plans", type: "boolean", description: "Run unattended without pausing for plan approval" },
      { name: "auto-approve", type: "boolean", description: "Alias for --auto-approve-plans" },
      { name: "dry-run", type: "boolean", description: "Simulate dispatch without sending to provider (-d)" },
      { name: "json", type: "boolean", description: "Output JSON structured dispatch result (-j)" },
    ],
  },
  {
    id: "bootstrap",
    path: ["bootstrap"],
    title: "bootstrap",
    description: "Bootstrap zero-test repository with verification oracle",
    category: "Configure",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["bs"],
    examples: [
      "agentctl bootstrap",
      "agentctl bootstrap --force",
    ],
    flags: [
      { name: "force", type: "boolean", description: "Overwrite existing verification oracle or config (-f)" },
      { name: "dry-run", type: "boolean", description: "Simulate bootstrap without writing files (-d)" },
      { name: "json", type: "boolean", description: "Output JSON structured bootstrap result (-j)" },
    ],
  },
  {
    id: "pr-harvest",
    path: ["pr", "harvest"],
    title: "pr harvest",
    description: "Scan, audit and auto-merge verified agent pull requests",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["pr"],
    examples: [
      "agentctl pr harvest",
      "agentctl pr harvest --auto",
      "agentctl pr harvest --dry-run",
      "agentctl pr harvest --json",
    ],
    flags: [
      { name: "tier", type: "string", description: "Filter PRs by tier label" },
      { name: "limit", type: "string", description: "Maximum PRs to harvest" },
      { name: "auto", type: "boolean", description: "Automatically merge qualifying green PRs" },
      { name: "merge", type: "boolean", description: "Merge matching PRs" },
      { name: "allow-no-checks", type: "boolean", description: "Allow PR merge when no CI checks are configured" },
      { name: "dry-run", type: "boolean", description: "Simulate PR harvest without merging (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON harvest report (-j)" },
    ],
  },
  {
    id: "harvest",
    path: ["harvest"],
    title: "harvest",
    description: "Harvest failure traces and record resolution observations into system memory",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl harvest --exit-code 4 --task TASK-1 --agent jules",
      "agentctl harvest --exit-code 1 --log ./fail.log --json",
    ],
    flags: [
      { name: "exit-code", type: "string", description: "Failing command exit code (default: 4)" },
      { name: "log", type: "string", description: "Path to failure log file" },
      { name: "diff", type: "string", description: "Diff text or path describing the attempted change" },
      { name: "task", type: "string", description: "Task identifier for the failure" },
      { name: "agent", type: "string", description: "Agent name that produced the failure (default: jules)" },
      { name: "dry-run", type: "boolean", description: "Simulate harvesting without writing (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON harvest result (-j)" },
    ],
  },
  {
    id: "session-get",
    path: ["session", "get"],
    title: "session get",
    description: "Retrieve remote execution status for a session ID",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["session status", "session"],
    examples: [
      "agentctl session get <sessionId>",
      "agentctl session get <sessionId> --dry-run",
      "agentctl session get <sessionId> --json",
    ],
    flags: [
      { name: "dry-run", type: "boolean", description: "Simulate session retrieval (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON session data (-j)" },
    ],
  },
  {
    id: "session-list",
    path: ["session", "list"],
    title: "session list",
    description: "List recent and active Jules sessions from remote API or local ledger",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["sessions"],
    examples: [
      "agentctl session list",
      "agentctl session list --limit 10",
      "agentctl session list --json",
    ],
    flags: [
      { name: "limit", type: "string", description: "Maximum number of sessions to list (default: 20) (-l)" },
      { name: "page-size", type: "string", description: "Alias for --limit" },
      { name: "remote", type: "boolean", description: "Query remote Jules API" },
      { name: "dry-run", type: "boolean", description: "Simulate listing without remote requests (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON session list (-j)" },
    ],
  },
  {
    id: "plan-approve",
    path: ["plan", "approve"],
    title: "plan approve",
    description: "Approve a pending execution plan for an agent session",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["approve", "plan"],
    examples: [
      "agentctl plan approve <sessionId>",
      "agentctl plan approve <sessionId> --dry-run",
      "agentctl approve <sessionId>",
    ],
    flags: [
      { name: "dry-run", type: "boolean", description: "Simulate plan approval (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "lock",
    path: ["lock"],
    title: "lock",
    description: "Multi-agent coordination locks: acquire, release, or view file status",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl lock status",
      "agentctl lock acquire agent-1 task-1 src/main.js",
      "agentctl lock acquire agent-1 task-1 src/main.js --ttl 60",
      "agentctl lock release task-1",
    ],
    flags: [
      { name: "ttl", type: "string", description: "Lease duration in minutes for acquire (default: 120)" },
      { name: "pid", type: "string", description: "Bind the lock to a process id instead of a time lease" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "evidence",
    path: ["evidence"],
    title: "evidence",
    description: "Manage cryptographic audit evidence (generate | verify | show)",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl evidence generate",
      "agentctl evidence verify",
      "agentctl evidence show --json",
    ],
    flags: [
      { name: "output", type: "string", description: "Output path for generate (-o)" },
      { name: "manifest", type: "string", description: "Manifest path for verify or show (-m)" },
      { name: "markdown", type: "string", description: "Markdown output path for generate" },
      { name: "dry-run", type: "boolean", description: "Simulate without writing (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "fix",
    path: ["fix"],
    title: "fix",
    description: "Auto-repair from piped terminal logs or error trace (npm test 2>&1 | agentctl fix)",
    category: "Repair",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "npm test 2>&1 | agentctl fix",
      "agentctl fix --file ./fail.log",
      'agentctl fix --input "Error: boom" --task --json',
    ],
    flags: [
      { name: "input", type: "string", description: "Inline error log text (-i)" },
      { name: "file", type: "string", description: "Path to file containing error logs (-f)" },
      { name: "cmd", type: "string", description: "Verification command for the repair task (-c)" },
      { name: "task", type: "boolean", description: "Synthesize a repair task envelope instead of dispatching (-t)" },
      { name: "author", type: "string", description: "Attribution author for the repair" },
      { name: "dry-run", type: "boolean", description: "Simulate repair without dispatching" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "patch",
    path: ["patch"],
    title: "patch",
    description: "Extract and test/apply git patch from a Jules session",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl patch <sessionId>",
      "agentctl patch <sessionId> --apply",
      "agentctl patch <sessionId> --save ./fix.patch --json",
    ],
    flags: [
      { name: "session", type: "string", description: "Session ID (positional also accepted) (-s)" },
      { name: "apply", type: "boolean", description: "Apply the patch to the working tree (-a)" },
      { name: "save", type: "string", description: "Save patch content to file path" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "retry",
    path: ["retry"],
    title: "retry",
    description: "Retry failed session with automated failure-trace injection",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl retry <sessionId>",
      "agentctl retry <sessionId> --role debugger",
      "agentctl retry <sessionId> --dry-run --json",
    ],
    flags: [
      { name: "session", type: "string", description: "Session ID (positional also accepted) (-s)" },
      { name: "role", type: "string", description: "Specialist role for the retry (-r)" },
      { name: "title", type: "string", description: "Title for the retry session (-t)" },
      { name: "without-failure", type: "boolean", description: "Retry without injecting previous failure diagnostics" },
      { name: "dry-run", type: "boolean", description: "Simulate retry without dispatching (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "prune",
    path: ["prune"],
    title: "prune",
    description: "Batch-archive or delete stale sessions via Jules API",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl prune --json",
      "agentctl prune --age 7d --dry-run",
      "agentctl prune --age 30d --state COMPLETED --yes",
    ],
    flags: [
      { name: "age", type: "string", description: "Only match sessions older than this (e.g. 7d) (-a)" },
      { name: "state", type: "string", description: "Only match sessions in this state (-s)" },
      { name: "delete", type: "boolean", description: "Delete matched sessions instead of archiving" },
      { name: "dry-run", type: "boolean", description: "Report matches without archiving (-d)" },
      { name: "yes", type: "boolean", description: "Confirm archiving matched sessions (-y)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "clean",
    path: ["clean"],
    title: "clean",
    description: "Clean stale branches, worktrees, locks, and ledgers",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl clean",
    ],
    flags: [],
  },
  {
    id: "provider",
    path: ["provider"],
    title: "provider",
    description: "Show provider readiness or switch the active provider (provider set <name>)",
    category: "Configure",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl provider",
      "agentctl provider set codex",
      "agentctl provider --json",
    ],
    flags: [
      { name: "json", type: "boolean", description: "Output structured JSON provider list (-j)" },
    ],
  },
  {
    id: "providers",
    path: ["providers"],
    title: "providers",
    description: "List agent providers and whether this machine can reach them",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl providers",
      "agentctl providers --json",
      "agentctl provider set codex",
    ],
    flags: [
      { name: "json", type: "boolean", description: "Output structured JSON provider list (-j)" },
    ],
  },
  {
    id: "profile",
    path: ["profile"],
    title: "profile",
    description: "Show or set the verification profile",
    category: "Configure",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl profile",
      "agentctl profile --list",
      "agentctl profile --set max",
    ],
    flags: [
      { name: "list", type: "boolean", description: "List available verification profiles (-l)" },
      { name: "set", type: "string", description: "Set the active verification profile" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "ci",
    path: ["ci", "init"],
    title: "ci init",
    description: "Generate a stack-aware CI gate workflow",
    category: "Configure",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: ["ci-init"],
    examples: [
      "agentctl ci init",
      "agentctl ci init --target gitlab --force",
      "agentctl ci init --dry-run --json",
    ],
    flags: [
      { name: "target", type: "string", description: "CI target (github | gitlab, default: github)" },
      { name: "force", type: "boolean", description: "Overwrite existing workflow file (-f)" },
      { name: "dry-run", type: "boolean", description: "Report what would be written (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "review-repair",
    path: ["review-repair"],
    title: "review-repair",
    description: "Parse PR review comments and synthesize OODA repair tasks",
    category: "Repair",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl review-repair ./reviews.json",
    ],
    flags: [],
  },
  {
    id: "scan",
    path: ["scan"],
    title: "scan",
    description: "Scan codebase for TODO/FIXME task candidates",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl scan",
    ],
    flags: [],
  },
  {
    id: "rollback",
    path: ["rollback"],
    title: "rollback",
    description: "Restore git state and working tree to atomic pre-flight checkpoint",
    category: "Repair",
    mutates: true,
    risk: "high",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl rollback --latest",
      "agentctl rollback <sessionId> --json",
      'agentctl rollback --latest --reason "bad deploy"',
    ],
    flags: [
      { name: "reason", type: "string", description: "Rollback reason recorded in the handover (-r)" },
      { name: "intent", type: "string", description: "Intent recorded in the handover (-i)" },
      { name: "handover", type: "boolean", description: "Write a Baton Pass handover envelope (default: true)" },
      { name: "latest", type: "boolean", description: "Restore the newest checkpoint explicitly" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "resume",
    path: ["resume"],
    title: "resume",
    description: "Resume warm session with human response",
    category: "Operate",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      'agentctl resume <sessionId> --response "approved, continue"',
      "agentctl resume <sessionId> --dry-run --json",
    ],
    flags: [
      { name: "response", type: "string", description: "Human response text for the warm session (-r)" },
      { name: "dry-run", type: "boolean", description: "Simulate resume without provider call (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "test-gen",
    path: ["test-gen"],
    title: "test-gen",
    description: "Scaffold and run automated TDD Red-to-Green test cycle",
    category: "Create",
    mutates: true,
    risk: "moderate",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl test-gen --title my-feature --spec \"Handles EOF\"",
      "agentctl test-gen --title my-feature --run",
      "agentctl test-gen --title my-feature --json",
    ],
    flags: [
      { name: "title", type: "string", description: "Feature title for the generated test (-t)" },
      { name: "spec", type: "string", description: "Requirement specification text (-s)" },
      { name: "run", type: "boolean", description: "Run the TDD Red check after scaffolding (-r)" },
      { name: "dry-run", type: "boolean", description: "Simulate scaffolding without writing (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
  {
    id: "mcp",
    path: ["mcp"],
    title: "mcp",
    description: "Start stdio MCP server or scaffold IDE integration config (mcp init)",
    category: "Configure",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl mcp",
      "agentctl mcp init cursor",
      "agentctl mcp init --target vscode --dry-run",
    ],
    flags: [
      { name: "target", type: "string", description: "IDE target for init (cursor | vscode | claude | all) (-t)" },
      { name: "dry-run", type: "boolean", description: "Report what would be written for init (-d)" },
      { name: "json", type: "boolean", description: "Output structured JSON init result (-j)" },
    ],
  },
  {
    id: "hydrate",
    path: ["hydrate"],
    title: "hydrate",
    description: "Prepend active system learnings and baton-pass state to a prompt",
    category: "Inspect",
    mutates: false,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      'agentctl hydrate "Fix the flaky login test"',
      "agentctl hydrate",
    ],
    flags: [],
  },
  {
    id: "learning",
    path: ["learning"],
    title: "learning",
    description: "Record a system learning rule into .agent/knowledge/",
    category: "Operate",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      'agentctl learning add "flaky port bind" "retry with port 0"',
    ],
    flags: [],
  },
  {
    id: "rules",
    path: ["rules"],
    title: "rules",
    description: "Audit rule token budgets or compile rule sentinels (check | compile)",
    category: "Inspect",
    mutates: true,
    risk: "low",
    interactive: "never",
    requiresRepository: true,
    shortcuts: [],
    examples: [
      "agentctl rules check",
      "agentctl rules check --json",
      "agentctl rules compile --out .agent/rules.compiled.md",
    ],
    flags: [
      { name: "max-chars", type: "string", description: "Override max characters per file for check" },
      { name: "max-lines", type: "string", description: "Override max lines per file for check" },
      { name: "out", type: "string", description: "Write compiled rules to file for compile (-o)" },
      { name: "json", type: "boolean", description: "Output structured JSON result (-j)" },
    ],
  },
];

/**
 * Lookup command descriptor by ID, command path, or shortcut alias.
 * @param {string} idOrAlias
 * @returns {CommandDescriptor | null}
 */
export function getCommandDescriptor(idOrAlias) {
  if (!idOrAlias) return null;
  const target = String(idOrAlias).trim().toLowerCase();

  return (
    COMMAND_REGISTRY.find((cmd) => {
      if (cmd.id.toLowerCase() === target) return true;
      if (cmd.path.join(" ").toLowerCase() === target) return true;
      if (cmd.shortcuts.some((s) => s.toLowerCase() === target)) return true;
      return false;
    }) || null
  );
}

/**
 * List commands filtered by category.
 * @param {CommandCategory} [category]
 * @returns {CommandDescriptor[]}
 */
export function listCommandsByCategory(category) {
  if (!category) return COMMAND_REGISTRY;
  return COMMAND_REGISTRY.filter((cmd) => cmd.category === category);
}

/**
 * Format clean CLI --help text for a command descriptor.
 * @param {CommandDescriptor} descriptor
 * @returns {string}
 */
export function formatCommandHelp(descriptor) {
  const lines = [];
  lines.push(`Usage: agentctl ${descriptor.path.join(" ")} [flags]`);
  lines.push("");
  lines.push(`Description: ${descriptor.description}`);
  lines.push(`Category:    ${descriptor.category}`);
  lines.push(`Risk Tier:   ${descriptor.risk.toUpperCase()}`);
  lines.push("");

  if (descriptor.flags && descriptor.flags.length > 0) {
    lines.push("Flags:");
    for (const flag of descriptor.flags) {
      lines.push(`  --${flag.name.padEnd(16)} ${flag.description}`);
    }
    lines.push("");
  }

  if (descriptor.examples && descriptor.examples.length > 0) {
    lines.push("Examples:");
    for (const ex of descriptor.examples) {
      lines.push(`  $ ${ex}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format JSON representation of full command registry.
 * @returns {{ ok: true, commands: CommandDescriptor[] }}
 */
export function formatRegistryJson() {
  return {
    ok: true,
    commands: COMMAND_REGISTRY,
  };
}

/**
 * Format the full command registry as a Markdown reference document.
 * Single source of truth for docs/COMMAND_REFERENCE.md: the doc-sync gate
 * regenerates this string and diffs it against the file on disk.
 * @returns {string}
 */
export function formatRegistryMarkdown() {
  const lines = [];
  lines.push("# agentctl Command Reference");
  lines.push("");
  lines.push(
    "> Auto-generated from `src/ops/command-registry.mjs`. Do not edit by hand —",
    "run `node scripts/generate-command-reference.mjs` to regenerate."
  );
  lines.push("");
  lines.push(`Total commands: ${COMMAND_REGISTRY.length}`);
  lines.push("");
  lines.push("## Index");
  lines.push("");
  for (const cmd of COMMAND_REGISTRY) {
    const anchor = cmd.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    lines.push(`- [\`agentctl ${cmd.path.join(" ")}\`](#${anchor}) — ${cmd.description}`);
  }
  lines.push("");
  for (const cmd of COMMAND_REGISTRY) {
    lines.push(`## \`agentctl ${cmd.path.join(" ")}\``);
    lines.push("");
    lines.push(`**ID:** \`${cmd.id}\` · **Category:** ${cmd.category} · **Risk:** ${cmd.risk.toUpperCase()} · **Mutates:** ${cmd.mutates ? "yes" : "no"}`);
    lines.push("");
    lines.push(cmd.description);
    lines.push("");
    if (cmd.shortcuts && cmd.shortcuts.length > 0) {
      lines.push(`**Shortcuts:** ${cmd.shortcuts.map((s) => `\`${s}\``).join(", ")}`);
      lines.push("");
    }
    if (cmd.flags && cmd.flags.length > 0) {
      lines.push("**Flags:**");
      lines.push("");
      lines.push("| Flag | Type | Description |");
      lines.push("| :--- | :--- | :--- |");
      for (const flag of cmd.flags) {
        lines.push(`| \`--${flag.name}\` | ${flag.type} | ${flag.description} |`);
      }
      lines.push("");
    } else {
      lines.push("**Flags:** none.");
      lines.push("");
    }
    if (cmd.examples && cmd.examples.length > 0) {
      lines.push("**Examples:**");
      lines.push("");
      lines.push("```sh");
      for (const ex of cmd.examples) lines.push(ex);
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}
