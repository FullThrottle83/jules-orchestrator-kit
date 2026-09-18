import { git, runCmd, resolveBase } from "./git.mjs";
import { checkScope } from "./security.mjs";
import { normalizeScope } from "./config.mjs";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

/**
 * Validates a Task Envelope before dispatch or during CI triage.
 * Prevents execution on fabricated premises (missing files/tests) or stale bases.
 *
 * @param {Object} envelope - Task envelope payload
 * @param {Object} [opts] - Options (root, maxBehindCommits, maxBaseAgeHours)
 * @returns {{ ok: boolean, code?: number, errors: string[], warnings: string[] }}
 */
export function validateEnvelope(envelope = {}, opts = {}) {
  const root = opts.root || process.cwd();
  const maxBehind = opts.maxBehindCommits ?? 25;
  const maxAgeHours = opts.maxBaseAgeHours ?? 24;
  const errors = [];
  const warnings = [];

  if (!envelope || typeof envelope !== "object") {
    return { ok: false, code: 1, errors: ["Envelope must be a non-null object"], warnings: [] };
  }

  // 1. Mandatory Fields
  const rawIntent = (envelope.intent && typeof envelope.intent === "object")
    ? envelope.intent.outcome
    : (envelope.intent || envelope.title || envelope.prompt);
  if (!rawIntent || typeof rawIntent !== "string" || !rawIntent.trim()) {
    errors.push("Envelope missing required 'intent' string.");
  }

  // 2. Base Commit & Freshness Check
  const baseCommit = envelope.base_commit || envelope.baseCommit || envelope.base_sha || envelope.baseSha || "main";
  let resolvedBase = null;
  try {
    resolvedBase = resolveBase(root, baseCommit);
  } catch (_) {
    try {
      resolvedBase = resolveBase(root, "HEAD");
    } catch (_) {
      resolvedBase = null;
    }
  }

  if (resolvedBase) {
    try {
      const behindStr = git(["rev-list", "--count", `${resolvedBase}..origin/main`], { cwd: root, ignoreError: true });
      const behindCount = parseInt(behindStr || "0", 10);
      if (!isNaN(behindCount) && behindCount > maxBehind) {
        errors.push(`Stale base commit: base is ${behindCount} commits behind origin/main (max allowed: ${maxBehind}).`);
      }

      const commitTimeStr = git(["show", "-s", "--format=%ct", resolvedBase], { cwd: root, ignoreError: true });
      const commitTimestamp = parseInt(commitTimeStr || "0", 10);
      if (commitTimestamp > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const ageHours = (nowSec - commitTimestamp) / 3600;
        if (ageHours > maxAgeHours) {
          warnings.push(`Base commit is ${Math.round(ageHours)}h old (exceeds recommended ${maxAgeHours}h).`);
        }
      }
    } catch (_) {
      // Git commit range checks are non-blocking if origin/main is not fetched locally
    }
  }

  // 3. Premise Check: Referenced Paths Must Exist
  if (Array.isArray(envelope.referenced_paths)) {
    for (const relPath of envelope.referenced_paths) {
      if (typeof relPath !== "string") continue;
      const absPath = resolve(root, relPath);
      const rootRelative = relative(resolve(root), absPath);
      if (isAbsolute(rootRelative) || rootRelative === ".." || rootRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        errors.push(`Premise failure: referenced path '${relPath}' escapes repository root.`);
        continue;
      }
      let existsInGit = false;
      if (resolvedBase) {
        const catRes = runCmd(["git", "cat-file", "-e", `${resolvedBase}:${relPath}`], { cwd: root, ignoreError: true });
        existsInGit = catRes.status === 0;
      }
      const existsOnDisk = existsSync(absPath);
      if (!existsInGit && !existsOnDisk) {
        errors.push(`Premise failure: referenced path '${relPath}' does not exist at base '${baseCommit}' or on disk.`);
      }
    }
  }

  // 4. Allowed Paths & Protected Scope Check
  const riskObj = envelope.risk && typeof envelope.risk === "object" ? envelope.risk : {};
  const rawLane = riskObj.lane || envelope.risk_lane || envelope.riskLane;
  const riskLane = rawLane ? String(rawLane).toLowerCase() : (envelope.flags?.requirePlanApproval ? "amber" : "green");
  const allowProtected = opts.allowProtected ?? (riskLane === "amber" && Boolean(envelope.flags?.requirePlanApproval || riskObj.require_plan_approval));

  if (riskLane === "red") {
    errors.push("Red-lane tasks are outside autonomous agent delegation boundaries (unsupervised high-impact, custom crypto, un-oracleable).");
  } else if (riskLane === "orange") {
    warnings.push("Orange-lane task: candidate generation only. Execution must be conducted outside Jules via protected control plane.");
  }

  const allowPaths = envelope.allowed_paths || envelope.scope?.allow;
  if (Array.isArray(allowPaths) && allowPaths.length > 0) {
    const scope = normalizeScope(opts.scopeConfig || {});
    const scopeCheck = checkScope(allowPaths, scope, { allowProtected });
    if (!scopeCheck.ok) {
      const hasProtectedViolation = scopeCheck.violations.some((v) => v.rule === "protect");
      if (hasProtectedViolation && !allowProtected) {
        errors.push(
          `Allowed paths violate protected scope: ${scopeCheck.violations.map((v) => `${v.file} (${v.reason})`).join(", ")}. Modifying protected paths requires risk.lane 'amber' and requirePlanApproval: true.`
        );
      } else {
        errors.push(`Allowed paths violate protected scope: ${scopeCheck.violations.map((v) => `${v.file} (${v.reason})`).join(", ")}`);
      }
    }
  }

  // 5. Acceptance Criteria & Verification Commands
  if (envelope.acceptance_criteria !== undefined) {
    if (!Array.isArray(envelope.acceptance_criteria) || envelope.acceptance_criteria.length === 0) {
      errors.push("acceptance_criteria must be a non-empty array of strings when provided.");
    }
  } else if (envelope.verification?.commands !== undefined) {
    if (!Array.isArray(envelope.verification.commands) || envelope.verification.commands.length === 0) {
      errors.push("verification.commands must be a non-empty array of strings when provided.");
    }
  }

  if (envelope.verification && typeof envelope.verification === "object") {
    if (envelope.verification.require_nonzero_test_count !== undefined && typeof envelope.verification.require_nonzero_test_count !== "boolean") {
      errors.push("verification.require_nonzero_test_count must be a boolean when provided.");
    }
    if (envelope.verification.trusted_base !== undefined && typeof envelope.verification.trusted_base !== "string") {
      errors.push("verification.trusted_base must be a string when provided.");
    }
  }

  // 6. Concurrency Group Check
  if (envelope.concurrency_group !== undefined) {
    if (typeof envelope.concurrency_group !== "string" || !envelope.concurrency_group.trim()) {
      errors.push("concurrency_group must be a non-empty string when provided.");
    }
  }

  // 7. Invariants Check
  if (envelope.invariants !== undefined && !Array.isArray(envelope.invariants)) {
    errors.push("invariants must be an array of strings when provided.");
  }

  // 8. MCP Directives Check
  if (envelope.mcp_directives !== undefined && !Array.isArray(envelope.mcp_directives)) {
    errors.push("mcp_directives must be an array of strings when provided.");
  }

  // 9. Risk Object Check
  if (envelope.risk !== undefined) {
    if (typeof envelope.risk !== "object" || envelope.risk === null) {
      errors.push("risk must be an object when provided.");
    } else {
      if (envelope.risk.lane !== undefined && !["green", "amber", "orange", "red"].includes(String(envelope.risk.lane).toLowerCase())) {
        errors.push("risk.lane must be one of 'green', 'amber', 'orange', 'red' when provided.");
      }
      if (envelope.risk.require_plan_approval !== undefined && typeof envelope.risk.require_plan_approval !== "boolean") {
        errors.push("risk.require_plan_approval must be a boolean when provided.");
      }
    }
  }

  // 10. Circuit Breaker Check
  const cb = envelope.circuit_breaker || envelope.circuitBreaker;
  if (cb !== undefined) {
    if (typeof cb !== "object" || cb === null) {
      errors.push("circuitBreaker must be an object when provided.");
    } else {
      if (cb.max_attempts !== undefined && !Number.isInteger(Number(cb.max_attempts))) {
        errors.push("circuitBreaker.max_attempts must be an integer when provided.");
      }
      if (cb.max_diff_lines !== undefined && !Number.isInteger(Number(cb.max_diff_lines))) {
        errors.push("circuitBreaker.max_diff_lines must be an integer when provided.");
      }
      if (cb.stop_if_same_failure_repeats !== undefined && typeof cb.stop_if_same_failure_repeats !== "boolean") {
        errors.push("circuitBreaker.stop_if_same_failure_repeats must be a boolean when provided.");
      }
    }
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? 0 : 1,
    errors,
    warnings,
  };
}

