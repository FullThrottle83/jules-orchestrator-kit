/**
 * Verification profiles: one word in `.agent/config.yml` that turns the kit's
 * verification primitives on as a coherent set.
 *
 * The kit ships mutation testing, V8 diff coverage, flakiness probing and
 * anti-tamper detection, and every one of them was reachable only by knowing
 * the command exists and typing it by hand. A repository that scaffolded a
 * default config got exactly one gate — `npm test` — and none of the rest, so
 * the capability shipped and then sat idle. A profile is the shortest sentence
 * that says how hard this repository wants its agents verified.
 *
 * Profiles are expanded at load time (see `loadConfig`), not frozen into the
 * scaffolded YAML, so the stage list stays correct when the stack changes and
 * improves when the kit does.
 */

/** Ordered weakest to strictest; `standard` is the default for a fresh repo. */
export const PROFILE_NAMES = ["minimal", "standard", "max"];

export const PROFILE_DESCRIPTIONS = {
  minimal: "Tests only. For a slow suite, an unfamiliar stack, or a first day with the kit.",
  standard: "Lint, tests, build, plus anti-tamper on the diff. The everyday gate.",
  max: "Everything mechanical: adds mutation scoring, diff coverage, and flakiness probing.",
};

/**
 * Stacks whose test command runs on Node and therefore honours
 * `NODE_V8_COVERAGE`, which is how `assert:diff-coverage` collects data.
 *
 * Bun and Deno are deliberately absent: they run JavaScript but do not emit V8
 * coverage into that directory, so the assertion would find no coverage maps
 * and fail every diff for a reason that has nothing to do with the diff.
 */
const V8_COVERAGE_STACKS = new Set(["node", "turbo", "pnpm", "nx", "react-native", "hardhat"]);

/**
 * Build the full verification pipeline for a profile.
 *
 * Returns the *complete* stage list, not an addendum: `gate()` replaces its
 * built-in pipeline wholesale when `verify.stages` is present, so a profile
 * that emitted only its extra assertions would silently drop the tests.
 *
 * @param {string} profile - one of {@link PROFILE_NAMES}
 * @param {object} ctx
 * @param {string} [ctx.stack] - detected stack id (see `detectPolyglotStack`)
 * @param {{setup?: string, lint?: string, test?: string, unit?: string, e2e?: string, build?: string, policy?: object}} [ctx.verify]
 * @returns {{ profile: string, stages: object[], skipped: Array<{id: string, reason: string}> }}
 */
