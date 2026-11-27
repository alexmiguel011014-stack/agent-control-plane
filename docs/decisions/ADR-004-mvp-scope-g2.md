# ADR-004: Accept the G2 scope as the MVP; integrations stay rejected

Status: superseded by `docs/decisions/ADR-005-qwen35-9b-passes-g3.md` (2026-11-13): a later model passed G3.2, so the reduced scope is no longer needed.

Date: 2026-11-12. Decided by the owner in chat, after the results below were known. This is a scope decision, not a relaxation of any measured gate.

## Context

G2.7 (ten pure and localized tasks) passed with every local model tried: base 1.5B 5 of 10, 3B 7 of 10, fine-tuned 1.5B 6, 6, 7 and 8 of 10 (policy clean, medians under 20 s). G3.2 (six small integrations) never reached an accepted result: base 1.5B 0, 3B 1, four fine-tune rounds 1, 2 (with a policy violation), 0 and 1 of 6, under protocol v1 to v4. Details and run ids are in `docs/decisions/ADR-002-g3-integration-gate.md` and the G20.6 proof lines of `GOALS.md`.

## Decision

The MVP scope is **the G2 scope**: a local executor that proposes whole-file replacements for small, single-purpose fixes in disposable repositories (the shape of tasks `P01-P04` and `B01-B06`: at most two edited files, 16 KiB per file), always checked by the independent evaluator. `LOCAL_MVP_ACCEPTED` is granted for that scope only, on the strength of G2.7.

- G3.2 stays **failed** (`NOT_ACCEPTED`/`NO_GO` as recorded). Its threshold is not changed and the integration capability is **not** claimed.
- Multi-file integration work is out of scope and marked deferred. A new attempt (a stronger local model within 4 GB, or a different approach) needs a new plan.
- Measurements remain one repetition at temperature 0 on one machine; the G2 result is a measured sample on 10 tasks, not a general success rate.

## Consequences

- GOALS 4 (read-only dashboard) is unblocked under this scope. It must not suggest that integrations are supported.
- `docs/mvp-status.md` states the accepted scope, the rejected capability and what remains deferred.
- G3.4 (manual remote comparison) stays optional and unrun.
- The training pilot ended without changing the integration verdict; the adapters and data stay outside the repository.
