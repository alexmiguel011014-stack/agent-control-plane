# Hardware baseline

**Capture date:** 2026-10-24\
**Evidence:** read-only probes of the current Windows host; generated report path is `runtime/diagnostics/hardware-baseline.json` (ignored by Git).

| Field | Observed value | Source / note |
| --- | --- | --- |
| Windows | Windows 10 Pro, display version 26H2, build 26300.9711 | Windows current-version registry keys |
| CPU | AMD Ryzen 5 3600 6-Core Processor | Windows processor registry key |
| RAM | 24 GB, owner-reported; independent measurement unavailable in this execution context | CIM/WMI and `systeminfo` probes were unavailable |
| GPU | NVIDIA GeForce GTX 1650 SUPER, 4096 MiB | `nvidia-smi` query; driver 610.88 |
| Project volume | D:, 645,796,249,600 bytes free | PowerShell drive probe; private path omitted |
| Node.js / npm | v24.18.0 / 11.16.0 | version commands |
| Git | 2.56.0.windows.3 | version command |
| Ollama | unavailable | executable not found on PATH |

The project concept previously listed a Ryzen 5 5600. The current host probe instead reports a Ryzen 5 3600. This discrepancy remains unresolved; the measured host value is the one to use for future performance experiments unless the owner identifies a different target PC. Do not infer local model speed, fit, or quality from the hardware names alone.

The diagnostic script intentionally records only hardware/runtime fields needed for planning. It does not write usernames, machine names, serial numbers, full paths, environment-variable values, or credentials. Optional operating-system probes are represented as `null` when Windows does not permit them.
