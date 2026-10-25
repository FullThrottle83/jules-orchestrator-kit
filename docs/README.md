# Documentation

For the 0.x preview, start with one repository, one task and one provider.
Dispatch and verification are separate; merge decisions remain with you or CI.

## Start here

- [Quickstart and preview scope](../README.md) — requirements, setup, dispatch,
  verification and coverage limits.
- [Workflow examples](../EXAMPLES.md) — local verification, one task, explicit repair
  and CI setup.
- [Configuration](configuration.md) — credentials, verification, scope and optional features.
- [Jules provider notes](providers/jules.md) — hosted sessions, approval and remote results.
- [Removal](uninstall.md) — undo setup while preserving project-owned files.

## Reference

- [Command reference](COMMAND_REFERENCE.md) — generated CLI help, advanced operations and aliases.
- [Architecture](architecture.md) — pipeline boundaries, lifecycles, evidence and exit codes.
- [SDK and MCP](sdk.md) — programmatic workflow and client integration.
- [Security policy](../SECURITY.md) — threat model, limitations and private reporting.

## Project maintenance

- [Roadmap](../ROADMAP_V1.md) — preview priorities and the proposed v1 contract.
- [Changelog](../CHANGELOG.md) — changes to review before upgrading.
- [Contributing](../CONTRIBUTING.md) and [repository rules](../AGENTS.md) — verification,
  signing and review requirements.
- [Contributors](../CONTRIBUTORS.md) — human and agent attribution.
- [Releasing](releasing.md) — maintainer release procedure.
- [Repository protection](repository-protection.md) — recommended GitHub rulesets,
  required checks, waivers and the release under them.

Earlier [onboarding trials](cold-start-trial.md), [package audits](package-payload.md),
[repository audits](audits/repository-professionalism-audit.md) and
[archived investigations](archive/README.md) describe their stated revisions.
Use current code and reference documentation for present behavior. The
[Google-first workflow proposal](jules-workflow.md) describes an optional operating
model, not default behavior installed by `init`.
