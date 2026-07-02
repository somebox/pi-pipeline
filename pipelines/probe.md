---
name: probe
description: Minimal bounded probe — read a few named files and summarize. Used to test the maxTools budget against an unbounded run.
inputs:
  - target
---

# probe

**Inputs:** `target` — a file or small set of files to read (path or glob).

## 1. Read & summarize  (util, maxTools=5, reads=AGENTS.md,go.mod)
Read `{{target}}` plus `AGENTS.md` and `go.mod` if present. Produce a tight
100–200 word summary of what the code/docs do. Do not explore the repo beyond
the named files. Write `probe-summary.md`.
