/**
 * Backward compatibility shim for command-resolver.mjs in v0.9.0.
 * Re-exports detectStack from src/config.mjs.
 */

import { detectStack, parseYaml } from "../src/config.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export { detectStack, detectPackageManager } from "../src/config.mjs";

/**
 * Extract and parse custom command definitions from .agent/jules.yml or .agent/config.yml.
 */
export function parseYamlConfig(root = process.cwd()) {
  const candidates = [join(root, ".agent", "jules.yml"), join(root, ".agent", "config.yml")];
  for (const configPath of candidates) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = parseYaml(raw);
        if (parsed && (parsed.test_cmd || parsed.build_cmd || parsed.verify)) {
          return {
            testCmd: parsed.verify?.test || parsed.test_cmd || "",
            buildCmd: parsed.verify?.build || parsed.build_cmd || "",
            source: configPath.endsWith("jules.yml") ? ".agent/jules.yml" : ".agent/config.yml",
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

/**
 * Autodetect framework/stack test and build verification commands.
 */
export function detectFrameworkCommands(root = process.cwd()) {
  try {
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch (_) {
        return { testCmd: "", buildCmd: "", source: "generic" };
      }
    }
  } catch (_) {}

  const res = detectStack(root);
  return {
    testCmd: res.testCmd,
    buildCmd: res.buildCmd,
    source: `package.json (${res.stack})`,
  };
}

export function resolveProjectCommands(root = process.cwd()) {
  const yamlConfig = parseYamlConfig(root);
  if (yamlConfig) {
    return yamlConfig;
  }
  return detectFrameworkCommands(root);
}

export function resolveWorkspaceExecutionBoundary(paths = [], root = process.cwd()) {
  if (existsSync(join(root, "turbo.json"))) {
    return {
      source: "Turborepo Workspace (turbo.json)",
      testCmd: "npx turbo run test --filter=@scope/app...",
      buildCmd: "npx turbo run build",
      filteredPaths: paths,
    };
  }
  if (existsSync(join(root, "pnpm-workspace.yaml"))) {
    return {
      source: "pnpm Workspace (pnpm-workspace.yaml)",
      testCmd: "pnpm test --filter=...web",
      buildCmd: "pnpm build",
      filteredPaths: paths,
    };
  }
  if (existsSync(join(root, "nx.json"))) {
    return {
      source: "Nx Workspace (nx.json)",
      testCmd: "npx nx run-many -t test",
      buildCmd: "npx nx run-many -t build",
      filteredPaths: paths,
    };
  }
  return { source: "workspace-root", testCmd: "", buildCmd: "", filteredPaths: paths };
}
