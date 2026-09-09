import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig, detectStack } from "../config.mjs";
import { probeProvider, detectAvailableProviders, probeProviderLiveness } from "../provider-readiness.mjs";
import { resolveConcurrency } from "../budget.mjs";

/**
 * @typedef {"pass" | "warn" | "fail" | "skip" | "unknown"} DiagnosticStatus
 * @typedef {"info" | "low" | "medium" | "high" | "critical"} DiagnosticSeverity
 *
 * @typedef {Object} DiagnosticEvidence
 * @property {string} label
 * @property {string | number | boolean} value
 * @property {boolean} sensitive
 *
 * @typedef {Object} FixDescriptor
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {"low" | "moderate" | "high" | "destructive"} risk
 * @property {boolean} automatic
 * @property {boolean} requiresProbe
 *
 * @typedef {Object} DiagnosticResult
 * @property {"agentctl/diagnostic-result-v1"} schema
 * @property {string} id
 * @property {string} category
 * @property {string} title
 * @property {DiagnosticStatus} status
 * @property {DiagnosticSeverity} severity
 * @property {string} summary
 * @property {number} durationMs
 * @property {boolean} passive
 * @property {DiagnosticEvidence[]} evidence
 * @property {FixDescriptor[]} fixes
 * @property {{ code: string, message: string }} [error]
 *
 * @typedef {Object} DoctorReport
 * @property {"agentctl/doctor-report-v1"} schema
 * @property {string} repository
 * @property {string} [headSha]
 * @property {string} generatedAt
 * @property {boolean} activeProbe
 * @property {Record<DiagnosticStatus, number>} summary
 * @property {DiagnosticResult[]} results
 * @property {string} reportHash
 */

/**
 * Compute SHA-256 report hash for DoctorReport.
 * @param {Omit<DoctorReport, "reportHash">} report
 * @returns {string}
 */
