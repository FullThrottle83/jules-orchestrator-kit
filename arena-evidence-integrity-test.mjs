#!/usr/bin/env node
/**
 * arena-evidence-integrity-test.mjs
 * ================================
 * Evidence Chain Tamper Audit — adversarial harness for src/evidence.mjs.
 *
 * Mission: test the SHA-256 hash chains and manifest verification of
 * src/evidence.mjs against manipulation, truncation and corruption, and
 * document every manipulation that goes UNDETECTED.
 *
 * Scope: standalone Node.js ESM, zero external dependencies, imports only
 * from ./src/evidence.mjs and node: builtins. It never touches the repository
 * itself — every scenario runs inside throwaway temp workspaces.
 *
 * Verdict taxonomy (per case):
 *   DETECTED    — the attack was caught (secure behaviour, expectation met)
 *   BYPASS      — the attack succeeded undetected (security finding)
 *   PARTIAL     — partially protected (security finding)
 *   GAP         — silent coverage / robustness hole (security finding)
 *   ROBUST      — hostile input handled safely (secure behaviour)
 *
 * Every case records the verdict observed during the audit and asserts it.
 * The harness therefore doubles as a regression detector: if src/evidence.mjs
 * changes such that a finding is fixed (or a defence regresses), the case
 * diverges from the recorded matrix and the run exits 1 — at which point
 * arena-evidence-integrity-report.md must be re-run and re-issued.
 *
 * Run: node arena-evidence-integrity-test.mjs
 * See:  arena-evidence-integrity-report.md (findings F-01 … F-18)
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  sha256,
  computeDirectoryHash,
  computeEvidenceHash,
  generateEvidenceManifest,
  writeEvidenceManifest,
  loadEvidenceManifest,
  verifyEvidenceManifest,
  generateEvidenceMarkdown,
  exportJsonReport,
} from "./src/evidence.mjs";

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

const results = [];
const RUN_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const tempRoots = [];

function makeWorkspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "arena-evd-audit-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function makeFixtureWorkspace() {
  return makeWorkspace({
    "src/core.js": "export const add = (a, b) => a + b;\n",
    "test/core.test.js": "test('core', () => { assert.equal(add(2, 2), 4); });\n",
    "scripts/run-tests.mjs": "console.log('runner');\n",
    "index.mjs": "export * from './src/core.js';\n",
  });
}

/**
 * Records one audit observation and checks it against the verdict recorded
 * during the audit. `expected` may be a single verdict or a list of
 * acceptable verdicts (for environment-dependent cases).
 */
function record(id, vector, title, expected, observed, severity, finding, note = "") {
  const match = Array.isArray(expected) ? expected.includes(observed) : expected === observed;
  results.push({ id, vector, title, expected, observed, severity, finding, note, match });
  return match;
}

/** Runs `fn`, converting an unexpected throw into a CRASH observation. */
function observe(fn) {
  try {
    return fn();
  } catch (err) {
    return `CRASH: ${err.message}`;
  }
}

/** verifyEvidenceManifest verdict flattened to the harness taxonomy. */
function verifyVerdict(root, manifestOrPath) {
  const res = verifyEvidenceManifest(root, manifestOrPath);
  return res.ok ? "BYPASS" : "DETECTED";
}

/** Same as verifyVerdict, but only counts cryptographic (hash-level) failures. */
function verifyHashCatch(root, manifestOrPath) {
  const res = verifyEvidenceManifest(root, manifestOrPath);
  return !res.ok && /hash|mismatch|tampered/i.test(res.reason || "") ? "DETECTED" : res.ok ? "BYPASS" : "DETECTED-OTHER";
}