/**
 * Parses a subset of YAML suitable for task envelopes without third-party dependencies.
 * Handles mappings, sequence lists, inline lists, quoted strings, numbers, and booleans.
 *
 * @param {string} yamlText
 * @returns {Record<string, any>}
 */
export function parseYamlSubset(yamlText) {
  if (!yamlText || typeof yamlText !== "string") return {};
  const lines = yamlText.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root, key: null }];

  function parseVal(raw) {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null" || trimmed === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s) => parseVal(s.trim()));
    }
    return trimmed;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let line = rawLine;
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      const before = line.slice(0, commentIdx);
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        line = before;
      }
    }
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    if (content.startsWith("- ")) {
      const itemVal = parseVal(content.slice(2));
      let targetArray;
      if (Array.isArray(current.obj)) {
        targetArray = current.obj;
      } else if (current.key && current.obj && Array.isArray(current.obj[current.key])) {
        targetArray = current.obj[current.key];
      } else if (current.key && current.obj) {
        current.obj[current.key] = [];
        targetArray = current.obj[current.key];
      }
      if (targetArray) {
        targetArray.push(itemVal);
      }
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx !== -1) {
      const key = content.slice(0, colonIdx).trim();
      const valStr = content.slice(colonIdx + 1).trim();

      if (valStr === "") {
        let isNextArray = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].trim();
          if (!nextTrimmed || nextTrimmed.startsWith("#")) continue;
          if (nextTrimmed.startsWith("- ")) isNextArray = true;
          break;
        }
        const container = isNextArray ? [] : {};
        if (Array.isArray(current.obj)) {
          current.obj.push({ [key]: container });
        } else {
          current.obj[key] = container;
        }
        stack.push({ indent, obj: container, key });
      } else {
        const val = parseVal(valStr);
        if (Array.isArray(current.obj)) {
          current.obj.push({ [key]: val });
        } else {
          current.obj[key] = val;
        }
        current.key = key;
      }
    }
  }

  return root;
}

