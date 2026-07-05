---
name: probe
description: Minimal bounded probe — read a few named files and summarize. Used to test the maxTools budget against an unbounded run.
inputs:
  - target
---

# probe

**Inputs:** `target` — a file or small set of files to read (path or glob).

## 1. Read & summarize  (util, maxTools=5, reads=project:AGENTS.md,project:go.mod, output=probe_summary)
Read `{{target}}` plus `AGENTS.md` and `go.mod` if present. Produce a tight
100–200 word summary of what the code/docs do. Do not explore the repo beyond
the named files. Write the `probe_summary` target.
