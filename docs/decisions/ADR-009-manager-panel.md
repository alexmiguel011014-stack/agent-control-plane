# ADR-009: Manager panel

## Status

Accepted, 2026-11-23 (G24.1 approval).

## Context

The owner wants a terminal that shows the queue and the Kaggle use. Kaggle and Colab are the compute hosts of phase 2.

## Decision

- The mod is named `gerente-painel`. Its source lives in the repository under `dev/mods/gerente-painel/` and is tracked in Git.
- The mod reads files with `$.fs.read`, `$.fs.list`, `$.fs.stat`, and `$.fs.exists` only. It never calls `$.fs.write`, `$.http`, `$.settings`, `$.tool.register`, `$.agent`, or `$.model`.
- The mod never names the `kaggle` CLI and never reads a token. It does not start any Kaggle command.
- The mod makes exactly one process call: `$.process.run(['node', 'src/bin/agentctl.ts', 'watch', '--once', '--json'], { timeoutMs: 15000 })`. If the call rejects or exits non-zero, the panel shows `RESOURCES unavailable`.
- Data sources, all relative to the session working directory, which is the repository: `GOALS.md`; `bench/results/local/<runId>/<task>-attempt-<n>.json`; `runtime/offload/kaggle-ledger.jsonl`.

## Consequences

- The panel needs the ledger script to be run after each Kaggle command.

## Out of scope

- Write actions, buttons that start a run, any Kaggle or Colab control, the phase 2 dispatcher, and sharing the mod on GitHub.
