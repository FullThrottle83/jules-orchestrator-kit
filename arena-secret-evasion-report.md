# Secret Scanner Evasion Audit Report

**Repository:** `FullThrottle83/jules-orchestrator-kit`  
**Scanner:** `src/secret-scanner.mjs` + `src/security.mjs` (`scanDiff`)  
**Test harness:** `arena-secret-evasion-test.mjs`  
**Date:** 2026-09-30  
**Credentials used:** All fabricated, e.g. `AKIAIOSFODNN7EXAMPLE` (AWS docs example), `ghp_`+`a`*36, JWT from security.test.mjs, RSA key with fake body.

## Executive Summary

The scanner is hardened against many classic evasions (zero-width, homoglyphs, base64, hex, concatenation, template `${}` collapsing, `.join("")`, `.concat()`). Out of 38 crafted payloads, 25 were detected, 13 evaded. Of the 13, 4 are by design (lockfile exclusion, entropy threshold), 1 is generic hex that does not decode to a structured secret, and 8 represent genuine bypasses that an attacker could exploit to smuggle a credential past `scanDiff()`.

Genuine bypasses:
- **a. Multi-line split without concatenation** – secret split into two variables across hunks/files without `+` operator evades.
- **f. Private key BEGIN marker split** – `["-----BEGIN ", "RSA PRIVATE KEY-----"]` breaks the `-----BEGIN ... KEY-----` regex.
- **g. Context lines** – scanner only inspects `+` lines; secrets in space-prefixed context lines are ignored (by design, but attacker can craft diff where context carries secret).
- **h. Unicode escapes** – `\u0041\u004B...` spelling `AKIA...` is not decoded; `hasHighConfidenceSecret` sees literal backslashes, not `AWS`.

Partial bypass:
- **d. JWT casing** – regex `/\beyJ.../` requires lowercase `eyJ`. Changing to `EyJ`, `EYJ`, `eyj` bypasses the JWT high-confidence pattern, but the token is still caught by secondary `HIGH_ENTROPY_TOKEN` (entropy >4.5) and `LOW_CONFIDENCE` Bearer check. So gate still blocks, but specific JWT regex is bypassed.

No bypass (hardened):
- **b. Base64 in template literals** – detected via `hasEncodedSecret` + `secretScanVariants` collapsing `${"chunk"}`.
- **c. Hex-encoded** – detected via `tryHexDecodeTokens` (`\b([0-9a-fA-F]{24,})\b` → Buffer.from hex).
- **e. Whitespace padding** – detected, pattern uses `\s*` which includes spaces, tabs, newlines.

## Pass/Fail Matrix

| ID | Technique | Payloads Tested | Detected | Evaded | Result |
|---|---|---|---|---|---|
| a | Multi-line secrets split across diff hunks | 5 | 3 | 2 | **PARTIAL BYPASS** |
| b | Base64-encoded API keys inside template literals | 3 | 3 | 0 | PASS (hardened) |
| c | Hex-encoded secrets in env var assignments | 4 | 3 | 1* | PASS (structured hex detected) |
| d | JWT tokens with modified header casing | 5 | 5 | 0** | PARTIAL (regex bypassed, entropy catches) |
| e | AWS credentials with whitespace padding | 5 | 5 | 0 | PASS |
| f | Private keys as string arrays joined at runtime | 5 | 4 | 1 | **BYPASS** |
| g | Secrets placed in diff context lines | 3 | 0 | 3 | **BYPASS (by design)** |
| h | Unicode escape sequences | 3 | 0 | 3 | **BYPASS** |
| i | Shannon entropy boundary cases | 5 | 2 | 3* | PASS (threshold works) |

\* c4 and i3,i4,i5 are intentional non-detections (low entropy, lockfile exclusion)  
\** d2-d4 bypass JWT regex but caught by entropy

### Detailed by payload

