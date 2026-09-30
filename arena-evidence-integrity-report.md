# Evidence Chain Tamper Audit — arena-evidence-integrity-report.md

> **Mission**: adversarial audit of `src/evidence.mjs` SHA-256 hash chains and
> manifest verification — manipulation, truncation, corruption — with explicit
> documentation of *undetected* manipulation.
> **Method**: 64 executable attack cases in `arena-evidence-integrity-test.mjs`
> (standalone Node.js ESM, zero dependencies, temp workspaces only). Every
> number in this report is reproducible by running that file.

| | |
| :--- | :--- |
| Repository | `FullThrottle83/jules-orchestrator-kit` |
| Base | `main` @ `1d176f8` |
| Audit branch | `arena/01a0f277-jules-orchestrator-kit` (see note below) |
| Target | `src/evidence.mjs` — `verifyEvidenceManifest`, `computeDirectoryHash`, `computeEvidenceHash`, `loadEvidenceManifest`, `generateEvidenceManifest`, `generateEvidenceMarkdown`, `exportJsonReport` |
| Reference coverage | `test/evidence.test.mjs` (237 lines, 12 cases — happy path + one tamper case) |
| Runtime | Node v22.22.3, Linux, non-root (uid 1001) |
| Date | 2026-09-30 |
| Verification | `node arena-evidence-integrity-test.mjs` → exit 0 (64/64 observations match) · `npm test` → 1650 pass / 0 fail |
| Files changed | **created**: `arena-evidence-integrity-test.mjs`, `arena-evidence-integrity-report.md` — no existing file modified |

*Branch note: the mission requested branch `arena/evidence-integrity-audit`.
This Arena session is pinned to `arena/01a0f277-jules-orchestrator-kit`, so the
work and PR are delivered from that branch instead. Content is identical.*

---

## 1. Executive summary

The evidence system defends well against **lazy tampering** — anyone who edits a
manifest without touching `evidenceHash` is caught in 100 % of tested field
edits, and all truncation/corruption scenarios fail closed. That is the threat
model the existing test suite exercises.

Against a **reasoning attacker** the chain does not hold. `evidenceHash` is an
*unkeyed* SHA-256 over a whitelist of fields: anyone who can edit the file can
recompute the hash. There is no trust anchor (no HMAC key, no signature, no
external transcript), so "tamper-evidence" reduces to "did you remember to run
one extra line of code". Three findings are critical:

1. **F-01 — the signature is forgeable.** Recomputing `evidenceHash` after any
   field edit defeats every check that depends on it (case A16: a weakened test
   suite + rehashed manifest verifies `ok:true`).
2. **F-02 — an empty shell verifies.** `{schema, manifestId, generatedAt,
   evidenceHash}` passes `verifyEvidenceManifest` with **zero** workspace
   binding — even on a completely destroyed workspace (A17, A19).
3. **F-03 — the tree hash is not injective.** Hash lines are concatenated as
   `path:hash` joined by `\n` with no escaping. A single file whose *name*
   contains `\n` and `:` reproduces the joined lines of two files. A test file
   can be **deleted from the suite** and verification passes — with **no hash
   recompute at all** (C3, C3b). This is a working forgery against the honest,
   unmodified verifier.

Additionally the attested set has a hole (F-04): `scripts/`, `bin/`,
`.agent/`, `.github/` and `package.json` are **not** in the source tree hash,
yet `npm test` runs `scripts/run-tests.mjs`. Evidence can attest a pristine
suite while the runner itself has been swapped (E06).

**Score: 64 cases — 21 detected, 30 bypass, 9 gap, 1 partial, 2 robust,
1 fail-closed.** 40 observations fall in the undetected/degraded categories
(2 of them benign baselines: A00, C1).

---

## 2. Findings register (F-01 … F-18)

