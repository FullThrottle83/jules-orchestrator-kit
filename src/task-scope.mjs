/**
 * Task-envelope scope and commit provenance for the gate.
 *
 * The repository scope answers "may an agent touch this path in this
 * repository". A task envelope narrows that to "may it touch this path for this
 * task". The two are separate verdicts: a candidate can satisfy the first and
 * break the second, and a gate that only reports the first must not be readable
 * as having checked the second.
 *
 * The envelope is operator input. It is never taken from the candidate: a path
 * the candidate changes is refused, and a path tracked on the trusted base is
 * read from the base commit rather than from the working tree.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { canonicalizePath } from "./config.mjs";
import { parseEnvelopeHeader } from "./envelope.mjs";
import { checkScope } from "./scope-guard.mjs";
import { git, showFromOrigin } from "./git.mjs";

const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_PROVENANCE_COMMITS = 100;

/** What the gate reports when no envelope was supplied. */
export const TASK_SCOPE_NOT_CHECKED = Object.freeze({
  checked: false,
  reason: "NO_TASK_ENVELOPE",
  note: "No --task envelope was supplied, so the task's own scope.allow/scope.deny were not applied to this candidate.",
});

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

function failure(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/**
 * Loads the task contract the operator named, from a source the candidate
 * cannot have written.
 *
 * @param {string} root
 * @param {string} taskPath - operator-supplied path to a task envelope
 * @param {{ base?: string, candidateFiles?: string[] }} ctx
 * @returns {{ ok: true, contract: object } | { ok: false, code: string, error: string }}
 */
export function loadTaskContract(root, taskPath, ctx = {}) {
  if (typeof taskPath !== "string" || taskPath.trim() === "") {
    return failure("TASK_ENVELOPE_INVALID", "--task requires a path to a task envelope.");
  }

  const abs = resolve(root, taskPath);
  let real;
  try {
    if (!statSync(abs).isFile()) throw new Error("not a file");
    real = realpathSync(abs);
  } catch (err) {
    return failure("TASK_ENVELOPE_UNREADABLE", `Task envelope "${taskPath}" cannot be read: ${err.message}`);
  }

  const candidates = new Set((ctx.candidateFiles || []).map((f) => canonicalizePath(f).toLowerCase()));
  let repoRoot = root;
  try {
    repoRoot = realpathSync(root);
  } catch (_) {}

  // A path may be spelled through a link, so both the spelling the operator gave
  // and the file it resolves to are checked against the candidate.
  const insideRepo = [abs, real]
    .map((p) => relative(repoRoot, p))
    .map((rel) => (rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/")));
  for (const rel of insideRepo) {
    if (rel && candidates.has(canonicalizePath(rel).toLowerCase())) {
      return failure(
        "TASK_ENVELOPE_IN_CANDIDATE",
        `Task envelope "${rel}" is changed by the candidate under review. The task contract must come from the operator, not from the candidate; keep it outside the diff.`
      );
    }
  }

  let bytes;
  let source = "file";
  const trackedRel = insideRepo[1];
  if (trackedRel && ctx.base) {
    const trusted = showFromOrigin(root, ctx.base, trackedRel);
    if (trusted !== null) {
      bytes = Buffer.from(trusted, "utf-8");
      source = "base";
    }
  }
  if (!bytes) {
    try {
      bytes = readFileSync(real);
    } catch (err) {
      return failure("TASK_ENVELOPE_UNREADABLE", `Task envelope "${taskPath}" cannot be read: ${err.message}`);
    }
  }
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    return failure("TASK_ENVELOPE_INVALID", `Task envelope "${taskPath}" is larger than ${MAX_ENVELOPE_BYTES} bytes.`);
  }

  const header = parseEnvelopeHeader(bytes.toString("utf-8"));
  if (!header) {
    return failure("TASK_ENVELOPE_INVALID", `Task envelope "${taskPath}" has no parseable frontmatter or JULES_TASK_ENVELOPE header.`);
  }
  const strings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === "string" && v.trim() !== "") : []);
  const allow = strings(header.scope?.allow);
  const deny = strings(header.scope?.deny);

  return {
    ok: true,
    contract: {
      taskId: header.taskId || null,
      path: insideRepo[1] || taskPath,
      source,
      sha256: sha256Hex(bytes),
      allow,
      deny,
    },
  };
}

/**
 * Applies the task's own scope to the same candidate file list the repository
 * scope was applied to. The repository verdict is not repeated or relaxed here:
 * both must pass, so the effective scope is their intersection.
 *
 * @param {string[]} files - candidate paths, as the repository scope saw them
 * @param {{ allow: string[], deny: string[] }} contract
 */
export function checkTaskScope(files, contract) {
  const result = checkScope(files, { allow: contract.allow, deny: contract.deny, protect: [] }, { allowProtected: false });
  return {
    ok: result.ok,
    violations: result.violations.map((v) => ({ ...v, source: "task" })),
    // An envelope that names no paths constrains nothing; saying so keeps a
    // pass from reading as a narrowed one.
    unconstrained: contract.allow.length === 0 && contract.deny.length === 0,
  };
}

const SIGNATURE_LABELS = Object.freeze({
  G: "good",
  U: "good-unknown-validity",
  X: "good-expired",
  Y: "good-expired-key",
  R: "good-revoked-key",
  B: "bad",
  E: "unverifiable",
  N: "unsigned",
});

/**
 * Observes who wrote and signed the commits in base..head. Read-only: it
 * reports, it never decides. Whether an unsigned commit is acceptable is a
 * policy question the report leaves to the reviewer.
 *
 * @returns {{ observed: boolean, commits?: object[], truncated?: boolean, error?: string }}
 */
export function observeCommitProvenance(root, base, head) {
  const range = base && head ? `${base}..${head}` : null;
  if (!range || String(base).startsWith("-") || String(head).startsWith("-")) {
    return { observed: false, error: "No commit range to observe." };
  }
  try {
    const out = git(
      [
        "log",
        "--no-show-signature",
        `--max-count=${MAX_PROVENANCE_COMMITS + 1}`,
        "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%G?%x1f%GK%x1e",
        range,
        "--",
      ],
      { cwd: root, raw: true }
    );
    const rows = out.split("\x1e").map((r) => r.replace(/^\n+/, "")).filter(Boolean);
    const truncated = rows.length > MAX_PROVENANCE_COMMITS;
    const commits = rows.slice(0, MAX_PROVENANCE_COMMITS).map((row) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, code, keyId] = row.split("\x1f");
      return {
        sha,
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
        signature: { code, status: SIGNATURE_LABELS[code] || "unknown", ...(keyId ? { keyId } : {}) },
      };
    });
    return { observed: true, range, commits, ...(truncated ? { truncated: true } : {}) };
  } catch (err) {
    return { observed: false, error: err.message };
  }
}