export function computeReportHash(report) {
  const payload = JSON.stringify({
    schema: report.schema,
    repository: report.repository,
    generatedAt: report.generatedAt,
    summary: report.summary,
    results: report.results.map((r) => ({ id: r.id, status: r.status, summary: r.summary })),
  });
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

/**
 * Run diagnostic check suite across DAG.
 * @param {Object} options
 * @param {string} options.root
 * @param {boolean} [options.activeProbe=false]
 * @param {string[]} [options.selectedChecks]
 * @returns {Promise<DoctorReport>}
 */
export async function runDoctorChecks(options = {}) {
  const root = resolve(options.root || process.cwd());
  const activeProbe = Boolean(options.activeProbe);
  const _startTime = Date.now();

  /** @type {DiagnosticResult[]} */
  const results = [];

  // Helper to append result
  const addResult = (res) => {
    results.push({
      schema: "agentctl/diagnostic-result-v1",
      durationMs: 0,
      passive: !activeProbe,
      evidence: [],
      fixes: [],
      ...res,
    });
  };

  // 1. System Checks
  // runtime.node
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (nodeMajor >= 20) {
    addResult({
      id: "runtime.node",
      category: "System",
      title: "Node.js Engine Version",
      status: "pass",
      severity: "info",
      summary: `Node.js ${nodeVersion} satisfies runtime requirements (v20+)`,
      evidence: [{ label: "nodeVersion", value: nodeVersion, sensitive: false }],
    });
  } else {
    addResult({
      id: "runtime.node",
      category: "System",
      title: "Node.js Engine Version",
      status: "fail",
      severity: "critical",
      summary: `Node.js ${nodeVersion} is below required minimum v20.0.0`,
      evidence: [{ label: "nodeVersion", value: nodeVersion, sensitive: false }],
    });
  }

  // runtime.git
  let gitPassed = false;
  try {
    const gitOut = execFileSync("git", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    gitPassed = true;
    addResult({
      id: "runtime.git",
      category: "System",
      title: "Git Command Available",
      status: "pass",
      severity: "info",
      summary: gitOut.trim(),
      evidence: [{ label: "gitVersion", value: gitOut.trim(), sensitive: false }],
    });
  } catch (err) {
    addResult({
      id: "runtime.git",
      category: "System",
      title: "Git Command Available",
      status: "fail",
      severity: "critical",
      summary: "Git executable not found or failed to run",
      error: { code: "ENOENT", message: err.message },
    });
  }

  // 2. Repository Checks

  if (!gitPassed) {
    addResult({
      id: "repo.root",
      category: "Repository",
      title: "Repository Root Verification",
      status: "skip",
      severity: "info",
      summary: "Skipped due to failed runtime.git check",
    });
    addResult({
      id: "repo.dirty",
      category: "Repository",
      title: "Working Directory Cleanliness",
      status: "skip",
      severity: "info",
      summary: "Skipped due to failed runtime.git check",
    });
  } else {
    let isRepo = false;
    let headSha = "";
    try {
      const insideWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (insideWorkTree === "true") {
        isRepo = true;
        try {
          headSha = execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
            cwd: root,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch (_) {}

        if (headSha) {
          addResult({
            id: "repo.root",
            category: "Repository",
            title: "Repository Root Verification",
            status: "pass",
            severity: "info",
            summary: `Valid repository at ${root} (HEAD: ${headSha.slice(0, 8)})`,
            evidence: [{ label: "headSha", value: headSha, sensitive: false }],
          });
        } else {
          addResult({
            id: "repo.root",
            category: "Repository",
            title: "Repository Root Verification",
            status: "pass",
            severity: "info",
            summary: `Valid repository at ${root} (unborn HEAD, 0 commits)`,
            evidence: [{ label: "headSha", value: "", sensitive: false }],
          });
        }
      }
    } catch (_) {}

    if (!isRepo) {
      addResult({
        id: "repo.root",
        category: "Repository",
        title: "Repository Root Verification",
        status: "fail",
        severity: "high",
        summary: `Directory ${root} is not a valid Git repository`,
      });
    }

    if (isRepo) {
      try {
        const statusOut = execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const modifiedCount = statusOut ? statusOut.split("\n").length : 0;
        if (modifiedCount === 0) {
          addResult({
            id: "repo.dirty",
            category: "Repository",
            title: "Working Directory Cleanliness",
            status: "pass",
            severity: "info",
            summary: "Working tree is clean",
            evidence: [{ label: "uncommittedFiles", value: 0, sensitive: false }],
          });
        } else {
          addResult({
            id: "repo.dirty",
            category: "Repository",
            title: "Working Directory Cleanliness",
            status: "warn",
            severity: "low",
            summary: `Working tree has ${modifiedCount} uncommitted changes`,
            evidence: [{ label: "uncommittedFiles", value: modifiedCount, sensitive: false }],
          });
        }
      } catch {
        addResult({
          id: "repo.dirty",
          category: "Repository",
          title: "Working Directory Cleanliness",
          status: "warn",
          severity: "low",
          summary: "Could not query git status",
        });
      }
    }
  }

  // 3. Config Checks
  const configCandidates = [
    [".agent/config.yml", join(root, ".agent", "config.yml")],
    [".agent/jules.yml", join(root, ".agent", "jules.yml")],
  ];
  const existingConfig = configCandidates.find(([, path]) => existsSync(path));
  if (existingConfig) {
    addResult({
      id: "config.present",
      category: "Config",
      title: "Agent Configuration File",
      status: "pass",
      severity: "info",
      summary: `${existingConfig[0]} exists`,
      evidence: [{ label: "configPath", value: existingConfig[0], sensitive: false }],
    });
  } else {
    addResult({
      id: "config.present",
      category: "Config",
      title: "Agent Configuration File",
      status: "warn",
      severity: "medium",
      summary: "Neither .agent/config.yml nor .agent/jules.yml exists",
      fixes: [
        {
          id: "config.create-default",
          title: "Create default config",
          summary: "Initialize standard .agent/config.yml manifest",
          risk: "low",
          automatic: true,
          requiresProbe: false,
        },
      ],
    });
  }

  // 3b. Worker slots against the plan's ceiling.
  //
  // A warning, never a failure: the kit cannot see the account, only the
  // config. Pooled accounts legitimately exceed a single plan's ceiling, and
  // the provider refuses what it will not allow regardless of what we think.
  try {
    const cfg = loadConfig(root);
    const slots = resolveConcurrency(cfg);
    addResult({
      id: "limits.concurrency",
      category: "Config",
      title: "Worker Slots vs Plan Ceiling",
      status: slots.overCeiling ? "warn" : "pass",
      severity: slots.overCeiling ? "medium" : "info",
      summary: `${slots.concurrency} concurrent worker(s) — ${slots.note}`,
      evidence: [
        { label: "concurrency", value: slots.concurrency, sensitive: false },
        { label: "planCeiling", value: slots.ceiling, sensitive: false },
        { label: "source", value: slots.source, sensitive: false },
      ],
      remediation: slots.overCeiling
        ? [
            {
              summary: `Set limits.concurrency to ${slots.ceiling} or lower in .agent/config.yml, unless this account pools several plans`,
              risk: "low",
              automatic: false,
              requiresProbe: false,
            },
          ]
        : [],
    });
  } catch (_) {
    // A config the loader rejects is already reported by config.present.
  }

  // 4. Verification Oracle Checks
  // Judge the command the gate will actually run — `verify.test` from the
  // config, falling back to the npm `test` script — rather than package.json
  // alone. package.json-only logic told a fresh Python/Rust/Go or zero-test
  // repo "missing test script" (a warning, exit 0) while config carried the
  // real command, or nothing at all; and a green `doctor` right before an
  // `agentctl gate`/`agentctl task create` that both hard-fail with "No
  // Verification Oracle" sent newcomers into a contradiction. When verification
  // is required and there is no oracle, that is a genuine health failure and is
  // reported red so `doctor`'s exit code matches what the gate will do.
  const pkgPath = join(root, "package.json");
  let pkgTestScript = "";
  let pkgValid = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgValid = true;
      pkgTestScript = (pkg.scripts && pkg.scripts.test) || "";
    } catch {
      pkgValid = false;
    }
  }
  let cfg = null;
  try {
    cfg = loadConfig(root);
  } catch (_) {
    // A config the loader rejects is already reported by config.present; fall
    // through with null and treat verification as required (the default).
  }
  const configTest = (cfg?.verify?.test || "").trim();
  // verify.required defaults to true; an operator who sets it false is saying
  // "scope/secret gating only, on purpose" — which is a warning, not a failure.
  const verificationRequired = cfg?.verify?.required !== false;
  // The gate auto-detects a per-stack command even before init writes config
  // (e.g. `python3 -m pytest` for a .py repo), so detection counts as an oracle
  // too — otherwise a detected but not-yet-onboarded stack would report red.
  const detectedTest = detectStack(root)?.testCmd || "";
  const effectiveTest = configTest || pkgTestScript || detectedTest;

  if (effectiveTest) {
    const source = configTest
      ? "verify.test in config"
      : pkgTestScript
        ? "package.json test script"
        : "auto-detected from repository stack";
    addResult({
      id: "oracle.test",
      category: "Verification",
      title: "Test Oracle Configuration",
      status: "pass",
      severity: "info",
      summary: `Verification oracle: "${effectiveTest}" (${source})`,
      evidence: [{ label: "testCommand", value: effectiveTest, sensitive: false }],
    });
  } else if (existsSync(pkgPath) && !pkgValid) {
    addResult({
      id: "oracle.test",
      category: "Verification",
      title: "Test Oracle Configuration",
      status: "warn",
      severity: "medium",
      summary: "Malformed package.json file",
    });
  } else if (!verificationRequired) {
    addResult({
      id: "oracle.test",
      category: "Verification",
      title: "Test Oracle Configuration",
      status: "warn",
      severity: "medium",
      summary: "No verification oracle — verify.required: false (scope/secret gating only)",
    });
  } else {
    addResult({
      id: "oracle.test",
      category: "Verification",
      title: "Test Oracle Configuration",
      status: "fail",
      severity: "high",
      summary:
        "No verification command is configured, so the gate rejects every change with a No Verification Oracle finding",
      fixes: [
        {
          id: "oracle.bootstrap",
          title: "Generate a verification oracle",
          summary: "Run `agentctl bootstrap` to create one for this stack, or set verify.test in .agent/config.yml",
          risk: "low",
          automatic: true,
          requiresProbe: false,
        },
      ],
    });
  }

  // 5. State & Telemetry Checks
  const telemetryDate = new Date().toISOString().split("T")[0];
  const telemetryHeadPath = join(root, ".agent", "state", `telemetry-${telemetryDate}.head`);
  if (existsSync(telemetryHeadPath)) {
    addResult({
      id: "state.telemetry",
      category: "State",
      title: "Telemetry Spine Head Integrity",
      status: "pass",
      severity: "info",
      summary: "Telemetry .head file present"
    });
  } else {
    addResult({
      id: "state.telemetry",
      category: "State",
      title: "Telemetry Spine Head Integrity",
      status: "warn",
      severity: "low",
      summary: "Telemetry .head file missing; can be rebuilt from tail log",
      fixes: [
        {
          id: "state.rebuild-head",
          title: "Rebuild telemetry head",
          summary: "Recompute .head SHA-256 pointer from tail log",
          risk: "low",
          automatic: true,
          requiresProbe: false,
        },
      ],
    });
  }

  // 6. VFS Locks Check
  const locksDir = join(root, ".agent", "state", "locks");
  let activeLockCount = 0;
  let lockInspectionFailed = false;
  try {
    if (existsSync(locksDir)) {
      const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".json"));
      activeLockCount = lockFiles.length;
    }
  } catch (_) {
    lockInspectionFailed = true;
    addResult({
      id: "locks.active",
      category: "State",
      title: "VFS Active Locks",
      status: "unknown",
      severity: "medium",
      summary: "Could not inspect VFS lock directory",
    });
  }
  if (!lockInspectionFailed && activeLockCount === 0) {
    addResult({
      id: "locks.active",
      category: "State",
      title: "VFS Active Locks",
      status: "pass",
      severity: "info",
      summary: "No active VFS locks present",
    });
  } else if (!lockInspectionFailed) {
    addResult({
      id: "locks.active",
      category: "State",
      title: "VFS Active Locks",
      status: "warn",
      severity: "medium",
      summary: `${activeLockCount} active VFS lock(s) held`,
      evidence: [{ label: "lockCount", value: activeLockCount, sensitive: false }],
      fixes: [
        {
          id: "locks.prune-stale",
          title: "Prune stale locks",
          summary: "Remove locks owned by dead processes",
          risk: "low",
          automatic: true,
          requiresProbe: false,
        },
      ],
    });
  }

  // 7. Provider readiness — for the provider this repository actually selected.
  //
  // This used to ask one question ("is JULES_API_KEY set?") and report it as a
  // high-severity warning regardless of the configured provider, so a
  // repository driving the Claude Code or Codex CLI was permanently told it was
  // misconfigured over a key it neither needs nor should have.
  let configuredProvider = "jules";
  try {
    configuredProvider = loadConfig(root).provider || "jules";
  } catch (_) {
    // Fall back to the default; config.present already reports a broken config.
  }
  const providerProbe = probeProvider(configuredProvider);
  // A green row here used to read as "the provider works", when all it ever
  // checked was a name on PATH or a variable in the environment. An installed
  // CLI whose account has no entitlement passes both and then fails on the
  // first dispatch, so the row has to say what it actually verified.
  const liveness = activeProbe ? probeProviderLiveness(configuredProvider) : null;
  const scopeNote =
    providerProbe.kind === "exec"
      ? "Checked: the binary is on PATH. Not checked: whether the CLI is signed in — only a dispatch can show that."
      : "Checked: a credential is present in the environment. Not checked: whether the provider accepts it.";
  const livenessFailed = Boolean(liveness && liveness.attempted && !liveness.ok);

  addResult({
    id: "provider.key",
    category: "Provider",
    title: `Provider Readiness (${providerProbe.name})`,
    alwaysShowSummary: true,
    status: providerProbe.ready && !livenessFailed ? "pass" : "warn",
    severity: providerProbe.ready && !livenessFailed ? "info" : "high",
    // Naming the variable, not the value: an operator who wonders which key a
    // dispatch will use should not have to echo a secret to find out.
    summary: [
      `${providerProbe.label} — ${providerProbe.reason}`,
      liveness && liveness.attempted ? liveness.detail : null,
      providerProbe.ready ? scopeNote : null,
      !activeProbe && providerProbe.kind === "exec" ? "Run `agentctl doctor --probe` to start the CLI and confirm it answers." : null,
    ]
      .filter(Boolean)
      .join(" "),
    remediation:
      providerProbe.ready && !livenessFailed
        ? []
        : [
            {
              summary: livenessFailed ? `The CLI is installed but did not run cleanly: ${liveness.detail}` : providerProbe.remedy,
              risk: "low",
              automatic: false,
              requiresProbe: !providerProbe.ready ? false : true,
            },
          ],
    evidence: [
      { label: "provider", value: providerProbe.name, sensitive: false },
      { label: "providerKind", value: providerProbe.kind, sensitive: false },
      { label: "ready", value: providerProbe.ready, sensitive: false },
      { label: "keySource", value: providerProbe.keySource || "", sensitive: false },
      { label: "binaryFound", value: Boolean(providerProbe.binPath), sensitive: false },
      { label: "livenessProbed", value: Boolean(liveness && liveness.attempted), sensitive: false },
      { label: "livenessOk", value: liveness ? liveness.ok : null, sensitive: false },
    ],
  });

  // 7a. What else this machine could dispatch to. Purely informational: an
  // operator blocked on one provider should not have to discover by reading
  // source that three others are installed and ready.
  const alternatives = detectAvailableProviders().filter((p) => p.ready && p.name !== providerProbe.name);
  if (alternatives.length > 0) {
    addResult({
      id: "provider.alternatives",
      category: "Provider",
      title: "Other Providers Available",
      status: "pass",
      severity: "info",
      summary: `Also ready on this machine: ${alternatives.map((p) => p.name).join(", ")} — switch with provider: in .agent/config.yml`,
      evidence: alternatives.map((p) => ({ label: p.name, value: p.reason, sensitive: false })),
    });
  }

  // 7b. A .env holding the key must not be tracked by git.
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    let tracked = false;
    try {
      const res = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      tracked = res.status === 0;
    } catch (_) {}

    addResult({
      id: "provider.key.dotenv",
      category: "Provider",
      title: "Local .env secrecy",
      status: tracked ? "fail" : "pass",
      severity: tracked ? "critical" : "info",
      summary: tracked
        ? ".env is tracked by git — an API key committed here is disclosed to everyone with repository access"
        : ".env is present and untracked",
      evidence: [{ label: "gitTracked", value: tracked, sensitive: false }],
      remediation: tracked
        ? [
            {
              summary: "Run: git rm --cached .env && echo '.env' >> .gitignore, then rotate the key",
              risk: "low",
              automatic: false,
              requiresProbe: false,
            },
          ]
        : [],
    });
  }

  // Summarize count by status
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0, unknown: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  const baseReport = {
    schema: /** @type {const} */ ("agentctl/doctor-report-v1"),
    repository: root,
    generatedAt: new Date().toISOString(),
    activeProbe,
    summary,
    results,
  };

  const reportHash = computeReportHash(baseReport);
  /** @type {DoctorReport} */
  const report = {
    ...baseReport,
    reportHash,
  };

  return report;
}
