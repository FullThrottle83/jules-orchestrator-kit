import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { gate } from "./engine.mjs";
import { scanDiff, shannonEntropy } from "./security.mjs";
import { getQueueDir } from "./state.mjs";
import { scanCodebaseForTodos } from "../scripts/jules-scan-todos.mjs";
import { select, input, confirm, spinner, isTTY } from "./tui.mjs";

export const GUARDRAIL_FOOTER = `
---
HARD CONSTRAINTS:
- Do NOT modify package.json, pnpm-lock.yaml, tsconfig.json, or .github/ files.
- Diff Payload Governor: Keep total diff payload under 75 KB (\`git diff | wc -c\`).
- Falsifiable & Evidence-Based: Attach full terminal verification output to PR. Never weaken assertions or delete failing tests to force a pass.
- Read-Before-Write: Inspect existing symbol signatures, definitions, and call sites before making edits.
- BEFORE opening the PR: Run \`git fetch origin main && git rebase origin/main\`, then re-verify.
`;

const TRIVIAL_ORACLES = new Set(["true", "echo", ":", "false", "exit 0", "exit 1", "echo ok"]);

/**
 * Pure planning core for task creation & envelope synthesis.
 * @param {string} root
 * @param {object} inputObj
 * @returns {{
 *   ok: boolean,
 *   taskId: string,
 *   title: string,
 *   prompt: string,
 *   fullPrompt: string,
 *   verifyCmd: string,
 *   flags: { autoPr: boolean, requirePlanApproval: boolean, repoless: boolean, startingBranch: string },
 *   secretFindings: Array<any>,
 *   taskFileContent: string
 * }}
 */
