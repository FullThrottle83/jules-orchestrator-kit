# Reply to Rajdeep Sadhu — Smoke Monkey Canvas outreach

**Status:** draft, ready to send. Plain text below the rule; nothing else needs to
accompany it.
**Send to:** rajdeepsadhu125@gmail.com (the address in his mail)
**Note:** the message I received was a template — it ends with "You are
receiving this invitation because you are a maintainer…" and carries an opt-out
header. The reply is written as a real read of his code rather than an answer to
the pitch, which is the only thing that makes it worth his time.

---

Hi Rajdeep,

Thanks for reaching out. I'll be straight with you: outreach like this rarely
gets read past the first paragraph, so I did the thing you actually asked for —
I read the code. Both repos. Below is what I found, including one thing I'd want
fixed before the Canvas gets more deploy buttons pointed at it.

**First, a correction that matters for your pitch.** Your mail describes
jules-orchestrator-kit as a multi-agent protocol spanning Google Jules, Claude
Code, Codex and Gemini CLI. That's the npm description, and it oversells what the
project is now. The provider layer is bound to Jules, and Jules is being retired,
so that half of the kit is on its way out. What survives — and what I'm still
maintaining — is the verification layer: scope, test integrity, secrets, evidence.
Provider-agnostic, zero dependencies, no credentials. If you're telling people
about the kit, that's the honest part.

**What's genuinely good in Harness.** I don't want this to read as flattery, so
three specific things:

- `agent-guards.ts` — the distinction between "no-progress spin" and "doom loop"
  and the separate accounting for *failed verifications since the last successful
  mutation* is the right decomposition. Most harnesses collapse all of it into a
  step counter.
- `isFinalReport()` — requiring a heading or completion phrase at line start, and
  documenting *why* (a model that is still narrating mentions the same words), is
  a better solution than a keyword blocklist. That comment is the kind of thing
  more projects should write.
- The hook failure policy in `agent-hooks.ts` — `before*` fail-closed, `after*`
  fail-open, with the reason stated — is exactly right, and it's the seam I'd
  build on.

**One thing I'd look at before wider adoption.** Your own comment in
`app.server.ts` explains the mobile bind case well: the API has no
authentication, so binding the Wi-Fi interface would expose agent creation to
every other device on the network. That reasoning holds for the container and
deploy paths too, and there the guard doesn't exist. As it reads today:

- the server binds every interface by default (the `--no-open` entrypoint in the
  Docker image included), with `Access-Control-Allow-Origin: *` and no auth
  middleware;
- `GET /api/agents/:id` returns each agent's `agent_mcps` rows, which carry
  `config_json` — and that's where `env` lives (`agent.server.ts` stores
  `{ command, args, url, env }`, and `agent.runner.ts` reads `env` back out of
  it);
- `GET /api/settings/keys` returns masked values, but it accepts any key name,
  including the ones not in your known-key list;
- `POST /api/settings/keys` writes arbitrary settings, `POST /api/settings/upgrade`
  spawns `npm install -g`, and `POST /api/resolve-path` stats arbitrary paths.

Your README leads with Render and DigitalOcean deploy buttons and
`render.yaml`/`fly.toml` both point at port 3333. So a reachable instance can be
reconfigured, have its credentials read, and run an agent with
`permission: 'allow-all'` in whatever workspace directory the caller sets. Your
own `render.yaml` comment says it plainly: "Losing this disk loses agents, chat
history and API keys."

The fix is small and doesn't need a rearchitecture: a bearer token from an env
var when `NODE_ENV=production` (or when the bind address isn't loopback), CORS
restricted to the same origin by default, and credentials stripped out of the
agent REST projection rather than shipped in `config_json`. Optional but cheap:
give `POST /api/settings/keys` the same treatment and warn in the docs that the
deploy buttons should sit behind a proxy with auth.

**What I'd like to contribute.** A TypeScript port of the test-tamper guard from
my kit, wired to your existing seams — not as a new mechanism, but as an
`afterToolCall` hook on `run_test`/`run_command` plus a flag on the run record.
The gap it closes is real: `run_test` instructs the model to fix the *code*, but
nothing in the harness distinguishes a run that made the tests pass from a run
that made the tests stop meaning anything. Seven finding types (skip injection,
vacuous assertion, commented assertion, removal, weakening, expectation rewrite,
deregistration), ~40 dialect spellings including pytest, Go, Rust, JUnit, RSpec
and XCTest, and a `status` field that separates "checked and clean" from
"nothing was checked" — the latter is the failure mode I burned real time on and
would rather not see you rediscover.

Two things I'd want your view on before writing it:

1. Are the guards in `agent-guards.ts` intended as the *only* place run-level
   policy lives, or is a hook the right seam? I don't want to add a second
   opinion that disagrees with yours silently.
2. Would you rather have dependency-free JS that drops in, or TypeScript that
   matches your `ToolContext` and test style? I'd default to the latter.

I'd also suggest a smaller idea you can implement without me: your guards and
`isSensitiveTarget` are activation predicates, and a predicate that silently
stops matching is invisible — every test still passes, the guard just never
fires. A hand-written witness table (path → expected classification, with a
reason per row) plus a canary per check, and a mutant of the predicate that must
kill at least one canary, catches that class. It cost me a real bug to learn; the
write-up is in `scripts/guard-reach-check.mjs` in my repo.

I'll pass on the Canvas for my own workflow — not because it isn't good, but
because I already have the orchestration I need. The verification gap is the part
I care about, and that's the part I'm offering.

Reply with a yes on either question above and I'll open a PR against `main`.

Best,
Jonas
FullThrottle83 · jules-orchestrator-kit

---

## Why the reply is shaped this way

- **The correction goes early.** He opened with a factual claim about the
  recipient's project. Leaving it uncorrected means every point afterwards rests
  on a misreading, and correcting it late reads as an ambush.
- **Specificity is the currency.** `isFinalReport()`, the hook failure policy,
  the mobile-bind comment — a mail that can only be written by someone who read
  the source is the only defence against "another mass-mail reply".
- **The security note is scoped and actionable.** Files and routes, not a lecture;
  the fix is three small changes and reuses a rationale he already wrote down
  himself, which is why it lands as collegial rather than as an audit report.
- **The offer is concrete and bounded.** One module, two questions, a PR. No
  "let's explore synergies".
- **No inward pitch.** The temptation is to answer the template with a reciprocal
  template for jules-orchestrator-kit. That would confirm the exchange was
  transactional all along.
