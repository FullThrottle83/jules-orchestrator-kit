import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Hosts this kit is allowed to contact, and why each one is here.
 *
 * The kit's central claim to a stranger is that it has zero dependencies and
 * talks to exactly one third party. That is only worth anything if it is
 * enforced: a reviewer should be able to trust the boundary without auditing
 * every future commit, and an operator handing over an API key deserves better
 * than a promise in a README.
 *
 * Adding a host here is the deliberate act of widening that boundary. It should
 * be hard to do by accident and obvious in review.
 */
const ALLOWED_HOSTS = new Set([
  "jules.googleapis.com", // the agent provider itself — the only outbound API call
  "github.com", // link text in generated PR descriptions, never fetched
  "jules.google", // documentation link printed into the generated setup guide
  "localhost", // local dashboard and verification servers
  "127.0.0.1",
  "0.0.0.0",
]);

/**
 * Runtime-configured destinations are legitimate but must stay operator-chosen:
 * these are read from env/config and never hardcoded, so no host literal exists
 * for them and they cannot silently point somewhere the operator did not name.
 */
const OPERATOR_SUPPLIED = ["SLACK_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"];

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    // `.js` as well as `.mjs`: `bin/init.js` is published as the `jules-init`
    // binary and sat outside this scan entirely. The point of the guard is
    // that a reviewer can trust the boundary without reading every commit,
    // and a boundary with a file-extension hole does not earn that.
    else if (entry.endsWith(".mjs") || entry.endsWith(".js")) acc.push(full);
  }
  return acc;
}

const SHIPPED_DIRS = ["src", "bin", "scripts"].map((d) => join(REPO_ROOT, d));
const SHIPPED_FILES = SHIPPED_DIRS.flatMap((d) => sourceFiles(d)).concat(join(REPO_ROOT, "index.mjs"));

describe("network egress boundary", () => {
  it("contacts no host outside the allowlist", () => {
    const violations = [];
    for (const file of SHIPPED_FILES) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
        const host = match[1].toLowerCase();
        if (ALLOWED_HOSTS.has(host)) continue;
        // Template placeholders like ${host} are resolved from operator config.
        if (host.includes("$")) continue;
        violations.push(`${relative(REPO_ROOT, file)} → ${host}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Unapproved network destination(s) introduced.\n${violations.join("\n")}\n\n` +
        "If this is intentional, add the host to ALLOWED_HOSTS with a justification."
    );
  });

  it("keeps notification targets operator-supplied rather than baked in", () => {
    const webhook = readFileSync(join(REPO_ROOT, "src", "webhook.mjs"), "utf-8");
    for (const envVar of OPERATOR_SUPPLIED) {
      assert.match(
        webhook,
        new RegExp(`process\\.env\\.${envVar}`),
        `${envVar} must come from the operator's environment, never a literal URL`
      );
    }
  });

  it("ships no runtime dependencies", () => {
    // The egress guarantee above is only meaningful if no third-party code runs
    // alongside it: a single transitive dependency could reach anywhere.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    assert.deepEqual(pkg.dependencies || {}, {}, "the kit must stay dependency-free at runtime");
  });

  it("never places an API token in a URL", () => {
    // Tokens in query strings leak into proxy logs, browser history and
    // referrer headers. provider.mjs already throws on interpolated templates;
    // this catches a literal slipping into any shipped file.
    const offenders = [];
    for (const file of SHIPPED_FILES) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(/https?:\/\/[^\s"'`]*[?&](?:key|token|api_?key|access_?token)=/gi)) {
        offenders.push(`${relative(REPO_ROOT, file)} → ${match[0].slice(0, 60)}`);
      }
    }
    assert.deepEqual(offenders, [], "API credentials must travel in headers, not URLs");
  });
});
