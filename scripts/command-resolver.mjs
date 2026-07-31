import fs from "node:fs";
import path from "node:path";

/**
 * Dynamic Framework-Agnostic Command Resolver
 * Sniffs project manifests to return proper build & test verification commands.
 */
export function resolveProjectCommands(projectRoot = process.cwd()) {
  // 1. Check for explicit custom config (.agent/jules.yml or jules.config.json)
  const yamlConfigPath = path.join(projectRoot, ".agent/jules.yml");
  if (fs.existsSync(yamlConfigPath)) {
    const lines = fs.readFileSync(yamlConfigPath, "utf-8").split("\n");
    let testCmd = "";
    let buildCmd = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("test_cmd:")) {
        testCmd = trimmed.slice("test_cmd:".length).trim().replace(/^["']|["']$/g, "");
      } else if (trimmed.startsWith("build_cmd:")) {
        buildCmd = trimmed.slice("build_cmd:".length).trim().replace(/^["']|["']$/g, "");
      }
    }
    if (testCmd || buildCmd) {
      return {
        testCmd,
        buildCmd,
        source: ".agent/jules.yml",
      };
    }
  }

  const jsonConfigPath = path.join(projectRoot, "jules.config.json");
  if (fs.existsSync(jsonConfigPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(jsonConfigPath, "utf-8"));
      return {
        testCmd: cfg.testCmd || cfg.verifyCmd || "",
        buildCmd: cfg.buildCmd || "",
        source: "jules.config.json",
      };
    } catch (err) {
      console.warn("⚠️ Failed to parse jules.config.json:", err.message);
    }
  }

  // 2. Dynamic Detector Strategy List
  const detectors = [
    {
      files: ["bunfig.toml", "bun.lockb"],
      resolve: () => ({ testCmd: "bun test", buildCmd: "bun run build", source: "Bun Manifest" }),
    },
    {
      files: ["deno.json", "deno.jsonc"],
      resolve: () => ({ testCmd: "deno test", buildCmd: "deno task build", source: "Deno Manifest" }),
    },
    {
      files: ["package.json"],
      resolve: (root) => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
          const scripts = pkg.scripts || {};
          let verifyScript = scripts["check:all"] ? "npm run check:all" : "";
          if (!verifyScript) {
            const parts = [];
            if (scripts.lint) parts.push("npm run lint");
            else if (scripts.check) parts.push("npm run check");
            if (scripts.test) parts.push("npm test");
            verifyScript = parts.join(" && ");
          }
          const buildScript = scripts.build ? "npm run build" : "";
          return {
            testCmd: verifyScript || "npm test",
            buildCmd: buildScript,
            source: "package.json",
          };
        } catch (err) {
          console.warn("⚠️ Failed to parse package.json:", err.message);
          return null;
        }
      },
    },
    {
      files: ["Cargo.toml"],
      resolve: () => ({ testCmd: "cargo test --workspace", buildCmd: "cargo build", source: "Cargo.toml" }),
    },
    {
      files: ["go.mod"],
      resolve: () => ({ testCmd: "go test ./...", buildCmd: "go build ./...", source: "go.mod" }),
    },
    {
      files: ["pyproject.toml", "requirements.txt", "setup.py"],
      resolve: () => ({ testCmd: "pytest", buildCmd: "", source: "Python Manifest" }),
    },
    {
      files: ["mix.exs"],
      resolve: () => ({ testCmd: "mix test", buildCmd: "mix compile", source: "mix.exs" }),
    },
    {
      files: ["Gemfile"],
      resolve: () => ({ testCmd: "bundle exec rake test", buildCmd: "", source: "Gemfile" }),
    },
    {
      files: ["Package.swift"],
      resolve: () => ({ testCmd: "swift test", buildCmd: "swift build", source: "Package.swift" }),
    },
    {
      files: ["pom.xml"],
      resolve: () => ({ testCmd: "mvn test", buildCmd: "mvn compile", source: "pom.xml" }),
    },
    {
      files: ["build.gradle", "build.gradle.kts"],
      resolve: () => ({ testCmd: "./gradlew test", buildCmd: "./gradlew assemble", source: "build.gradle" }),
    },
    {
      files: ["Makefile"],
      resolve: () => ({ testCmd: "make test", buildCmd: "make build", source: "Makefile" }),
    },
  ];

  for (const detector of detectors) {
    if (detector.files.some((f) => fs.existsSync(path.join(projectRoot, f)))) {
      const res = detector.resolve(projectRoot);
      if (res) return res;
    }
  }

  return {
    testCmd: "",
    buildCmd: "",
    source: "generic",
  };
}

