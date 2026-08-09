/**
 * PR Review Auto-Remediation Engine for jules-orchestrator-kit (v0.27.0).
 * Parses GitHub PR review comments, filters conversational praise/noise,
 * and synthesizes actionable OODA repair task envelopes.
 */

export function parseReviewComments(input) {
  let comments = typeof input === "string" ? (() => { try { return JSON.parse(input); } catch { return []; } })() : input;
  comments = Array.isArray(comments) ? comments : comments?.comments || comments?.reviews || [comments];

  const actionable = [];
  let idx = 0;
  for (const c of comments) {
    if (!c || typeof c !== "object") continue;

    const state = String(c.state || c.status || "").toUpperCase();
    if (state === "APPROVED" || state === "DISMISSED" || c.isResolved === true || c.resolved === true) continue;

    const body = String(c.body || c.comment || "").trim();
    if (body.length < 5) continue;

    const praiseRegex = /^(?:lgtm|looks good(?: to me)?|nice|awesome|thanks|thank you|great work|approved|ship it)[\s.!]*$/i;
    if (praiseRegex.test(body)) continue;

    idx++;
    const path = c.path || c.file || null;
    const line = c.line || c.original_line || null;
    const author = c.user?.login || c.author || "reviewer";

    actionable.push({
      id: String(c.id || `review-${idx}`),
      path,
      line: line ? Number(line) : null,
      author,
      body,
      actionable: true,
      prompt: `Fix PR review comment by @${author} on ${path || "code"}${line ? ` line ${line}` : ""}:\n\n"${body}"\n\nEnsure all unit tests and safety gates pass cleanly after applying fix.`,
    });
  }

  return actionable;
}

export function createReviewRepairTask(comment, baseBranch = "main") {
  return {
    id: `repair-${comment.id}`,
    title: `PR Review Repair: ${comment.path || "code"} (${comment.id})`,
    prompt: comment.prompt || `Fix review feedback: ${comment.body}`,
    baseBranch,
    targetFiles: comment.path ? [comment.path] : [],
    metadata: { source: "pr-review", commentId: comment.id, author: comment.author, line: comment.line },
  };
}
