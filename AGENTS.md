# Project instructions

- Follow `GOALS.md` in dependency order. Stop at its benchmark and safety gates; do not advance after a failed gate without a revised plan.
- Use Node.js LTS and TypeScript after the scope ADR confirms the stack. Keep domain types independent of infrastructure.
- Route operator commands through the provisional `agentctl` CLI and application command/query services. The later dashboard is read-only and must use the same read projection.
- Keep policy, workspaces, tools, adapters, and event storage behind application ports. Model adapters cannot approve work, write audit events directly, or choose arbitrary commands.
- Do not add general shell, PowerShell, `cmd`, external network, package installation, deletion, Git push, credential, or secret access to agent tools. Local inference may use loopback only after its goal is reached.
- Use disposable repositories only. Content-addressed local snapshots and allowlists are integrity/workflow controls, not an OS sandbox; do not run hostile code, secrets, personal data, or real sensitive repositories.
- Do not execute any model-generated patch through tests until the manual G2 OS-isolation gate has passed with evidence for filesystem containment, network denial, timeout termination of child processes, and oracle inaccessibility. If the gate is unavailable or fails, stop before the generated-code benchmark.
- Add no provider API key or real credential to source, fixtures, prompts, tests, logs, or `.env.example`. Keep `.env` files, generated output, local runtime state, and benchmark results out of Git.
- Verify behavior through deterministic CLI and application tests. A model's own success claim is never verification; only the independent evaluator may approve task completion.
- Never run a broad process kill such as `taskkill /IM`, `taskkill /F /IM node.exe`, or `Stop-Process -Name`. Stop only a process this task started, by its handle or PID.
- Preserve user files and research artifacts. Never stage, commit, or publish automatically.