/**
 * Resolves targeted build & test commands based on affected workspace packages.
 * Prevents running O(N) full-repo test suites in monorepos when changes are localized.
 */
export function resolveWorkspaceExecutionBoundary(modifiedFiles = [], projectRoot = process.cwd()) {
  const baseCmds = resolveProjectCommands(projectRoot);
  if (baseCmds.source === ".agent/jules.yml" || baseCmds.source === "jules.config.json") {
    return baseCmds;
  }
  if (!modifiedFiles || modifiedFiles.length === 0) return baseCmds;

  // Find affected package names by walking up from modified files to nearest manifest
  const affectedPkgs = new Set();
  for (const file of modifiedFiles) {
    let currentDir = path.resolve(projectRoot, path.dirname(file));
    while (currentDir !== projectRoot && currentDir !== path.dirname(currentDir)) {
      const pkgPath = path.join(currentDir, "package.json");
      const cargoPath = path.join(currentDir, "Cargo.toml");
      
      if (fs.existsSync(pkgPath)) {
        try {
          const pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkgData.name) affectedPkgs.add(pkgData.name);
        } catch (_) {}
        break;
      } else if (fs.existsSync(cargoPath) && currentDir !== projectRoot) {
        const cargoContent = fs.readFileSync(cargoPath, "utf-8");
        const nameMatch = cargoContent.match(/name\s*=\s*["']([^"']+)["']/);
        if (nameMatch) affectedPkgs.add(nameMatch[1]);
        break;
      }
      currentDir = path.dirname(currentDir);
    }
  }

  const SAFE_PKG_NAME = /^[@a-zA-Z0-9._\/-]+$/;
  const targets = Array.from(affectedPkgs).filter((t) => SAFE_PKG_NAME.test(t));
  if (targets.length === 0) return baseCmds;

  // 1. Turborepo (turbo.json)
  if (fs.existsSync(path.join(projectRoot, "turbo.json"))) {
    const filters = targets.map((t) => `--filter=${t}...`).join(" ");
    return {
      buildCmd: `npx turbo run build ${filters}`,
      testCmd: `npx turbo run test ${filters}`,
      source: `Turborepo Workspace (${targets.join(", ")})`,
    };
  }

  // 2. pnpm Workspace (pnpm-workspace.yaml)
  if (fs.existsSync(path.join(projectRoot, "pnpm-workspace.yaml"))) {
    const filters = targets.map((t) => `--filter=...${t}`).join(" ");
    return {
      buildCmd: `pnpm ${filters} run build`,
      testCmd: `pnpm ${filters} run test`,
      source: `pnpm Workspace (${targets.join(", ")})`,
    };
  }

  // 3. Nx Workspace (nx.json)
  if (fs.existsSync(path.join(projectRoot, "nx.json"))) {
    const projects = targets.join(",");
    return {
      buildCmd: `npx nx run-many -t build -p ${projects} --with-deps`,
      testCmd: `npx nx run-many -t test -p ${projects} --with-deps`,
      source: `Nx Workspace (${targets.join(", ")})`,
    };
  }

  // 4. Cargo Workspace (Cargo.toml in root with workspace)
  const rootCargo = path.join(projectRoot, "Cargo.toml");
  if (fs.existsSync(rootCargo) && fs.readFileSync(rootCargo, "utf-8").includes("[workspace]")) {
    const filters = targets.map((t) => `-p ${t}`).join(" ");
    return {
      buildCmd: `cargo build ${filters}`,
      testCmd: `cargo test ${filters}`,
      source: `Cargo Workspace (${targets.join(", ")})`,
    };
  }

  return baseCmds;
}