| Payload | Expected | Actual | Finding Type | Notes |
|---|---|---|---|---|
| a1-split-no-concat-same-file | evade | evaded | none | Two variables `AKIA` and `IOSFODNN7EXAMPLE` across hunks, no `+` |
| a2-split-with-plus-same-hunk | detect | detected | HIGH_CONFIDENCE | `"AKIA" + "IOSFODNN7EXAMPLE"` collapsed via `STRING_CONCAT_JOIN` |
| a3-split-across-files-with-plus | detect | detected | HIGH_CONFIDENCE | Fallback joins across files, then dejoins |
| a4-split-across-files-no-concat | evade | evaded | none | Two files, separate vars |
| a5-split-inside-string-across-lines | detect | detected | HIGH_CONFIDENCE | `base64Dejoined` collapses `\n` between base64 chars |
| b1-b64-in-template-literal | detect | detected | HIGH_CONFIDENCE (encoded) | `QUtJQUlPU0ZPRE5ON0VYQU1QTEU=` → decodes to AKIA... |
| b2-b64-split-in-template-expressions | detect | detected | HIGH_CONFIDENCE (encoded) | `${"QUtJ"}${"QUl..."}` → `secretScanVariants` replaces `${"VAL"}` with VAL |
| b3-b64-wrapped-in-Buffer | detect | detected | HIGH_CONFIDENCE (encoded) | `Buffer.from("...", "base64")` still contains blob |
| c1-hex-encoded-aws-in-env | detect | detected | HIGH_CONFIDENCE | `414b4941494f53464f444e4e374558414d504c45` → hex decode → AKIA... |
| c2-hex-encoded-in-api-key-env | detect | detected | HIGH_CONFIDENCE | Same |
| c3-hex-encoded-aws-secret | detect | detected | HIGH_CONFIDENCE | Hex of 40-char secret |
| c4-hex-generic-not-structured | evade | evaded | none | `5375706572...` decodes to `SuperSecretPassword123!` – not high-confidence, variable `data` avoids low-confidence |
| d1-standard-jwt | detect | detected | HIGH_CONFIDENCE | `eyJhbGci...` matches `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/` |
| d2-jwt-EyJ-casing | detect* | detected | HIGH_ENTROPY_TOKEN | `EyJ...` bypasses JWT regex, but entropy 4.6 catches |
| d3-jwt-EYJ-casing | detect* | detected | HIGH_ENTROPY_TOKEN | Same |
| d4-jwt-eyj-lowercase | detect* | detected | HIGH_ENTROPY_TOKEN | Same |
| d5-jwt-EyJ-with-Bearer | detect | detected | LOW_CONFIDENCE | `Authorization: Bearer EyJ...` caught by Bearer regex |
| e1-baseline-aws | detect | detected | HIGH_CONFIDENCE | `AKIAIOSFODNN7EXAMPLE` matches `/\bAKIA[0-9A-Z]{16}\b/` |
| e2-aws-with-spaces-around-equals | detect | detected | HIGH_CONFIDENCE | `api_key=    AKIA...` – `\s*` allows spaces |
| e3-aws-secret-with-padding | detect | detected | HIGH_CONFIDENCE | `aws_secret_access_key    =    "..."` – pattern `/aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{40}['"]?/gi` |
| e4-aws-with-tabs | detect | detected | HIGH_CONFIDENCE | Tab is `\s` |
| e5-aws-with-newline-between | detect | detected | HIGH_CONFIDENCE | `\s*` includes `\n` |
| f1-baseline-private-key | detect | detected | HIGH_CONFIDENCE | `-----BEGIN RSA PRIVATE KEY-----...-----END RSA PRIVATE KEY-----` matches `/-----BEGIN (?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PRIVATE)(?:\s+PRIVATE)? KEY-----[\s\S]*?-----END .../` |
| f2-private-key-array-join-newline | detect | detected | HIGH_CONFIDENCE | `["-----BEGIN RSA PRIVATE KEY-----", "...", "-----END RSA PRIVATE KEY-----"]` – regex `[\s\S]*?` spans `", "` |
| f3-private-key-split-BEGIN-marker | evade | evaded | none | `["-----BEGIN ", "RSA PRIVATE KEY-----..."]` – BEGIN marker itself split, no contiguous `-----BEGIN RSA PRIVATE KEY-----` |
| f4-private-key-array-literal-join-empty | detect | detected | HIGH_CONFIDENCE | `.join("")` stripped, but BEGIN/END still contiguous across array elements |
| f5-private-key-array-join-with-replace | detect | detected | HIGH_CONFIDENCE | Same |
| g1-secret-in-context-line | evade | evaded | none | ` const token = "AKIAIOSFODNN7EXAMPLE";` (space prefix) – `splitDiffByFile` only collects `+` lines |
| g2-secret-in-context-between-hunks | evade | evaded | none | Same |
| g3-secret-in-context-after-add | evade | evaded | none | Same |
| h1-unicode-escaped-AWS-key | evade | evaded | none | `\u0041\u004b\u0049\u0041...` – no unicode escape decoding in `secretScanVariants` |
| h2-unicode-escaped-AWS-literal | evade | evaded | none | `\u0041\u0057\u0053` → `AWS` but scanner sees literal `\u...` |
| h3-mixed-plain-and-unicode-escape | evade | evaded | none | `"AKIA" + "\u0049\u004f..."` – concatenation collapsed, but second half still escaped |
| i1-entropy-all-unique-4.58 | detect | detected | HIGH_ENTROPY_TOKEN | `ABCDEFGHIJKLmnopqrstuvwx` entropy 4.585 >4.5, regex `[A-Za-z0-9_-]{24,}` |
| i2-entropy-23-unique-just-above | detect | detected | HIGH_ENTROPY_TOKEN | `ABCDEFGHIJKLMNOPQRSTUVWA` entropy 4.502 >4.5 |
| i3-entropy-22-unique-below-threshold | evade | evaded | none | `ABCDEFGHIJKLMNOPQRSTUVAA` entropy 4.387 <4.5 – `hasHighEntropyToken` returns false |
| i4-entropy-low-2.0 | evade | evaded | none | `abcdabcd...` entropy 2.0 |
| i5-high-entropy-in-lockfile-should-be-ignored | evade | evaded | none | File `package-lock.json` excluded in `hasHighEntropyToken` |