| ID | Finding | Sev | Cases |
| :--- | :--- | :---: | :--- |
| **F-01** | **Unkeyed hash = forgeable signature.** `evidenceHash` is plain SHA-256 over a canonical JSON whitelist. Any attacker who edits a manifest can recompute it; every attested field (exit codes, status, diagnostics, hashes) is forgeable. | **High** | A14, A15, A16, E03, E05 |
| **F-02** | **Empty-shell / stripped manifests verify `ok:true`.** All three verification layers are guarded by optional chaining over optional sections; missing sections *skip* the corresponding check. A schema-only self-hashed document verifies even on a destroyed workspace. | **Critical** | A17, A19, A20 |
| **F-03** | **Tree-hash collision via crafted filenames.** `hashLines = relPath + ":" + hash` joined by `\n`, unescaped → the mapping is not injective. One file named `x.test.js:sha256:<H_A>\ny.test.js` with content hashing to `H_B` reproduces the tree hash of `{x.test.js→A, y.test.js→B}`. Test-weakening **without** any rehash. | **Critical** | C3, C3b |
| **F-04** | **Attested-set coverage gap.** Tree hash covers `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `src/` + root-level source-extension files only. `scripts/`, `bin/`, `.agent/`, `.github/`, `package.json`, lockfiles are unattested — including the test runner `scripts/run-tests.mjs`. | **High** | E06 |
| **F-05** | **Replay: provenance & freshness unbound.** `commitSha`, `branch`, `dirty`, `repository`, `generatedAt` are attested but never compared to the workspace at verify time. Manifests replay across workspaces/commits and stay valid forever. | **High** | A13, D07, H01, H02, H05 |
| **F-06** | **No cross-manifest chain.** Manifests are standalone documents (no `prevHash`/linkage). Deleting an intermediate (e.g. failed-run) manifest leaves no trace; the audit trail cannot attest its own history. | **High** | E04 |
| **F-07** | **`fileHashes` attested but never verified.** Only `postTestHash` (tree level) is compared; the per-file map can be erased, thinned or left stale with no effect on the verdict. | **Medium** | D02, E02 |
| **F-08** | **Fail-open and outcome-blind verdict.** Checks skip on `null`/missing values (`postTestHash && …`, `=== false` is the only failing comparison); and the gate verdict **ignores `status`, `failedStage` and exit codes** — a manifest recording a failing run verifies `ok:true` (A08b). | **High** | A08b, A20, D01, D03–D06 |
| **F-09** | **Non-canonical hashing.** (a) Key order inside nested sections changes the hash; (b) duplicate JSON keys are last-wins for `JSON.parse` but first-wins for naive readers (parser differential, C2); (c) empty optional sections (`metrics: {}`, `diagnostics: []`) are hash-invisible — semantically different documents share a hash (D09). | **Medium** | C2, D09 |
| **F-10** | **Self-referential chain link.** Without a caller-supplied `preTestHash`, generation sets `preTestHash = postTestHash` — the "no tampering during the run" claim attests to itself (D08). At verify time the `pre ≠ post` condition is never re-derived; the boolean `tamperDetected` is trusted (A11c). | **High** | A11c, D08 |
| **F-11** | **Silent exclusion from the attested set.** Symlinks, permission-denied files/dirs and ENAMETOOLONG paths are dropped with `catch(_){}` / `null` — no diagnostic, no manifest field. Evidence can silently cover less than the suite and still report clean (G05). | **Medium** | F03, G02–G05 |
| **F-12** | **Unknown top-level fields are hash-invisible.** `computeEvidenceHash` whitelists fields; arbitrary extra claims (`"waiver": "approved-by-ciso"`) ride along a verified manifest **without** a rehash. | **Low** | A12 |
| **F-13** | **Human-auditable digest is a 64-bit prefix.** Markdown shows `evidenceHash.slice(0, 16)` and reason strings `slice(0, 12)`. Code comparisons are full-length (safe, H03); the displayed digest is forgeable in ~2⁶⁴ work (or 2³² for a look-alike pair). | **Low** | H03, H04 |
| **F-14** | **Long-path robustness.** `exportJsonReport`/`writeEvidenceManifest` throw uncaught `ENAMETOOLONG` on >4096-char paths (fail-closed but ungraceful); markdown export renders attacker-controlled multi-kilobyte path strings with no validation. | **Low** | F01, F02 |
| **F-15** | **Truncation fails closed** (positive finding). 60 %/99 % truncation, empty file and binary garbage all produce `ok:false` via `JSON.parse`. Sub-note: a truncated `manifest.v1.json` with an intact id-addressed copy degrades availability only (B04). | **Info** (B04: Low) | B01–B05 |
| **F-16** | **Symlink loops are safe** (positive finding). `readdirSync(withFileTypes)` does not follow symlinks; loops terminate. | **Info** | G01 |
| **F-17** | **`options.paths` allows `../` escape.** Caller-supplied paths are joined onto root without containment checks — files outside the root can be folded into the attested set. Not reachable from `verifyEvidenceManifest` itself. | **Low** | F05 |
| **F-18** | **Duplicate hash values are legitimate and undistinguished** (identical files). Forensics cannot use `fileHashes` values as unique entry identifiers. | **Info** | C1 |

---

## 3. Manipulationsdetekterings-täckningsmatris (Tamper-Detection Coverage Matrix)

Attacker models per column:

- **Lazy** — edits the manifest (or workspace) and leaves `evidenceHash` stale.
- **Informed** — understands the scheme and recomputes the unkeyed hash
  ("rehash"), uses crafted filenames, or manipulates the environment.

Verdicts: `DETECTED` caught · `BYPASS` undetected (ok:true) · `PARTIAL` degraded
but fail-closed · `GAP` silent coverage/robustness hole · `ROBUST` hostile input
handled safely · `FAIL-CLOSED` rejects via error. `BY PASS` on a *baseline*
(A00, C1) is the benign case working as designed.

### 3.1 Vector a — field manipulation of a valid manifest

| ID | Scenario | Lazy | Informed | Verdict | Find | Sev |
| :-- | :--- | :---: | :---: | :--- | :-- | :---: |
| A00 | Genuine manifest on unmodified workspace (baseline) | — | — | BYPASS (benign) | — | — |
| A01 | `manifestId` rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A02 | `generatedAt` rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A03 | `intent.taskId` rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A04 | `provenance.commitSha` rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A05 | `testIntegrity.postTestHash` rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A06 | One `fileHashes` entry rewritten | ✅ | ❌ | DETECTED | F-01 | — |
| A07 | Failing exit code laundered `1 → 0` | ✅ | ❌ | DETECTED | F-01 | — |
| A08 | `secretScanOk: false → true` | ✅ | ❌ | DETECTED | F-01 | — |
| A08a | `secretScanOk:false` manifest rejected (positive control) | ✅ | ✅ | DETECTED | F-08 | — |
| A08b | Manifest recording failing run (`exitCode 1`) verifies `ok:true` | ❌ | ❌ | **BYPASS** | F-08 | High |
| A09 | `evidenceHash` removed | ✅ | ❌ | DETECTED | F-01 | — |
| A10 | Schema version changed | ✅ | ❌ | DETECTED | F-01 | — |
| A11a | Generation-time `pre ≠ post` sets `tamperDetected` (positive control) | ✅ | ✅ | DETECTED | F-10 | — |
| A11b | `tamperDetected true → false`, no rehash | ✅ | ❌ | DETECTED | F-01 | — |
| A11c | `tamperDetected` flipped + stale pre/post kept + rehash | ✅ | ❌ | **BYPASS** | F-10 | High |
| A12 | Extra unknown field (`"waiver"`) added, **no rehash** | ❌ | ❌ | **BYPASS** | F-12 | Low |
| A13 | `provenance.commitSha` rewritten + rehash | ✅ | ❌ | **BYPASS** | F-05 | High |
| A14 | Failed run laundered (exit code, status, diagnostics) + rehash | ✅ | ❌ | **BYPASS** | F-01 | High |
| A15 | `secretScanOk` flipped + rehash | ✅ | ❌ | **BYPASS** | F-01 | High |
| A16 | **Full chain forge**: tests weakened on disk, `testIntegrity` + `sourceIntegrity` retargeted + rehash | ✅ | ❌ | **BYPASS** | F-01 | **Critical** |
| A17 | Stripped shell (schema + ids + self-hash) on intact workspace | ❌ | ❌ | **BYPASS** | F-02 | **Critical** |
| A18 | `evidenceHash` 16-char-prefix forgery (wrong tail) | ✅ | ✅ | DETECTED | F-13 | — |
| A19 | Stripped shell + rehash on **destroyed** workspace | ❌ | ❌ | **BYPASS** | F-02 | **Critical** |
| A20 | `testIntegrity: null` + rehash | ✅ | ❌ | **BYPASS** | F-08 | High |

### 3.2 Vector b — truncated JSON / corrupted manifest files

| ID | Scenario | Verdict | Find | Sev |
| :-- | :--- | :--- | :-- | :---: |
| B01 | Truncated at 60 % (simulated disk-full write) | DETECTED | F-15 | — |
| B02 | Truncated at 99 % (final brace missing) | DETECTED | F-15 | — |
| B03 | Empty file (0 bytes) | DETECTED | F-15 | — |
| B05 | Binary garbage | DETECTED | F-15 | — |
| B04 | `manifest.v1.json` truncated, id-addressed copy intact | PARTIAL | F-15 | Low |

### 3.3 Vector c — duplicated entry hashes & hash-line ambiguity

| ID | Scenario | Lazy | Informed | Verdict | Find | Sev |
| :-- | :--- | :---: | :---: | :--- | :-- | :---: |
| C1 | Two `fileHashes` entries with identical hash values (identical files) | n/a | n/a | BYPASS (benign) | F-18 | — |
| C2 | Duplicate `evidenceHash` keys in JSON (decoy first, real last) | ❌ | ❌ | **BYPASS** | F-09 | Medium |
| C3 | **End-to-end tree-hash collision**: `x.test.js` deleted (suite weakened), survivor renamed to impersonate both hash lines — **no rehash** | ❌ | ❌ | **BYPASS** | F-03 | **Critical** |
| C3b | `computeDirectoryHash` not injective (same `treeHash`, different file sets, `fileCount` 2→1) | ❌ | ❌ | **BYPASS** | F-03 | **Critical** |

### 3.4 Vector d — empty / null / undefined fields (all + rehash)

| ID | Scenario | Verdict | Find | Sev |
| :-- | :--- | :--- | :-- | :---: |
| D01 | `postTestHash: null` — test-hash check skipped entirely | BYPASS | F-08 | Medium |
| D02 | `fileHashes: {}` — per-file map erased | BYPASS | F-07 | Medium |
| D03 | `executionRecords: []` — all runtime evidence erased | BYPASS | F-08 | Medium |
| D04 | `securityChecks: {}` | BYPASS | F-08 | Medium |
| D05 | `secretScanOk: null` (only strict `false` fails) | BYPASS | F-08 | Medium |
| D06 | `intent: {}` + `provenance: {}` | BYPASS | F-08 | Medium |
| D07 | `generatedAt: "not-a-date"` | BYPASS | F-05 | Medium |
| D08 | Generation without `preTestHash` → self-referential chain | GAP | F-10 | High |
| D09 | Empty-optional canonicalization gap (`metrics:{}` ≡ absent) | GAP | F-09 | Low |

### 3.5 Vector e — deleted intermediate records

| ID | Scenario | Lazy | Informed | Verdict | Find | Sev |
| :-- | :--- | :---: | :---: | :--- | :-- | :---: |
| E01 | One `fileHashes` entry deleted, no rehash | ✅ | ❌ | DETECTED | F-01 | — |
| E02 | One `fileHashes` entry deleted + rehash | ✅ | ❌ | **BYPASS** | F-07 | Medium |
| E03 | Intermediate `executionRecord` deleted + rehash | ✅ | ❌ | **BYPASS** | F-01 | Medium |
| E04 | Intermediate evidence manifest deleted from audit trail | ❌ | ❌ | **BYPASS** | F-06 | High |
| E05 | History rewrite: failed manifest re-issued as passed + rehash | ✅ | ❌ | **BYPASS** | F-01 | High |
| E06 | `scripts/` + `bin/` modified after generation (unattested paths) | ❌ | ❌ | **BYPASS** | F-04 | High |

### 3.6 Vector f — markdown export with >4096-char paths

| ID | Scenario | Verdict | Find | Sev |
| :-- | :--- | :--- | :-- | :---: |
| F01 | `generateEvidenceMarkdown` with >4096-char paths in `fileHashes`/`cmd` | ROBUST | F-14 | Low |
| F02 | `exportJsonReport` to a >4096-char path (throws `ENAMETOOLONG`) | FAIL-CLOSED | F-14 | Low |
| F03 | `computeDirectoryHash` `options.paths` with a >4096-char path | GAP (silent drop) | F-11 | Medium |
| F04 | `loadEvidenceManifest` / `verifyEvidenceManifest` with >4096-char path | DETECTED | F-15 | — |
| F05 | `options.paths` with `../` escapes the root | GAP | F-17 | Low |

### 3.7 Vector g — symlink loops & permission-denied files

| ID | Scenario | Verdict | Find | Sev |
| :-- | :--- | :--- | :-- | :---: |
| G01 | Symlink loops (dir→ancestor, a↔b cycle, self-link) | ROBUST | F-16 | — |
| G02 | Symlinked test file silently excluded (fresh manifest attests empty suite as clean) | GAP | F-11 | Medium |
| G03 | `chmod 000` test file silently excluded | GAP | F-11 | Medium |
| G04 | `chmod 000` directory silently drops the whole subtree | GAP | F-11 | Medium |
| G05 | Manifest over unreadable subtree records `tamperDetected:false`, reduced `fileCount` | GAP | F-11 | Medium |

### 3.8 Vector h — replay resistance & same-hash-prefix attacks

| ID | Scenario | Lazy | Informed | Verdict | Find | Sev |
| :-- | :--- | :---: | :---: | :--- | :-- | :---: |
| H01 | Manifest replayed on a different workspace/commit, identical src+test bytes | ❌ | ❌ | **BYPASS** | F-05 | High |
| H02 | `generatedAt: "2000-01-01"` stale manifest + rehash | ✅ | ❌ | **BYPASS** | F-05 | Medium |
| H03 | `evidenceHash` matching 16-char prefix, wrong remainder | ✅ | ✅ | DETECTED | F-13 | — |
| H04 | Displayed-digest prefix weakness (brute-force demo @ 4 hex chars) | n/a | ❌ | GAP | F-13 | Low |
| H05 | Whole manifest replayed via on-disk path on second identical workspace | ❌ | ❌ | **BYPASS** | F-05 | High |

### 3.9 Aggregate

| Verdict | Count | Meaning |
| :--- | :---: | :--- |
| DETECTED | 21 | Attack caught (lazy tamper: 100 % catch rate) |
| BYPASS | 30 | **Undetected manipulation** (2 benign baselines: A00, C1) |
| GAP | 9 | Silent coverage / robustness holes |
| PARTIAL | 1 | Degraded but fail-closed |
| ROBUST | 2 | Hostile input handled safely |
| FAIL-CLOSED | 1 | Rejects via error |

---

## 4. Eventuella oupptäckta korruptionsscenarier (Undetected corruption scenarios)

Concrete end-to-end scenarios that verification **cannot** distinguish from an
honest run. All were executed in the harness.

1. **Silent test-weakening via filename collision (F-03, C3) — no rehash
   needed.** Suite = `x.test.js` (strong assertions) + `y.test.js`. Attacker
   deletes `x.test.js` and renames `y.test.js` to
   `x.test.js:sha256:<hash(x)>\ny.test.js` with `y`'s content. The tree hash is
   byte-identical because `computeDirectoryHash` joins unescaped `path:hash`
   lines with `\n`. `verifyEvidenceManifest` → `ok:true`. The deleted test's
   assertions are gone. Only `testFileCount` (2 → 1) betrays the swap — and it
   is never compared (F-07).
2. **Full-chain forgery (F-01, A16).** Weaken `test/*.test.js`, then set
   `testIntegrity.{preTestHash,postTestHash,fileHashes}` and
   `sourceIntegrity.{treeHash,fileCount}` to the recomputed values and
   `evidenceHash = computeEvidenceHash(manifest)`. Verdict: `ok:true`. The
   "cryptographic signature" is a hash the attacker can sign themselves.
3. **Zero-evidence pass (F-02, A17/A19).** Submit
   `{"schema":"agentctl/evidence-manifest-v1","manifestId":"…","generatedAt":"…","evidenceHash":"<self-computed>"}`
   — no test integrity, no source integrity, no security checks. Verdict
   `ok:true`, even after deleting the entire `test/` and `src/` trees.
4. **Runner swap (F-04, E06).** After `evidence generate`, replace
   `scripts/run-tests.mjs` (this repository's `npm test` entry point) with a
   no-op — or `bin/agentctl.mjs` with anything. `sourceIntegrity` never sees
   those directories; verification passes while the executed "tests" are
   attacker-controlled.
5. **Replay & staleness (F-05, H01/H02/H05).** A manifest generated on commit
   A verifies on commit B or a second checkout with identical attested bytes;
   `provenance.commitSha`/`branch`/`dirty`/`repository`/`generatedAt` are
   attested but never bound to the verification decision. Old evidence replays
   forever.
6. **Audit-trail erasure (F-06, E04).** Delete the intermediate failed-run
   manifest (`.agent/evidence/EVD-…-1.json`); the later passed manifest still
   verifies. No `prevHash` or chain linkage exists. `pruneEvidenceManifests`
   (retention 200) deletes old manifests *by design* — with no chain, erasure
   and pruning are indistinguishable.
7. **Outcome laundering (F-08, A08b/E05/A14).** A manifest whose
   `executionRecords[0].exitCode === 1` and `status: "failed"` still verifies
   `ok:true` — the gate verdict is outcome-blind. Combined with the rehash
   attack, a failed run can be re-issued as passed (E05) and the gate agrees.
8. **Parser differential (F-09, C2).** A manifest JSON carrying two
   `"evidenceHash"` keys (decoy first, real last) verifies `ok:true` under
   `JSON.parse` (last-wins) while grep-style or first-key readers display the
   decoy. Same trick works on any attested field.
9. **Silent coverage shrinkage (F-11, G02–G05).** Replace a test file with a
   symlink, or `chmod 000` a test file/subtree before `evidence generate`: the
   manifest records `tamperDetected: false` over a reduced file set and
   verifies clean. Conversely, restoring permissions later produces a
   *false-positive* tamper signal — the coverage boundary is unstable in both
   directions.
10. **Side-channel claims (F-12, A12).** Add `"waiver": "approved-by-ciso"`
    (or any unknown key) to a verified manifest without rehashing; every
    consumer that reads fields outside the whitelist sees attacker text on a
    document the gate just blessed.

---

## 5. Hash-kedjans attackyteanalys (Hash-chain attack surface analysis)

### 5.1 Chain structure

```
file content ──sha256──▶ fileHash ("sha256:" + 64 hex)
fileHash + relPath ──"path:hash\n…" join──▶ treeHash = sha256(lines)     [computeDirectoryHash]
manifest fields ──JSON.stringify(whitelist)──▶ evidenceHash              [computeEvidenceHash]
preTestHash ──(generation-time compare)──▶ postTestHash ──▶ tamperDetected
```

Three layers, all **unkeyed** SHA-256, all deterministic (mtime/permissions
ignored — good for reproducibility).

### 5.2 Surface by layer

| Layer | Binds | Attack surface |
| :--- | :--- | :--- |
| `computeFileHash` | single file bytes | Read errors → `null` → file **silently omitted** (F-11). Follows symlinks if ever listed — but the walker never lists them. |
| `computeDirectoryHash` | test tree (testOnly) / source tree | **Not injective** (F-03): `relPath` may contain `\n`/`:`, no escaping, no length prefix. File set is filtered: artifact dirs/extensions excluded by design; symlinks, unreadable and >4096-char paths excluded silently (F-11). `options.paths` accepts `../` escapes (F-17). `fileCount` is computed but **not enforced** at verify. |
| `computeEvidenceHash` | manifest whitelist | Whitelist ≠ whole document (F-12): unknown fields invisible; empty optional sections invisible (F-09); nested key order sensitive (non-canonical). Duplicate JSON keys → parser differential (F-09). Unkeyed → forgeable (F-01). |
| verify-time checks | `postTestHash`, `sourceIntegrity.treeHash`, `secretScanOk===false`, `protectedScopeOk===false`, `tamperDetected` | All optional (F-02/F-08): missing sections skip checks; `pre ≠ post` never re-derived (F-10); `status`/exit codes ignored (F-08); `fileHashes` ignored (F-07); provenance ignored (F-05); no cross-manifest linkage (F-06). |

### 5.3 Same-hash-prefix analysis

| Comparison point | Length | Property |
| :--- | :--- | :--- |
| `loadEvidenceManifest` / `verifyEvidenceManifest` | full 64 hex (256 bit) | **Prefix-safe.** A18/H03: equal 16-char prefix + wrong tail is rejected. Collision/second-preimage infeasible. |
| `generateEvidenceMarkdown` digest display | 16 hex (64 bit) | **Human-auditable surface.** Forging the *displayed* digest of an existing manifest costs ~2⁶⁴ SHA-256; producing two mutually colluding manifests with the same display costs ~2³² (birthday). H04 demonstrates the principle at 4 hex chars. |
| Failure `reason` strings | 12 hex (48 bit) | Display-only; informational. |

The *chain* itself ("kedjan") is replayable as a unit: `preTestHash →
postTestHash → evidenceHash` contains no nonce, timestamp binding, or external
reference (H05). Same-hash-prefix in the strong sense (finding a different
manifest accepted as the same one) is only possible at the display layer or via
the tree-hash ambiguity of F-03 — not via SHA-256 weakness.

### 5.4 Threat-model coverage

| Attacker | Capability | Outcome |
| :--- | :--- | :--- |
| Disk corruption / partial write | none | **Detected** (B01–B05) — fail-closed via `JSON.parse` |
| Casual editor | changes text only | **Detected** (A01–A11b, E01) — stale hash mismatch |
| Malicious agent in workspace | file write, no scheme knowledge | **Mostly detected**; F-12 and F-03 attacks work without scheme rehash |
| Informed attacker | knows `computeEvidenceHash` | **Everything forgeable** (F-01, F-02, A16, E05) — no trust anchor |
| Attacker with FS tricks | symlinks, chmod, long paths | **Silent gaps** (F-11) |
| Replay attacker | old artifact resubmission | **Undetected** (F-05) |
| History editor | delete/replace manifests | **Undetected** (F-06) |

### 5.5 Out of scope / not audited

SHA-256 cryptographic strength (sound), concurrent multi-writer races on
`.agent/evidence/`, Windows path semantics (`\` handling in the collision
attack), and the engine/ops consumers beyond confirming that
`verifyEvidenceManifest().ok` is the gate verdict (F-08).

---

## 6. Svårighetsgrad per fynd (Severity per finding)

| ID | Severity | Exploit preconditions | Impact | Rationale |
| :--- | :---: | :--- | :--- | :--- |
| F-01 | **High** (Critical at A16) | Write access to manifest + one line of attacker code | Complete integrity loss: any attested fact forgeable | The document's only integrity mechanism is attacker-recomputable |
| F-02 | **Critical** | Write access to manifest (or ability to present one) | Gate passes with zero evidence, even on destroyed trees | Breaks the gate's core promise with minimal effort |
| F-03 | **Critical** | Write access to the test tree; `\n`/`:` in filenames (legal on Linux/macOS) | Test-weakening with **no** rehash; undetectable by hash comparison | Defeats the honest verifier, not just the lazy attacker |
| F-04 | **High** | Write access to `scripts/`, `bin/` or `package.json` | Evidence attests suite A while suite B executes | The runner itself is outside the attested set |
| F-05 | **High** | Possession of any previously valid manifest | Stale/cross-context evidence accepted forever | Provenance fields exist but are never enforced |
| F-06 | **High** | Write access to `.agent/evidence/` | Audit history erasable without trace | No chain linkage; pruning is indistinguishable from deletion |
| F-08 | **High** | Any (A08b needs none) | Failed runs pass the gate; null sections skip checks | Verdict is fail-open and outcome-blind |
| F-10 | **High** | Caller omits `preTestHash` (default path) | "No tampering during run" claim is self-attested | The chain's only interlock is optional and never re-derived |
| F-07 | Medium | Rehash or stale map | Per-file forensics unreliable | Map is attested but unverified |
| F-09 | Medium | JSON crafting ability | Cross-tool disagreement; non-byte-level tamper-evidence | Canonicalization gaps |
| F-11 | Medium | Symlink/chmod/long-path access | Silent coverage shrinkage; false positives in reverse | Fail-open exclusion with no manifest record |
| F-12 | Low | Write access to manifest | Attacker text on a blessed document | Limited to fields consumers read outside the whitelist |
| F-13 | Low | 2⁶⁴ compute (displayed digest) | Human review fooled | Code-level compares are full-length |
| F-14 | Low | Long path input | Ungraceful crash; PR-markdown bloat | Fail-closed but noisy |
| F-17 | Low | Caller-controlled `options.paths` | Out-of-root files folded into hashes | Not reachable from `verifyEvidenceManifest` |
| F-15 | Info (B04: Low) | — | Positive: truncation detected | Availability nuance on the `latest` pointer |
| F-16 | Info | — | Positive: symlink loops safe | |
| F-18 | Info | — | Forensic ambiguity only | By design |

---

## 7. Recommendations (priority order)

1. **Anchor the hash (fixes F-01/F-02/F-05/F-06 at the root).** Make
   `evidenceHash` verifiable against something the attacker cannot recompute:
   an HMAC with a key stored outside the repository (CI secret), a detached
   signature over the manifest (e.g. `git commit -S` of the manifest or
   `git notes`), or an append-only external transcript. Until then, treat
   evidence as *consistency-checking*, not *tamper-proof* — and say so in the
   docs.
2. **Make the tree hash injective (F-03).** Hash length-prefixed entries
   (e.g. `sha256(utf8(path)) + ":" + fileHash`) or hash a canonical JSON array
   of `{path, hash}` — never a raw `\n`-joined string with unescaped paths.
   At verify time also compare `fileCount` and the full `fileHashes` map.
3. **Fail closed on missing sections (F-02/F-08/F-10).** Require
   `testIntegrity.postTestHash`, `sourceIntegrity.treeHash` and
   `securityChecks` to be present and well-formed; re-derive
   `tamperDetected` from `preTestHash !== postTestHash` at verify time; add a
   verdict field (or explicit policy) for `status`/exit codes so failed runs
   cannot pass the gate silently.
4. **Bind provenance and freshness (F-05).** Compare
   `manifest.provenance.commitSha` with `getGitProvenance(root).commitSha`
   (configurable `--allow-detached` for artifact review); enforce a maximum
   evidence age; add a workspace nonce if cross-run replay matters.
5. **Close the attested-set gap (F-04).** Include `scripts/`, `bin/` and
   `package.json` in `computeDirectoryHash`'s scan (or resolve the configured
   test command and hash the files it executes).
6. **Chain the manifests (F-06).** Store `prevEvidenceHash` in each manifest
   and verify the link on load; anchor the head periodically (recommendation 1)
   so pruning and erasure become detectable.
7. **Canonicalize (F-09/F-12).** Serialize the payload with sorted keys
   (RFC 8785-style), reject duplicate keys and unknown fields at parse time,
   and define empty optional sections as either always-present or
   always-absent.
8. **Record exclusions instead of swallowing them (F-11/F-14/F-17).** Emit an
   `unhashed: [{path, reason}]` manifest section for symlinks, unreadable files
   and oversized paths; validate path lengths; contain `options.paths` within
   root.

---

## 8. Reproduction

```bash
node arena-evidence-integrity-test.mjs   # 64 adversarial cases, exit 0 = matrix matches
npm test                                 # repo suite: 1650 pass / 0 fail
```

The harness is standalone (Node ≥ 20, ESM, zero dependencies), imports only
from `src/evidence.mjs`, runs each case in a throwaway temp workspace and never
touches the repository. It is a *characterization* suite: each observation is
asserted against the matrix above, so any fix (or regression) in
`src/evidence.mjs` makes the run exit 1 and this report must be re-issued.

Existing coverage (`test/evidence.test.mjs`) exercises the happy path, one
lazy-tamper case (weakened test file), markdown formatting and retention
pruning. None of the 18 findings above overlap with that coverage — the gaps
are exclusively in adversarial directions (rehash, collision, stripping,
replay, coverage holes).

## 9. Positive controls (what the audit confirms works)

- Every plain field edit without rehash is caught (A01–A11b, E01) — the
  "stale-hash" tripwire is reliable.
- Truncation, empty files and binary corruption fail closed (B01–B05).
- Recorded secret-scan failures are rejected (A08a).
- Full-length digest comparison rejects same-prefix forgeries (A18, H03).
- Symlink loops cannot hang the walker (G01).
- Markdown/JSON export of hostile long paths cannot crash the renderer (F01).
