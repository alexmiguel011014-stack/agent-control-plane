# MVP status (G5.4)

Status as of 2026-11-13: **local MVP accepted (G2.7 and G3.2 passed) with `qwen3.5:9b` under protocol v4 (`docs/decisions/ADR-005-qwen35-9b-passes-g3.md`).** Every claim below points to a report or test; anything unmeasured is marked deferred.

## Measured

| Capability | Evidence | Result |
|---|---|---|
| Independent evaluator and corpus | G0 report, `bench/evaluator/` | 20 of 20 references pass, 20 of 20 null controls fail |
| OS isolation of candidate code | G2.2 probe, `docs/isolation-boundary.md` | 22 of 22 checks on one host; not a general sandbox claim |
| Local model on pure/localized tasks (G2.7) | run `ed263497-…` (tuned 1.5B), `6059a15a-…` (3B: 7 of 10) | PASS, 6 of 10 and 7 of 10 |
| Local model on small integrations (G3.2) | runs `ee13ca8c-…` (tuned 1.5B), `4dfb9e15-…` (3B) | 1 of 6 each; tuned 1.5B has one policy violation: `NO_GO` / `NOT_ACCEPTED` |
| Fine-tune pilot (G20.6), round 1 | `ADR-002` addendum, `GOALS.md` G20.6 | +1 task on G2, G3 1 of 6 |
| Model search: `qwen3.5:9b` (protocol v4, `think:false`) | G3 `1b7e96d0-…` (3 repetitions), `a99e24c3-…`; G2 `0ab9194e-…`; `qwen3.5:4b`: `71f644a5-…`, `03d39726-…` | G3 mean 2.0 of 6 PASS, policy clean; G2 8 of 10 PASS; 4b 0 of 6 and 6 of 10 |
| `qwen3.5:9b` on the 30-task G3 corpus | G3 `b98b34d7-…` | 12 of 30 solved (40 percent), policy clean, median 50.8 s, I02 times out |
| `qwen3.5:9b`, protocol v5 (review then pinned edit), best round R3 | G3 `3633ec51-…` | 20 of 30 solved; rounds R4 19, R5 17; loop stopped; one sample, tuned on the same tasks (ADR-005 addendum) |
| `qwen3.5:9b`, validation at temperature 0.3, v5 against v4 | sample 1 `04485e60-…` and `c9c9cf85-…` | v5 16 of 29, v4 10 of 29; solved in 2 of 3 samples: v5 19, v4 11 (ADR-005 addendum) |
| Protocol v4 (plain-text FILE blocks) and fine-tune round 4 | runs `b1d942d8-…` (G3), `f52d980d-…` (G2); base 3B v4: `42c440be-…`, `b22c12ac-…` | G3 1 of 6, policy clean; G2 8 of 10 PASS; base 3B unchanged by the format |
| Fine-tune pilot (G20.6), round 3 (escaping, unhinted prompts) | runs `6ad8bbed-…` (G3), `c40a0795-…` (G2) | G3 0 of 6, policy clean; G2 7 of 10 PASS |
| Fine-tune pilot (G20.6), round 2 (integration data) | runs `63db0d30-…` (G3), `bca295ea-…` (G2) | G3 2 of 6 (I01, I04) but I03 `POLICY_VIOLATION`: `NO_GO`; G2 6 of 10 PASS |
| Control plane, CLI, policy, audit log | `npm run verify` | deterministic tests green |

## Decision

`LOCAL_MVP_ACCEPTED` is granted. `qwen3.5:9b` (Ollama, partly in system RAM) passes G3.2 under its original rule: mean 2.0 of 6 over three repetitions, policy 100 percent clean, with G2.7 at 8 of 10. The pass is at the threshold (I03 and I04 solved, I02 times out at 120 s, I01, I05 and I06 fail), so it is a marginal result on one machine with a deterministic sample. The earlier fine-tune rounds and the interim G2-scope decision (`ADR-004`, superseded) are kept as history. The terminal view (GOALS 21) replaces the 2D dashboard and is unblocked.

## Not claimed

Savings in currency, secure isolation, provider credit control, general-purpose autonomy, other hosts or Windows builds, or any result with more than one machine and one repetition at temperature 0.

## Deferred

Integration tasks beyond the six measured, a faster or more reliable integration model, G3.4 manual remote comparison, terminal view (GOALS 21, not built), repositories beyond disposable ones.