/** Deep clone through JSON (manifests are JSON documents by construction). */
function clone(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

/** Tamper helper: mutates a clone and optionally forges the unkeyed hash. */
function forge(manifest, mutate, { rehash = true } = {}) {
  const m = clone(manifest);
  mutate(m);
  if (rehash) m.evidenceHash = computeEvidenceHash(m);
  return m;
}

function validShell(manifestId = "EVD-0-shell") {
  // The minimal self-hashed document verifyEvidenceManifest accepts.
  const shell = {
    schema: "agentctl/evidence-manifest-v1",
    manifestId,
    generatedAt: new Date().toISOString(),
  };
  shell.evidenceHash = computeEvidenceHash(shell);
  return shell;
}

// ---------------------------------------------------------------------------
// Vector a — field manipulation of a valid manifest
// ---------------------------------------------------------------------------

function vectorFieldTamper() {
  const root = makeFixtureWorkspace();
  const manifest = generateEvidenceManifest(root, {
    taskId: "TASK-A",
    title: "Vector A baseline",
    prompt: "ship the auth fix",
    executionRecords: [
      { id: "unit", kind: "test", cmd: "npm test", exitCode: 0, durationMs: 100, networkAccess: "forbidden" },
    ],
    secretScanOk: true,
    diffKb: 10,
  });
  writeEvidenceManifest(root, manifest);
  record("A00", "a", "valid manifest verifies on unmodified workspace",
    "BYPASS", verifyVerdict(root, manifest), "Info", "-",
    "baseline sanity: verification of a genuine manifest succeeds");

  const cases = [
    ["A01", "manifestId rewritten", (m) => { m.manifestId = "EVD-forged"; }],
    ["A02", "generatedAt rewritten", (m) => { m.generatedAt = "2030-01-01T00:00:00.000Z"; }],
    ["A03", "intent.taskId rewritten", (m) => { m.intent.taskId = "TASK-OTHER"; }],
    ["A04", "provenance.commitSha rewritten", (m) => { m.provenance.commitSha = "deadbeef".repeat(5); }],
    ["A05", "testIntegrity.postTestHash rewritten", (m) => { m.testIntegrity.postTestHash = "sha256:" + "f".repeat(64); }],
    ["A06", "one testIntegrity.fileHashes entry rewritten", (m) => {
      const k = Object.keys(m.testIntegrity.fileHashes)[0];
      m.testIntegrity.fileHashes[k] = "sha256:" + "e".repeat(64);
    }],
    ["A09", "evidenceHash removed", (m) => { delete m.evidenceHash; }],
    ["A10", "schema version changed", (m) => { m.schema = "agentctl/evidence-manifest-v2"; }],
    ["A18", "evidenceHash prefix forgery (16-char prefix match, wrong tail)", (m) => {
      m.evidenceHash = m.evidenceHash.slice(0, 7 + 16) + "0".repeat(48);
    }],
  ];
  for (const [id, title, mutate] of cases) {
    record(id, "a", `${title} — no rehash`,
      "DETECTED", verifyVerdict(root, forge(manifest, mutate, { rehash: false })), "Info", "F-01",
      "unkeyed-hash integrity: plain field edits are caught while the hash is left stale");
  }

  // A07/A08/A08b: field-level tampering of "bad news" fields. The baselines
  // record genuine failures (failing exit code / failed secret scan) so that
  // laundering them is observable and the catch is cryptographic.
  const dirtyRun = generateEvidenceManifest(root, {
    taskId: "TASK-A-dirty-run",
    executionRecords: [
      { id: "unit", kind: "test", cmd: "npm test", exitCode: 1, durationMs: 100, networkAccess: "forbidden" },
    ],
    secretScanOk: true,
  });
  record("A07", "a", "executionRecords exit code laundered (1 -> 0) — no rehash",
    "DETECTED", verifyHashCatch(root, forge(dirtyRun, (m) => {
      m.executionRecords = [{ id: "unit", kind: "test", cmd: "npm test", exitCode: 0, durationMs: 100, networkAccess: "forbidden" }];
    }, { rehash: false })), "Info", "F-01",
    "unkeyed-hash integrity: plain field edits are caught while the hash is left stale");

  const dirtySecret = generateEvidenceManifest(root, {
    taskId: "TASK-A-dirty-secret",
    secretScanOk: false,
  });
  record("A08a", "a", "manifest recording secretScanOk:false is rejected (positive control)",
    "DETECTED", verifyVerdict(root, dirtySecret), "Info", "F-08",
    "explicit recorded failures do fail the gate");
  record("A08", "a", "securityChecks.secretScanOk flipped false -> true — no rehash",
    "DETECTED", verifyHashCatch(root, forge(dirtySecret, (m) => { m.securityChecks.secretScanOk = true; }, { rehash: false })),
    "Info", "F-01", "");
  record("A08b", "a", "manifest recording a failing run (exitCode 1) verifies ok:true",
    "BYPASS", verifyVerdict(root, dirtyRun), "High", "F-08",
    "the gate verdict is outcome-blind: verifyEvidenceManifest never reads status/failedStage/exit codes — it authenticates the document but not its verdict");

  // A11: tamperDetected flag laundering. First build a manifest that genuinely
  // records tampering (pre != post at generation time).
  const tamperedGen = generateEvidenceManifest(root, {
    taskId: "TASK-A-tampered",
    preTestHash: "sha256:" + "a".repeat(64), // not the current tree hash
  });
  record("A11a", "a", "manifest generated with preTestHash != postTestHash records tamperDetected",
    "DETECTED", verifyVerdict(root, tamperedGen), "Info", "F-10",
    "generation-time tamper flag works when the caller supplies a real pre-run hash");
  record("A11b", "a", "tamperDetected true -> false, no rehash",
    "DETECTED", verifyVerdict(root, forge(tamperedGen, (m) => { m.testIntegrity.tamperDetected = false; }, { rehash: false })),
    "Info", "F-01", "");
  record("A11c", "a", "tamperDetected true -> false + stale pre/post hashes kept + rehash",
    "BYPASS", verifyVerdict(root, forge(tamperedGen, (m) => { m.testIntegrity.tamperDetected = false; })),
    "High", "F-10",
    "verify never re-derives preTestHash != postTestHash; it trusts the boolean alone");

  // A12: unknown extra fields are invisible to computeEvidenceHash.
  record("A12", "a", "extra unknown top-level field added ('waiver'), no rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.waiver = "approved-by-ciso"; }, { rehash: false })),
    "Low", "F-12",
    "computeEvidenceHash whitelists fields; arbitrary side-channel claims ride a verified manifest");

  // A13-A17: the rehash attack. evidenceHash is unkeyed SHA-256 — any field
  // can be forged by recomputing it. Only a trust anchor outside the document
  // could stop this.
  record("A13", "a", "provenance.commitSha rewritten + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.provenance.commitSha = "deadbeef".repeat(5); })),
    "High", "F-05",
    "provenance is attested but never cross-checked against the workspace at verify time");
  record("A14", "a", "failed run laundered: exit code 1 -> 0, status failed -> passed, diagnostics dropped + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => {
      m.executionRecords = [{ id: "unit", kind: "test", cmd: "npm test", exitCode: 0, durationMs: 100, networkAccess: "forbidden" }];
      m.status = "passed";
      delete m.failedStage;
      delete m.diagnostics;
    })),
    "High", "F-01", "");
  record("A15", "a", "securityChecks.secretScanOk false -> true + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.securityChecks.secretScanOk = true; })),
    "High", "F-01", "");
  record("A16", "a", "testIntegrity hashes retargeted at weakened suite + sourceIntegrity retargeted + rehash",
    "BYPASS", observe(() => {
      // Weaken the suite on disk, then re-attest to it.
      writeFileSync(join(root, "test", "core.test.js"), "test('core', () => {});\n");
      const freshTests = computeDirectoryHash(root, { testOnly: true });
      const freshSource = computeDirectoryHash(root);
      return verifyVerdict(root, forge(manifest, (m) => {
        m.testIntegrity.preTestHash = freshTests.treeHash;
        m.testIntegrity.postTestHash = freshTests.treeHash;
        m.testIntegrity.fileHashes = freshTests.fileHashes;
        m.testIntegrity.tamperDetected = false;
        m.sourceIntegrity = { treeHash: freshSource.treeHash, fileCount: freshSource.fileCount };
      }));
    }),
    "Critical", "F-01",
    "full chain forge: tests weakened, manifest rehashed, verification passes");
  record("A17", "a", "stripped manifest (schema + ids only, self-hashed) on an intact workspace",
    "BYPASS", verifyVerdict(root, validShell()), "Critical", "F-02",
    "no workspace binding at all is required for an ok:true verdict");

  // A19: stripped manifest on a DESTROYED workspace.
  record("A19", "a", "stripped manifest (no testIntegrity/sourceIntegrity/securityChecks) + rehash on a destroyed workspace",
    "BYPASS", observe(() => {
      const stripped = {
        schema: manifest.schema,
        manifestId: manifest.manifestId,
        generatedAt: manifest.generatedAt,
        intent: manifest.intent,
        provenance: manifest.provenance,
        executionRecords: [],
        securityChecks: { secretScanOk: true, diffKb: 0, maxDiffKb: 75, protectedScopeOk: true },
      };
      stripped.evidenceHash = computeEvidenceHash(stripped);
      rmSync(join(root, "test"), { recursive: true, force: true });
      rmSync(join(root, "src"), { recursive: true, force: true });
      return verifyVerdict(root, stripped);
    }),
    "Critical", "F-02",
    "checks 2-4 of verifyEvidenceManifest are all optional and skip on missing sections");

  // A20: null sections + rehash — own workspace, since A19 destroys `root`.
  record("A20", "a", "testIntegrity: null + rehash",
    "BYPASS", observe(() => {
      const root2 = makeFixtureWorkspace();
      const m2 = generateEvidenceManifest(root2, { taskId: "TASK-A20" });
      return verifyVerdict(root2, forge(m2, (m) => { m.testIntegrity = null; }));
    }),
    "High", "F-08",
    "null testIntegrity skips the whole test-integrity check via optional chaining");
}

