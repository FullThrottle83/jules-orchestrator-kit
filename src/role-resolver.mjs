import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves specialist agent role markdown prompt from .agent/prompts/
 * @param {string} [root=process.cwd()]
 * @param {string} [roleName=""]
 * @returns {{ role: string, path: string, content: string } | null}
 */
export function resolveRolePrompt(root = process.cwd(), roleName = "") {
  if (!roleName || typeof roleName !== "string") return null;
  const cleanName = roleName.trim().toLowerCase();
  const promptsDir = join(root, ".agent", "prompts");
  if (!existsSync(promptsDir)) return null;

  try {
    const files = readdirSync(promptsDir);
    const matched = files.find(
      (f) => f.toLowerCase() === `${cleanName}.md` || f.toLowerCase() === cleanName
    );
    if (matched) {
      const fullPath = join(promptsDir, matched);
      return {
        role: matched.replace(/\.md$/i, ""),
        path: fullPath,
        content: readFileSync(fullPath, "utf-8").trim(),
      };
    }
  } catch (_) {}
  return null;
}
