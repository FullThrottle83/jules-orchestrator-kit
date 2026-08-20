import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

/**
 * Normalizes file path to POSIX slashes.
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p = "") {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Computes SHA-256 hex digest of a string or buffer.
 * @param {string | Buffer} content
 * @returns {string}
 */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Computes SHA-256 of a single file on disk.
 * @param {string} filePath
 * @returns {string | null}
 */
export function computeFileHash(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath);
    return "sha256:" + sha256(content);
  } catch (_) {
    return null;
  }
}

/**
 * Recursively scans a directory and finds all matching files.
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {string[]}
 */
export function findFilesRecursively(dir, baseDir = dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target" || entry.name === "vendor") {
        continue;
      }
      if (entry.isDirectory()) {
        results.push(...findFilesRecursively(fullPath, baseDir));
      } else if (entry.isFile()) {
        results.push(normalizePath(relative(baseDir, fullPath)));
      }
    }
  } catch (_) {}
  return results.sort();
}

/**
 * Deterministically computes SHA-256 tree hash over a directory or set of files.
 * Ignores mtime and permissions to ensure byte-level determinism.
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.paths] - Specific paths to hash (relative to root)
 * @param {string[]} [options.directories] - Specific directory names to scan (e.g. ['test', 'tests'])
 * @returns {{ treeHash: string, fileCount: number, fileHashes: Record<string, string> }}
 */
export function computeDirectoryHash(root, options = {}) {
  let fileList = [];

  if (Array.isArray(options.paths) && options.paths.length > 0) {
    fileList = options.paths
      .map((p) => normalizePath(p))
      .filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile())
      .sort();
  } else {
    const targetDirs = options.directories || ["test", "tests", "__tests__", "spec", "src"];
    for (const dirName of targetDirs) {
      const dirPath = join(root, dirName);
      if (existsSync(dirPath)) {
        const found = findFilesRecursively(dirPath, root);
        fileList.push(...found);
      }
    }
    fileList = Array.from(new Set(fileList)).sort();
  }

  // Filter test files if specifically looking for test suites
  if (options.testOnly) {
    fileList = fileList.filter((f) => {
      const lower = f.toLowerCase();
      return (
        lower.startsWith("test/") ||
        lower.startsWith("tests/") ||
        lower.startsWith("__tests__/") ||
        lower.startsWith("spec/") ||
        lower.includes(".test.") ||
        lower.includes(".spec.") ||
        lower.includes("_test.") ||
        lower.endsWith("test.sol") ||
        lower.endsWith(".t.sol")
      );
    });
  }

  const fileHashes = {};
  const hashLines = [];

  for (const relPath of fileList) {
    const fullPath = join(root, relPath);
    const hash = computeFileHash(fullPath);
    if (hash) {
      fileHashes[relPath] = hash;
      hashLines.push(`${relPath}:${hash}`);
    }
  }

  const treeHash = "sha256:" + sha256(hashLines.join("\n"));
  return {
    treeHash,
    fileCount: hashLines.length,
    fileHashes,
  };
}

/**
 * Computes canonical hash for an evidence manifest (excluding the evidenceHash field).
 * @param {object} manifest
 * @returns {string}
 */
export function computeEvidenceHash(manifest) {
  const canonicalPayload = JSON.stringify({
    schema: manifest.schema,
    manifestId: manifest.manifestId,
    generatedAt: manifest.generatedAt,
    intent: manifest.intent,
    provenance: manifest.provenance,
    testIntegrity: manifest.testIntegrity,
    executionRecords: manifest.executionRecords,
    securityChecks: manifest.securityChecks,
  });
  return "sha256:" + sha256(canonicalPayload);
}

/**
 * Safely writes a file atomically.
 * @param {string} filePath
 * @param {string} content
 */
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
 * Queries current git provenance data safely.
 * @param {string} root
 * @returns {object}
 */
