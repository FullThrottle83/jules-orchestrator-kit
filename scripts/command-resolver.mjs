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
    const content = fs.readFileSync(yamlConfigPath, "utf-8");
    const testMatch = content.match(/test_cmd:\s*["']?([^"'\n]+)["']?/);
    const buildMatch = content.match(/build_cmd:\s*["']?([^"'\n]+)["']?/);
    if (testMatch || buildMatch) {
      return {
        testCmd: testMatch ? testMatch[1].trim() : "",
        buildCmd: buildMatch ? buildMatch[1].trim() : "",
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

  // 2. JavaScript / TypeScript (package.json)
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

  // 3. Rust (Cargo.toml)
  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    return {
      testCmd: "cargo test --workspace",
      buildCmd: "cargo build",
      source: "Cargo.toml",
    };
  }

  // 4. Go (go.mod)
  if (fs.existsSync(path.join(projectRoot, "go.mod"))) {
    return {
      testCmd: "go test ./...",
      buildCmd: "go build ./...",
      source: "go.mod",
    };
  }

  // 5. Python (pyproject.toml / requirements.txt / setup.py)
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

  // 6. Java (Maven pom.xml / Gradle build.gradle)
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

  // 7. Makefile
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
