# Jules Task Queue Directory

Drop markdown task specification files here (e.g. `TASK-001-feature-name.md`) to queue tasks for background execution by Google Jules.

### File Format Example

```markdown
# TASK-001: Implement User Rate Limiting

## Objective
Implement sliding window rate limiting for public API routes.

## Execution Rules
- Use Redis / memory store for tracking hit counts.
- Must return HTTP 429 Too Many Requests when limit is exceeded.
- Must pass `npm test` before submitting PR.
```

Process all queued tasks in batch:

```bash
npm run jules:queue
# or node scripts/jules-queue-runner.mjs
```

Or dispatch a single queued task using `scripts/jules-dispatch.mjs`:

```bash
node scripts/jules-dispatch.mjs "TASK-001 Rate Limiting" .agent/jules-queue/TASK-001-rate-limiting.md
```
