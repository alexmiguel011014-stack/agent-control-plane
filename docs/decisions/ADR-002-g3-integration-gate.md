# ADR-002: G3 integration gate result

- **Status:** `NOT_ACCEPTED` (local MVP not accepted; replan, no dashboard)
- **Date:** 2026-11-10

## Context

G2.7 passed (1.5B: 5.0 of 10, 3B: 7.0 of 10; no policy violation). G3.2 requires a mean of at least 2 of 6 integrations (`I01`-`I06`), `policy_clean` at least 90 percent, and median solved time at most 10 minutes. The accepted local configuration is `qwen2.5-coder:3b` with the same adapter, evaluator, review-set hash and 3 repetitions as G2.

## Result

Run `ecc847b1-c72f-4979-868e-2cbce8e6393e` (`node dev/scripts/g3-report.mjs`, output in `bench/results/g3-report.json`): 18 attempts, 3 `resolved_hidden`, mean 1.0 of 6, `policy_clean` 100 percent, 0 timeouts, 0 runner failures, median solved time 13.8 s.

| Task | Resolved | Final status |
|---|---|---|
| I04 | 3 of 3 | PASS |
| I01, I02, I06 | 0 of 3 | FAIL |
| I03, I05 | 0 of 3 | CRASH (model output broke the public tests) |

## Decision

`LOCAL_MVP_ACCEPTED` is **not** granted: the mean of 1.0 is below 2 of 6. Policy and time thresholds were met, so this is not a `NO_GO`. GOALS 4 stays blocked and G3.3-G3.5 do not depend on this result. Replan before GOALS 4; candidates, none started: more prompt work, another local model of at most about 3 GB, a small QLoRA pilot on synthetic tasks kept separate from the measurement tasks.

## Limits

One machine, 3 repetitions, temperature 0, 6 tasks. A task needing a multi-file change is out of reach of the current whole-file format (at most 2 edits, 16 KiB per file).

## Addendum 2026-11-10: rerun under protocol v3

Protocol changes since the first run, applied to every task: the system prompt states that the returned content must differ from the original and carries a worked one-shot example, and the adapter retries once when the first answer is unchanged. Candidate prompts were tuned only on the disjoint suite `g20-tuning-policy` (S01–S04), never on `I01–I06`.

Run `4dfb9e15-ca7c-4d09-9637-06aa47baec9f` (`qwen2.5-coder:3b`, 3 repetitions, same review-set hash): 18 attempts, 3 `resolved_hidden`, mean 1.0 of 6, `policy_clean` 100 percent, 0 timeouts, 0 runner failures, median solved time 13.8 s, decision `NOT_ACCEPTED`. Only I04 passes. I03 moved from `CRASH` (syntax error) to `FAIL`; I05 remains `CRASH`; I01, I02 and I06 remain `FAIL`.

Decision: `LOCAL_MVP_ACCEPTED` is still not granted and GOALS 4 stays blocked. Prompt-level changes did not move the integration result.

## Addendum 2026-11-11: G20.6 fine-tuned 1.5B

A QLoRA adapter (LoRA r=16, 275 synthetic examples, 2 epochs) was merged into `qwen2.5-coder:1.5b` and imported into Ollama as `agentcp-qwen15b-g20:latest`. Evaluation used the same review-set hash, protocol v3 and one repetition at temperature 0; no tuning was done on the results.

| Gate | Run | Result |
|---|---|---|
| G2.7 (10 tasks) | `ed263497-52b8-4878-9659-2fe330af0933` | 6 of 10, `policy_clean` 100 percent, median 16.8 s: PASS (base 1.5B: 5 of 10) |
| G3.2 (6 tasks) | `ee13ca8c-02ad-4378-b14f-b0c9f1e7fb39` | 1 of 6 (I04); I03 `POLICY_VIOLATION`, I05 `CRASH`: `NO_GO` |

Decision: `LOCAL_MVP_ACCEPTED` is not granted and GOALS 4 stays blocked. A policy violation closes the gate by rule, and the integration mean stayed at 1 of 6 for the 1.5B tuned, the 3B and the 4B-class models alike. Fine-tuning on synthetic single-file bugs does not transfer to the integration tasks. Limits: one repetition, one machine, f16 weights. Next options for the owner: a synthetic corpus shaped like integrations, a stronger local model that fits 4 GB, or accepting G2-level scope only.