// ---------------------------------------------------------------------------
// Vector b — truncated JSON (disk-full writes) and corruption
// ---------------------------------------------------------------------------

function vectorTruncation() {
  const root = makeFixtureWorkspace();
  const manifest = generateEvidenceManifest(root, { taskId: "TASK-B" });
  const path = writeEvidenceManifest(root, manifest);
  const raw = readFileSync(path, "utf-8");

  record("B01", "b", "manifest truncated at 60% (simulated disk-full write)",
    "DETECTED", verifyVerdict(root, (() => { writeFileSync(path, raw.slice(0, Math.floor(raw.length * 0.6))); return path; })()),
    "Info", "F-15", "JSON.parse fails closed");
  record("B02", "b", "manifest truncated at 99% (final brace missing)",
    "DETECTED", verifyVerdict(root, (() => { writeFileSync(path, raw.slice(0, raw.length - 2)); return path; })()),
    "Info", "F-15", "");
  record("B03", "b", "manifest file empty (0 bytes)",
    "DETECTED", verifyVerdict(root, (() => { writeFileSync(path, ""); return path; })()),
    "Info", "F-15", "");
  record("B05", "b", "manifest file replaced with binary garbage",
    "DETECTED", verifyVerdict(root, (() => { writeFileSync(path, Buffer.from([0x00, 0xff, 0xfe, 0x01])); return path; })()),
    "Info", "F-15", "");

  // B04: the `latest` pointer is corrupt while the id-addressed file is fine.
  writeFileSync(path, raw); // restore
  const latestPath = join(root, ".agent", "evidence", "manifest.v1.json");
  writeFileSync(latestPath, raw.slice(0, Math.floor(raw.length / 2)));
  record("B04", "b", "latest pointer (manifest.v1.json) truncated, id-addressed copy intact",
    "PARTIAL", observe(() => {
      const viaLatest = verifyVerdict(root, "manifest.v1.json");
      let viaId = "DETECTED";
      try {
        const loaded = loadEvidenceManifest(root, manifest.manifestId);
        viaId = loaded.evidenceHash === manifest.evidenceHash ? "BYPASS" : "DETECTED";
      } catch (_) {}
      return viaLatest === "DETECTED" && viaId === "BYPASS" ? "PARTIAL" : `MIXED:${viaLatest}/${viaId}`;
    }),
    "Low", "F-15",
    "fail-closed on the pointer, but an alternate load path still succeeds — partial availability loss");
  writeFileSync(path, raw);
}

// ---------------------------------------------------------------------------
// Vector c — duplicated entry hashes and hash-line ambiguity
// ---------------------------------------------------------------------------