## Specific Regex / Check Bypassed

### a. Multi-line split
- **Bypassed:** No single regex, but logic: `splitDiffByFile` groups `+` lines per file, `secretScanVariants` only rejoins when `+` operator or base64 newline present. Splitting into two independent variables `const part1 = "AKIA";` and `const part2 = "IOSFODNN7EXAMPLE";` across hunks yields no contiguous `AKIAIOSFODNN7EXAMPLE`, so `/\bAKIA[0-9A-Z]{16}\b/` does not match.
- **Mitigated when:** Using `"AKIA" + "IOSFODNN7EXAMPLE"` – `STRING_CONCAT_JOIN` `/([\"'`])\s*(?:\/\*[\s\S]*?\*\/)?\s*\+\s*(?:\/\*[\s\S]*?\*\/)?\s*([\"'`])/g` collapses to `"AKIAIOSFODNN7EXAMPLE"`.

### b. Base64 in template literals
- **Not bypassed:** `BASE64_CANDIDATE = /[A-Za-z0-9+\/_-]{20,}={0,2}/g` finds blob inside `` `...` ``. `decodeBase64Blobs` decodes and `hasHighConfidenceSecret` matches. Template `${"chunk"}` collapsed by `dejoined.replace(/\$\{\s*["'`]([^"'`]+)["'`]\s*\}/g, "$1")`.

### c. Hex-encoded
- **Not bypassed for structured secrets:** `tryHexDecodeTokens` `/\b([0-9a-fA-F]{24,})\b/g` → `Buffer.from(match, "hex").toString("utf-8")` → `printableRatio >=0.9` → returns decoded `AKIA...` which matches `/\bAKIA[0-9A-Z]{16}\b/`.
- **Bypass for generic:** If hex decodes to non-structured high-entropy string and variable name avoids `api_key|secret|password|token` low-confidence pattern, it evades.

### d. JWT casing
- **Bypassed regex:** `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g` – requires exact `eyJ` (lower e, y, upper J). Changing to `EyJ`, `EYJ`, `eyj` fails this regex. Direct `hasHighConfidenceSecret("EyJ...")` returns false.
- **Secondary catch:** `hasHighEntropyToken` still flags because JWT has high entropy (~4.7) and matches `[A-Za-z0-9_-]{24,}`. So gate still blocks, but via `HIGH_ENTROPY_TOKEN`, not `HIGH_CONFIDENCE_SECRET`.

### e. Whitespace padding
- **Not bypassed:** `aws_secret_access_key\s*[:=]\s*` and `(api[_-]?key|...)\s*[:=]\s*` both use `\s*` which matches spaces, tabs, newlines. `/\bAKIA[0-9A-Z]{16}\b/` matches regardless of surrounding `=`.

### f. Private key array join
- **Bypassed when BEGIN marker split:** Regex `/-----BEGIN (?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PRIVATE)(?:\s+PRIVATE)? KEY-----[\s\S]*?-----END .../` requires contiguous `-----BEGIN RSA PRIVATE KEY-----`. Splitting as `["-----BEGIN ", "RSA PRIVATE KEY-----"]` breaks it. `secretScanVariants` only strips `.join("")` and `.concat("...")`, not array bracket/commas, but even if it did, the split BEGIN would still be broken.
- **Not bypassed when:** `["-----BEGIN RSA PRIVATE KEY-----", "MIIE...", "-----END RSA PRIVATE KEY-----"].join("\n")` – `[\s\S]*?` matches across `", "` and `hasHighConfidenceSecret` still finds BEGIN...END.

### g. Context lines
- **Bypassed:** `splitDiffByFile` only pushes lines starting with `+` (and not `+++`). Context lines starting with space advance `lineNo` but are not added to `addedText`. So ` const token = "AKIAIOSFODNN7EXAMPLE";` is never scanned. This is intentional (context is not new), but an attacker who can control diff generation could place secret in context and still have it be new content in the file (if diff is malformed).

### h. Unicode escapes
- **Bypassed:** No decoding of `\uXXXX` escapes in `secretScanVariants`. `hasHighConfidenceSecret("\u0041\u004b\u0049\u0041...")` sees literal backslashes, not `AKIA`. `normalizeSecretText` handles NFKD and homoglyphs but not JS string escape decoding. So `"\u0041\u0057\u0053"` spelling `"AWS"` evades.
- **Concrete:** `AKIA` → `\u0041\u004b\u0049\u0041` each char as `\uXXXX`. Scanner would need `JSON.parse` or custom unescape to catch.

### i. Entropy boundary
- **Bypassed (by design):** `hasHighEntropyToken` uses `shannonEntropy(token) > 4.5` and `CANDIDATE_TOKEN_REGEX = /[A-Za-z0-9_-]{24,}/g`. Token `ABCDEFGHIJKLMNOPQRSTUVAA` (22 unique) has entropy 4.387 <4.5, so not flagged. `ABCDEFGHIJKLmnopqrstuvwx` (24 unique) has entropy 4.585 >4.5, flagged. Lockfiles (`package-lock.json`, `yarn.lock`, etc.) are explicitly excluded.
- **Implication:** An attacker can craft a 24-char token with limited alphabet (e.g., 22 unique chars) to stay just below threshold.

## Concrete Diff Payloads Demonstrating Bypass

### a1 – Split across hunks, no concat (EVADED)
```diff
--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,3 @@
 const a = 1;
-const old = 2;
+const part1 = "AKIA";
@@ -10,3 +10,3 @@
 const b = 2;
-const old2 = 3;
+const part2 = "IOSFODNN7EXAMPLE";
```

### a4 – Split across files, no concat (EVADED)
```diff
--- a/a.js
+++ b/a.js
@@ -1,1 +1,1 @@
+const part1 = "AKIA";
--- a/b.js
+++ b/b.js
@@ -1,1 +1,1 @@
+const part2 = "IOSFODNN7EXAMPLE";
```

### f3 – Private key BEGIN split (EVADED)
```diff
--- a/file.js
+++ b/file.js
@@ -1,3 +1,1 @@
+const parts = ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIE...", "-----END RSA PRIVATE KEY-----"]; const key = parts.join("");
```

### g1 – Secret in context line (EVADED)
```diff
--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 const x = 1;
 const token = "AKIAIOSFODNN7EXAMPLE";
+const y = 2;
```
`scanDiff` only scans `+` lines, so context line with secret is ignored.

### h1 – Unicode escaped AWS key (EVADED)
```diff
--- a/file.js
+++ b/file.js
@@ -1,3 +1,1 @@
+const k = "\u0041\u004b\u0049\u0041\u0049\u004f\u0053\u0046\u004f\u0044\u004e\u004e\u0037\u0045\u0058\u0041\u004d\u0050\u004c\u0045";
```
Decodes at runtime to `AKIAIOSFODNN7EXAMPLE`, but scanner sees literal `\u...`.

### d2 – JWT with EyJ casing (JWT regex BYPASSED, but caught by entropy)
```diff
--- a/file.js
+++ b/file.js
@@ -1,3 +1,1 @@
+const jwt = "EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
```
- `hasHighConfidenceSecret` returns false (needs `eyJ`).
- `hasHighEntropyToken` returns true (entropy 4.7), so finding is `HIGH_ENTROPY_TOKEN`, not `HIGH_CONFIDENCE_SECRET`.

### i3 – Entropy just below threshold (EVADED by design)
```diff
--- a/file.js
+++ b/file.js
@@ -1,3 +1,1 @@
+const myData = "ABCDEFGHIJKLMNOPQRSTUVAA";
```
Entropy 4.387 < 4.5, so `hasHighEntropyToken` false. 24 unique variant `ABCDEFGHIJKLMNOPQRSTUVWX` entropy 4.585 >4.5 would be flagged.

## Recommendations

1. **Unicode escape decoding:** Add `\uXXXX` and `\xXX` unescaping in `secretScanVariants` (e.g., `str.replace(/\\u([0-9a-fA-F]{4})/g, ...)`).
2. **Split variable tracking:** Detect when two variables each hold half of a known pattern and are concatenated via `+` across files – already partially handled via fallback, but not when split without operator. Could add heuristic to join all string literals in diff regardless of `+`.
3. **Private key marker split:** Normalize by removing `["`, `"]`, `", "` etc. before private key regex, or search for `BEGIN` and `END` markers separately.
4. **Context line audit:** Consider scanning context lines that are adjacent to added lines, or require diff to be well-formed (git-generated).
5. **JWT case-insensitivity:** Make JWT regex case-insensitive for first char, or lower-case token before matching, since JWT header `eyJ` is base64 of `{"` – `EyJ` decodes to different JSON but still high-entropy secret. Alternatively rely on entropy catch as defense-in-depth (currently works).
6. **Entropy threshold:** Document that threshold 4.5 is tunable; attacker can stay just below with 22 unique chars. Could lower to 4.3 or add secondary check for known prefixes like `AKIA`.

## Verification

```bash
node arena-secret-evasion-test.mjs
npm test
```

`arena-secret-evasion-test.mjs` imports `scanDiff` from `src/security.mjs` and exercises all 9 vectors. It prints DETECTED/EVADED per payload and summary.

`npm test` passes (no src/ modified).

## Appendix – Test Harness Output (abridged)

```
[a1-split-no-concat-same-file] => EVADED
[a2-split-with-plus-same-hunk] => DETECTED
...
[b1-b64-in-template-literal] => DETECTED
...
[c1-hex-encoded-aws-in-env] => DETECTED
...
[d1-standard-jwt] => DETECTED
[d2-jwt-EyJ-casing] => DETECTED (via entropy, JWT regex bypassed)
...
[e1-baseline-aws] => DETECTED
...
[f1-baseline-private-key] => DETECTED
[f3-private-key-split-BEGIN-marker] => EVADED
...
[g1-secret-in-context-line] => EVADED
...
[h1-unicode-escaped-AWS-key] => EVADED
...
[i1-entropy-all-unique-4.58] => DETECTED
[i3-entropy-22-unique-below-threshold] => EVADED
```

Total: 25/38 detected, 13 evaded (8 genuine bypasses + 5 by design).
