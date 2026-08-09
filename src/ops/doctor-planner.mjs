import { join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

/**
 * @typedef {import("../ux/capabilities.mjs").ActionPlan} ActionPlan
 * @typedef {import("./doctor-registry.mjs").DoctorReport} DoctorReport
 *
 * @typedef {Object} FixPlanningContext
 * @property {string} root
 * @property {DoctorReport} report
 * @property {string[]} selectedFixIds
 * @property {Record<string, unknown>} [answers]
 */

/**
 * Generate unified diff preview string for file creation/replacement.
 * @param {string} path
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {string}
 */
function createDiffPreview(path, oldContent, newContent) {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];
  const lines = [];

  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -1,${oldLines.length || 0} +1,${newLines.length || 0} @@`);

  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return lines.join("\n");
}

/**
 * Plan diagnostic fixes into immutable ActionPlan objects.
 * @param {FixPlanningContext} context
 * @returns {Promise<ActionPlan[]>}
 */
export async function planDiagnosticFixes(context) {
  const root = resolve(context.root || process.cwd());
  const report = context.report;
  const selectedFixIds = context.selectedFixIds || ["safe"];

  const wantSafeOnly = selectedFixIds.includes("safe");
  /** @type {ActionPlan[]} */
  const plans = [];

  for (const result of report.results || []) {
    for (const fix of result.fixes || []) {
      const isSelected = selectedFixIds.includes(fix.id) || (wantSafeOnly && fix.automatic);
      if (!isSelected) continue;

      if (fix.id === "config.create-default") {
        const configPath = ".agent/config.yml";
        const newContent = `# jules-orchestrator-kit configuration manifest
version: 1
tier: pro
verification:
  testCmd: "npm test"
  buildCmd: "npm run build"
`;
        const diff = createDiffPreview(configPath, "", newContent);
        const planId = `PLAN-${Date.now()}-${randomUUID().slice(0, 8)}`;

        plans.push({
          schema: "agentctl/action-plan-v1",
          id: planId,
          kind: "config.create-default",
          title: "Create default .agent/config.yml",
          summary: "Generate initial configuration manifest for jules-orchestrator-kit",
          risk: "low",
          repository: root,
          createdAt: new Date().toISOString(),
          preconditions: [],
          fileMutations: [
            {
              operation: "create",
              path: configPath,
              newContent,
            },
          ],
          commandEffects: [],
          stateTransitions: [],
          preview: {
            unifiedDiff: diff,
            warnings: [],
            estimatedImpact: ["Creates .agent/config.yml"],
          },
          confirmation: {
            mode: "none",
            prompt: "Apply default configuration?",
          },
          planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
        });
      } else if (fix.id === "state.rebuild-head") {
        const headPath = ".agent/state/telemetry/.head";
        const newContent = "sha256:0000000000000000000000000000000000000000000000000000000000000000\n";
        const planId = `PLAN-${Date.now()}-${randomUUID().slice(0, 8)}`;

        plans.push({
          schema: "agentctl/action-plan-v1",
          id: planId,
          kind: "state.rebuild-head",
          title: "Rebuild telemetry spine head pointer",
          summary: "Re-initialize .head pointer for telemetry spine ledger",
          risk: "low",
          repository: root,
          createdAt: new Date().toISOString(),
          preconditions: [],
          fileMutations: [
            {
              operation: "create",
              path: headPath,
              newContent,
            },
          ],
          commandEffects: [],
          stateTransitions: [],
          preview: {
            unifiedDiff: createDiffPreview(headPath, "", newContent),
            warnings: [],
            estimatedImpact: ["Creates .agent/state/telemetry/.head pointer"],
          },
          confirmation: {
            mode: "none",
            prompt: "Rebuild telemetry head pointer?",
          },
          planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
        });
      } else if (fix.id === "locks.prune-stale") {
        const locksDir = join(root, ".agent", "state", "locks");
        if (existsSync(locksDir)) {
          const lockFiles = readdirSync(locksDir).filter((f) => f.endsWith(".lock"));
          for (const lockFile of lockFiles) {
            const lockRelPath = `.agent/state/locks/${lockFile}`;
            const planId = `PLAN-${Date.now()}-${randomUUID().slice(0, 8)}`;

            plans.push({
              schema: "agentctl/action-plan-v1",
              id: planId,
              kind: "locks.prune-stale",
              title: `Remove stale lock ${lockFile}`,
              summary: `Prune inactive VFS lock file ${lockRelPath}`,
              risk: "low",
              repository: root,
              createdAt: new Date().toISOString(),
              preconditions: [],
              fileMutations: [
                {
                  operation: "delete",
                  path: lockRelPath,
                },
              ],
              commandEffects: [],
              stateTransitions: [],
              preview: {
                unifiedDiff: `--- a/${lockRelPath}\n+++ /dev/null\n`,
                warnings: [],
                estimatedImpact: [`Removes ${lockRelPath}`],
              },
              confirmation: {
                mode: "none",
                prompt: `Remove lock ${lockFile}?`,
              },
              planHash: "sha256:" + createHash("sha256").update(planId).digest("hex"),
            });
          }
        }
      }
    }
  }

  return plans;
}
