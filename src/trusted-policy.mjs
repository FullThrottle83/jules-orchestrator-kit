/**
 * The one place that decides what policy the gate obeys.
 *
 * The rule is a single sentence: **every field the gate obeys is resolved from
 * a commit the diff under review cannot author.** Not the working tree, not
 * the index, not a commit the diff itself selected — the base.
 *
 * That rule already existed for exactly one field. `verify.tamperGuard` was
 * read from the base commit, with a comment saying why, while `verify.test`,
 * `verify.profile`, `base_branch`, `verify.minTests`, `verify.required`, the
 * stage list and the protected-path lists were read from whichever config
 * `loadConfig` happened to find on disk. That split is the whole of findings
 * F06, F07 and F08:
 *
 *   F07  An unstaged edit to `verify.test` was excluded from the staged diff
 *        and therefore from scope evaluation — and then executed anyway,
 *        because the stage plan came from the live config.
 *   F08  A committed `base_branch: HEAD` made the agent's own commit the
 *        trusted base, so the diff selected the policy that judged it.
 *   F06  On a first install there is no base config at all, so the gate
 *        obeyed the uncommitted scaffold, which the same diff had rewritten.
 *
 * Three findings, three code paths, one missing rule. The project's own
 * guard-policy.mjs opens by saying that a rule written twice is how this
 * defect keeps recurring. So it is written once, here, and every consumer
 * calls `resolveTrustedPolicy`.
 *
 * ## What "trusted" means for each field
 *
 * | field                                   | source                        |
 * |-----------------------------------------|-------------------------------|
 * | `verify.*` (every stage command)        | base commit                   |
 * | `verify.profile` and its expansion      | base commit                   |
 * | `verify.required`, `minTests`           | base commit                   |
 * | `verify.tamperGuard`, `scope`, timeouts | base commit                   |
 * | `scope.deny/allow/protect`              | base commit + built-ins       |
 * | `limits.diff_kb`                        | base commit                   |
 * | `base_branch`                           | base commit — never the diff  |
 *
 * ## First install
 *
 * A repository whose base commit has no kit config has no trusted policy to
 * read, and refusing outright would mean the gate rejects its own
 * installation — the defect the bootstrap exception was added to fix. But
 * obeying the uncommitted scaffold means an agent supplies its own oracle,
 * which is F06.
 *
 * The answer is neither: accept the scaffold **only when it is byte-identical
 * to what `init` would generate for this repository right now**. A scaffold
 * the agent has modified is not a trusted policy, and the gate says which
 * file and which field differ rather than merely refusing. Regenerating the
 * scaffold is cheap, deterministic, and — importantly — does not depend on
 * anything in the diff.
 */

import { parseYaml, normalizeScope } from "./config.mjs";
import { showFromOrigin } from "./git.mjs";

/** Config paths a repository may keep its policy in, in precedence order. */
export const POLICY_FILES = [".agent/config.yml", ".agent/jules.yml"];

/**
 * Fields whose value the gate obeys, named for the diff report.
 *
 * Used to describe *which* field an untrusted scaffold changed. Ordered so the
 * most consequential — the command that decides pass or fail — is reported
 * first when several differ.
 */
const OBEYED_FIELDS = [
  ["verify.test", (c) => c?.verify?.test ?? c?.test_cmd],
  ["verify.profile", (c) => c?.verify?.profile ?? c?.profile],
  ["verify.required", (c) => c?.verify?.required],
  ["verify.minTests", (c) => c?.verify?.minTests ?? c?.verify?.min_tests],
  ["verify.tamperGuard", (c) => c?.verify?.tamperGuard ?? c?.verify?.tamper_guard],
  ["verify.scope", (c) => c?.verify?.scope],
  ["verify.stages", (c) => c?.verify?.stages],
  ["verify.timeout_ms", (c) => c?.verify?.timeoutMs ?? c?.verify?.timeout_ms],
  ["verify.lint", (c) => c?.verify?.lint ?? c?.lint_cmd],
  ["verify.build", (c) => c?.verify?.build ?? c?.build_cmd],
  ["verify.e2e", (c) => c?.verify?.e2e ?? c?.e2e_cmd],
  ["verify.setup", (c) => c?.verify?.setup],
  ["verify.teardown", (c) => c?.verify?.teardown],
  ["base_branch", (c) => c?.base_branch ?? c?.baseBranch],
  ["limits.diff_kb", (c) => c?.limits?.diff_kb ?? c?.limits?.diffKb],
  ["forbidden_paths", (c) => c?.forbidden_paths ?? c?.scope?.deny],
  ["allow_paths", (c) => c?.allow_paths ?? c?.scope?.allow],
  ["scope.protect", (c) => c?.scope?.protect],
];

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined && b === undefined) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Which obeyed fields differ between two parsed configs.
 *
 * @returns {Array<{ field: string, expected: unknown, found: unknown }>}
 */