function vectorDuplicates() {
  const root = makeWorkspace({
    "x.test.js": "test('gate: auth must reject expired tokens', () => assert.ok(false));\n",
    "y.test.js": "test('smoke', () => assert.ok(true));\n",
    "src/a.js": "export const a = 1;\n",
  });
  const contentA = readFileSync(join(root, "x.test.js"));
  const contentB = readFileSync(join(root, "y.test.js"));
  const hA = "sha256:" + sha256(contentA);
  const hB = "sha256:" + sha256(contentB);

  const manifest = generateEvidenceManifest(root, { taskId: "TASK-C" });
  writeEvidenceManifest(root, manifest);

  // C1: duplicate hash VALUES across entries (identical files) — legitimate.
  record("C1", "c", "two fileHashes entries carrying the same hash value (identical content)",
    "BYPASS", observe(() => {
      const dupRoot = makeWorkspace({ "t1.test.js": "same\n", "t2.test.js": "same\n" });
      const m = generateEvidenceManifest(dupRoot, { taskId: "TASK-C-dup" });
      const hashes = Object.values(m.testIntegrity.fileHashes);
      return hashes.length === 2 && hashes[0] === hashes[1] && verifyVerdict(dupRoot, m) === "BYPASS" ? "BYPASS" : "DETECTED";
    }),
    "Info", "F-18",
    "by design: identical content yields identical hashes; entries are not nonce-distinct (forensics note only)");

  // C2: duplicate JSON keys — parser differential.
  record("C2", "c", "duplicate 'evidenceHash' keys in the JSON document (decoy first, real last)",
    "BYPASS", observe(() => {
      const raw = JSON.stringify(manifest, null, 2);
      const decoy = '"evidenceHash": "sha256:' + "0".repeat(64) + '",\n  "evidenceHash"';
      const poisoned = raw.replace('"evidenceHash"', decoy);
      const p = join(root, ".agent", "evidence", "dup-keys.json");
      writeFileSync(p, poisoned);
      return verifyVerdict(root, p);
    }),
    "Medium", "F-09",
    "JSON.parse last-wins: verification hashes the last value while naive first-key readers see the decoy");

  // C3: tree-hash collision via crafted filenames. hashLines are concatenated
  // as `path:hash` joined by \n with no escaping, so a filename containing
  // \n and : can impersonate two hash lines. Demonstrated end-to-end: a test
  // file is DELETED from the suite and verification still passes — with no
  // hash recompute at all.
  record("C3", "c", "tree-hash collision via newline+colon filename: x.test.js deleted, suite weakened, no rehash",
    "BYPASS", observe(() => {
      const evilName = `x.test.js:${hA}\ny.test.js`;
      rmSync(join(root, "x.test.js"));
      rmSync(join(root, "y.test.js"));
      writeFileSync(join(root, evilName), contentB); // 2nd-preimage requires contentB
      const verdict = verifyVerdict(root, manifest);
      const tree = computeDirectoryHash(root, { testOnly: true });
      return verdict === "BYPASS" && tree.treeHash === manifest.testIntegrity.postTestHash ? "BYPASS" : "DETECTED";
    }),
    "Critical", "F-03",
    "hashLines concatenation is ambiguous: 1 file with a crafted name reproduces the joined lines of 2 files; testIntegrity.fileHashes/fileCount are never compared to disk");

  // C3b: the same ambiguity on the raw tree hash (unit level).
  record("C3b", "c", "computeDirectoryHash is not injective (same treeHash for different file sets)",
    "BYPASS", observe(() => {
      const tmp = makeWorkspace({ "x.test.js": "A\n", "y.test.js": "B\n" });
      const before = computeDirectoryHash(tmp, { testOnly: true });
      const a = "sha256:" + sha256("A\n");
      rmSync(join(tmp, "x.test.js"));
      rmSync(join(tmp, "y.test.js"));
      writeFileSync(join(tmp, `x.test.js:${a}\ny.test.js`), "B\n");
      const after = computeDirectoryHash(tmp, { testOnly: true });
      return before.treeHash === after.treeHash && before.fileCount !== after.fileCount ? "BYPASS" : "DETECTED";
    }),
    "Critical", "F-03",
    "collision works anywhere two relative paths share a slash-free directory level");
}

// ---------------------------------------------------------------------------
// Vector d — empty / null / undefined fields
// ---------------------------------------------------------------------------

