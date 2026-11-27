# ADR-006: Terminal observability view

## Context

The owner cancelled the 2D dashboard (GOALS 4) on 2026-11-13. The reasons were the customization effort and the wish to avoid GPU use next to a 4 GiB model.

## Decision

`agentctl watch` is a read-only terminal view of tasks, benchmark runs, and resources. It replaces the 2D dashboard.

## Consequences

The view adds no dependency and never writes state. It reads event files with a lock-free reader and contacts the GPU only through one `nvidia-smi` child process every 5 seconds.

## Out of scope

Web page, SVG, animation, mouse, keyboard commands, history charts, remote access, and any mutation.
