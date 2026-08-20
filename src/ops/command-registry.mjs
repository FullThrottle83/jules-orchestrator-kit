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