function vectorEmptyFields() {
  const root = makeFixtureWorkspace();
  const manifest = generateEvidenceManifest(root, { taskId: "TASK-D" });
  writeEvidenceManifest(root, manifest);

  record("D01", "d", "testIntegrity.postTestHash = null + rehash",
    "BYPASS", observe(() => {
      const m = forge(manifest, (mm) => { mm.testIntegrity.postTestHash = null; });
      return verifyVerdict(root, m);
    }),
    "Medium", "F-08",
    "the guard `postTestHash && ...` skips the test-hash check entirely on null/empty — fail-open; only sourceIntegrity still binds the tree");

  record("D02", "d", "fileHashes = {} + rehash (per-file map erased, treeHash intact)",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.testIntegrity.fileHashes = {}; })),
    "Medium", "F-07",
    "fileHashes is attested but never verified against disk — erasing it changes nothing");

  record("D03", "d", "executionRecords = [] + rehash (all runtime evidence erased)",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.executionRecords = []; })),
    "Medium", "F-08",
    "verification never requires that any command was actually executed");

  record("D04", "d", "securityChecks = {} + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.securityChecks = {}; })),
    "Medium", "F-08",
    "fail-open: only an explicit `false` fails; missing/empty securityChecks pass");

  record("D05", "d", "securityChecks.secretScanOk = null + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.securityChecks.secretScanOk = null; })),
    "Medium", "F-08",
    "`=== false` is the only failing comparison — null/undefined pass");

  record("D06", "d", "intent = {} + provenance = {} + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.intent = {}; m.provenance = {}; })),
    "Medium", "F-08",
    "intent/provenance contents are never validated at verify time");

  record("D07", "d", "generatedAt = 'not-a-date' + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => { m.generatedAt = "not-a-date"; })),
    "Medium", "F-05",
    "no format validation and no freshness check — enabler for replay/staleness");

  record("D08", "d", "generateEvidenceManifest without preTestHash yields a self-referential chain",
    "GAP", observe(() => {
      const m = generateEvidenceManifest(root, { taskId: "TASK-D-selfref" });
      return m.testIntegrity.preTestHash === m.testIntegrity.postTestHash && m.testIntegrity.tamperDetected === false
        ? "GAP" : "DETECTED";
    }),
    "High", "F-10",
    "preTestHash defaults to postTestHash: without a caller-supplied pre-run hash the chain attests that nothing changed relative to itself");

  record("D09", "d", "empty-optional-field canonicalization gap (metrics:{} vs absent)",
    "GAP", observe(() => {
      const withEmpty = forge(manifest, (m) => { m.metrics = {}; m.diagnostics = []; m.summary = {}; }, { rehash: false });
      // Hash ignores empty optional sections: evidenceHash unchanged, but the
      // byte-level document differs from the attested one.
      return withEmpty.evidenceHash === manifest.evidenceHash ? "GAP" : "DETECTED";
    }),
    "Low", "F-09",
    "two semantically different documents hash identically — tamper-evidence is per-canonicalization, not per-byte");
}

// ---------------------------------------------------------------------------
// Vector e — deleted intermediate records in the chain
// ---------------------------------------------------------------------------

function vectorDeletedRecords() {
  const root = makeFixtureWorkspace();
  const manifest = generateEvidenceManifest(root, {
    taskId: "TASK-E",
    executionRecords: [
      { id: "unit", kind: "test", cmd: "npm test", exitCode: 0, durationMs: 10, networkAccess: "forbidden" },
      { id: "lint", kind: "test", cmd: "npm run lint", exitCode: 0, durationMs: 10, networkAccess: "forbidden" },
    ],
  });
  writeEvidenceManifest(root, manifest);

  record("E01", "e", "one fileHashes entry deleted, no rehash",
    "DETECTED", verifyVerdict(root, forge(manifest, (m) => {
      delete m.testIntegrity.fileHashes[Object.keys(m.testIntegrity.fileHashes)[0]];
    }, { rehash: false })), "Info", "F-01", "");

  record("E02", "e", "one fileHashes entry deleted + rehash",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => {
      delete m.testIntegrity.fileHashes[Object.keys(m.testIntegrity.fileHashes)[0]];
    })), "Medium", "F-07",
    "per-file records can be silently dropped; nothing compares the map to disk");

  record("E03", "e", "intermediate executionRecord deleted + rehash (lint stage erased)",
    "BYPASS", verifyVerdict(root, forge(manifest, (m) => {
      m.executionRecords = m.executionRecords.filter((r) => r.id !== "lint");
    })), "Medium", "F-01",
    "intra-manifest records are only as tamper-evident as the unkeyed hash");

  // E04: cross-manifest chain does not exist. Delete an intermediate evidence
  // manifest and verify the survivor — nothing links the two.
  record("E04", "e", "intermediate evidence manifest deleted from the audit trail",
    "BYPASS", observe(() => {
      const failed = generateEvidenceManifest(root, {
        taskId: "TASK-E-failed",
        ok: false,
        diagnostics: ["tests failed"],
        failedStage: "test",
      });
      const failedPath = writeEvidenceManifest(root, failed);
      const passed = generateEvidenceManifest(root, { taskId: "TASK-E-passed" });
      writeEvidenceManifest(root, passed);
      rmSync(failedPath); // erase the intermediate (failed) record
      const noLink = !("prevHash" in passed) && !("chain" in passed) && !("previousManifestHash" in passed);
      return verifyVerdict(root, passed.manifestId) === "BYPASS" && noLink ? "BYPASS" : "DETECTED";
    }),
    "High", "F-06",
    "manifests are standalone: no prevHash/chain linkage exists, so the audit trail cannot attest its own history");

  record("E05", "e", "rewritten history: failed manifest re-issued as passed + rehash",
    "BYPASS", observe(() => {
      const failed = generateEvidenceManifest(root, {
        taskId: "TASK-E-rewrite",
        ok: false,
        diagnostics: ["tests failed"],
        failedStage: "test",
      });
      const p = writeEvidenceManifest(root, failed);
      const laundered = forge(failed, (m) => {
        m.status = "passed";
        delete m.failedStage;
        delete m.diagnostics;
      });
      writeFileSync(p, JSON.stringify(laundered, null, 2));
      return verifyVerdict(root, p);
    }),
    "High", "F-01",
    "on-disk history rewrite is indistinguishable from the original record without an external anchor");

  // E06: attested-set coverage gap. The tree hash covers test/, tests/,
  // spec/, src/ and root-level source files — scripts/ and bin/ are outside
  // it. In this very repository `npm test` runs scripts/run-tests.mjs.
  record("E06", "e", "scripts/ and bin/ modified after manifest generation (unattested paths)",
    "BYPASS", observe(() => {
      writeFileSync(join(root, "scripts", "run-tests.mjs"), "console.log('EVIL: nothing to see');\n");
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "bin", "agentctl.mjs"), "EVIL\n");
      return verifyVerdict(root, manifest);
    }),
    "High", "F-04",
    "computeDirectoryHash scans only test/tests/__tests__/spec/specs/src + root source files; the test runner and CLI entry points can be swapped without breaking sourceIntegrity");
}

