import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { filterDiffByPaths } from "./git.mjs";

/**
 * The learning ledger, and why it needs the same discipline as the rest.
 *
 * Everything recorded here is prepended to every future dispatch prompt, so
 * this file decides what the agent is told is true. That makes it the one
 * place where a single observation could quietly become a permanent rule.
 *
 * It did. `harvestFailure` fired on every OODA loop that exhausted its retry
 * budget, and wrote a `solution` that was a hardcoded sentence — identical on
 * every call, regardless of what had gone wrong or whether it was ever fixed.
 * Its `trigger` carried 120 characters of raw log line, so the exact-string
 * dedup never matched twice and every occurrence appended a fresh row. The
 * ledger grew without bound, `hydratePrompt`'s fallback drew its five "most
 * recent" from that pool, and the agent was handed five near-identical
 * non-facts dressed as rules.
 *
 * Two mechanisms in this codebase already solve exactly this evidence
 * problem, and this module was the one learning path that skipped both:
 * `flaky-ledger.mjs` will not call a test flaky from one bad run — it wants a
 * Wilson interval over repeated runs first; `remediation.mjs` is
 * fingerprint-keyed and deliberately short-lived, and never claims a durable
 * rule from one data point.
 *
 * So: harvested entries are normalized to a signature, counted, and stay out
 * of the prompt until they have recurred. Entries a person or an agent wrote
 * down on purpose are confirmed immediately — someone chose to state them,
 * which is evidence of a different kind.
 */

/** Recurrences an observed failure needs before it is injected as a rule. */
export const CONFIRM_AFTER = 3;

/** Upper bound on the ledger, so it cannot grow until it is all noise. */
const MAX_ENTRIES = 200;

function atomicWrite(file, content) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export function getLearningsPath(root = process.cwd()) {
  return join(root, ".agent", "knowledge", "learnings.json");
}

export function getSystemLearningsMdPath(root = process.cwd()) {
  return join(root, ".agent", "SYSTEM_LEARNINGS.md");
}

