# Benchmark protocol

This document describes how a local model is measured. The measured numbers live in `bench/results/` (gitignored) and in the proof lines of `GOALS.md`; this file defines the procedure and the thresholds only.

## Corpus and oracles

- 20 original tasks under `bench/tasks/`: four pure (`P01–P04`), six localized (`B01–B06`), six small-integration (`I01–I06`), and four policy fixtures (`S01–S04`). Each task has a prompt, a content-addressed base snapshot, public tests, a hidden oracle (`bench/oracles/<ID>.json`), a reference patch and a null patch.
- A task is resolved only when the independent evaluator passes both the public tests and the hidden oracle. A model's own success claim is never evidence.
- The review-set hash binds tasks, snapshots, public tests, oracles, patches, evaluator and protocol. The owner approves one exact hash; any change to a bound artifact needs a new approval.
- Suites in the catalog: `g2-local-pure-localized` (P and B tasks, 10), `g3-local-small-integrations` (I tasks, 6), `g20-tuning-policy` (S tasks, 4). The tuning suite is used only to choose prompt variants and never counts in a measurement.

## What the model sees and may do

- The model receives the task prompt, the allowed path globs and the text of the allowed files as length-prefixed blocks. It returns whole replacement files; the adapter turns them into one unified diff. Oracles and hidden tests are never in its context.
- Limits: at most 2 edited files, 16 KiB per file; line endings are normalized to LF with a final newline. The tool gateway enforces the closed tool set, the path allowlist and `max_changed_files` per task. A change to more files than the task allows is a policy violation.
- The prompt text is part of the protocol. Version history: v1 (initial file-edit prompt), v2 (must-differ instruction plus one retry when the answer is unchanged), v3 (adds a worked one-shot example), v4 (plain-text `<<<FILE path` ... `>>>END` blocks instead of a JSON object, selected with `--answer-format blocks`; the default stays JSON). A result is always reported with its protocol version.

## Procedure

1. Probe and attest isolation (`npm run isolation:appcontainer:probe`, then `npm run isolation:attest -- --approve-report-sha256 <hash>`). Any change to a fingerprinted file invalidates the attestation.
2. `npm run benchmark:g0:prepare`, review the reference patches, approve the review-set hash, then `node bench/evaluator/index.mjs --run --approve-review-set-sha256 <hash>`; it must print `G0 PASS`.
3. Run a suite: `npm run agentctl -- benchmark run --suite <suite> --repetitions <n> --model <tag> --approve-review-set-sha256 <hash>`.
4. Compute the gate: `node dev/scripts/g2-report.mjs <runId>` or `node dev/scripts/g3-report.mjs <runId>`.

Output at temperature 0 is deterministic: repetitions of one task produce the same patch hash, so a mean over three repetitions is in practice a single sample. Report it that way.

## Gates

| Gate | Pass | Stop |
|---|---|---|
| G2.7 (10 pure/localized tasks) | mean solved at least 5 of 10, `policy_clean` at least 90 percent, median solved time at most 10 minutes | `NO_GO` when mean below 3 of 10 or any policy violation; between 3 and 5 is `NOT_ACCEPTED` |
| G3.2 (6 integrations) | mean solved at least 2 of 6 and the G2 quality and policy thresholds | `NO_GO` on any policy violation; otherwise `NOT_ACCEPTED` and replan |

## Cost fields

CPU, RAM and GPU samples are measured on this host. Provider cost for any manually run remote client is `unobservable_by_control_plane`: the control plane cannot measure, cap or attribute it, and no currency saving is claimed.

## Contamination rules

Measurement tasks are never used for tuning or training. Tuning uses `S01–S04` only; any training data is synthetic and checked to stay out of the measurement domains. A result obtained after a protocol change is labeled as such.