// ---------------------------------------------------------------------------
// Vector f — markdown export with extremely long paths (>4096 chars)
// ---------------------------------------------------------------------------

function vectorLongPaths() {
  const root = makeFixtureWorkspace();
  const manifest = generateEvidenceManifest(root, { taskId: "TASK-F" });
  const longPath = "dir/".repeat(1300) + "file.test.js"; // > 5200 chars
  const longHashes = { [longPath]: "sha256:" + "a".repeat(64) };
  const longRec = [{ id: "x", kind: "test", cmd: `npm test ${longPath}`, exitCode: 0, durationMs: 1, networkAccess: "forbidden" }];

  record("F01", "f", "generateEvidenceMarkdown with >4096-char file path in fileHashes and cmd",
    "ROBUST", observe(() => {
      const m = forge(manifest, (mm) => {
        mm.testIntegrity.fileHashes = longHashes;
        mm.executionRecords = longRec;
      });
      const md = generateEvidenceMarkdown(m);
      return typeof md === "string" && md.length > 0 ? "ROBUST" : "CRASH";
    }),
    "Low", "F-14",
    "no crash, but also no path-length validation: attacker-controlled multi-kilobyte strings render into PR markdown");

  record("F02", "f", "exportJsonReport to a >4096-char custom path",
    "FAIL-CLOSED", observe(() => {
      try {
        exportJsonReport(manifest, join(root, longPath));
        return "BYPASS";
      } catch (err) {
        return /ENAMETOOLONG|name too long/i.test(err.message) ? "FAIL-CLOSED" : `CRASH: ${err.message}`;
      }
    }),
    "Low", "F-14",
    "uncaught ENAMETOOLONG at the export boundary — fail-closed but ungraceful (caller-visible throw)");

  record("F03", "f", "computeDirectoryHash options.paths containing a >4096-char path",
    "GAP", observe(() => {
      const res = computeDirectoryHash(root, { paths: [longPath, "test/core.test.js"] });
      return res.fileCount === 1 && !(longPath in res.fileHashes) ? "GAP" : "DETECTED";
    }),
    "Medium", "F-11",
    "oversized paths are silently dropped from the attested set (existsSync false on ENAMETOOLONG)");

  record("F04", "f", "loadEvidenceManifest / verifyEvidenceManifest with a >4096-char manifest path",
    "DETECTED", observe(() => {
      const res = verifyEvidenceManifest(root, join(root, longPath));
      return res.ok ? "BYPASS" : "DETECTED";
    }),
    "Info", "F-15",
    "fails closed through the load-error path");

  record("F05", "f", "computeDirectoryHash options.paths with '../' escapes the root",
    "GAP", observe(() => {
      const outside = makeWorkspace({ "outside-secret.js": "secret\n" });
      // `outside` is a sibling temp dir; the relative path escapes root via ..
      const rel = relative(root, join(outside, "outside-secret.js"));
      const res = computeDirectoryHash(root, { paths: [rel] });
      return Object.keys(res.fileHashes).length === 1 && res.fileHashes[rel] ? "GAP" : "DETECTED";
    }),
    "Low", "F-17",
    "options.paths is caller-supplied and unnormalized against root escape — files outside the root can be folded into the attested set");
}

// ---------------------------------------------------------------------------
// Vector g — computeDirectoryHash vs symlink loops and permission-denied files
// ---------------------------------------------------------------------------

