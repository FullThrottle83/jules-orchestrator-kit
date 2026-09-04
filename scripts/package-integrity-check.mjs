#!/usr/bin/env node

/**
 * Does the package we publish actually work?
 *
 * Every test in this repository runs against the source tree, where every
 * file is present by definition. What users install is a tarball built from
 * the `files` list in package.json, and nothing checked that the two agreed.
 *
 * They did not. v0.63.0 shipped `scripts/guard-reach-check.mjs` — the check
 * whose entire purpose is to prove no guard has silently gone missing —
 * while leaving behind the policy contract it imports. Unpacked and run, it
 * threw ERR_MODULE_NOT_FOUND. The CLI was fine, 1015 tests were green, nine
 * CI cells passed, and the published artefact still had a hole in it,
 * because every one of those signals was measured somewhere the file existed.
 *
 * This asks the packer what it would ship, and then resolves the import
 * graph inside that answer.
 *
 * Usage: node scripts/package-integrity-check.mjs [--json]
 * Exit codes: 0 = the tarball is self-contained, 1 = it is not.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { IMPORT_EXTRACTION_CASES } from "../src/guard-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Mark every character that sits inside a string literal or a comment.
 *
 * Without this, an import quoted *inside* a fixture string reads as an
 * import of the file itself — this check's first run reported six broken
 * imports in the policy contract, all of them example text. A guard that
 * cries wolf about its own fixtures gets switched off in a week.
 *
 * Approximate on purpose, and biased on purpose: a regex literal holding a
 * quote can open a phantom string, so the counts reported below exist to
 * make a mask that swallowed the file visible rather than silent.
 */
function stringMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  let quote = null;
  let comment = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = null;
      else mask[i] = 1;
      i++;
      continue;
    }
    if (comment === "block") {
      mask[i] = 1;
      if (c === "*" && d === "/") {
        mask[i + 1] = 1;
        comment = null;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote !== null) {
      mask[i] = 1;
      if (c === "\\") {
        if (i + 1 < src.length) mask[i + 1] = 1;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && d === "/") { comment = "line"; mask[i] = 1; i++; continue; }
    if (c === "/" && d === "*") { comment = "block"; mask[i] = 1; i++; continue; }
    // A regex literal holding a quote — `/["']/` — opens a string that never
    // closes, and everything after it is misread. This file's own subject
    // matter is regexes full of quote characters, so the mask desynchronised
    // and a `require("./calc")` written inside a comment was reported as a
    // missing module. Deciding regex-versus-division on the previous token is
    // the same approximation the diff scanner already makes.
    if (c === "/") {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      const prev = k >= 0 ? src[k] : "";
      if (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev)) {
        mask[i] = 1;
        let j = i + 1;
        let cls = false;
        while (j < src.length) {
          const e = src[j];
          mask[j] = 1;
          if (e === "\\") { if (j + 1 < src.length) mask[j + 1] = 1; j += 2; continue; }
          if (e === "[") cls = true;
          else if (e === "]") cls = false;
          else if (e === "/" && !cls) { j++; break; }
          else if (e === "\n") break;
          j++;
        }
        i = j;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; mask[i] = 1; i++; continue; }
    i++;
  }
  return mask;
}

/**
 * Every module specifier in a source file.
 *
 * Deliberately newline-tolerant. A matcher bounded by `[^;\n]*?` cannot see
 * a multi-line named import, which is exactly the import that was missing
 * from the tarball, so the first version of this check certified the broken
 * package as sound. The extraction cases in the policy contract exist to
 * keep that from being a private mistake twice.
 */