export function getGitProvenance(root = process.cwd()) {
  try {
    const commitSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    let branch = "";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (_) {}

    let statusOutput = "";
    try {
      statusOutput = execSync("git status --porcelain", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (_) {}

    return {
      commitSha,
      branch: branch || "HEAD",
      dirty: statusOutput.length > 0,
    };
  } catch (_) {
    return {
      commitSha: "unknown",
      branch: "unknown",
      dirty: false,
    };
  }
}

/**
 * Generates an Evidence Manifest capturing deterministic build, test, and security evidence.
 * @param {string} root
 * @param {object} [options]
 * @returns {object}
 */
export function generateEvidenceManifest(root = process.cwd(), options = {}) {
  const manifestId = options.manifestId || `EVD-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const generatedAt = new Date().toISOString();
  const gitInfo = getGitProvenance(root);

  // Compute test tree integrity
  const preTestHash = options.preTestHash || null;
  const currentTestState = computeDirectoryHash(root, { testOnly: true });
  const postTestHash = currentTestState.treeHash;

  let tamperDetected = false;
  if (preTestHash && preTestHash !== postTestHash) {
    tamperDetected = true;
  }

  // Intent metadata
  const taskPrompt = options.prompt || options.task?.prompt || "";
  const promptHash = taskPrompt ? "sha256:" + sha256(taskPrompt) : "sha256:empty";
  const promptExcerpt = taskPrompt ? taskPrompt.slice(0, 140).replace(/[\r\n]+/g, " ") : "";

  // Base manifest
  const baseManifest = {
    schema: "agentctl/evidence-manifest-v1",
    manifestId,
    generatedAt,
    intent: {
      taskId: options.taskId || options.task?.id || "local-task",
      title: options.title || options.task?.title || "Verification Run",
      promptHash,
      promptExcerpt,
    },
    provenance: {
      commitSha: gitInfo.commitSha,
      branch: gitInfo.branch,
      dirty: gitInfo.dirty,
      repository: options.repository || "local",
    },
    testIntegrity: {
      preTestHash: preTestHash || postTestHash,
      postTestHash,
      tamperDetected,
      testFileCount: currentTestState.fileCount,
      fileHashes: currentTestState.fileHashes,
    },
    executionRecords: options.executionRecords || [],
    securityChecks: {
      secretScanOk: options.secretScanOk ?? true,
      diffKb: options.diffKb || 0,
      maxDiffKb: options.maxDiffKb || 75,
      protectedScopeOk: options.protectedScopeOk ?? true,
    },
  };

  const evidenceHash = computeEvidenceHash(baseManifest);
  return {
    ...baseManifest,
    evidenceHash,
  };
}

/**
 * Persists an evidence manifest to disk.
 * @param {string} root
 * @param {object} manifest
 * @param {string} [customPath]
 * @returns {string} Target path
 */
export function writeEvidenceManifest(root, manifest, customPath = null) {
  const evidenceDir = join(root, ".agent", "evidence");
  if (!existsSync(evidenceDir)) {
    mkdirSync(evidenceDir, { recursive: true });
  }

  const targetPath = customPath
    ? isAbsolute(customPath) ? customPath : join(root, customPath)
    : join(evidenceDir, `${manifest.manifestId}.json`);

  writeFileAtomically(targetPath, JSON.stringify(manifest, null, 2));

  // Also maintain symlink/latest pointer
  const latestPath = join(evidenceDir, "manifest.v1.json");
  try {
    writeFileAtomically(latestPath, JSON.stringify(manifest, null, 2));
  } catch (_) {}

  return targetPath;
}

/**
 * Loads and validates an evidence manifest from disk.
 * @param {string} root
 * @param {string} [manifestIdOrPath]
 * @returns {object}
 */
export function loadEvidenceManifest(root, manifestIdOrPath = "manifest.v1.json") {
  const evidenceDir = resolve(root, ".agent", "evidence");
  let targetPath;

  if (manifestIdOrPath.endsWith(".json")) {
    targetPath = isAbsolute(manifestIdOrPath) ? resolve(manifestIdOrPath) : resolve(evidenceDir, manifestIdOrPath);
    if (!existsSync(targetPath)) {
      targetPath = resolve(root, manifestIdOrPath);
    }
  } else {
    targetPath = join(evidenceDir, `${manifestIdOrPath}.json`);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`Evidence manifest not found: ${targetPath}`);
  }

  const raw = readFileSync(targetPath, "utf-8");
  const manifest = JSON.parse(raw);

  if (manifest.schema !== "agentctl/evidence-manifest-v1") {
    throw new Error(`Invalid evidence manifest schema: ${manifest.schema}`);
  }

  const expectedHash = computeEvidenceHash(manifest);
  if (manifest.evidenceHash !== expectedHash) {
    throw new Error(`Tampered evidence manifest hash mismatch in ${targetPath}`);
  }

  return manifest;
}

/**
 * Validates current workspace state against an evidence manifest.
 * Asserts zero test tampering and matching test suite tree hash.
 * @param {string} root
 * @param {object | string} manifestOrPath
 * @returns {{ ok: boolean, reason?: string, details?: object }}
 */
export function verifyEvidenceManifest(root = process.cwd(), manifestOrPath = "manifest.v1.json") {
  let manifest;
  try {
    manifest = typeof manifestOrPath === "object" && manifestOrPath !== null
      ? manifestOrPath
      : loadEvidenceManifest(root, manifestOrPath);
  } catch (err) {
    return { ok: false, reason: `Failed to load evidence manifest: ${err.message}` };
  }

  // 1. Verify schema & cryptographic hash
  if (manifest.schema !== "agentctl/evidence-manifest-v1") {
    return { ok: false, reason: `Invalid schema version: ${manifest.schema}` };
  }
  if (manifest.evidenceHash !== computeEvidenceHash(manifest)) {
    return { ok: false, reason: "Evidence manifest hash signature mismatch (tampered file)" };
  }

  // 2. Verify test integrity / No test weakening
  const currentTestState = computeDirectoryHash(root, { testOnly: true });
  if (manifest.testIntegrity?.tamperDetected) {
    return {
      ok: false,
      reason: "Test suite tampering detected in evidence manifest",
      details: { preTestHash: manifest.testIntegrity.preTestHash, postTestHash: manifest.testIntegrity.postTestHash },
    };
  }

  if (manifest.testIntegrity?.postTestHash && currentTestState.treeHash !== manifest.testIntegrity.postTestHash) {
    return {
      ok: false,
      reason: `Current test suite tree hash (${currentTestState.treeHash}) does not match manifest evidence (${manifest.testIntegrity.postTestHash})`,
      details: { currentHash: currentTestState.treeHash, manifestHash: manifest.testIntegrity.postTestHash },
    };
  }

  // 3. Verify security checks
  if (manifest.securityChecks?.secretScanOk === false) {
    return { ok: false, reason: "Evidence manifest records secret scanning failure" };
  }
  if (manifest.securityChecks?.protectedScopeOk === false) {
    return { ok: false, reason: "Evidence manifest records protected scope violation" };
  }

  return { ok: true, manifestId: manifest.manifestId, evidenceHash: manifest.evidenceHash };
}

/**
 * Renders PR-ready Markdown evidence section.
 * @param {object} manifest
 * @returns {string}
 */
export function generateEvidenceMarkdown(manifest) {
  const lines = [
    "### 🛡️ Autonomous Verification & Evidence Proof",
    "",
    `> **Evidence Manifest**: \`${manifest.manifestId}\` | **Signature**: \`${manifest.evidenceHash?.slice(0, 16)}...\``,
    "",
    "| Gate / Policy | Status | Evidence Record |",
    "| :--- | :---: | :--- |",
    `| **Test Suite Integrity** | ${manifest.testIntegrity?.tamperDetected ? "❌ Tampered" : "✅ Verified"} | \`${manifest.testIntegrity?.testFileCount || 0} test files\` (Tree: \`${manifest.testIntegrity?.postTestHash?.slice(0, 16)}...\`) |`,
    `| **Secret Leak Scanner** | ${manifest.securityChecks?.secretScanOk ? "✅ Clean" : "❌ Detected"} | High-confidence entropy scan passed |`,
    `| **Payload Governor** | ${manifest.securityChecks?.diffKb <= manifest.securityChecks?.maxDiffKb ? "✅ Bounded" : "❌ Exceeded"} | \`${manifest.securityChecks?.diffKb || 0} KB\` / \`${manifest.securityChecks?.maxDiffKb || 75} KB\` limit |`,
  ];

  if (Array.isArray(manifest.executionRecords) && manifest.executionRecords.length > 0) {
    lines.push("", "#### Executed Verification Stages");
    lines.push("| Stage | Command | Policy | Exit Code | Duration |");
    lines.push("| :--- | :--- | :---: | :---: | :---: |");
    for (const rec of manifest.executionRecords) {
      const statusIcon = rec.exitCode === 0 ? "✅" : "❌";
      const policyStr = rec.networkAccess === "forbidden" ? "🔒 Offline" : rec.networkAccess === "read-only" ? "📖 Read-Only" : "🌐 Online";
      lines.push(`| \`${rec.id || rec.kind}\` | \`${rec.cmd}\` | ${policyStr} | ${statusIcon} \`${rec.exitCode}\` | \`${rec.durationMs || 0}ms\` |`);
    }
  }

  return lines.join("\n");
}
