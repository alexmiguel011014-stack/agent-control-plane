# ADR-005: `qwen3.5:9b` passes G3.2; the local MVP is accepted under the original gate

Date: 2026-11-13. Supersedes the scope decision of `docs/decisions/ADR-004-mvp-scope-g2.md`, which is no longer needed.

## Context

After four fine-tune rounds and protocol v4 the owner first chose to accept only the G2 scope (ADR-004), then asked to look for other local models. A web search of the Ollama library produced four candidates for 4 GB of VRAM and 24 GB of RAM; the two Qwen 3.5 sizes were downloaded and measured (the larger MoE models were not needed).

## Measurements

All runs: review-set hash `c9a82e5e…` (unchanged), protocol v4 (`<<<FILE` blocks), thinking disabled (`think:false`, a flag the adapter already had, passed through `dev/scripts/g20-run.ts`), temperature 0, no tuning on results.

| Model | G3.2 | G2.7 |
|---|---|---|
| `qwen3.5:4b` | 0 of 6 (`71f644a5-d60c-44ad-8005-ecc7d2d08aae`) | 6 of 10 (`03d39726-1602-4a11-a057-9c3e7b1684af`) |
| `qwen3.5:9b` (digest `56671c2a…`, Ollama 0.40.16) | **2 of 6**, policy clean 100 percent, median 40.6 s (`a99e24c3-399c-49ae-a8d7-b95a7e43db06`) | **8 of 10**, policy clean 100 percent, median 31.4 s (`0ab9194e-f5ff-4eb5-86bc-b5de7e3b52b7`) |
| `qwen3.5:9b`, three repetitions of G3.2 | **mean 2.0 of 6**, policy clean 100 percent, median 39.4 s, 3 runner failures (`1b7e96d0-863c-49ad-907a-61761a4eb20d`) | |

I03 and I04 pass in every repetition with identical patch hashes (output is deterministic); I01, I05 and I06 fail; I02 ends in `RUNNER_FAILURE` in all three repetitions of that run (about 120 s, the adapter time limit) after an earlier single run in which it failed normally. The model sits partly in system RAM (peak GPU use about 3.3 GiB).

## Decision

G3.2 passes under its original rule (mean at least 2 of 6, G2 quality and policy thresholds met, no policy violation): `LOCAL_MVP_ACCEPTED` is granted for the model `qwen3.5:9b` with protocol v4. GOALS 4 is unblocked.

## Limits

The pass is exactly at the threshold (2 of 6) with one task that times out; one machine; temperature 0 makes repetitions a single sample; 6 integration tasks. The result is a measured sample, not a success rate. The 9b is slower than the earlier models (tens of seconds per attempt) and needs the thinking flag off. No claim about other hardware, other tasks or other models.

## Addendum: 30-task corpus (2026-11-13)

The G3 corpus was extended to I01-I30 (24 new tasks; review-set hash `7783afce…`, re-approved by the owner). One run of `qwen3.5:9b` (protocol v4, `think:false`, temperature 0, one repetition, run `b98b34d7-979b-4488-b461-091f4953e869`): **12 of 30 solved (40 percent)**, policy clean 30 of 30, median solved time 50.8 s, 1 runner failure (I02, the same 120 s limit), decision `PASS`. Solved: I03, I04, I10, I11, I12, I13, I19, I22, I23, I26, I28, I30. I16 passed the public tests but failed the hidden oracle. The 6-task result (2 of 6, 33 percent) is consistent with this larger sample, so the earlier pass was not a small-sample accident. The new tasks were written by the assistant and their reference patches await human review.

## Addendum: protocol v5 improvement rounds (2026-11-14 to 2026-11-16)

Same 30 tasks, same review-set hash, `qwen3.5:9b`, temperature 0, one sample per round. Protocol v5 adds a review call before the edit call. The review names the faulty file (`DEFECT_FILE`), and the edit call is pinned to that file.

| Round | Change | Solved |
|---|---|---|
| Baseline | protocol v4 | 12 (`b98b34d7-…`) |
| R1 | review call `helpers` | 19 (`54b8a30a-…`) |
| R2 | R1 plus verify call | 19 (`0c5cb233-…`), no gain |
| R3 | R1 plus pinned-file retry | **20** (`3633ec51-…`) |
| R4 | path-only note, keepAlive 10m | 19 (`c5a75f9a-…`), wall time 26.6 min instead of about 50 |
| R5 | three-review ensemble vote | 17 (`045d6f9c-402f-4757-950f-8304b99e34b9`), 4 runner failures (I02, I20, I21, I24) from the longer chain |

R4 and R5 did not beat R3, so the loop stopped under the two-round rule. The best config is R3 plus `keepAlive 10m` (about 19 to 20 of 30). Remaining failures are localization (I09, I14, I15, I20) and reasoning (I06, I07, I16, I29). I03, I21 and I25 flip between runs. A one-task difference is inside the noise at one sample. The tuning used the same 30 tasks, so the gain from 12 to about 20 is not proof of generalization. Repeated samples at temperature 0.3 and a held-out set are still open.

## Addendum: validation at temperature 0.3 (2026-11-16)

Config final (protocol v5, `localize: helpers`, `keepAlive` 10m, pinned retry) against protocol v4, both at temperature 0.3, `qwen3.5:9b`, 29 tasks (I02 skipped, it exceeds the time limit). Sample 1 ran all 29 tasks. Samples 2 and 3 reran only the tasks that failed in sample 1. Tasks that passed in sample 1 were not repeated, so instability among them is not measured.

| | Config final | v4 |
|---|---|---|
| Sample 1 | **16 of 29** (`04485e60-…`) | 10 of 29 (`c9c9cf85-…`) |
| Solved in at least 1 of 3 | 21 | 13 |
| Solved in at least 2 of 3 | 19 | 11 |

Sample 2 and 3 run ids: final `e9a2330b-…` (5 of 13 rerun tasks solved) and `f8aa623a-…` (3 of 13); v4 `dfa62497-…` (3 of 19) and `2488713e-…` (1 of 19). Config final solved I03, I17 and I30 in 2 of 3 samples and I13 and I14 in 1 of 3. Tasks failed in all samples: I06, I07, I16, I20, I21, I24, I25, I29. I21 and I25 passed at temperature 0, so they are sensitive to sampling.

Conclusion: the v5 gain over v4 (about 6 to 8 tasks) is larger than the sampling variation measured here. The ceiling stays near 20 to 21 of 30. Single machine, one model, the same 30 tasks used for tuning. A held-out check is still open.
