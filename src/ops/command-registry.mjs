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
      { name: "dir", type: "string", description: "Target directory path for dir-size assertion" },
      { name: "file", type: "string", description: "Target file path for file-size assertion" },
      { name: "targets", type: "string", description: "Target glob/path for pattern matching" },
      { name: "patterns", type: "string", description: "Comma-separated patterns or regex to ban" },
      { name: "patterns-file", type: "string", description: "Path to JSON file containing banned patterns" },
      { name: "max-bytes", type: "string", description: "Maximum byte limit" },
      { name: "max-kb", type: "string", description: "Maximum KiB limit" },
      { name: "max-mb", type: "string", description: "Maximum MiB limit" },
      { name: "gzip", type: "boolean", description: "Measure gzip compressed byte size" },
      { name: "config", type: "string", description: "Path to assertion JSON/YAML config" },
      { name: "json", type: "boolean", description: "Output structured JSON assertion result" },
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
      "agentctl doctor --interactive",
      "agentctl doctor --fix safe --yes",
      "agentctl doctor --json",
    ],
    flags: [
      { name: "interactive", type: "boolean", description: "Open full-screen diagnostic matrix" },
      { name: "fix", type: "string", description: "Apply fix classes (e.g. 'safe' or check IDs)" },
      { name: "probe", type: "boolean", description: "Enable active network/execution probes" },
      { name: "json", type: "boolean", description: "Output structured JSON doctor report" },
      { name: "yes", type: "boolean", description: "Bypass interactive confirmation for safe fixes" },
    ],
  },
  {
    id: "queue",
    path: ["queue"],
    title: "queue",
    description: "Browse and manage canonical task queue",
    category: "Operate",
    mutates: false,
    risk: "low",
    interactive: "optional",
    requiresRepository: true,
    shortcuts: ["q"],
    examples: [
      "agentctl queue",
      "agentctl queue --interactive",
      "agentctl queue --json",
    ],
    flags: [
      { name: "interactive", type: "boolean", description: "Open full-screen queue dashboard" },
      { name: "json", type: "boolean", description: "Output structured JSON queue snapshot" },
      { name: "limit", type: "string", description: "Maximum tasks to include in snapshot" },
    ],
  },
  {
    id: "swarm",
    path: ["swarm"],
    title: "swarm",
    description: "Inspect active worker slots and concurrency scheduler",
    category: "Operate",
    mutates: false,
    risk: "low",
    interactive: "optional",
    requiresRepository: true,
    shortcuts: ["s"],
    examples: [
      "agentctl swarm",
      "agentctl swarm --interactive",
      "agentctl swarm --json",
    ],
    flags: [
      { name: "interactive", type: "boolean", description: "Open full-screen swarm dashboard" },
      { name: "json", type: "boolean", description: "Output structured JSON swarm snapshot" },
    ],
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
    shortcuts: ["tc", "create"],
    examples: [
      'agentctl task create --title "Fix webhook" --prompt "Add retry handling" --verify-cmd "npm test"',
      "agentctl task create --interactive",
    ],
    flags: [
      { name: "title", type: "string", description: "Short title for task" },
      { name: "prompt", type: "string", description: "Detailed task instructions" },
      { name: "verify-cmd", type: "string", description: "Verification command" },
      { name: "interactive", type: "boolean", description: "Launch interactive task wizard" },
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
      { name: "fix", type: "boolean", description: "Synthesize optimized markdown task envelope" },
      { name: "json", type: "boolean", description: "Output structured JSON prompt evaluation" },
      { name: "file", type: "string", description: "Path to text file containing task prompt" },
      { name: "dir", type: "string", description: "Target repository directory root" },
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
      { name: "tier", type: "string", description: "Target configuration tier (free, pro, ultra, enterprise)" },
      { name: "interactive", type: "boolean", description: "Launch interactive onboarding wizard" },
      { name: "yes", type: "boolean", description: "Accept auto-detected Stack Oracle defaults" },
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
    ],
    flags: [
      { name: "port", type: "string", description: "HTTP server port (default 3000)" },
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
      "agentctl budget reset --dry-run",
      "agentctl budget reset --yes",
    ],
    flags: [
      { name: "json", type: "boolean", description: "Output structured JSON budget snapshot" },
      { name: "dry-run", type: "boolean", description: "Report what reset would release, write nothing" },
      { name: "yes", type: "boolean", description: "Confirm releasing today's open reservations" },
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
      { name: "reason", type: "string", description: "Escalation reason category" },
      { name: "branch", type: "string", description: "Target git branch" },
      { name: "logs", type: "string", description: "Error logs text" },
      { name: "critical", type: "boolean", description: "Bypass Silence Governor and alert immediately" },
      { name: "flush", type: "boolean", description: "Flush buffered escalation digest" },
      { name: "status", type: "boolean", description: "Inspect digest status and interruption budget" },
      { name: "clear", type: "boolean", description: "Clear pending digest buffer" },
      { name: "dry-run", type: "boolean", description: "Simulate dispatch without sending HTTP requests" },
      { name: "json", type: "boolean", description: "Output JSON structured response" },
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
      { name: "role", type: "string", description: "Agent persona role (default: janitor)" },
      { name: "test-cmd", type: "string", description: "Target specific test command" },
      { name: "dry-run", type: "boolean", description: "Simulate healing swarm generation without writing" },
      { name: "json", type: "boolean", description: "Output JSON structured response" },
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
      { name: "intent", type: "string", description: "Task intent or goal description" },
      { name: "status", type: "string", description: "Handover status (aborted, rolled-back, escalated, failed)" },
      { name: "landmines", type: "string", description: "Obstacles or error summary" },
      { name: "next-steps", type: "string", description: "Actionable next steps for successor agent" },
      { name: "json", type: "boolean", description: "Output JSON structured response" },
      { name: "limit", type: "string", description: "Maximum handovers to list" },
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