function vectorSymlinksAndPerms() {
  const root = makeWorkspace({
    "test/ok.test.js": "ok\n",
    "test/secret.test.js": "secret\n",
    "test/sub/nested.test.js": "nested\n",
    "src/a.js": "a\n",
  });

  record("G01", "g", "symlink loops (dir->ancestor, a<->b, self-link) do not hang or crash",
    "ROBUST", observe(() => {
      symlinkSync(root, join(root, "test", "loop-up"));
      symlinkSync(join(root, "test", "ok.test.js"), join(root, "test", "loop-a"));
      symlinkSync(join(root, "test", "loop-b"), join(root, "test", "loop-a2"));
      symlinkSync(join(root, "test", "loop-a2"), join(root, "test", "loop-b"));
      const started = Date.now();
      const res = computeDirectoryHash(root);
      return res.treeHash.startsWith("sha256:") && Date.now() - started < 5000 ? "ROBUST" : "HANG";
    }),
    "Info", "F-16",
    "readdirSync withFileTypes does not follow symlinks, so loops terminate");

  record("G02", "g", "symlinked test file silently excluded from the attested set",
    "GAP", observe(() => {
      const root2 = makeWorkspace({ "test/real.test.js": "real\n", "src/a.js": "a\n" });
      rmSync(join(root2, "test", "real.test.js"));
      symlinkSync(join(root2, "src", "a.js"), join(root2, "test", "real.test.js"));
      const m = generateEvidenceManifest(root2, { taskId: "TASK-G2" });
      return m.testIntegrity.testFileCount === 0 && m.testIntegrity.tamperDetected === false ? "GAP" : "DETECTED";
    }),
    "Medium", "F-11",
    "a test file replaced by a symlink vanishes from the evidence with no warning — a fresh manifest attests an empty suite as clean");

  record("G03", "g", "permission-denied test file (chmod 000) silently excluded",
    ["GAP", "PARTIAL"], observe(() => {
      const target = join(root, "test", "secret.test.js");
      chmodSync(target, 0o000);
      try {
        const res = computeDirectoryHash(root, { testOnly: true });
        const excluded = !( "test/secret.test.js" in res.fileHashes);
        if (RUN_AS_ROOT) return excluded ? "GAP" : "PARTIAL"; // root bypasses mode bits
        return excluded ? "GAP" : "PARTIAL";
      } finally {
        chmodSync(target, 0o644);
      }
    }),
    "Medium", "F-11",
    "unreadable files are dropped from the attested set via computeFileHash's null path — no diagnostic is recorded");

  record("G04", "g", "permission-denied directory (chmod 000) silently drops the whole subtree",
    ["GAP", "PARTIAL"], observe(() => {
      const target = join(root, "test", "sub");
      chmodSync(target, 0o000);
      try {
        const res = computeDirectoryHash(root, { testOnly: true });
        const excluded = !("test/sub/nested.test.js" in res.fileHashes);
        return excluded ? "GAP" : "PARTIAL";
      } finally {
        chmodSync(target, 0o755);
      }
    }),
    "Medium", "F-11",
    "findFilesRecursively swallows readdir errors with catch(_){} — the evidence silently covers less than the suite");

  record("G05", "g", "manifest generated over an unreadable subtree attests reduced coverage as clean",
    ["GAP", "PARTIAL"], observe(() => {
      const root2 = makeWorkspace({ "test/a.test.js": "a\n", "test/hidden.test.js": "h\n" });
      chmodSync(join(root2, "test", "hidden.test.js"), 0o000);
      try {
        const m = generateEvidenceManifest(root2, { taskId: "TASK-G5" });
        const clean = m.testIntegrity.tamperDetected === false && m.testIntegrity.testFileCount === 1;
        return clean ? "GAP" : "DETECTED";
      } finally {
        chmodSync(join(root2, "test", "hidden.test.js"), 0o644);
      }
    }),
    "Medium", "F-11",
    "tamperDetected stays false while a test file is invisible to the hash — permission loss reads as a clean suite");
}

// ---------------------------------------------------------------------------
// Vector h — replay resistance and same-hash-prefix attacks
// ---------------------------------------------------------------------------

function vectorReplayAndPrefix() {
  // H01: cross-workspace replay. Two workspaces with identical attested
  // bytes but disjoint provenance; a manifest from one verifies on the other.
  record("H01", "h", "manifest replayed on a different workspace/commit with identical src+test bytes",
    "BYPASS", observe(() => {
      const files = {
        "src/core.js": "export const add = (a, b) => a + b;\n",
        "test/core.test.js": "test('core', () => {});\n",
        "index.mjs": "export * from './src/core.js';\n",
      };
      const wsA = makeWorkspace(files);
      const wsB = makeWorkspace(files);
      const manifest = generateEvidenceManifest(wsA, { taskId: "TASK-H", repository: "repo-a" });
      // The two workspaces share no git history, no provenance, no identity.
      return verifyVerdict(wsB, manifest);
    }),
    "High", "F-05",
    "provenance (commitSha/branch/dirty/repository) is attested but never bound into the verification decision");

  // H02: staleness replay — a manifest from the distant past is accepted.
  record("H02", "h", "manifest generatedAt '2000-01-01' (stale by decades) + rehash",
    "BYPASS", observe(() => {
      const root = makeFixtureWorkspace();
      const manifest = generateEvidenceManifest(root, { taskId: "TASK-H2" });
      return verifyVerdict(root, forge(manifest, (m) => { m.generatedAt = "2000-01-01T00:00:00.000Z"; }));
    }),
    "Medium", "F-05",
    "no freshness/nonce check — old evidence replays forever on an unchanged tree");

  // H03: code-level comparisons are full-length (prefix forgery rejected).
  record("H03", "h", "evidenceHash with matching 16-char prefix but wrong remainder",
    "DETECTED", observe(() => {
      const root = makeFixtureWorkspace();
      const manifest = generateEvidenceManifest(root, { taskId: "TASK-H3" });
      const forged = clone(manifest);
      forged.evidenceHash = forged.evidenceHash.slice(0, 7 + 16) + "0".repeat(48);
      return verifyVerdict(root, forged);
    }),
    "Info", "F-13",
    "loadEvidenceManifest/verifyEvidenceManifest compare full digests — safe against same-prefix forgeries");

  // H04: human-facing digests are truncated to 16 hex chars (64 bits).
  record("H04", "h", "markdown digest display is a 16-hex-char prefix (brute-force demo at 4 hex chars)",
    "GAP", observe(() => {
      const target = sha256("arena-audit-target").slice(0, 4);
      let found = -1;
      for (let i = 0; i < 2_000_000 && found < 0; i++) {
        if (sha256(`forge-${i}`).slice(0, 4) === target) found = i;
      }
      if (found < 0) return "DETECTED"; // astronomically unlikely at 16 bits
      // The principle: a displayed prefix is a weak, forgeable identifier.
      const manifest = { schema: "agentctl/evidence-manifest-v1", manifestId: "EVD-x", evidenceHash: "sha256:" + "a".repeat(64) };
      const mdA = generateEvidenceMarkdown(manifest);
      const manifestB = { ...manifest, evidenceHash: "sha256:" + "a".repeat(40) + "b".repeat(24) };
      const mdB = generateEvidenceMarkdown(manifestB);
      const displayCollides = mdA.includes(manifest.evidenceHash.slice(0, 16)) && mdB.includes(manifestB.evidenceHash.slice(0, 16));
      return displayCollides ? "GAP" : "DETECTED";
    }),
    "Low", "F-13",
    "16 hex chars = 64-bit prefix: forgery against the *displayed* digest costs ~2^64 (or 2^32 birthday for look-alike pairs) — full compares stay safe");

  // H05: chain replay via the verification entry point with a path — the
  // "chain" (preTestHash -> postTestHash -> evidenceHash) carries no nonce and
  // no external reference, so the whole chain replays as one unit.
  record("H05", "h", "entire manifest replayed via its on-disk path on a second identical workspace",
    "BYPASS", observe(() => {
      const files = { "src/a.js": "a\n", "test/a.test.js": "t\n" };
      const wsA = makeWorkspace(files);
      const wsB = makeWorkspace(files);
      const manifest = generateEvidenceManifest(wsA, { taskId: "TASK-H5" });
      const p = writeEvidenceManifest(wsA, manifest);
      return verifyVerdict(wsB, p);
    }),
    "High", "F-05",
    "the chain proves internal consistency only; it cannot prove freshness or locality");
}

