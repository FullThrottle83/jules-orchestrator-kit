/**
 * Whether a command invocation is asking to be walked through a wizard, or has
 * already said everything the wizard would ask.
 *
 * `agentctl task create --title X --prompt Y` states the whole task and then
 * opened the interactive wizard anyway, which re-asked for the title and the
 * prompt in a terminal and hung a CI job that had no terminal to answer with.
 * Neither `--yes` nor `--non-interactive` was passed, so the CLI concluded
 * "interactive" from the absence of a flag rather than from the presence of the
 * answers.
 *
 * Kept as a pure function, out of the CLI script, because that script executes
 * on import and so cannot be exercised from a test.
 *
 * @param {object} input
 * @param {boolean} [input.interactive] - `--interactive` was passed explicitly
 * @param {boolean} [input.nonInteractive] - `--non-interactive` / `--no-interactive`
 * @param {boolean} [input.yes] - `--yes`
 * @param {boolean} [input.fullySpecified] - every field the wizard would ask for is present
 * @returns {boolean|undefined} true/false to force a mode, undefined to let the
 *   callee decide from whether stdin is a TTY
 */
export function resolveWizardInteractivity(input = {}) {
  // An explicit `--interactive` always wins: the flags may be intended as seeds
  // to edit rather than as a complete invocation.
  if (input.interactive === true) return true;
  if (input.nonInteractive || input.yes || input.fullySpecified) return false;
  return undefined;
}
