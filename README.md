# Agent Control Plane

A Windows-local control plane that tests one question honestly: **can a small local model finish small coding tasks, with every claim checked by an evaluator the model cannot influence?**

Nothing here trusts a model's own success claim. A task counts as done only when an independent evaluator, running in an OS-isolated process, says so against hidden tests.

## What is in the repository

- **`agentctl`**, a terminal CLI over application services (`src/`). It runs benchmarks and offers `agentctl watch`, a read-only live view of the queue, runs and resources.
- **An independent evaluator and benchmark** (`bench/`). It has 20 reference tasks and null controls, content-addressed snapshots, and an AppContainer launcher that denies network access and kills child processes on timeout.
- **A policy layer** (`src/policy/`, `src/tools/`). Model adapters cannot approve work, write audit events, or choose arbitrary commands. Agents get no shell, no network, no package installer, no deletion, and no Git push.
- **Batch offload to free notebooks** (`dev/offload/`, `docs/offload.md`). The model runs on a Kaggle GPU on the notebook's own loopback, and the results are replayed through the local evaluator.
- **One LoRA training round on Kaggle** (`dev/training/`, `docs/training-kaggle.md`), with its negative result kept in the open.
- **A read-only manager panel mod** for the Claude desktop app (`dev/mods/gerente-painel/`, `docs/panel.md`).

## Results so far

All numbers come from one machine (Ryzen 5 3600, GTX 1650 Super with 4 GB VRAM) unless noted, with the hashes and run ids in the linked records. Read them as small samples, not as a leaderboard.

| Question | Result | Record |
| --- | --- | --- |
| Does `qwen3.5:9b` pass the small-integrations gate (G3)? | Marginally, with a deterministic sample | [ADR-005](docs/decisions/ADR-005-qwen35-9b-passes-g3.md), [MVP status](docs/mvp-status.md) |
| `qwen3.5:9b` on the 30-task G3 corpus, protocol v5 | 20 of 30 solved locally, 21 of 30 on a Kaggle T4, policy 100 percent clean | [ADR-007](docs/decisions/ADR-007-offload-batch-inference.md) |
| Does a LoRA fine-tune of that model help? | **No.** 11 of 30 against 21 of 30 for the base model on G3-30, and 7 of 10 against 8 of 10 on G2 | [ADR-008](docs/decisions/ADR-008-kaggle-lora-round.md) |

The fine-tune failed its pre-registered GO rule, and the repository says so.

## Limits you should know

- **Windows only.** The isolation layer uses AppContainer. The evaluator tests need Windows 11.
- **Not a general sandbox.** The isolation was probed on one host (22 of 22 checks). Do not run hostile code, secrets, personal data, or real sensitive repositories. Use disposable repositories only. See [the isolation boundary](docs/isolation-boundary.md) and [the threat model](docs/threat-model.md).
- **Small and single-machine.** There is one repetition at temperature 0 for most claims. The terminal view replaced the planned dashboard.
- **Planning documents are public on purpose.** [`GOALS.md`](GOALS.md) is the working plan, and `dev/goals-archive/` holds the finished plans. They are long and written for the author. Start with the ADRs in `docs/decisions/`.

## Getting started

You need Node.js 24 and Windows 11.

```powershell
npm ci
npm run typecheck
npm run lint
npm test
```

`npm run verify` also runs the benchmark contract tests, including the isolation suites. Running the benchmark against a model needs a local [Ollama](https://ollama.com) on loopback, a hardware baseline, and an isolation attestation. [`docs/operations.md`](docs/operations.md) lists the everyday commands, and the attestation steps are in [`docs/offload.md`](docs/offload.md).

```powershell
node src/bin/agentctl.ts watch --once --json
```

## Documentation

- [`docs/operations.md`](docs/operations.md): how to run things
- [`docs/benchmark-protocol.md`](docs/benchmark-protocol.md): how tasks are scored
- [`docs/offload.md`](docs/offload.md) and [`docs/training-kaggle.md`](docs/training-kaggle.md): the Kaggle flows
- [`docs/decisions/`](docs/decisions/): nine architecture decision records, with the results
- [`reports/`](reports/) and [`research_notes/`](research_notes/): background research, in Portuguese

## License

MIT. See [LICENSE](LICENSE).
