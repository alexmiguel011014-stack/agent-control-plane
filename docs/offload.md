# Offload procedure

## Overview

The model runs in batch on a notebook host. Ollama stays on the host's own loopback. Nothing is exposed. The local AppContainer evaluator judges the answers after replay. Decision record: `docs/decisions/ADR-007-offload-batch-inference.md`.

Training procedure on Kaggle: `docs/training-kaggle.md`.

## Prerequisites

- A Kaggle account with phone verification. Internet access on Kaggle notebooks requires it.
- Python 3.11 or later.
- `pip install kaggle`.
- The Kaggle token in the owner profile. Use `~/.kaggle/access_token` or the `KAGGLE_API_TOKEN` variable. Never store the token in the repository.

The phone-verification requirement is unverified. Confirm it before executing.

Each checkout needs its own G2.2 attestation, because it is bound to the bytes of that checkout. In a new worktree, copy `runtime/diagnostics/hardware-baseline.json` and `windows-junction-check.json` from a checkout on the same host. Then run `npm run isolation:appcontainer:probe`, `npm run isolation:attest -- --approve-report-sha256 <report SHA-256>`, and `npm run benchmark:g0:prepare`. Compare the printed review-set hash with the one you approved.

## Capture

Capture is local. It makes no model call. It needs the owner-approved review-set hash.

```
G20_TASK_IDS=I04 G20_TUNING_FILE=<file> node dev/offload/capture-bundle.ts <reviewSetSha256> qwen3.5:9b g3-local-small-integrations runtime/offload/<name>
```

- The tuning file for the R3 configuration is `{"localize":"helpers","keepAlive":"10m"}`.
- Omit `G20_TASK_IDS` to capture the whole suite.
- The bundle holds `manifest.json`, `invocations.jsonl`, and `code/`.
- `code/` is a copy of `src/` without tests, plus `package.json` and the runner.
- The script never overwrites an existing bundle folder.
- The script refuses paths that look like secrets.
- The capture run writes refusal results (`offload_captured`) under `bench/results/local`. Ignore that run id. Never report it.

## Kaggle run

The owner or the assistant may run these commands. The owner allowed the assistant to run the `kaggle` CLI on 2026-11-19. The assistant runs it only for this offload flow (`datasets create` and `status`, `kernels push`, `status` and `output`). It never reads or prints the token. It never makes anything public. It asks first before any `delete`.

1. Copy `dev/offload/kaggle/dataset-metadata.template.json` into the bundle folder as `dataset-metadata.json`. Replace `<KAGGLE_USER>`.
2. Create an empty folder `<kernelDir>` outside the repository.
3. Copy `dev/offload/kaggle/kernel-metadata.template.json` into `<kernelDir>` as `kernel-metadata.json`. Replace `<KAGGLE_USER>`.
4. Copy `dev/offload/kaggle/offload_runner.py` into `<kernelDir>`.
5. Run the commands in order:

```
kaggle datasets create -p <bundleDir> --dir-mode zip
kaggle kernels push -p <kernelDir>
kaggle kernels status <user>/agentcp-offload-runner
kaggle kernels output <user>/agentcp-offload-runner -p <outDir>
```

- The `--dir-mode zip` flag is unverified. It keeps the `code/` sub-folder. Without it, `kaggle datasets create` may skip sub-folders. Confirm before executing.
- The notebook runs `offload_runner.py`. The runner installs Ollama and Node v24.18.0. It pulls the model, runs `run-bundle.ts`, and writes `results.jsonl` to `/kaggle/working`.
- Poll `kaggle kernels status` until it reports completion.
- The runner warms the model up before it measures anything. Expect about 130 s once: the model loads (about 60 s) and the first prompt compiles GPU kernels. After that, one I04 call took 6.5 s on a Tesla T4 (G22.12). Without the warm-up, the first call passed the 120 s adapter limit.
- `kaggle kernels output` downloads `results.jsonl`, `gpu.txt` and the kernel log. Read the log to find where a failed run stopped.
- `run-bundle.ts` skips keys already present in a results file it finds. This helps when you run it by hand.
- Kaggle GPU quota appears in the account settings. It is reported as about 30 hours per week. Unverified. Confirm in the account settings.
- After each `kaggle` command, the assistant runs `node dev/offload/ledger.mjs <event> <kernel> [options]`. See [docs/panel.md](panel.md#ledger).

## Colab run

Colab is a manual fallback only.

1. Open a notebook with a GPU runtime.
2. Upload the bundle as a zip.
3. Upload `offload_runner.py`.
4. Run `!python offload_runner.py <bundle>` in a cell.
5. Download `results.jsonl`.

Do not start a tunnel, SSH shell, or web UI. The Colab FAQ disallows them on free runtimes: https://research.google.com/colaboratory/faq.html (accessed 2026-11-17).

## Replay

Run the local check without a notebook (G22.11) by running `node runtime/offload/<name>/code/dev/offload/run-bundle.ts runtime/offload/<name> runtime/offload/<name>/results.jsonl` with `ollama serve` running. For the replay of the notebook results, run:

```
node dev/offload/replay-run.ts <reviewSetSha256> <bundleDir> <resultsFile>
```

- The hash argument must equal the manifest `reviewSetSha256`.
- The command prints `runId`, `statusCounts`, `offloadMissing`, and `resultsSha256`.
- Then run `node dev/scripts/g3-report.mjs <runId>`.
- A missing answer counts as a refusal `offload_missing`. It never counts as a pass.

## Cleanup

- Tell the owner to delete the Kaggle dataset after the run.
- Delete the Kaggle kernel after the run.
- Delete `runtime/offload/<name>` when done.
- `runtime/` is ignored by Git.
