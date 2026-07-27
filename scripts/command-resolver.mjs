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
    } catch (_) {}
  }

  // 2. Bun (bunfig.toml or bun.lockb)
  if (
    fs.existsSync(path.join(projectRoot, "bunfig.toml")) ||
    fs.existsSync(path.join(projectRoot, "bun.lockb"))
  ) {
    return {
      testCmd: "bun test",
      buildCmd: "bun run build",
      source: "Bun Manifest",
    };
  }

  // 3. Deno (deno.json / deno.jsonc)
  if (
    fs.existsSync(path.join(projectRoot, "deno.json")) ||
    fs.existsSync(path.join(projectRoot, "deno.jsonc"))
  ) {
    return {
      testCmd: "deno test",
      buildCmd: "deno task build",
      source: "Deno Manifest",
    };
  }

  // 4. JavaScript / TypeScript (package.json)
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      const verifyScript = scripts["check:all"]
        ? "npm run check:all"
        : scripts.test
        ? "npm test"
        : "";
      const buildScript = scripts.build ? "npm run build" : "";
      return {
        testCmd: verifyScript,
        buildCmd: buildScript,
        source: "package.json",
      };
    } catch (_) {}
  }

  // 5. Rust (Cargo.toml)
  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    return {
      testCmd: "cargo test --workspace",
      buildCmd: "cargo build",
      source: "Cargo.toml",
    };
  }

  // 6. Go (go.mod)
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) {
    return {
      testCmd: "go test ./...",
      buildCmd: "go build ./...",
      source: "go.mod",
    };
  }

  // 7. Python (pyproject.toml / requirements.txt / setup.py)
  if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(projectRoot, "requirements.txt")) ||
    fs.existsSync(path.join(projectRoot, "setup.py"))
  ) {
    return {
      testCmd: "pytest",
      buildCmd: "",
      source: "Python Manifest",
    };
  }

  // 8. Elixir (mix.exs)
  if (fs.existsSync(path.join(projectRoot, "mix.exs"))) {
    return {
      testCmd: "mix test",
      buildCmd: "mix compile",
      source: "mix.exs",
    };
  }

  // 9. Ruby (Gemfile)
  if (fs.existsSync(path.join(projectRoot, "Gemfile"))) {
    return {
      testCmd: "bundle exec rake test",
      buildCmd: "",
      source: "Gemfile",
    };
  }

  // 10. Swift (Package.swift)
  if (fs.existsSync(path.join(projectRoot, "Package.swift"))) {
    return {
      testCmd: "swift test",
      buildCmd: "swift build",
      source: "Package.swift",
    };
  }

  // 11. Java (Maven pom.xml / Gradle build.gradle)
  if (fs.existsSync(path.join(projectRoot, "pom.xml"))) {
    return {
      testCmd: "mvn test",
      buildCmd: "mvn compile",
      source: "pom.xml",
    };
  }
  if (
    fs.existsSync(path.join(projectRoot, "build.gradle")) ||
    fs.existsSync(path.join(projectRoot, "build.gradle.kts"))
  ) {
    return {
      testCmd: "./gradlew test",
      buildCmd: "./gradlew assemble",
      source: "build.gradle",
    };
  }

  // 12. Makefile
  if (fs.existsSync(path.join(projectRoot, "Makefile"))) {
    return {
      testCmd: "make test",
      buildCmd: "make build",
      source: "Makefile",
    };
  }

  return {
    testCmd: "",
    buildCmd: "",
    source: "generic",
  };
}
