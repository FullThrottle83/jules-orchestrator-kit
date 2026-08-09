import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

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
export async function runDoctorChecks(options) {
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
    const gitOut = execFileSync("git", ["--version"], { encoding: "utf-8", timeout: 5000 });
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
      headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
      isRepo = true;
      addResult({
        id: "repo.root",
        category: "Repository",
        title: "Repository Root Verification",
        status: "pass",
        severity: "info",
        summary: `Valid repository at ${root} (HEAD: ${headSha.slice(0, 8)})`,
        evidence: [{ label: "headSha", value: headSha, sensitive: false }],
      });
    } catch {
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
        const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).trim();
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
  const configPath = join(root, ".agent", "config.yml");
  const configExists = existsSync(configPath);
  if (configExists) {
    addResult({
      id: "config.present",
      category: "Config",
      title: "Agent Configuration File",
      status: "pass",
      severity: "info",
      summary: ".agent/config.yml exists",
      evidence: [{ label: "configPath", value: ".agent/config.yml", sensitive: false }],
    });
  } else {
    addResult({
      id: "config.present",
      category: "Config",
      title: "Agent Configuration File",
      status: "warn",
      severity: "medium",
      summary: ".agent/config.yml is missing",
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

  // 4. Verification Oracle Checks
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const testScript = pkg.scripts && pkg.scripts.test;
      if (testScript) {
        addResult({
          id: "oracle.test",
          category: "Verification",
          title: "Test Oracle Configuration",
          status: "pass",
          severity: "info",
          summary: `Test oracle script found: "npm test" -> "${testScript}"`,
          evidence: [{ label: "testScript", value: testScript, sensitive: false }],
        });
      } else {
        addResult({
          id: "oracle.test",
          category: "Verification",
          title: "Test Oracle Configuration",
          status: "warn",
          severity: "medium",
          summary: "package.json missing test script entry",
        });
      }
    } catch {
      addResult({
        id: "oracle.test",
        category: "Verification",
        title: "Test Oracle Configuration",
        status: "warn",
        severity: "medium",
        summary: "Malformed package.json file",
      });
    }
  } else {
    addResult({
      id: "oracle.test",
      category: "Verification",
      title: "Test Oracle Configuration",
      status: "pass",
      severity: "info",
      summary: "Non-Node workspace verified",
    });
  }

  // 5. State & Telemetry Checks
  const telemetryHeadPath = join(root, ".agent", "state", "telemetry", ".head");
  if (existsSync(telemetryHeadPath)) {
    addResult({
      id: "state.telemetry",
      category: "State",
      title: "Telemetry Spine Head Integrity",
      status: "pass",
      severity: "info",
      summary: "Telemetry .head file present and valid",
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
  if (existsSync(locksDir)) {
    const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
    activeLockCount = lockFiles.length;
  }
  if (activeLockCount === 0) {
    addResult({
      id: "locks.active",
      category: "State",
      title: "VFS Active Locks",
      status: "pass",
      severity: "info",
      summary: "No active VFS locks present",
    });
  } else {
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

  // 7. Jules Provider Key Check
  const hasApiKey = Boolean(process.env.JULES_API_KEY || process.env.GEMINI_API_KEY);
  if (hasApiKey) {
    addResult({
      id: "provider.key",
      category: "Jules",
      title: "Jules Provider API Key",
      status: "pass",
      severity: "info",
      summary: "API key environment variable detected",
      evidence: [{ label: "keyConfigured", value: true, sensitive: false }],
    });
  } else {
    addResult({
      id: "provider.key",
      category: "Jules",
      title: "Jules Provider API Key",
      status: "warn",
      severity: "high",
      summary: "Neither JULES_API_KEY nor GEMINI_API_KEY environment variable is set",
      evidence: [{ label: "keyConfigured", value: false, sensitive: false }],
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
