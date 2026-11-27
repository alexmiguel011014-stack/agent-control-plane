# ADR-007: Batch inference offload to notebook hosts

## Status

Accepted, 2026-11-17 (G22.1 owner approval).

## Context

The local GPU has 4 GiB, and I02 times out at 120 s.

## Decision

- Mode is **batch offload, not a tunnel**. The notebook runs Ollama on its own loopback `127.0.0.1:11434`. No Ollama port is exposed. `OLLAMA_BASE_URL` in `src/adapters/ollama.ts` stays `http://127.0.0.1:11434`. The AGENTS.md loopback rule does not change.
- Reasons for rejecting a tunnel: the Colab FAQ disallows "remote control such as SSH shells" and "bypassing the notebook UI" on free runtimes, and "connecting to remote proxies" on all runtimes. Cloudflare quick tunnels are public to anyone with the URL and have no authentication by default. Sources: https://research.google.com/colaboratory/faq.html and https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ (both accessed 2026-11-17).
- Flow: (1) a local capture run records each agent invocation (envelope and context files) without a model. (2) The bundle goes to a private Kaggle dataset. (3) A Kaggle notebook runs the unchanged `OllamaAgentAdapter` over the bundle. (4) The owner downloads `results.jsonl`. (5) A local replay run feeds the recorded answers through the normal pipeline, so the AppContainer evaluator, policy, and review-set hash stay local and unchanged.

## Rejected alternatives

- A tunnel: the Colab FAQ disallows "remote control such as SSH shells" and "bypassing the notebook UI" on free runtimes, and "connecting to remote proxies" on all runtimes. Cloudflare quick tunnels are public to anyone with the URL and have no authentication by default.
- OpenCode as executor: OpenCode is not integrated into the product. It is a terminal app with its own shell, edit, and web tools, and the Ollama integration asks for a 64k context. It stays an optional owner-side client (G22.16), outside `src/`.
- Dispatch of real repository items: AGENTS.md allows disposable repositories only and forbids running model-generated code outside the G2.2 gate, so real repository items are never sent or applied. The GOALS dispatcher is a dry-run report only in this goal.

## Update 2026-11-19: the assistant may run the Kaggle CLI

The original plan said the agent never runs the `kaggle` CLI. The owner changed that rule in the chat on 2026-11-19. The assistant may now run the `kaggle` CLI for the offload flow: `datasets create` and `status`, `kernels push`, `status` and `output`. Limits stay in force: the assistant never reads or prints the token, never makes a dataset or kernel public, and asks before any `delete`. This applies to the assistant as operator. It does not give the model adapters or any product code a credential, a network path, or the `kaggle` CLI, and `src/` still holds no remote URL.

## Consequences

Results come only from replay through the local evaluator; a hosted run is never a verdict by itself. Nothing about the loopback rule changes: no port is exposed and no remote URL enters `src/`.

## Results

Run on 2026-11-19, `qwen3.5:9b` (digest `56671c2a…`, Ollama 0.40.16), protocol v5 with the R3 configuration (`localize: helpers`, `keepAlive` 10m, temperature 0), review-set hash `7783afce…9ab0`, 30 tasks of `g3-local-small-integrations`, one sample, on a Kaggle notebook with two Tesla T4 (15 GB each; Ollama used one).

| Measure | Kaggle (replay `offload-replay-20261119202657`) | Local (ADR-005 addendum) |
|---|---|---|
| Solved (`resolved_hidden`) | 21 of 30 | 20 of 30 (R3, run `3633ec51-…`); 19 (R4) |
| Policy clean | 30 of 30 | clean |
| Model time for 30 tasks | 374 s, median 7.2 s per task, longest 46 s | about 26.6 min wall (R4, `keepAlive` 10m); about 50 min without `keepAlive` |
| One-time start-up | 130 s warm-up (60 s model load, then first-run kernel compile), about 80 s install and pull | not applicable |
| Whole notebook | 638 s (10.6 min) | not applicable |

Not solved on Kaggle: I02, I06, I07, I09, I15, I16, I21, I25, I29. Locally the same model failed I09, I14, I15, I20 (localization), I06, I07, I16, I29 (reasoning), I02, and flipped on I03, I21, I25. So Kaggle solved I14 and I20, and failed I21 and I25 (flip tasks). I02 ended in `FAIL`, not a timeout: it fits inside the 120 s limit on a T4.

Reading: the slowness is hardware. The same weights and protocol run about four times faster in total on a T4, and per task about ten times faster once warm. Accuracy did not change beyond noise (21 against 20 of 30, with tasks that flip between runs). The Kaggle run does not give a better model; it gives the same model sooner. One sample, one machine pair, one run each side, and the local figure comes from a different run, so the time ratio is an estimate. The 30 tasks were also used to tune protocol v5, so none of this is a held-out result.
