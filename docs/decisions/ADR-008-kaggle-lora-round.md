# ADR-008: Kaggle LoRA training round

## Status

Accepted, 2026-11-22 (G23.1 approval).

## Context

Protocol v5 reached 20 to 21 of 30 on G3-30. Fine-tuning the 1.5B never moved G3.

## Decision

- Base weights: Hugging Face `Qwen/Qwen3.5-9B`. It is ungated, Apache-2.0, architecture `Qwen3_5ForConditionalGeneration`, four safetensors shards, and ships `chat_template.jinja` (Hugging Face API, checked 2026-11-22). The vision tower stays frozen.
- Training mode A (first choice): 16-bit LoRA in fp16 across both Kaggle T4 GPUs with `device_map="auto"`, Hugging Face `transformers` 5.x, `peft`, `trl`, `accelerate`. No Unsloth.
- Training mode B (fallback, only after mode A fails the spike): QLoRA nf4 4-bit on one T4 with `bitsandbytes`. ADR-008 records the fallback as a deviation.
- Data: protocol v5 rows from `dev/training/gen-data-integration.mjs` in a new `v5` format. Each example gives two rows: one review row and one edit row. 300 examples, seed 20261122, at least 25 validation examples. The data lives outside the repository under `<work>\agentcp-train\v5-r1`.
- Export: merge the adapter into fp16 weights on the Kaggle CPU, convert with llama.cpp `convert_hf_to_gguf.py` without a vision projector, and quantize to `Q4_K_M` with `llama-quantize`. Build llama.cpp from tag `v1.0.0` (latest release on 2026-11-13, GitHub API checked 2026-11-22) with CMake, CPU only.
- Control model: the base weights go through the same export with no adapter. Names: `agentcp-qwen35-9b-base-q4` (control) and `agentcp-qwen35-9b-ft1-q4` (fine-tuned). The decision compares these two; `qwen3.5:9b` from Ollama (21 of 30 on Kaggle, ADR-007) is reported only.

## Thresholds

- GO rule: the fine-tuned model solves at least 3 more G3-30 tasks than the control, solves at least as many G2 tasks as the control, and is policy clean on all attempts. Otherwise NO_GO.

## Risks

- QLoRA quality on Qwen3.5.
- Chat-template parity.
- Ollama loading a text-only Qwen3.5 GGUF.

## Results

Evaluation ran on Kaggle (kernel `agentcp-offload-runner`, version 3, 2x T4) and was replayed locally through the AppContainer evaluator with review-set hash `7783afce…9ab0`. Every replay printed `offloadMissing` 0. Policy clean was 100% in all four runs.

The first evaluation run (version 1) produced only `offload_runner_error` refusals. Cause: the adapter matches the model name exactly, and Ollama lists a model created without a tag as `<name>:latest`. The fix was to write `:latest` in the `modelTag` of the four bundle manifests. This changes no invocation and no hash.

Ollama loaded both text-only Qwen3.5 GGUF files (`ollama create` and warm-up worked), so the open fact is closed.

| Suite | Model | Solved | Policy clean | Median time (ms) | Replay run |
| --- | --- | --- | --- | --- | --- |
| G3-30 | `qwen3.5:9b` (ADR-007, Kaggle) | 21 of 30 | 30 of 30 | n/a | n/a |
| G3-30 | base GGUF Q4_K_M | 21 of 30 | 30 of 30 | 9586 | `offload-replay-20261126004928` |
| G3-30 | fine-tuned (ft1) | 11 of 30 | 30 of 30 | 9584 | `offload-replay-20261126005443` |
| G2 | base GGUF Q4_K_M | 8 of 10 | 10 of 10 | 9623 | `offload-replay-20261126004519` |
| G2 | fine-tuned (ft1) | 7 of 10 | 10 of 10 | 9655 | `offload-replay-20261126004724` |

G3 tasks solved only by the fine-tuned model: none. G3 tasks solved only by the base model: i01, i03, i05, i12, i13, i14, i18, i19, i23, i27. The fine-tuned run also had 18 FAIL, 1 CRASH and 5 `no_change_proposed` refusals, against 9 FAIL and 2 refusals for the base.

NO_GO: the fine-tuned model solved 10 fewer G3-30 tasks than the control and 1 fewer G2 task, so the GO rule (at least 3 more on G3-30, at least as many on G2) failed on both parts.
