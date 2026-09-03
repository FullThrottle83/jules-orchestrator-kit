/**
 * Choose what to show the operator from a failed stage's captured streams.
 *
 * stderr is where a failing suite says what it expected; stdout is where
 * several runners (node:test among them) put the whole report — assertion text
 * and stack included.
 *
 * Preferring stderr outright discarded all of that whenever stderr held so much
 * as the spawn wrapper's own "Command failed: npm test", which it always does.
 * The operator was shown a line naming the command they had just typed, and
 * nothing about which test failed or why. A wrapper line is not diagnostic
 * output: when that is all stderr has, stdout is the report.
 *
 * Lives in src/ rather than in the CLI script so it can be imported and tested
 * without executing the CLI, which runs on import.
 *
 * @param {{ stdout?: string, stderr?: string }} failure
 * @returns {string}
 */
export function selectFailureOutput(failure = {}) {
  const rawStderr = (failure.stderr || "").trim();
  const rawStdout = (failure.stdout || "").trim();
  if (!rawStderr) return rawStdout;

  const stderrIsWrapperOnly = rawStderr
    .split("\n")
    .every((line) => line.trim() === "" || /^(command failed|error: command failed|npm err!?)/i.test(line.trim()));

  if (stderrIsWrapperOnly && rawStdout) return rawStdout;
  if (rawStdout && rawStdout !== rawStderr) {
    // Both carry something real, so show both rather than guessing which runner
    // this is. stderr goes last on purpose: the caller keeps only the tail, and
    // when stderr has real content it is nearly always the failure itself —
    // putting the runner's banner after it would spend the cap on noise.
    return `${rawStdout}\n${rawStderr}`;
  }
  return rawStderr;
}