// ---------------------------------------------------------------------------
// Run the audit
// ---------------------------------------------------------------------------

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function main() {
  console.log("=== Evidence Chain Tamper Audit — arena-evidence-integrity-test.mjs ===");
  console.log(`target : src/evidence.mjs (verifyEvidenceManifest, computeDirectoryHash, computeEvidenceHash)`);
  console.log(`runtime: node ${process.version}${RUN_AS_ROOT ? " (root — permission cases degrade gracefully)" : ""}`);
  console.log(`date   : ${new Date().toISOString()}`);
  console.log("");

  const vectors = [
    ["a", "field manipulation of a valid manifest", vectorFieldTamper],
    ["b", "truncated JSON / corrupted manifest files", vectorTruncation],
    ["c", "duplicated entry hashes & hash-line ambiguity", vectorDuplicates],
    ["d", "empty / null / undefined fields", vectorEmptyFields],
    ["e", "deleted intermediate records", vectorDeletedRecords],
    ["f", "markdown export with >4096-char paths", vectorLongPaths],
    ["g", "symlink loops & permission-denied files", vectorSymlinksAndPerms],
    ["h", "replay resistance & same-hash-prefix attacks", vectorReplayAndPrefix],
  ];

  for (const [key, label, fn] of vectors) {
    console.log(`--- vector ${key}: ${label} ---`);
    try {
      fn();
    } catch (err) {
      record(`X-${key}`, key, `vector ${key} harness aborted unexpectedly`, "n/a", `CRASH: ${err.message}`, "Info", "-");
    }
    const rows = results.filter((r) => r.vector === key);
    for (const r of rows) {
      const sev = r.severity === "Info" ? "  -  " : r.severity;
      console.log(`  ${pad(r.id, 5)} ${pad(r.observed, 11)} ${pad(sev, 8)} ${r.title}`);
    }
    console.log("");
  }

  const mismatches = results.filter((r) => !r.match);
  const byVerdict = {};
  for (const r of results) byVerdict[r.observed] = (byVerdict[r.observed] || 0) + 1;

  console.log("--- summary ---");
  console.log(`cases: ${results.length} | ` + Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(" | "));
  const findings = results.filter((r) => ["BYPASS", "PARTIAL", "GAP"].includes(r.observed));
  const byFinding = new Map();
  for (const r of findings) {
    if (!byFinding.has(r.finding)) byFinding.set(r.finding, []);
    byFinding.get(r.finding).push(r.id);
  }
  console.log("");
  console.log("undetected-manipulation findings (see arena-evidence-integrity-report.md):");
  for (const [f, ids] of [...byFinding.entries()].sort()) {
    const sev = results.find((r) => r.finding === f && r.severity !== "Info")?.severity || "-";
    console.log(`  ${pad(f, 6)} ${pad(sev, 9)} cases: ${ids.join(", ")}`);
  }
  console.log("");

  if (mismatches.length > 0) {
    console.log("!!! DIVERGENCE from the audit matrix recorded in arena-evidence-integrity-report.md:");
    for (const r of mismatches) {
      console.log(`  ${r.id}: expected ${JSON.stringify(r.expected)}, observed ${r.observed} — ${r.title}`);
    }
    console.log("src/evidence.mjs behaviour has changed since the audit was written; re-run and re-issue the report.");
    cleanup();
    process.exit(1);
  }

  console.log("=== AUDIT COMPLETE — every observation matches the matrix in arena-evidence-integrity-report.md ===");
  cleanup();
  process.exit(0);
}

function cleanup() {
  for (const root of tempRoots) {
    try {
      // Restore any permission bits a case may have left behind.
      chmodWalk(root);
      rmSync(root, { recursive: true, force: true });
    } catch (_) {}
  }
}

function chmodWalk(dir) {
  try {
    chmodSync(dir, 0o755);
    for (const entry of readdirSyncSafe(dir)) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) chmodWalk(p);
        else chmodSync(p, 0o644);
      } catch (_) {}
    }
  } catch (_) {}
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

main();