export function planTaskCreate(root = process.cwd(), inputObj = {}) {
  const config = loadConfig(root);

  const title = inputObj.title || "Agent Task";
  const rawPrompt = inputObj.prompt || "";
  const verifyCmd = (inputObj.verifyCmd || config.verify.test || config.verify.build || "").trim();

  // 1. Falsifiability check
  if (!rawPrompt.trim()) {
    throw new Error("Task prompt cannot be empty.");
  }
  const cleanCmd = verifyCmd.toLowerCase().replace(/['"]/g, "").trim();
  if ((!verifyCmd || TRIVIAL_ORACLES.has(cleanCmd)) && !inputObj.allowUnverifiable) {
    throw new Error(
      "Unfalsifiable Task Rejected: Task must include a non-trivial verification test/build command. Configure verify.test in .agent/config.yml or pass --verify-cmd."
    );
  }

  // 2. Secret Scrubbing Preflight (multiline diff formatting)
  const secretFindings = [];
  const multilineDiff = rawPrompt.split("\n").map((line) => `+${line}`).join("\n");
  const secretScan = scanDiff(multilineDiff);
  if (!secretScan.ok) {
    secretScan.findings.forEach((f) => secretFindings.push({ id: f.type || f.id || "SECRET_LEAK", ...f }));
  }
  if (shannonEntropy(rawPrompt) > 4.5 && !inputObj.allowHighEntropy) {
    secretFindings.push({ id: "HIGH_ENTROPY_PROMPT", line: 1 });
  }

  // High-confidence secrets cannot be bypassed
  const highConfidenceFindings = secretFindings.filter((f) => f.id !== "HIGH_ENTROPY_PROMPT");
  if (highConfidenceFindings.length > 0) {
    throw new Error(
      `Pre-Dispatch Secret Leak Blocked: Prompt contains ${highConfidenceFindings.length} high-confidence secret finding(s). High-confidence credentials cannot be bypassed.`
    );
  }
  if (secretFindings.length > 0 && !inputObj.allowSecrets) {
    throw new Error(
      `Pre-Dispatch Secret Leak Blocked: Prompt contains potential secrets or credentials (${secretFindings.length} finding(s)). Scrub keys before dispatching.`
    );
  }

  // 3. Jules v1alpha Flags
  const flags = {
    autoPr: Boolean(inputObj.autoPr),
    requirePlanApproval: Boolean(inputObj.requirePlanApproval),
    repoless: Boolean(inputObj.repoless),
    startingBranch: inputObj.startingBranch || config.baseBranch || "main",
  };

  // 4. Task ID Sanitization (Path Traversal Guard)
  const rawId = inputObj.id || `TASK-${Date.now().toString(36).toUpperCase()}`;
  const taskId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, "_");

  // 5. Prompt Envelope & Guardrail Footer Synthesis
  const fullPrompt = `[TASK INSTRUCTIONS]
${rawPrompt}

[VERIFICATION ORACLE]
Test/Verification Command: ${verifyCmd || "(None)"}

${GUARDRAIL_FOOTER}`;

  const envelopeMetadata = {
    version: 1,
    id: taskId,
    title,
    flags,
    verifyCmd,
  };

  const taskFileContent = `<!-- JULES_TASK_ENVELOPE: ${JSON.stringify(envelopeMetadata)} -->
# ${title}
# Task ID: ${taskId}
# Auto-PR: ${flags.autoPr} | Plan Approval: ${flags.requirePlanApproval} | Repoless: ${flags.repoless}

${fullPrompt}
`;

  return {
    ok: true,
    taskId,
    title,
    prompt: rawPrompt,
    fullPrompt,
    verifyCmd,
    flags,
    secretFindings,
    taskFileContent,
  };
}

/**
 * Run interactive or headless task creation wizard.
 * @param {string} [root=process.cwd()]
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, taskFile: string, plan: object }>}
 */
export async function runTaskCreateWizard(root = process.cwd(), options = {}) {
  const interactive = options.interactive !== false && isTTY(options.stdin || process.stdin);

  let title = options.title;
  let promptText = options.prompt;
  let verifyCmd = options.verifyCmd;
  let autoPr = options.autoPr;
  let requirePlanApproval = options.requirePlanApproval;
  let repoless = options.repoless;

  if (interactive) {
    const sp = spinner("Analyzing codebase task candidates & gate policy", options);
    const todos = scanCodebaseForTodos(root);
    await new Promise((resolve) => setTimeout(resolve, 200));
    sp.stop(`Scanned ${todos.length} TODO/FIXME candidates`);

    if (todos.length > 0 && !promptText) {
      const useTodo = await confirm("Import prompt from scanned TODO candidate?", false, options);
      if (useTodo) {
        const selectedTodo = await select(
          todos.slice(0, 10).map((t) => ({
            label: `[${t.type}] ${t.text} (${t.file}:${t.line})`,
            value: t,
          })),
          "Select TODO Candidate",
          options
        );
        title = `Fix ${selectedTodo.type}: ${selectedTodo.text.slice(0, 40)}`;
        promptText = `Resolve ${selectedTodo.type} in ${selectedTodo.file} at line ${selectedTodo.line}: ${selectedTodo.text}`;
      }
    }

    title = await input("Task Title", {
      defaultValue: title || "Refactor Component Module",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    promptText = await input("Detailed Task Instructions", {
      defaultValue: promptText || "Cleanly refactor module to improve readability and maintain full test coverage.",
      stdin: options.stdin,
      stdout: options.stdout,
    });

    autoPr = await confirm("Enable Automatic PR Creation (automationMode: AUTO_CREATE_PR)?", true, options);
    requirePlanApproval = await confirm("Require Plan Approval Gate before execution?", false, options);
    repoless = await confirm("Dispatch in Repoless mode (no repo source context)?", false, options);
  }

  const plan = planTaskCreate(root, {
    title,
    prompt: promptText,
    verifyCmd,
    autoPr,
    requirePlanApproval,
    repoless,
    ...options,
  });

  // Perform Gate Preflight
  const gateRes = await gate({ root, mode: "working-tree" });
  if (!gateRes.ok && (gateRes.code === 3 || gateRes.code === 6) && !options.allowGateFailure) {
    // Filter out uncommitted .agent/ config scope warnings if user initialized locally
    const realViolations = gateRes.phases[0]?.violations?.filter((v) => !v.file.startsWith(".agent/")) || [];
    if (realViolations.length > 0 || gateRes.code === 6) {
      throw new Error(`Gate Preflight Rejected Task: Repository contains scope or secret violations (Exit ${gateRes.code}).`);
    }
  }

  // Write Task File to canonical queue directory (getQueueDir)
  const queueDir = getQueueDir(root);
  if (!existsSync(queueDir)) {
    mkdirSync(queueDir, { recursive: true });
  }

  const taskFile = resolve(queueDir, `${plan.taskId}.md`);
  if (!taskFile.startsWith(resolve(queueDir))) {
    throw new Error("Task ID path traversal blocked.");
  }

  writeFileSync(taskFile, plan.taskFileContent, "utf-8");

  return {
    ok: true,
    taskFile,
    plan,
  };
}
