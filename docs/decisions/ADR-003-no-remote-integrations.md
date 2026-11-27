# ADR-003: No remote provider integration in product control

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

G3.4 allows an optional, manual comparison against an official Codex or Claude client using an allowance the owner already has. The control plane cannot programmatically impose a personal allowance ceiling on such an account, cannot force the provider to delegate internally, and cannot observe the provider cost.

## Decision

During GOALS 3 the product creates **no** Codex SDK, Claude Agent SDK, App Server, MCP, or remote-account adapter, and no code path that reads a remote credential or configuration. Remote comparison stays a manual protocol around two provider-neutral CLI commands: `agentctl comparison export` writes an immutable task package, and `agentctl comparison import` accepts only a patch and a log produced manually, then records their hashes with `provider cost: unobservable_by_control_plane`. Import rejects secrets, a base snapshot id that no longer matches, a missing log, and any patch outside the task allowlist. The evaluator run on the imported patch is a separate, owner-approved step.

`src/architecture-no-remote.test.ts` enforces this statically: production sources contain no remote SDK import, provider host, credential variable, or non-loopback URL.

## Conditions for a future adapter spike

A remote adapter may be proposed only as a separately approved spike that first shows: (1) a programmatic, enforceable spending and allowance ceiling; (2) a way to prevent provider-side delegation or background repetition; (3) credentials held outside the repository and never in prompts or logs; (4) an unchanged tool policy and evaluator, with the model unable to approve its own work; (5) an ADR that supersedes this one.

## Consequences

Comparison data against a stronger model stays manual, small, and labeled. Nothing in the benchmark depends on a provider.