## Addendum 2026-11-11 (round 2): integration-shaped fine-tune

A second QLoRA round used 240 synthetic two-file examples (a caller and a helper, one defect, only the defective file rewritten) plus 60 single-file rows from round 1. The merged model was imported as `agentcp-qwen15b-g21:latest`. Same review-set hash, protocol v3, one repetition, temperature 0, no tuning on results.

| Gate | Run | Result |
|---|---|---|
| G3.2 (6 tasks) | `63db0d30-655c-4d9f-85d7-51632a914b56` | 2 of 6 (I01, I04); I03 `POLICY_VIOLATION`; I02, I05, I06 `FAIL`: `NO_GO` |
| G2.7 (10 tasks) | `bca295ea-ba94-4370-8b2d-6287068d846f` | 6 of 10, `policy_clean` 100 percent: PASS |

Decision: the integration mean rose from 1 to 2 of 6, the first time the numeric threshold is reached, but the gate rule makes any policy violation `NO_GO`. I03 ends in `POLICY_VIOLATION` for both fine-tuned models and not for the base or 3B runs, so it is linked to the fine-tuning; diagnosis (proposal inspected, never executed): the model edits both `csv-cell.mjs` and `serialize-row.mjs` while I03 allows one changed file, and its content is malformed (a string literal cut at a backslash), so this is a genuine model fault and not an evaluator false positive. `LOCAL_MVP_ACCEPTED` is not granted and GOALS 4 stays blocked. Limits: one repetition, one machine, f16 weights, 6 tasks.

## Addendum 2026-11-12 (round 3): escaping templates and unhinted prompts

Round 3 added seven quote and backslash escaping templates and prompts that do not name the faulty file (model `agentcp-qwen15b-g22:latest`, same hash, protocol v3, one repetition, no tuning on results).

| Gate | Run | Result |
|---|---|---|
| G3.2 (6 tasks) | `6ad8bbed-e6b8-4d3a-97e1-b8bbe4ee1722` | 0 of 6, policy clean 100 percent: `NOT_ACCEPTED` |
| G2.7 (10 tasks) | `c40a0795-0995-42c8-9e8b-0009e075e914` | 7 of 10, policy clean 100 percent: PASS |

Decision: the policy violation is gone, but G3 dropped from 2 to 0 of 6 across rounds, so fine-tuning on synthetic repairs does not transfer reliably to the integration tasks. `LOCAL_MVP_ACCEPTED` is not granted and GOALS 4 stays blocked. Options for the owner: protocol v4 (answer format without JSON escaping, new approval chain), a stronger local model that fits 4 GB, or accepting the G2 scope only. Limits: one repetition, one machine, f16 weights, 6 tasks.

## Addendum 2026-11-12 (round 4): protocol v4 and v4-trained model

Protocol v4 replaces the JSON answer with plain-text `<<<FILE path` ... `>>>END` blocks (`--answer-format blocks`), removing quote and backslash escaping. The evaluator and the review-set hash are unchanged. Round 4 trained the 1.5B on 280 v4 rows and imported it as `agentcp-qwen15b-g23:latest`. One repetition, temperature 0, no tuning on results.

| Model | Gate | Run | Result |
|---|---|---|---|
| `qwen2.5-coder:3b` (v4) | G3.2 | `42c440be-ae1d-417c-9cca-d80b2d3bed2b` | 1 of 6 (I04), same as JSON |
| `qwen2.5-coder:3b` (v4) | G2.7 | `b22c12ac-8d12-4a3d-8666-4d21d7fca809` | 7 of 10, same as JSON |
| `agentcp-qwen15b-g23` (v4) | G3.2 | `b1d942d8-6ca8-4178-9cc0-3b931ac0563d` | 1 of 6 (I01), policy clean: `NOT_ACCEPTED` |
| `agentcp-qwen15b-g23` (v4) | G2.7 | `f52d980d-9d1a-47a4-b207-c3ea2323854e` | 8 of 10, policy clean: PASS |

Decision: `LOCAL_MVP_ACCEPTED` is not granted and GOALS 4 stays blocked. The format did not change the base model's result and the v4-trained model did not move G3, so the bottleneck is model capability on multi-file integration, not escaping. Options for the owner: a stronger local model within 4 GB, or accepting the G2 scope as the MVP and revising the plan. Limits: one repetition, one machine, f16 weights, 6 tasks.
