# Kaggle training procedure

The plan is GOALS 23 and the decision record is `docs/decisions/ADR-008-kaggle-lora-round.md`.

Run the Kaggle CLI from PowerShell with Windows backslash paths, such as `%USERPROFILE%\kaggle-offload\train-run`.

## Data

```
node dev/training/gen-data-integration.mjs <work>/agentcp-train/v5-r1 300 20261122 "" "" v5
node dev/training/check-contamination.mjs <work>/agentcp-train/v5-r1
```

## Spike

```
kaggle datasets create -p %USERPROFILE%\kaggle-offload\train-dataset --dir-mode zip
kaggle kernels push -p %USERPROFILE%\kaggle-offload\train-spike
kaggle kernels status alexsandermiguel/agentcp-train-spike
kaggle kernels output alexsandermiguel/agentcp-train-spike -p %USERPROFILE%\kaggle-offload\train-spike-out
kaggle datasets version -p %USERPROFILE%\kaggle-offload\train-dataset -m "train mode b" --dir-mode zip
kaggle kernels push -p %USERPROFILE%\kaggle-offload\train-spike
```

`kaggle kernels output` writes into `%USERPROFILE%\kaggle-offload\train-spike-out`. `kaggle datasets version` and the second push run only when mode `a` runs out of memory.

## Training and export

```
kaggle datasets version -p %USERPROFILE%\kaggle-offload\train-dataset -m "full run" --dir-mode zip
kaggle kernels push -p %USERPROFILE%\kaggle-offload\train-run
kaggle kernels status alexsandermiguel/agentcp-train-run
kaggle kernels output alexsandermiguel/agentcp-train-run -p %USERPROFILE%\kaggle-offload\train-run-out
```

`kaggle datasets version` targets `agentcp-train-v5`. `kaggle kernels output` writes into `%USERPROFILE%\kaggle-offload\train-run-out`.

## Evaluation

```
kaggle datasets create -p %USERPROFILE%\kaggle-offload\train-bundles --dir-mode zip
kaggle kernels push -p %USERPROFILE%\kaggle-offload\train-eval
kaggle kernels status alexsandermiguel/agentcp-offload-runner
kaggle kernels output alexsandermiguel/agentcp-offload-runner -p %USERPROFILE%\kaggle-offload\train-eval-out
```

`kaggle kernels output` writes into `%USERPROFILE%\kaggle-offload\train-eval-out`.

## Decision

```
node dev/offload/replay-run.ts 7783afcec5a772ba7da043c890e9fbc335a723568f9f8400c8f1848542aa9ab0 <bundleDir> <resultsFile>
node dev/scripts/g3-report.mjs <runId>
node dev/scripts/g2-report.mjs <runId>
```

## Cleanup

```
kaggle kernels delete -y
kaggle datasets delete -y
kaggle datasets list --mine
kaggle kernels list --mine
```

`kaggle kernels delete -y` targets `agentcp-train-spike`, `agentcp-train-run`, and `agentcp-offload-runner`. `kaggle datasets delete -y` targets `agentcp-train-v5` and `agentcp-train-bundles`. Run these only after the owner confirms.
