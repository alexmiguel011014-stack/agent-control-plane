# Residual isolation boundary (after G2.2)

This is documentation of limits, not a second isolation spike and not an approval gate. It separates what the G2.2 evidence verified from what is untested. Nothing here upgrades the product to "sandboxed".

## Verified on this host (G2.2 probe, full run)

Host: Windows build 10.0.26300 (the baseline file labels it Windows 10 Pro 26H2), AMD Ryzen 5 3600, user session, NTFS. The probe report was PASS with 22 of 22 checks, in scope `dedicated-isolation-probe-only`:

- Filesystem: read and write inside the staged workspace works; read and create are denied against synthetic canaries in the diagnostics folder, the repository root, a child of `bench/oracles`, and the user's local app-data root.
- Network: one TCP connection attempt from the worker to a host-controlled loopback listener was denied.
- Process tree: a synthetic child and grandchild were terminated by the Job Object; the worker token is an AppContainer token and the worker is a member of the job. The job carries a 1 GiB memory limit and the AppContainer holds no network capability (count 0).
- Oracle inaccessibility: the worker never opens a registered oracle, fixture, patch or public test; canaries stood in for them.
- Cleanup: the temporary profile and run tree were removed and verified, and the launcher keeps the profile when cleanup is uncertain.

After that gate, the real evaluator ran: `G0 PASS` (20 of 20 references pass, 20 of 20 null controls fail) and the model runs of G2, G3 and G20 produced no leftover profile or temporary folder.

## Not verified or assumed

- **One host and one Windows build.** No claim for other Windows versions, editions, policies or antivirus products. A Windows update can change AppContainer behavior; the attestation does not detect that.
- **Probe coverage is finite.** Only the listed filesystem locations, one TCP target and one process-tree shape were tested. Other network protocols (UDP, named pipes, DNS), other drives, registry access, clipboard, window messages, GPU access, and inter-process channels were not probed.
- **Shared kernel.** An AppContainer is not a virtual machine; a kernel or driver flaw is out of scope.
- **Same-user races.** Path checks cannot remove concurrent filesystem races by another process of the same user. The model cannot create one inside the container, but a hostile local process could.
- **Attestation freshness.** It binds the bytes of the evaluator, isolation and protocol files at one moment; it does not prove later behavior, and it does not cover files outside that list (for example the Ollama adapter).
- **Timeout and resource limits.** Termination and the 1 GiB job memory limit are in the probe contract; the memory limit was not stress-tested, and no CPU or disk ceiling is enforced. CPU, RAM and GPU use are only measured per attempt.
- **Readable system files.** The AppContainer shares the Windows kernel and can read immutable system resources that Node needs; the probe does not claim a closed filesystem namespace.
- **Input bounds.** The launcher bounds JSON input at 65,536 bytes and worker output at 1,048,576 bytes; larger traffic is refused, not isolated.
- **Model runtime.** Ollama runs outside the AppContainer as the same user and is reached only on loopback; the isolation covers candidate code, not the model server.
- **Hostile code and secrets.** The product is unsuitable for hostile repositories, real secrets or personal data, and says so in `AGENTS.md`.

## How claims should be worded

- "Candidate code ran in a Windows AppContainer with a Job Object on this host; the probe checks listed above passed." Correct.
- "The system is sandboxed", "secure", "safe against malicious code". Not supported.