export function buildProfileStages(profile, ctx = {}) {
  const name = PROFILE_NAMES.includes(String(profile || "").toLowerCase())
    ? String(profile).toLowerCase()
    : "standard";
  const verify = ctx.verify || {};
  const stack = ctx.stack || "unknown";
  const network = verify.policy?.networkAccess || "allow";
  const testCmd = verify.test || verify.unit || "";

  const stages = [];
  const skipped = [];

  // Dependency install always runs first when the stack declares one; without
  // it every later stage fails on a missing toolchain rather than on the code.
  if (verify.setup) {
    stages.push({ id: "setup", kind: "setup", cmd: verify.setup, required: true, networkAccess: "allow" });
  }

  if (name !== "minimal" && verify.lint) {
    stages.push({ id: "lint", kind: "lint", cmd: verify.lint, required: true, networkAccess: network });
  }

  if (testCmd) {
    stages.push({ id: "unit", kind: "test", cmd: testCmd, required: true, networkAccess: network });
  } else {
    skipped.push({
      id: "unit",
      reason: "No test command is configured or detectable — set verify.test in .agent/config.yml.",
    });
  }

  if (name !== "minimal" && verify.e2e) {
    stages.push({ id: "e2e", kind: "e2e", cmd: verify.e2e, required: true, networkAccess: "allow" });
  }

  if (name !== "minimal" && verify.build) {
    stages.push({ id: "build", kind: "build", cmd: verify.build, required: true, networkAccess: network });
  }

  // Anti-tamper is diff-based and language-agnostic: it costs nothing to run
  // and it is the one check an agent under pressure to go green will trip.
  if (name !== "minimal") {
    stages.push({ id: "anti-tamper", kind: "assert", assert: "test-integrity", required: true });
  }

  if (name === "max") {
    // Mutation operators are C-family (`===`, `&&`, `++`, `true`), so the score
    // is strongest on JS/TS, Go, Rust, Java, C#, PHP, Swift and Dart, and
    // weaker on Python/Ruby where the keywords differ. It is still safe
    // everywhere: it only ever mutates lines the diff added, and a diff with no
    // mutable operators scores 100 and passes.
    stages.push({
      id: "mutation",
      kind: "assert",
      assert: "mutation",
      minScore: 60,
      maxMutants: 20,
      testCmd,
      required: true,
    });

    if (V8_COVERAGE_STACKS.has(stack)) {
      stages.push({
        id: "diff-coverage",
        kind: "assert",
        assert: "diff-coverage",
        minCoverage: 80,
        testCmd,
        required: true,
      });
    } else {
      skipped.push({
        id: "diff-coverage",
        reason: `Diff coverage reads NODE_V8_COVERAGE, which stack '${stack}' does not produce.`,
      });
    }

    // Three passes is the cheapest count that can distinguish "passed" from
    // "passed this time": a single alternation is enough to quarantine.
    stages.push({
      id: "stability",
      kind: "assert",
      assert: "test-stability",
      repeat: 3,
      minPassRate: 1.0,
      cmd: testCmd,
      required: true,
    });

    // `assert:event-loop-lag` is deliberately not here. It measures the
    // orchestrator's own loop while it blocks on a synchronous child process,
    // so against a spawned test command it reports the blocking duration rather
    // than the application's latency. It stays available as an explicit stage
    // for repositories that know what they are measuring.
    skipped.push({
      id: "event-loop-lag",
      reason: "Opt-in only: meaningful for in-process latency targets, not for a spawned test command.",
    });
  }

  return { profile: name, stages, skipped };
}

/**
 * The pipeline `gate()` runs when no profile and no explicit stages are set:
 * every verification command the stack resolved, in dependency order.
 *
 * Lives here rather than inline in `gate()` so that `agentctl profile` can show
 * an operator what will actually run without reimplementing — and drifting
 * from — the sequence the gate uses.
 *
 * @param {{setup?: string, lint?: string, test?: string, unit?: string, fuzz?: string, invariant?: string, e2e?: string, build?: string, policy?: object}} verify
 * @returns {object[]}
 */
export function buildDefaultStages(verify = {}) {
  const network = verify.policy?.networkAccess || "allow";
  const stages = [];
  if (verify.setup) stages.push({ id: "setup", kind: "setup", cmd: verify.setup, required: true, networkAccess: "allow" });
  if (verify.lint) stages.push({ id: "lint", kind: "lint", cmd: verify.lint, required: true, networkAccess: network });
  if (verify.test || verify.unit) {
    stages.push({ id: "unit", kind: "test", cmd: verify.test || verify.unit, required: true, networkAccess: network });
  }
  if (verify.fuzz) stages.push({ id: "fuzz", kind: "fuzz", cmd: verify.fuzz, required: true, networkAccess: network });
  if (verify.invariant) stages.push({ id: "invariant", kind: "invariant", cmd: verify.invariant, required: true, networkAccess: network });
  if (verify.e2e) stages.push({ id: "e2e", kind: "e2e", cmd: verify.e2e, required: true, networkAccess: "allow" });
  if (verify.build) stages.push({ id: "build", kind: "build", cmd: verify.build, required: true, networkAccess: network });
  return stages;
}

/**
 * Short human-readable summary of what a profile will run, for `init` output
 * and `doctor`.
 *
 * @param {ReturnType<typeof buildProfileStages>} plan
 * @returns {string}
 */
export function describeProfilePlan(plan) {
  const ids = plan.stages.map((s) => s.id);
  return ids.length ? ids.join(" → ") : "(nothing to run)";
}