export function extractSpecifiers(src, { skipQuoted = true } = {}) {
  const mask = skipQuoted ? stringMask(src) : null;
  const found = new Set();
  const collect = (re) => {
    for (const m of src.matchAll(re)) {
      // What decides is the token immediately before the specifier — the
      // `from`, or the `(` of a call. In a real import it is code; in a
      // fixture it is the middle of a string. Testing the *keyword* instead
      // was not enough: `export const CASES = [` at the top of a file
      // matched lazily forward into the first `from "…"` inside an example,
      // so a genuine keyword lent its authority to quoted text.
      if (mask) {
        let j = m.indices[1][0] - 2;
        while (j >= 0 && /\s/.test(src[j])) j--;
        if (j >= 0 && mask[j]) continue;
      }
      found.add(m[1]);
    }
  };
  collect(/(?:^|[\s;}])(?:import|export)\s[\s\S]{0,500}?from\s*["']([^"']+)["']/gd);
  collect(/(?:^|[\s;}])import\s*["']([^"']+)["']/gd);
  collect(/\bimport\s*\(\s*["']([^"']+)["']/gd);
  collect(/\brequire\s*\(\s*["']([^"']+)["']/gd);
  return [...found];
}

/**
 * Run every integrity check and return the result.
 *
 * Exported as a function rather than run on import: a module that checks the
 * package must not exit the process of anything that merely imports it.
 */
export function checkPackageIntegrity() {
  const failures = [];
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  // --- 1. The extractor must be able to see what it claims to look for -------
  {
    const wrong = [];
    for (const c of IMPORT_EXTRACTION_CASES) {
      const got = extractSpecifiers(c.src).sort();
      const want = [...c.expect].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        wrong.push(`${c.id}: found ${JSON.stringify(got)}, contract says ${JSON.stringify(want)}`);
      }
    }
    add("extractor: every import form is visible", wrong.length === 0, wrong.length ? wrong.join("; ") : `${IMPORT_EXTRACTION_CASES.length} forms found`);
  }

  // --- 2. Ask the packer what it would actually ship -------------------------
  let shipped = new Set();
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    shipped = new Set(JSON.parse(out)[0].files.map((f) => f.path.split(/[\\/]/).join("/")));
  } catch (err) {
    add("packer: `npm pack --dry-run` answers", false, err.message);
  }
  add("packer: the tarball is not empty", shipped.size > 0, `${shipped.size} files`);

  // --- 3. Resolve the import graph inside the tarball ------------------------
  {
    const broken = [];
    let resolved = 0;
    let scanned = 0;

    for (const file of shipped) {
      if (!/\.(mjs|cjs|js)$/.test(file)) continue;
      let src;
      try {
        src = readFileSync(resolve(root, file), "utf-8");
      } catch {
        continue;
      }
      scanned++;
      for (const spec of extractSpecifiers(src)) {
        if (!spec.startsWith(".")) continue; // bare and node: specifiers are not ours to resolve
        resolved++;
        const target = relative(root, resolve(dirname(resolve(root, file)), spec)).split(sep).join("/");
        if (!shipped.has(target)) {
          broken.push(`${file} imports ${spec} — ${target} is not in the tarball (on disk: ${existsSync(resolve(root, target)) ? "yes" : "no"})`);
        }
      }
    }

    add(
      "tarball: every relative import resolves",
      broken.length === 0,
      broken.length ? broken.join("; ") : `${resolved} relative imports across ${scanned} shipped modules`
    );
    // A resolver that resolved nothing would report the same clean line.
    add("tarball: the graph was actually walked", resolved > 0 && scanned > 0, `${scanned} modules, ${resolved} relative imports`);
  }

  // --- 4. Every advertised entry point has to be in the box ------------------
  {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    const entries = [...Object.values(pkg.bin || {}), pkg.main, pkg.module].filter(Boolean);
    const missing = entries.map((e) => e.replace(/^\.\//, "")).filter((e) => !shipped.has(e));
    add("entry points: every bin and main ships", missing.length === 0, missing.length ? missing.join(", ") : `${entries.length} entry points present`);
  }

  return { ok: failures.length === 0, checks, failures };
}

const isMain = process.argv[1] && process.argv[1].endsWith("package-integrity-check.mjs");
if (isMain) {
  const { ok, checks: rows, failures: bad } = checkPackageIntegrity();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok, checks: rows }, null, 2));
  } else {
    console.log("\n📦 Package Integrity Check (what we actually publish)");
    console.log("-------------------------------------------------------");
    for (const c of rows) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name.padEnd(46)} ${c.detail}`);
    console.log("-------------------------------------------------------");
    console.log(
      ok
        ? "✅ The published package is self-contained.\n"
        : `\n❌ ${bad.length} problem(s). The tarball is not what the source tree looks like.\n`
    );
  }
  process.exit(ok ? 0 : 1);
}
