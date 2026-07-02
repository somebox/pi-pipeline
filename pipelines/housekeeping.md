---
name: housekeeping
description: Automatically scan a project workspace for TODOs, FIXMEs, untracked clutter, and debug statements, then build a prioritized technical-debt report and prioritized action plan.
inputs:
  - target_dir
---

# housekeeping

**Inputs:** `target_dir` — the directory of the project to run housekeeping on (e.g. `~/src/cards`).

## 1. Inventory debt sources  (util)
Scan the directory `{{target_dir}}` (relative paths). Locate all occurrences of TODO, FIXME, or other debt-related markers in source files (`*.go`, `*.ts`, `*.py`, etc.), and find unstaged or untracked temporary files. Identify what directories or file categories represent distinct "areas" for parallel review. Write `inventory.md` listing the file paths, found TODO comments, and the proposed review areas.

## 2. Review assigned areas  (dev, parallel)
Read `inventory.md`. For your assigned code area or package subset, review the list of TODOs, dead code, and temporary files. Assess if there are undocumented debug print statements left over (such as `fmt.Println`, `console.log`) or any obviously redundant/duplicated helper functions. Write a structured list of findings to `issues-<area>.md`.

## 3. Consolidate technical debt ledger  (research)
Read `inventory.md` and every `issues-*.md` produced in Step 2. Cross-reference similar patterns (e.g. repeated debug logging or half-finished error handling). Write `debt-ledger.md` as a standardized project technical-debt registry.

## 4. Prioritize and propose  (high)
Read `debt-ledger.md`. Prioritize the technical debt items by severity (High/Medium/Low), estimate effort, and render a final action plan to the user showing exactly what decisions to take and how to execute them. Summarize the plan clearly and do not edit any code files.
