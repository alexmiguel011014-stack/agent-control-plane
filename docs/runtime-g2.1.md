# G2.1 — manual Ollama smoke

G2.1 is a manual gate. This procedure is intentionally separate from `task.run`:
it checks the local Ollama version and exact model digest, then makes one bounded
inference request without tools, a workspace, task code, tests, or an oracle.

## Owner procedure

1. Install Ollama for Windows manually from its official distribution and start it.
   The CLI does not install, start, or update Ollama.
2. In a terminal, pull the approved model manually:

   ```powershell
   ollama pull qwen2.5-coder:1.5b
   ```

3. From the repository root, check the local runtime and model provenance:

   ```powershell
   npm run agentctl -- runtime diagnose --json
   ```

   Require `status: "ready"`; record `runtimeVersion`, `modelTag`, and
   `modelDigest` from the JSON result.
4. Run the one-time bounded smoke:

   ```powershell
   npm run agentctl -- runtime smoke --model qwen2.5-coder:1.5b --json
   ```

   Require `status: "passed"` and record its runtime version, exact model tag,
   digest, and validated output. The raw model response is not printed.
5. Attach the command outputs and host/date to the G2.1 evidence record. Leave
   G2.1 unchecked if installation, provenance, or the structured smoke fails.

The CLI contacts only `127.0.0.1:11434`, uses no tools, rejects redirects, and
does not download models. A smoke request is blocked while another task holds the
local execution lease. This gate does not open G2.2 and does not enable candidate
patch execution, public tests, hidden oracles, or benchmark runs.

## Execution evidence — 2026-10-27

Host: local Windows workstation. Ollama CLI reported version `0.40.12`; the owner confirmed the installed `qwen2.5-coder:1.5b` model (986 MB).

Diagnostic command:

```text
{"schemaVersion":1,"ok":true,"command":"runtime.diagnose","data":{"status":"ready","runtimeVersion":"0.40.12","modelTag":"qwen2.5-coder:1.5b","modelDigest":"d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668"}}
```

Smoke command:

```text
{"schemaVersion":1,"ok":true,"command":"runtime.smoke","data":{"status":"passed","runtimeVersion":"0.40.12","modelTag":"qwen2.5-coder:1.5b","modelDigest":"d7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668","output":{"schemaVersion":1,"ready":true,"summary":"local-smoke-ok"}}}
```

The runtime diagnosis and smoke used only `127.0.0.1:11434`. The smoke submitted one bounded structured request with no tools and did not execute workspace code, task tests, an evaluator, or an oracle. The raw model response was not printed. The focused adapter test passed (9 tests), and `npm run verify` passed with zero failures before this evidence record was added.
