import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../security.mjs";
import { resolveRoot } from "../config.mjs";

export class HandoverError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "HandoverError";
    this.code = opts.code || 1;
  }
}

/**
 * @typedef {"aborted" | "escalated" | "rolled-back" | "quarantined" | "completed" | "failed"} HandoverStatus
 *
 * @typedef {Object} HandoverPayload
 * @property {string} sessionId
 * @property {HandoverStatus} [status]
 * @property {string} [intent]
 * @property {string[] | string} [completed]
 * @property {string[] | string} [assumptions]
 * @property {string[] | string} [landmines]
 * @property {string[] | string} [nextSteps]
 * @property {string[]} [referencedPaths]
 * @property {string} [branch]
 * @property {string} [headSha]
 * @property {string} [diffSummary]
 * @property {Record<string, any>} [metadata]
 */

/**
 * Ensures handover storage directory exists.
 * @param {string} root
 * @returns {string} Absolute path to .agent/handovers directory
 */
export function getHandoverDir(root = resolveRoot()) {
  const dir = join(root, ".agent", "handovers");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new HandoverError(`Invalid handover session id: "${sessionId}"`);
  }
}

function toItemArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

function sanitizeText(value) {
  if (!value) return "";
  return redactSecrets(String(value).trim());
}

function writeFileAtomically(filePath, content) {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeSync(fd, content, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
    try { unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

/**
 * Creates and persists a Baton Pass handover manifest in .agent/handovers/YYYY-MM-DD-[sessionId].md.
 *
 * @param {string} root - Project root directory
 * @param {HandoverPayload} data - Handover details
 * @param {Object} [options]
 * @param {number} [options.maxRetention=20] - Max handovers to retain
 * @returns {{ sessionId: string, filePath: string, createdAt: string, status: string, markdown: string }}
 */
export function createHandover(root = resolveRoot(), data = {}, options = {}) {
  const handoverDir = getHandoverDir(root);
  const sessionId = data.sessionId || `session-${Date.now()}`;
  assertSessionId(sessionId);

  const createdAt = data.createdAt || new Date().toISOString();
  const datePrefix = createdAt.substring(0, 10);
  const status = data.status || "aborted";
  const branch = sanitizeText(data.branch || "");
  const headSha = sanitizeText(data.headSha || "");

  const intent = sanitizeText(data.intent || "");
  const completed = toItemArray(data.completed).map(sanitizeText);
  const assumptions = toItemArray(data.assumptions).map(sanitizeText);
  const landmines = toItemArray(data.landmines).map(sanitizeText);
  const nextSteps = toItemArray(data.nextSteps).map(sanitizeText);
  const referencedPaths = (Array.isArray(data.referencedPaths) ? data.referencedPaths : [])
    .map((p) => sanitizeText(p))
    .filter(Boolean);
  const diffSummary = sanitizeText(data.diffSummary || "");

  const fileName = `${datePrefix}-${sessionId}.md`;
  const filePath = join(handoverDir, fileName);

  // Build YAML frontmatter + structured markdown
  const frontmatterLines = [
    "---",
    "schema: agentctl/handover-v1",
    `session_id: "${sessionId}"`,
    `created_at: "${createdAt}"`,
    `status: "${status}"`,
  ];
  if (branch) frontmatterLines.push(`branch: "${branch}"`);
  if (headSha) frontmatterLines.push(`head_sha: "${headSha}"`);
  if (referencedPaths.length > 0) {
    frontmatterLines.push("referenced_paths:");
    for (const p of referencedPaths) {
      frontmatterLines.push(`  - "${p}"`);
    }
  }
  frontmatterLines.push("---", "");

  const bodySections = [
    `# Agent Handover: ${sessionId}`,
    "",
    `**Status:** \`${status}\`  `,
    `**Recorded At:** \`${createdAt}\`  `,
    branch ? `**Branch:** \`${branch}\`  ` : "",
    headSha ? `**Commit HEAD:** \`${headSha}\`  ` : "",
    "",
    "## Intent",
    intent ? intent : "*(No specific intent recorded)*",
    "",
    "## Completed Work",
    completed.length > 0 ? completed.map((c) => `- ${c}`).join("\n") : "*(No completed steps recorded)*",
    "",
    "## Validated Assumptions",
    assumptions.length > 0 ? assumptions.map((a) => `- ${a}`).join("\n") : "*(No explicit assumptions noted)*",
    "",
    "## Landmines & Failures",
    landmines.length > 0 ? landmines.map((l) => `- ${l}`).join("\n") : "*(No blockers or landmines reported)*",
    "",
    "## Recommended Next Steps",
    nextSteps.length > 0 ? nextSteps.map((s) => `- ${s}`).join("\n") : "*(No immediate next steps specified)*",
  ].filter(Boolean);

  if (referencedPaths.length > 0) {
    bodySections.push(
      "",
      "## Referenced Paths",
      ...referencedPaths.map((p) => `- \`${p}\``)
    );
  }

  if (diffSummary) {
    bodySections.push(
      "",
      "## Diff Summary",
      "```text",
      diffSummary,
      "```"
    );
  }

  bodySections.push("");
  const fullContent = frontmatterLines.join("\n") + bodySections.join("\n");

  writeFileAtomically(filePath, fullContent);

  const retention = typeof options.maxRetention === "number" ? options.maxRetention : 20;
  if (retention > 0) {
    pruneHandovers(root, retention);
  }

  return {
    sessionId,
    filePath,
    createdAt,
    status,
    markdown: fullContent,
  };
}

/**
 * Loads and parses a handover file by sessionId or filepath.
 *
 * @param {string} root
 * @param {string} sessionIdOrPath
 * @returns {Object} Structured handover object
 */
export function loadHandover(root = resolveRoot(), sessionIdOrPath = "") {
  const handoverDir = resolve(root, ".agent", "handovers");
  let targetPath;

  if (!sessionIdOrPath || typeof sessionIdOrPath !== "string") {
    throw new HandoverError("Handover session id or path is required");
  }

  if (sessionIdOrPath.endsWith(".md")) {
    targetPath = isAbsolute(sessionIdOrPath) ? resolve(sessionIdOrPath) : resolve(root, sessionIdOrPath);
    const rel = relative(handoverDir, targetPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new HandoverError(`Handover path escapes handovers directory: ${sessionIdOrPath}`);
    }
  } else {
    assertSessionId(sessionIdOrPath);
    // Find matching file in directory with date prefix
    const files = existsSync(handoverDir) ? readdirSync(handoverDir).filter((f) => f.endsWith(".md")) : [];
    const match = files.find((f) => f === `${sessionIdOrPath}.md` || f.endsWith(`-${sessionIdOrPath}.md`));
    if (!match) {
      throw new HandoverError(`Handover file not found for session "${sessionIdOrPath}"`);
    }
    targetPath = join(handoverDir, match);
  }

  if (!existsSync(targetPath)) {
    throw new HandoverError(`Handover file not found: ${targetPath}`);
  }

  const raw = readFileSync(targetPath, "utf-8");

  // Parse YAML Frontmatter
  let frontmatter = {};
  let markdownBody = raw;
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split(/\r?\n/);
    markdownBody = fmMatch[2];
    for (const line of fmLines) {
      const kv = line.match(/^([a-z_]+):\s*(?:"(.*)"|(.*))$/);
      if (kv) {
        frontmatter[kv[1]] = (kv[2] !== undefined ? kv[2] : kv[3] || "").trim();
      }
    }
  }

  // Parse markdown sections
  function extractSection(title) {
    const regex = new RegExp(`## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "i");
    const m = markdownBody.match(regex);
    if (!m) return "";
    return m[1].trim();
  }

  function extractListSection(title) {
    const section = extractSection(title);
    if (!section || section.startsWith("*(")) return [];
    return section
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^`|`$/g, "").trim())
      .filter(Boolean);
  }

  const intentRaw = extractSection("Intent");
  const intent = intentRaw.startsWith("*(") ? "" : intentRaw;

  return {
    schema: frontmatter.schema || "agentctl/handover-v1",
    sessionId: frontmatter.session_id || basename(targetPath, ".md"),
    createdAt: frontmatter.created_at || new Date(statSync(targetPath).mtimeMs).toISOString(),
    status: frontmatter.status || "aborted",
    branch: frontmatter.branch || "",
    headSha: frontmatter.head_sha || "",
    referencedPaths: extractListSection("Referenced Paths"),
    intent,
    completed: extractListSection("Completed Work"),
    assumptions: extractListSection("Validated Assumptions"),
    landmines: extractListSection("Landmines & Failures"),
    nextSteps: extractListSection("Recommended Next Steps"),
    rawMarkdown: raw,
    filePath: targetPath,
  };
}

/**
 * Lists all handovers in .agent/handovers/ ordered by creation timestamp descending.
 *
 * @param {string} root
 * @returns {Array<{ sessionId: string, status: string, createdAt: string, filePath: string, intent: string }>}
 */
export function listHandovers(root = resolveRoot()) {
  const handoverDir = getHandoverDir(root);
  if (!existsSync(handoverDir)) return [];

  const files = readdirSync(handoverDir).filter((f) => f.endsWith(".md"));
  const items = [];

  for (const file of files) {
    const filePath = join(handoverDir, file);
    try {
      const parsed = loadHandover(root, filePath);
      items.push({
        sessionId: parsed.sessionId,
        status: parsed.status,
        createdAt: parsed.createdAt,
        filePath,
        intent: parsed.intent,
      });
    } catch (_) {}
  }

  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return items;
}

/**
 * Prunes handovers keeping only the most recent N files.
 *
 * @param {string} root
 * @param {number} [maxRetention=20]
 * @returns {number} Count of pruned files
 */
export function pruneHandovers(root = resolveRoot(), maxRetention = 20) {
  const list = listHandovers(root);
  if (list.length <= maxRetention) return 0;

  const toRemove = list.slice(maxRetention);
  let prunedCount = 0;

  for (const item of toRemove) {
    try {
      if (existsSync(item.filePath)) {
        unlinkSync(item.filePath);
        prunedCount++;
      }
    } catch (_) {}
  }

  return prunedCount;
}

/**
 * Formats a handover object into a compact, token-efficient prompt context block.
 *
 * @param {Object} handover - Parsed handover object
 * @returns {string} Formatted [SESSION_HANDOVER_CONTEXT] string
 */
export function formatHandoverPromptContext(handover) {
  if (!handover || typeof handover !== "object") return "";

  const lines = [
    "[SESSION_HANDOVER_CONTEXT]",
    `Previous Session: ${handover.sessionId || "unknown"} (Status: ${handover.status || "aborted"}, Created: ${handover.createdAt || "N/A"})`,
  ];

  if (handover.intent) {
    lines.push(`Prior Intent: ${handover.intent}`);
  }

  if (Array.isArray(handover.completed) && handover.completed.length > 0) {
    lines.push("Completed Progress:");
    for (const c of handover.completed) {
      lines.push(`  - ${c}`);
    }
  }

  if (Array.isArray(handover.assumptions) && handover.assumptions.length > 0) {
    lines.push("Validated Assumptions:");
    for (const a of handover.assumptions) {
      lines.push(`  - ${a}`);
    }
  }

  if (Array.isArray(handover.landmines) && handover.landmines.length > 0) {
    lines.push("Obstacles & Landmines:");
    for (const l of handover.landmines) {
      lines.push(`  - ${l}`);
    }
  }

  if (Array.isArray(handover.nextSteps) && handover.nextSteps.length > 0) {
    lines.push("Recommended Next Steps:");
    for (const s of handover.nextSteps) {
      lines.push(`  - ${s}`);
    }
  }

  if (Array.isArray(handover.referencedPaths) && handover.referencedPaths.length > 0) {
    lines.push(`Referenced Files: ${handover.referencedPaths.join(", ")}`);
  }

  lines.push("[/SESSION_HANDOVER_CONTEXT]");
  return lines.join("\n");
}