/**
 * Strip the parts of a failure message that differ between two occurrences of
 * the same failure.
 *
 * Line numbers, temp directories, addresses, durations and ids are what made
 * every recurrence look new. What is left is the shape: the error class and a
 * generalized message. Ordering matters — paths are collapsed before line
 * numbers, so `/tmp/x-92ab/foo.js:14:9` does not lose its basename first.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTrigger(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/g, "<addr>")
    .replace(/(?:[a-z]:)?[\\/](?:tmp|temp|var[\\/]folders|private[\\/]var)[\\/][^\s'"]*/g, "<tmp>")
    .replace(/(?:[a-z]:)?[\\/](?:[\w.@-]+[\\/])+([\w.@-]+)/g, "$1")
    .replace(/:\d+(?::\d+)?\b/g, ":<line>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|kb|mb|gb|bytes)\b/g, "<duration>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A stable key for "the same failure, seen again".
 *
 * @param {string} category
 * @param {string} trigger
 * @returns {string} 16 hex characters
 */
export function learningSignature(category = "GENERAL", trigger = "") {
  return createHash("sha256")
    .update(`${String(category).toLowerCase()}\u0000${normalizeTrigger(trigger)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Read the ledger, filling in the fields older files do not have.
 *
 * A ledger written before signatures existed is not wrong, only unlabelled:
 * every entry in it was recorded deliberately, so it is treated as confirmed.
 * Silently dropping those would lose real knowledge on upgrade.
 */
export function loadLearnings(root = process.cwd()) {
  const dbFile = getLearningsPath(root);
  if (!existsSync(dbFile)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(dbFile, "utf8"));
  } catch (_) {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  return raw.map((l) => ({
    ...l,
    signature: l.signature || learningSignature(l.category, l.trigger),
    occurrences: Number.isFinite(l.occurrences) ? l.occurrences : 1,
    origin: l.origin || "manual",
    firstSeen: l.firstSeen || l.date || null,
    lastSeen: l.lastSeen || l.date || null,
    confirmed: l.confirmed !== undefined ? l.confirmed : true,
  }));
}

/** Confirmed entries carrying an actual remedy — the only ones stated as rules. */
const isRule = (l) => l.confirmed && typeof l.solution === "string" && l.solution.trim().length > 0;

/**
 * Drop the least valuable entries once the ledger is over its bound.
 *
 * Unconfirmed before confirmed, fewer occurrences before more, older before
 * newer. Nothing that has earned rule status is discarded while an
 * unconfirmed observation is still taking up space.
 */
function prune(db) {
  if (db.length <= MAX_ENTRIES) return db;
  const ranked = [...db].sort((a, b) => {
    if (isRule(a) !== isRule(b)) return isRule(a) ? -1 : 1;
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""));
  });
  return ranked.slice(0, MAX_ENTRIES);
}

function renderMarkdown(db) {
  const sanitize = (str) => String(str).replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
  const rules = db.filter(isRule);
  const pending = db.filter((l) => !isRule(l));

  let md = `<!-- 🚫 AUTO-GENERATED. AGENTS: DO NOT EDIT THIS FILE DIRECTLY. -->\n`;
  md += `# 🧠 System Learnings & Platform Quirks\n\n`;
  md += `> **⚠️ TO AGENTS:** NEVER edit this file manually. Record learnings via:\n`;
  md += `> \`agentctl learning add "<trigger>" "<solution>"\`\n\n`;
  md += `| Date | Agent | Seen | Trigger / Symptom | Mandatory Rule / Solution |\n`;
  md += `| :--- | :--- | ---: | :--- | :--- |\n`;
  for (const l of rules) {
    md += `| ${l.date} | \`${l.agent}\` | ${l.occurrences} | ${sanitize(l.trigger)} | **${sanitize(l.solution)}** |\n`;
  }

  if (pending.length > 0) {
    md += `\n## Unconfirmed observations\n\n`;
    md += `> Recorded, not yet acted on. A failure seen once is not a rule; these\n`;
    md += `> are listed so a person can look, and are **not** injected into agent\n`;
    md += `> prompts. They become rules at ${CONFIRM_AFTER} occurrences, or when someone\n`;
    md += `> records an actual remedy for one.\n\n`;
    md += `| First seen | Last seen | Seen | Observation |\n`;
    md += `| :--- | :--- | ---: | :--- |\n`;
    for (const l of pending) {
      md += `| ${l.firstSeen || l.date} | ${l.lastSeen || l.date} | ${l.occurrences} | ${sanitize(l.trigger)} |\n`;
    }
  }
  return md;
}

/**
 * Record a learning, or count another occurrence of one already known.
 *
 * @param {string} root
 * @param {object} learning
 * @param {string} [learning.agent]
 * @param {string} learning.trigger
 * @param {string} [learning.solution] - required unless this is an observation.
 * @param {string} [learning.category]
 * @param {"manual"|"harvest"} [learning.origin] - `manual` is confirmed on
 *   sight: somebody chose to write it down. `harvest` is an observation and
 *   must recur before it is stated as a rule.
 * @returns {{ recorded: boolean, count: number, signature: string, occurrences: number, confirmed: boolean }}
 */
export function recordLearning(root = process.cwd(), learning = {}) {
  const { agent = "agent", trigger, solution, category = "GENERAL", origin = "manual" } = learning;
  if (!trigger || (!solution && origin !== "harvest")) {
    throw new Error("Trigger and solution are required to record a learning.");
  }

  const db = loadLearnings(root);
  const cleanTrigger = String(trigger).trim();
  const cleanSolution = solution ? String(solution).trim() : null;
  const signature = learningSignature(category, cleanTrigger);
  const today = new Date().toISOString().split("T")[0];

  const existing = db.find((l) => l.signature === signature);
  let recorded;
  let entry;

  if (existing) {
    // Update in place. Appending a sibling row for the same failure is what
    // filled the ledger with near-duplicates in the first place.
    existing.occurrences += 1;
    existing.lastSeen = today;
    if (cleanSolution && !existing.solution) existing.solution = cleanSolution;
    if (cleanSolution && existing.solution !== cleanSolution && origin === "manual") {
      existing.solution = cleanSolution;
    }
    if (origin === "manual") existing.confirmed = true;
    else if (existing.occurrences >= CONFIRM_AFTER && existing.solution) existing.confirmed = true;
    entry = existing;
    // An occurrence of something already known is not a new record. The
    // caller's contract — and the CLI's "recorded" line — means "is this new".
    recorded = false;
  } else {
    entry = {
      date: today,
      firstSeen: today,
      lastSeen: today,
      agent,
      category,
      trigger: cleanTrigger,
      solution: cleanSolution,
      signature,
      occurrences: 1,
      origin,
      confirmed: origin === "manual",
    };
    db.push(entry);
    recorded = true;
  }

  const pruned = prune(db);
  atomicWrite(getLearningsPath(root), JSON.stringify(pruned, null, 2));
  atomicWrite(getSystemLearningsMdPath(root), renderMarkdown(pruned));

  return {
    recorded,
    count: pruned.length,
    signature,
    occurrences: entry.occurrences,
    confirmed: Boolean(entry.confirmed),
  };
}

export function hydratePrompt(root = process.cwd(), promptText = "", opts = {}) {
  const max = opts.max || 5;
  const all = loadLearnings(root);
  const learnings = all.filter(isRule);
  const observations = all.filter((l) => !isRule(l));
  if (learnings.length === 0 && !observations.some((l) => l.occurrences >= CONFIRM_AFTER)) {
    return promptText;
  }

  const lowerPrompt = promptText.toLowerCase();
  const matched = learnings
    .filter((l) => {
      const triggerWords = l.trigger.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      return triggerWords.some((w) => lowerPrompt.includes(w));
    })
    .slice(0, max);

  // Without a keyword match, recency alone chose whatever happened to be
  // appended last — which, while every OODA failure appended a row, meant the
  // five least considered entries in the file. Prefer what has been seen most.
  const activeLearnings =
    matched.length > 0
      ? matched
      : [...learnings]
          .sort((a, b) => {
            if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
            return String(b.lastSeen || b.date || "").localeCompare(String(a.lastSeen || a.date || ""));
          })
          .slice(0, max);

  let header = "\n";
  if (activeLearnings.length > 0) header += "\n<ACTIVE_SYSTEM_LEARNINGS>\n";
  if (activeLearnings.length > 0) header += "The following platform quirks & resolution rules apply to this task:\n";
  activeLearnings.forEach((l) => {
    header += `- [${l.category || "RULE"}] WHEN: ${l.trigger} → THEN: ${l.solution}\n`;
  });
  if (activeLearnings.length > 0) header += "</ACTIVE_SYSTEM_LEARNINGS>\n";

  // Recurrence is worth telling the agent. A remedy nobody found is not.
  //
  // This block is where CONFIRM_AFTER earns its place: a failure class the
  // repair loop has given up on several times is real information, and stating
  // it as a count is honest in a way `WHEN … → THEN …` is not. It is kept in
  // its own block, in the past tense, so nothing here can be read as an
  // instruction.
  const recurring = observations
    .filter((l) => l.occurrences >= CONFIRM_AFTER)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, max);
  if (recurring.length > 0) {
    header += "\n<RECURRING_FAILURES>\n";
    header += "Observed repeatedly and never resolved. No fix is known for these:\n";
    recurring.forEach((l) => {
      header += `- seen ${l.occurrences}×: ${l.trigger}\n`;
    });
    header += "</RECURRING_FAILURES>\n";
  }

  // Check for baton pass state
  const batonFile = join(root, ".agent", "state", "baton_pass.json");
  let batonBlock = "";
  if (existsSync(batonFile)) {
    try {
      const baton = JSON.parse(readFileSync(batonFile, "utf8"));
      batonBlock = `\n<BATON_PASS_STATE>\n`;
      batonBlock += `Previous Task ID: ${baton.taskId || "unknown"}\n`;
      batonBlock += `Last Status: ${baton.status || "BLOCKED"}\n`;
      if (baton.summary) batonBlock += `Summary: ${baton.summary}\n`;
      batonBlock += `</BATON_PASS_STATE>\n`;
    } catch (_) {}
  }

  return `${header}${batonBlock}\n${promptText}`;
}

export function harvestFailure(root = process.cwd(), opts = {}) {
  const { exitCode = 4, logPath, diffText = "", taskId = "unknown", agent = "jules" } = opts;

  let logContent = "";
  if (logPath && existsSync(logPath)) {
    try {
      logContent = readFileSync(logPath, "utf8");
    } catch (_) {}
  }

  // Guard: Test Weakening check
  const testWeakeningRegex = /-\s*(it\(|test\(|expect\(|assert\.)/g;
  if (testWeakeningRegex.test(diffText)) {
    return { status: "REJECTED", reason: "TEST_WEAKENING: Attempted to delete or weaken test assertions." };
  }

  // Guard: Diff Limit check (75 KiB limit)
  const MAX_DIFF_BYTES = 75 * 1024;
  if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
    const pruned = filterDiffByPaths(diffText);
    if (Buffer.byteLength(pruned.diff, "utf8") > MAX_DIFF_BYTES) {
      return { status: "REJECTED", reason: "DIFF_PAYLOAD_LIMIT: Diff payload exceeds 75 KiB limit." };
    }
  }

  // Extract error trace line
  const errorLine = logContent.split("\n").find((line) => /Error:|FAIL|TypeError|AssertionError/.test(line)) || "Unknown execution failure";

  // No solution. There isn't one — the repair loop exhausted its budget, which
  // is the definition of not having found a fix. The previous version wrote a
  // fixed sentence into the `solution` field and shipped it to the agent in
  // `WHEN … → THEN …` form, so a record of *failing* to solve something read
  // as instructions for solving it. Recording that this failure class recurs
  // is worth doing; dressing it as a remedy is not.
  const candidate = {
    agent,
    category: "OODA_HARVEST",
    trigger: `[OODA Exit ${exitCode}] ${errorLine.slice(0, 120)}`,
    origin: "harvest",
    taskId,
  };

  const res = recordLearning(root, candidate);
  return {
    status: "HARVESTED",
    candidate,
    recorded: res.recorded,
    occurrences: res.occurrences,
    confirmed: res.confirmed,
  };
}