export function diffObeyedFields(expected, found) {
  const out = [];
  for (const [field, read] of OBEYED_FIELDS) {
    const e = read(expected);
    const f = read(found);
    if (!sameValue(e, f)) out.push({ field, expected: e, found: f });
  }
  return out;
}

/**
 * What `init` would write for this repository, right now.
 *
 * Deliberately re-derived rather than read from anywhere in the working tree:
 * the whole point is a value the diff under review cannot influence. `planInit`
 * is pure with respect to `.agent/**` when `pristine` is set — it otherwise
 * seeds itself from the existing config, which on a first install is precisely
 * the untrusted file we are trying to check.
 *
 * @param {string} root
 * @returns {Promise<{ ".agent/config.yml": string, ".agent/jules.yml": string }|null>}
 */
export async function generateReferenceScaffold(root) {
  try {
    const { planInit } = await import("./wizard-init.mjs");

    // Fields the gate does NOT obey are carried over from the scaffold on disk,
    // and only those. This is not a loophole, it is what stops the rule from
    // rejecting correct work: `provider`, `tier` and `presets` are answers the
    // operator gave the wizard, they depend on which CLI happened to be on PATH
    // the day `init` ran, and regenerating them here would make an honest first
    // install fail a byte comparison over a question the gate never consults.
    //
    // Nothing in this list can influence a verdict. Every field that can —
    // `verify.*`, `base_branch`, the path lists, `limits.diff_kb` — is
    // regenerated from the repository itself, so a diff that edits one of them
    // still fails the comparison and is still named.
    const carried = await readCarriedChoices(root);
    const plan = planInit(root, { pristine: true, ...carried });
    return {
      ".agent/config.yml": plan.configYaml,
      ".agent/jules.yml": plan.julesYaml,
    };
  } catch (_) {
    return null;
  }
}

/** The wizard answers that are not policy. See `generateReferenceScaffold`. */
async function readCarriedChoices(root) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const out = {};
  try {
    const p = join(root, ".agent", "config.yml");
    if (!existsSync(p)) return out;
    const parsed = parseYaml(readFileSync(p, "utf-8")) || {};
    if (parsed.provider) out.provider = parsed.provider;
    if (parsed.tier) out.tier = parsed.tier;
    if (Array.isArray(parsed.presets)) out.presets = parsed.presets;
  } catch (_) {}
  return out;
}

/**
 * Normalise for byte comparison.
 *
 * Line endings only. A checkout with `core.autocrlf` rewrites every line of
 * every file, and failing an honest Windows install over `\r` would be exactly
 * the "reject correct work" failure this change has to avoid. Nothing else is
 * normalised: whitespace inside a command string is part of the command.
 */
