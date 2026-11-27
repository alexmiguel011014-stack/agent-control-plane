# Gerente panel and Kaggle ledger

The `gerente-painel` mod adds a read-only panel beside the chat. Source: `dev/mods/gerente-painel/`, tracked in Git.

## What it shows

- QUEUE: open items in `GOALS.md`, split into `owner` and `executable`.
- RUNS: the latest local benchmark runs from `bench/results/local/<runId>/`. Each run id shows its last 8 characters.
- KAGGLE: the Kaggle batch offload events from `runtime/offload/kaggle-ledger.jsonl`.
- RESOURCES: the output of `node src/bin/agentctl.ts watch --once --json`. It shows `RESOURCES unavailable` when that call fails.

The panel refreshes every 10 seconds. It keeps no state between sessions.

## Install

Persistent: set `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. The value is the main checkout path:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "<repository>\\dev\\mods\\gerente-painel"
  }
}
```

Windows separates several paths with `;`. Until GOALS 24 is merged into `main`, load the mod per session instead.

Per session: start Claude Code with `--plugin-dir <repository>\dev\mods\gerente-painel`.

## Commands

- `/painel` opens the panel pane.
- `/fila` answers the open queue as chat text.

Tests and validation, run from the repository:

- `npm run test:mod` runs the Node tests of the pure code in `dev/mods/gerente-painel/spec/`.
- `node %APPDATA%/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs plugin test dev/mods/gerente-painel` runs the hook tests in the engine. The plain `claude` command fails on this PC.
- The same path with `plugin validate` in place of `plugin test` validates the mod.

## Ledger

Only `dev/offload/ledger.mjs` writes the ledger. The file is `runtime/offload/kaggle-ledger.jsonl`, which Git ignores. The assistant runs the script after each Kaggle command.

```
node dev/offload/ledger.mjs <event> <kernel> [options]
```

Events are `push`, `status`, `output` and `delete`. The kernel has the form `<owner>/<slug>`. Options are `--version <n>`, `--status <WORD>`, `--gpu-seconds <n>`, `--note <text>` and `--file <path>`.

Examples, one per event:

```
node dev/offload/ledger.mjs push example-user/agentcp-offload-runner --version 3 --note "kernels push"
node dev/offload/ledger.mjs status example-user/agentcp-offload-runner --version 3 --status COMPLETE
node dev/offload/ledger.mjs output example-user/agentcp-offload-runner --version 3 --gpu-seconds 5400 --note "kernels output"
node dev/offload/ledger.mjs delete example-user/agentcp-offload-runner --note "owner approved"
```

## Limits

- The quota figure is an estimate. It adds `gpuSeconds` of `output` events from the last 7 days and divides by 3600. It compares with 30 h per week, a figure that is unverified. The panel always shows `(estimate)`.
- The panel reads only the repository of the session. It does not read other checkouts or worktrees.
- RESOURCES needs `$.process`. The API marks `$.process` as CLI only. Whether the desktop app offers it is unverified.
- The mod never writes files, calls the network, names the `kaggle` CLI or reads a token.
