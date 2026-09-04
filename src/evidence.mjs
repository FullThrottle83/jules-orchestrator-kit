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
import { join, resolve, relative, isAbsolute, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { isTestPath } from "./test-paths.mjs";

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
/**
 * Directories whose contents a build or a test run regenerates.
 *
 * These are not hashed. The test-integrity hash is taken before and after the
 * verification command and any difference is reported as tampering — so a
 * runner that writes its own cache *inside* the test tree accused itself. That
 * is exactly what pytest does: it drops `tests/__pycache__/*.pyc` on first
 * collection, the post-run hash no longer matched the pre-run hash, and every
 * Python project on earth failed the gate with "test files changed during the
 * run". A false accusation of tampering is worse than a missed one; it teaches
 * the user to pass --allow-test-modifications by reflex.
 */
const ARTIFACT_DIRS = new Set([
  ".git", "node_modules", "target", "vendor",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  ".venv", "venv", ".gradle", ".nyc_output", "coverage", "htmlcov",
  ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
]);

/** Compiled output. Regenerated from the sources that are hashed instead. */
const ARTIFACT_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".so", ".dll", ".dylib", ".exe", ".log",
]);

export function findFilesRecursively(dir, baseDir = dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (ARTIFACT_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        results.push(...findFilesRecursively(fullPath, baseDir));
      } else if (entry.isFile()) {
        if (ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
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
/**
 * Extensions that count as code when scanning the repository root.
 *
 * The directory walk above takes everything under `src/` and the test
 * directories; this list only governs the loose files beside package.json,
 * where a `.md` is documentation rather than something the evidence attests to.
 */
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".rs", ".rb", ".php", ".java", ".kt", ".kts", ".cs", ".fs",
  ".swift", ".dart", ".ex", ".exs", ".c", ".h", ".cc", ".cpp", ".hpp", ".sol",
]);

export function computeDirectoryHash(root, options = {}) {
  let fileList = [];

  if (Array.isArray(options.paths) && options.paths.length > 0) {
    fileList = options.paths
      .map((p) => normalizePath(p))
      .filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile())
      .sort();
  } else {
    // A sixth spelling of "where do the tests live?", and the one that got
    // missed when the other five were unified behind `isTestPath`: this is a
    // list of *directory names at the repository root*, not a predicate. Go
    // puts its tests beside the code (`internal/calc/calc_test.go`), and every
    // monorepo puts them under `packages/*/test/`. Neither is under a
    // root-level `test/`, so the walk found nothing, `fileCount` was 0, and
    // `strictTestLock` — which requires `fileCount > 0` — switched itself off
    // without saying so. The tree hash then became the SHA-256 of the empty
    // string, and the evidence manifest attested to it.
    //
    // The named directories stay as a fast path; when they yield nothing, walk
    // the repository and let the shared predicate decide. The walk already
    // skips node_modules, vendor, target and the build caches.
    const targetDirs = options.directories || ["test", "tests", "__tests__", "spec", "specs", "src"];
    for (const dirName of targetDirs) {
      const dirPath = join(root, dirName);
      if (existsSync(dirPath)) {
        const found = findFilesRecursively(dirPath, root);
        fileList.push(...found);
      }
    }
    if (options.testOnly && !fileList.some((f) => isTestPath(f))) {
      for (const f of findFilesRecursively(root, root)) {
        if (isTestPath(f)) fileList.push(f);
      }
    }

    // Plenty of projects keep `app.test.mjs` or `index.js` beside package.json
    // rather than under one of the directories above, and those files were
    // invisible to every hash computed here — a manifest could attest to a
    // pristine test suite while the only test in the repository had been
    // replaced with garbage.
    //
    // Depth one only: recursing from the root would walk node_modules and
    // vendor trees. Source extensions only: the hash exists to bind the
    // manifest to the code it verified, and pulling in README.md or the
    // EVIDENCE.md this very command is about to write would make the hash churn
    // on its own output.
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".")) continue;
        if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        fileList.push(normalizePath(entry.name));
      }
    } catch (_) {
      // An unreadable root yields whatever the directory walk already found.
    }

    fileList = Array.from(new Set(fileList)).sort();
  }

  // Filter test files if specifically looking for test suites
  if (options.testOnly) {
    fileList = fileList.filter((f) => isTestPath(f));
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
    ...(manifest.verification ? { verification: manifest.verification } : {}),
    ...(manifest.sourceIntegrity ? { sourceIntegrity: manifest.sourceIntegrity } : {}),
    executionRecords: manifest.executionRecords,
    securityChecks: manifest.securityChecks,
    ...(manifest.status ? { status: manifest.status } : {}),
    ...(manifest.failedStage ? { failedStage: manifest.failedStage } : {}),
    ...(manifest.diagnostics && manifest.diagnostics.length > 0 ? { diagnostics: manifest.diagnostics } : {}),
    ...(manifest.metrics && Object.keys(manifest.metrics).length > 0 ? { metrics: manifest.metrics } : {}),
    ...(manifest.summary && Object.keys(manifest.summary).length > 0 ? { summary: manifest.summary } : {}),
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
  const currentSourceState = computeDirectoryHash(root);
  const postTestHash = currentTestState.treeHash;

  let tamperDetected = false;
  if (preTestHash && preTestHash !== postTestHash) {
    tamperDetected = true;
  }

  // Intent metadata
  const taskPrompt = options.prompt || options.task?.prompt || "";
  const promptHash = taskPrompt ? "sha256:" + sha256(taskPrompt) : "sha256:empty";
  const promptExcerpt = taskPrompt ? taskPrompt.slice(0, 140).replace(/[\r\n]+/g, " ") : "";

  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
  const metrics = options.metrics || {};
  const status = options.status || (options.ok === false || tamperDetected || diagnostics.length > 0 ? "failed" : "passed");
  const failedStage = options.failedStage || options.failedStep || null;

  // Base manifest
  const baseManifest = {
    schema: "agentctl/evidence-manifest-v1",
    manifestId,
    generatedAt,
    status,
    ...(failedStage ? { failedStage } : {}),
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
    // The manifest attested to the test files and to nothing else, so the code
    // under test could be replaced wholesale after the fact and verification
    // still passed. Evidence that survives the thing it attests to being
    // rewritten is not evidence.
    sourceIntegrity: {
      treeHash: currentSourceState.treeHash,
      fileCount: currentSourceState.fileCount,
    },
    executionRecords: options.executionRecords || [],
    securityChecks: {
      secretScanOk: options.secretScanOk ?? true,
      diffKb: options.diffKb || 0,
      maxDiffKb: options.maxDiffKb || 75,
      protectedScopeOk: options.protectedScopeOk ?? true,
    },
    // How many tests the runner said it collected, and whether it said at all.
    //
    // The collection floor fails a *stated* zero and lets an unstated count
    // pass, because failing on "I could not tell" would break every runner not
    // on the list. That is the right call for the verdict and the wrong thing
    // to leave out of the record: a manifest that says nothing here reads as
    // though a suite ran. `counted: false` is the honest shape for a run where
    // the number was never observable — a quiet runner (`cargo test --quiet`,
    // `pytest -q`) suppresses the very line the floor reads.
    ...(options.collection
      ? {
          verification: {
            testsCollected: options.collection.count,
            counted: options.collection.count !== null,
            runner: options.collection.runner,
          },
        }
      : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
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

  // Written at a custom path means the caller owns the location and its
  // lifetime; only the kit's own directory is ours to rotate.
  if (!customPath) {
    pruneEvidenceManifests(root);
  }

  return targetPath;
}

/**
 * How many evidence manifests to keep.
 *
 * Two are written per verified task, so this is roughly the last hundred runs.
 * Checkpoints (10) and handovers (20) already rotate; evidence and telemetry
 * did not, and a fortnight of ordinary use left 305 files and 2.6 MB in a
 * directory nothing ever read past the newest few. Unbounded growth inside
 * `.agent/` is not just disk: `getLedgerPathsInWindow` and the doctor checks
 * walk these directories, so every dispatch slowly pays for every run before it.
 */
export const EVIDENCE_RETENTION = 200;

/**
 * Removes the oldest evidence manifests beyond the retention limit.
 *
 * Ordered by the timestamp embedded in the manifest id rather than by mtime:
 * a `git checkout` or an rsync rewrites mtimes and would otherwise make the
 * pruner delete the newest evidence it has.
 *
 * @param {string} root
 * @param {number} [retention=EVIDENCE_RETENTION]
 * @returns {{ pruned: number, kept: number }}
 */
export function pruneEvidenceManifests(root, retention = EVIDENCE_RETENTION) {
  const evidenceDir = join(root, ".agent", "evidence");
  if (!existsSync(evidenceDir)) return { pruned: 0, kept: 0 };

  let entries;
  try {
    entries = readdirSync(evidenceDir);
  } catch (_) {
    return { pruned: 0, kept: 0 };
  }

  const manifests = entries
    .filter((f) => f.startsWith("EVD-") && f.endsWith(".json"))
    .map((f) => {
      const match = /^EVD-(\d+)-/.exec(f);
      return { file: f, ts: match ? Number(match[1]) : 0 };
    })
    .sort((a, b) => b.ts - a.ts);

  if (manifests.length <= retention) return { pruned: 0, kept: manifests.length };

  let pruned = 0;
  for (const { file } of manifests.slice(retention)) {
    try {
      unlinkSync(join(evidenceDir, file));
      pruned++;
    } catch (_) {}
  }

  return { pruned, kept: retention };
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

  // 3. Verify the code the manifest attests to still is that code.
  //
  // Without this the manifest proved only that the *tests* had not changed,
  // so `evidence generate` followed by rewriting src/ and committing left
  // verification reporting PASSED over an implementation nobody had checked.
  if (manifest.sourceIntegrity?.treeHash) {
    const currentSourceState = computeDirectoryHash(root);
    if (currentSourceState.treeHash !== manifest.sourceIntegrity.treeHash) {
      return {
        ok: false,
        reason: `Source tree has changed since this evidence was generated (${manifest.sourceIntegrity.treeHash.slice(0, 12)} → ${currentSourceState.treeHash.slice(0, 12)}); the manifest no longer attests to what is on disk`,
        details: {
          currentHash: currentSourceState.treeHash,
          manifestHash: manifest.sourceIntegrity.treeHash,
          manifestCommit: manifest.provenance?.commitSha || null,
          currentCommit: getGitProvenance(root).commitSha,
        },
      };
    }
  }

  // 4. Verify security checks
  if (manifest.securityChecks?.secretScanOk === false) {
    return { ok: false, reason: "Evidence manifest records secret scanning failure" };
  }
  if (manifest.securityChecks?.protectedScopeOk === false) {
    return { ok: false, reason: "Evidence manifest records protected scope violation" };
  }

  return { ok: true, manifestId: manifest.manifestId, evidenceHash: manifest.evidenceHash };
}

/**
 * Exports a structured, machine-readable JSON report optimized for agent consumption.
 * @param {object} manifest
 * @param {string} [customPath]
 * @returns {object}
 */
export function exportJsonReport(manifest, customPath = null) {
  const report = {
    schema: manifest.schema || "agentctl/evidence-manifest-v1",
    manifestId: manifest.manifestId,
    generatedAt: manifest.generatedAt,
    status: manifest.status || (manifest.testIntegrity?.tamperDetected ? "failed" : "passed"),
    failedStage: manifest.failedStage || null,
    metrics: manifest.metrics || {},
    diagnostics: manifest.diagnostics || [],
    executionRecords: manifest.executionRecords || [],
    evidenceHash: manifest.evidenceHash,
  };

  if (customPath) {
    writeFileAtomically(customPath, JSON.stringify(report, null, 2));
  }

  return report;
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
    `> **Evidence Manifest**: \`${manifest.manifestId}\` | **Digest**: \`${manifest.evidenceHash?.slice(0, 16)}...\``,
    "",
    "| Gate / Policy | Status | Evidence Record |",
    "| :--- | :---: | :--- |",
    `| **Test Suite Integrity** | ${manifest.testIntegrity?.tamperDetected ? "❌ Tampered" : "✅ Verified"} | \`${manifest.testIntegrity?.testFileCount || 0} test files\` (Tree: \`${manifest.testIntegrity?.postTestHash?.slice(0, 16)}...\`) |`,
    `| **Secret Leak Scanner** | ${manifest.securityChecks?.secretScanOk ? "✅ Clean" : "❌ Detected"} | High-confidence entropy scan passed |`,
    `| **Payload Governor** | ${manifest.securityChecks?.diffKb <= manifest.securityChecks?.maxDiffKb ? "✅ Bounded" : "❌ Exceeded"} | \`${manifest.securityChecks?.diffKb || 0} KB\` / \`${manifest.securityChecks?.maxDiffKb || 75} KB\` limit |`,
  ];

  if (Array.isArray(manifest.executionRecords) && manifest.executionRecords.length > 0) {
    lines.push("", "#### Executed Verification Stages");
    lines.push("| Stage | Command / Assertion | Policy | Exit Code | Duration |");
    lines.push("| :--- | :--- | :---: | :---: | :---: |");
    for (const rec of manifest.executionRecords) {
      const statusIcon = rec.exitCode === 0 ? "✅" : "❌";
      const policyStr = rec.networkAccess === "forbidden" ? "🔒 Offline" : rec.networkAccess === "read-only" ? "📖 Read-Only" : "🌐 Online";
      const cmdOrAssert = rec.assert ? `\`assert:${rec.assert}\`` : `\`${rec.cmd}\``;
      lines.push(`| \`${rec.id || rec.kind}\` | ${cmdOrAssert} | ${policyStr} | ${statusIcon} \`${rec.exitCode}\` | \`${rec.durationMs || 0}ms\` |`);
    }
  }

  if (Array.isArray(manifest.diagnostics) && manifest.diagnostics.length > 0) {
    lines.push("", "#### ⚠️ Diagnostic Findings");
    for (const diag of manifest.diagnostics) {
      lines.push(`- ${diag}`);
    }
  }

  return lines.join("\n");
}