function canonical(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

/**
 * Resolve the policy the gate will obey.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.base - the base ref as given on the command line
 * @param {object} opts.config - the on-disk config, used ONLY for values that
 *   are not policy (defaults for fields absent from the trusted commit, and
 *   for stack detection which reads source files, not `.agent/**`).
 * @returns {Promise<{
 *   source: "base" | "verified-scaffold" | "none",
 *   raw: string|null,
 *   parsed: object,
 *   scope: object,
 *   verify: object,
 *   diffKb: number,
 *   baseBranch: string|null,
 *   scaffold: { accepted: string[], mismatches: Array<{file: string, field: string|null, detail: string}> }|null,
 *   trusted: boolean,
 *   reason: string|null
 * }>}
 */
export async function resolveTrustedPolicy(opts = {}) {
  const root = opts.root || process.cwd();
  const base = opts.base || "main";
  const config = opts.config || {};

  let raw = null;
  let rawFile = null;
  for (const file of POLICY_FILES) {
    const text = showFromOrigin(root, base, file);
    if (text !== null && text !== undefined) {
      raw = text;
      rawFile = file;
      break;
    }
  }

  if (raw !== null) {
    let parsed = {};
    try {
      parsed = parseYaml(raw) || {};
    } catch (_) {
      parsed = {};
    }
    return {
      source: "base",
      file: rawFile,
      raw,
      parsed,
      trusted: true,
      reason: null,
      scaffold: null,
      ...projectPolicy(parsed, config, opts.callerConfig?.limits),
    };
  }

  // No policy on the base commit. This is a first install — or an agent
  // pretending to be one.
  const reference = await generateReferenceScaffold(root);
  const mismatches = [];
  const accepted = [];

  if (!reference) {
    return {
      source: "none",
      file: null,
      raw: null,
      parsed: {},
      trusted: false,
      reason:
        "The base commit has no kit config, and the reference scaffold could not be regenerated, " +
        "so there is no policy the diff under review did not author.",
      scaffold: { accepted: [], mismatches: [] },
      ...projectPolicy({}, config, opts.callerConfig?.limits),
    };
  }

  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  for (const file of POLICY_FILES) {
    // `join` normalises the forward slashes to the platform separator.
    const full = join(root, ...file.split("/"));
    let onDisk = null;
    try {
      if (existsSync(full)) onDisk = readFileSync(full, "utf-8");
    } catch (_) {
      onDisk = null;
    }
    if (onDisk === null) continue;

    if (canonical(onDisk) === canonical(reference[file])) {
      accepted.push(file);
      continue;
    }

    // Not byte-identical. Name the field, not just the file: "your config
    // differs" is not actionable, and the operator has to be able to see
    // whether this is a legitimate local edit or an agent's replacement oracle.
    let found = {};
    let expected = {};
    try {
      found = parseYaml(onDisk) || {};
    } catch (_) {}
    try {
      expected = parseYaml(reference[file]) || {};
    } catch (_) {}

    const fieldDiffs = diffObeyedFields(expected, found);
    if (fieldDiffs.length === 0) {
      mismatches.push({
        file,
        field: null,
        detail:
          "differs from the scaffold `init` generates for this repository, though no field the gate " +
          "obeys changed value. Commit it to the base branch and it becomes trusted policy.",
      });
      continue;
    }
    for (const d of fieldDiffs) {
      mismatches.push({
        file,
        field: d.field,
        detail:
          `is ${JSON.stringify(d.found ?? null)} in the uncommitted scaffold, ` +
          `but \`init\` generates ${JSON.stringify(d.expected ?? null)} for this repository.`,
      });
    }
  }

  if (mismatches.length > 0) {
    // The scaffold was modified in the same uncommitted diff it is meant to
    // govern. Fall back to built-ins only — no command from this file runs —
    // and let the gate refuse and say which field.
    return {
      source: "none",
      file: null,
      raw: null,
      parsed: {},
      trusted: false,
      reason:
        "The base commit has no kit config, so the only candidate policy is the uncommitted scaffold — " +
        "and it is not the scaffold `init` generates. A policy file modified by the same diff the gate " +
        "is judging is not a trusted policy.",
      scaffold: { accepted, mismatches },
      ...projectPolicy({}, config, opts.callerConfig?.limits),
    };
  }

  if (accepted.length === 0) {
    return {
      source: "none",
      file: null,
      raw: null,
      parsed: {},
      trusted: false,
      reason:
        "The base commit has no kit config and no scaffold is present on disk, so there is no policy to obey.",
      scaffold: { accepted: [], mismatches: [] },
      ...projectPolicy({}, config, opts.callerConfig?.limits),
    };
  }

  // Every policy file present is byte-identical to what `init` generates. It
  // is a genuine first install: obey it, and say so.
  let parsed = {};
  try {
    parsed = parseYaml(reference[POLICY_FILES[0]]) || {};
  } catch (_) {}

  return {
    source: "verified-scaffold",
    file: POLICY_FILES[0],
    raw: reference[POLICY_FILES[0]],
    parsed,
    trusted: true,
    reason: null,
    scaffold: { accepted, mismatches: [] },
    ...projectPolicy(parsed, config, opts.callerConfig?.limits),
  };
}

/**
 * Project a parsed policy document into the shape `gate()` consumes.
 *
 * Every field the gate obeys is read here and nowhere else. Where the trusted
 * document is silent, the fallback is the *detected* value from `config`
 * (stack detection reads source files, which the diff may legitimately
 * change) — never a value the diff wrote into `.agent/**`, because those are
 * already excluded by the caller: `parsed` is the trusted document, and
 * `config.verify` reaches here only for stack-detected defaults.
 */
function projectPolicy(parsed, config, callerLimits) {
  const cv = config.verify || {};

  const verify = {
    stack: cv.stack,
    setup: parsed.verify?.setup ?? cv.setup,
    lint: parsed.verify?.lint ?? parsed.lint_cmd ?? cv.lint,
    test: parsed.verify?.test ?? parsed.test_cmd ?? cv.test,
    unit: parsed.verify?.unit ?? parsed.verify?.test ?? parsed.test_cmd ?? cv.unit ?? cv.test,
    fuzz: parsed.verify?.fuzz ?? parsed.fuzz_cmd ?? cv.fuzz,
    invariant: parsed.verify?.invariant ?? parsed.invariant_cmd ?? cv.invariant,
    e2e: parsed.verify?.e2e ?? parsed.e2e_cmd ?? cv.e2e,
    teardown: parsed.verify?.teardown ?? cv.teardown,
    build: parsed.verify?.build ?? parsed.build_cmd ?? cv.build,
    server: parsed.verify?.server ?? cv.server ?? null,
    policy: parsed.verify?.policy ?? cv.policy,
    required: parsed.verify?.required !== undefined ? parsed.verify.required !== false : cv.required !== false,
    minTests:
      parsed.verify?.minTests !== undefined
        ? parsed.verify.minTests
        : parsed.verify?.min_tests !== undefined
          ? parsed.verify.min_tests
          : cv.minTests,
    tamperGuard: parsed.verify?.tamperGuard ?? parsed.verify?.tamper_guard ?? cv.tamperGuard,
    scope: parsed.verify?.scope ?? cv.scope ?? "global",
    timeoutMs: parsed.verify?.timeoutMs ?? parsed.verify?.timeout_ms ?? cv.timeoutMs,
  };

  // The profile. Previously resolved by `loadConfig` from the working-tree
  // config and handed to the gate pre-expanded, which is how an uncommitted
  // `profile: minimal` switched off the anti-tamper stage (F06, F07). It is
  // expanded here instead, against the trusted commands above.
  const rawProfile = parsed.verify?.profile ?? parsed.profile ?? null;
  const explicitStages = Array.isArray(parsed.verify?.stages) ? parsed.verify.stages : null;

  return {
    verify,
    profile: rawProfile ? String(rawProfile).toLowerCase() : null,
    explicitStages,
    scope: normalizeScope(parsed),
    // The trusted document wins.
    //
    // When it is silent the fallback is `callerLimits` — the config an API
    // caller passed in explicitly — and never the config `loadConfig` found on
    // disk. That distinction is vulnerability B and it has its own regression
    // test: an uncommitted `.agent/config.yml` saying `diff_kb: 99999` must not
    // raise the ceiling in committed mode, because that file is part of the
    // diff. A config object handed to `gate()` by a program is the operator
    // speaking; a file in the working tree is the change speaking.
    diffKb:
      Number(parsed.limits?.diff_kb ?? parsed.limits?.diffKb) ||
      Number(callerLimits?.diffKb ?? callerLimits?.diff_kb) ||
      75,
    // Never from the diff. `base_branch: HEAD` committed alongside the change
    // it is meant to judge is F08, and it is refused by the caller resolving
    // the base *before* this function is reached — the value is returned only
    // so the gate can report a disagreement.
    baseBranch: parsed.base_branch ?? parsed.baseBranch ?? null,
  };
}