/**
 * Extracts and parses YAML frontmatter from markdown task files.
 * Supports standard `--- ... ---` envelopes (including `kind: Task`, `version: agentctl.task/v1`).
 *
 * @param {string} content
 * @returns {{ metadata: Record<string, any>, body: string, rawFrontmatter: string } | null}
 */
export function parseTaskFrontmatter(content) {
  if (!content || typeof content !== "string") return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return null;
  try {
    const parsed = parseYamlSubset(match[1]);
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
      return null;
    }
    const body = content.slice(match[0].length);
    return {
      metadata: parsed,
      body,
      rawFrontmatter: match[1],
    };
  } catch {
    return null;
  }
}

/**
 * Serializes task metadata into a canonical `agentctl.task/v1` YAML frontmatter block.
 *
 * @param {Record<string, any>} meta
 * @returns {string}
 */
export function serializeTaskFrontmatter(meta = {}) {
  const lines = [
    "---",
    `kind: ${meta.kind || "Task"}`,
    `version: ${meta.version || "agentctl.task/v1"}`,
  ];
  if (meta.id) lines.push(`id: ${meta.id}`);
  if (meta.title) lines.push(`title: ${meta.title}`);
  if (meta.role) lines.push(`role: ${meta.role}`);
  if (meta.tier) lines.push(`tier: ${meta.tier}`);
  const base = meta.baseCommit || meta.base_commit || meta.baseSha || meta.base_sha;
  if (base) lines.push(`base_commit: ${base}`);

  if (meta.risk && typeof meta.risk === "object") {
    lines.push("risk:");
    if (meta.risk.lane) lines.push(`  lane: ${meta.risk.lane}`);
    if (meta.risk.require_plan_approval !== undefined) {
      lines.push(`  require_plan_approval: ${Boolean(meta.risk.require_plan_approval)}`);
    }
  }

  const cb = meta.circuitBreaker || meta.circuit_breaker;
  if (cb && typeof cb === "object") {
    lines.push("circuitBreaker:");
    if (cb.max_attempts !== undefined) lines.push(`  max_attempts: ${cb.max_attempts}`);
    if (cb.max_diff_lines !== undefined) lines.push(`  max_diff_lines: ${cb.max_diff_lines}`);
    if (cb.stop_if_same_failure_repeats !== undefined) lines.push(`  stop_if_same_failure_repeats: ${cb.stop_if_same_failure_repeats}`);
  }

  if (Array.isArray(meta.dependsOn) && meta.dependsOn.length > 0) {
    lines.push("dependsOn:");
    for (const dep of meta.dependsOn) {
      lines.push(`  - ${dep}`);
    }
  }

  const allowPaths = meta.scope?.allow || meta.allowed_paths || meta.targetFiles || [];
  const denyPaths = meta.scope?.deny || meta.forbiddenPaths || meta.denyPaths || [];

  lines.push("scope:");
  lines.push("  allow:");
  if (Array.isArray(allowPaths) && allowPaths.length > 0) {
    for (const p of allowPaths) lines.push(`    - ${p}`);
  }
  lines.push("  deny:");
  if (Array.isArray(denyPaths) && denyPaths.length > 0) {
    for (const p of denyPaths) lines.push(`    - ${p}`);
  }

  const commands = meta.verification?.commands || (meta.verifyCmd ? [meta.verifyCmd] : []);
  const requireNonzero = meta.verification?.require_nonzero_test_count;
  const trustedBase = meta.verification?.trusted_base;
  if ((Array.isArray(commands) && commands.length > 0) || requireNonzero !== undefined || trustedBase) {
    lines.push("verification:");
    if (Array.isArray(commands) && commands.length > 0) {
      lines.push("  commands:");
      for (const cmd of commands) lines.push(`    - ${cmd}`);
    }
    if (requireNonzero !== undefined) {
      lines.push(`  require_nonzero_test_count: ${requireNonzero}`);
    }
    if (trustedBase) {
      lines.push(`  trusted_base: ${trustedBase}`);
    }
  }

  const invariants = Array.isArray(meta.invariants) ? meta.invariants : (Array.isArray(meta.constraints) ? meta.constraints : []);
  if (invariants.length > 0) {
    lines.push("invariants:");
    for (const inv of invariants) lines.push(`  - ${inv}`);
  }

  const mcpList = meta.mcp_directives || meta.mcpDirectives;
  if (Array.isArray(mcpList) && mcpList.length > 0) {
    lines.push("mcp_directives:");
    for (const d of mcpList) lines.push(`  - ${d}`);
  }

  if (meta.flags && typeof meta.flags === "object") {
    lines.push("flags:");
    for (const [k, v] of Object.entries(meta.flags)) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse metadata payload from either `agentctl.task/v1` frontmatter or HTML comment JULES_TASK_ENVELOPE.
 *
 * @param {string} content
 * @returns {Record<string, any> | null}
 */
export function parseEnvelopeHeader(content) {
  if (!content) return null;
  const str = String(content);

  // 1. Check for YAML frontmatter (agentctl.task/v1 or standard frontmatter)
  const frontmatter = parseTaskFrontmatter(str);
  if (frontmatter && frontmatter.metadata) {
    const m = frontmatter.metadata;
    let verifyCmd = m.verifyCmd || m.verify;
    if (!verifyCmd && m.verification) {
      if (Array.isArray(m.verification.commands) && m.verification.commands.length > 0) {
        verifyCmd = m.verification.commands[0];
      } else if (typeof m.verification.commands === "string") {
        verifyCmd = m.verification.commands;
      } else if (typeof m.verification === "string") {
        verifyCmd = m.verification;
      }
    }

    const scope = m.scope || {};
    const allow = Array.isArray(scope.allow) ? scope.allow : (Array.isArray(m.allowed_paths) ? m.allowed_paths : (Array.isArray(m.targetFiles) ? m.targetFiles : []));
    const deny = Array.isArray(scope.deny) ? scope.deny : (Array.isArray(m.forbiddenPaths) ? m.forbiddenPaths : (Array.isArray(m.denyPaths) ? m.denyPaths : []));

    const flags = m.flags || {};
    if (m.autoPr !== undefined) flags.autoPr = Boolean(m.autoPr);
    if (m.requirePlanApproval !== undefined) flags.requirePlanApproval = Boolean(m.requirePlanApproval);
    if (m.repoless !== undefined) flags.repoless = Boolean(m.repoless);

    const risk = m.risk && typeof m.risk === "object" ? m.risk : {};
    const rawLane = risk.lane || m.risk_lane || m.riskLane;
    const riskLane = rawLane ? String(rawLane).toLowerCase() : (flags.requirePlanApproval ? "amber" : "green");
    if (risk.require_plan_approval !== undefined) {
      flags.requirePlanApproval = Boolean(risk.require_plan_approval);
    } else if (risk.requirePlanApproval !== undefined) {
      flags.requirePlanApproval = Boolean(risk.requirePlanApproval);
    } else if (riskLane === "amber" && flags.requirePlanApproval === undefined) {
      flags.requirePlanApproval = true;
    }

    const circuitBreaker = m.circuitBreaker || m.circuit_breaker;
    const invariants = Array.isArray(m.invariants) ? m.invariants : (Array.isArray(m.constraints) ? m.constraints : []);
    const mcpDirectives = m.mcp_directives || m.mcpDirectives;

    const metaObj = m.metadata && typeof m.metadata === "object" ? m.metadata : {};
    const taskId = m.id || m.taskId || metaObj.id || metaObj.taskId;
    const title = m.title || metaObj.title || (typeof m.intent === "string" ? m.intent : m.intent?.outcome);

    let verification = m.verification;
    if (typeof verification === "string") {
      verification = { commands: [verification] };
    } else if (Array.isArray(verification)) {
      verification = { commands: verification };
    } else if (verification && typeof verification === "object") {
      if (typeof verification.commands === "string") {
        verification = { ...verification, commands: [verification.commands] };
      }
    } else if (verifyCmd) {
      verification = { commands: [verifyCmd] };
    }

    return {
      version: m.version || m.apiVersion || 1,
      kind: m.kind || "Task",
      id: taskId,
      taskId,
      title,
      intent: m.intent,
      role: m.role || metaObj.role,
      tier: m.tier || metaObj.tier,
      risk: {
        lane: riskLane,
        require_plan_approval: Boolean(flags.requirePlanApproval),
      },
      circuitBreaker,
      dependsOn: m.dependsOn,
      flags,
      verifyCmd,
      verification,
      scope: {
        allow,
        deny,
      },
      targetFiles: allow,
      allowed_paths: allow,
      forbiddenPaths: deny,
      invariants,
      constraints: invariants,
      mcp_directives: Array.isArray(mcpDirectives) ? mcpDirectives : (typeof mcpDirectives === "string" ? [mcpDirectives] : []),
      baseCommit: m.base_commit || m.base_sha || m.baseCommit || m.baseRef,
      base_commit: m.base_commit || m.base_sha || m.baseCommit || m.baseRef,
      promptBody: frontmatter.body,
    };
  }

  // 2. Legacy HTML comment fallback
  const match = str.match(/<!--\s*JULES_TASK_ENVELOPE:\s*({[\s\S]*?})\s*-->/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  return null;
}

