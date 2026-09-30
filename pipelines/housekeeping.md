---
name: housekeeping
description: Automatically scan a project workspace for TODOs, FIXMEs, untracked clutter, and debug statements, then build a prioritized technical-debt report and prioritized action plan.
inputs:
  - target_dir
---

# housekeeping

**Inputs:** `target_dir` — the directory of the project to run housekeeping on (e.g. `~/src/cards`).

## 1. Inventory debt sources  (util, output=inventory:json)
Scan the directory `{{target_dir}}`. Locate all occurrences of TODO, FIXME, or other debt-related markers in source files (`*.go`, `*.ts`, `*.py`, etc.), and find unstaged or untracked temporary files. Group the findings into distinct review areas (a directory, package, or file category each; at most 12 areas). Write the `inventory` target as JSON: `{ "target_dir": "<the scanned directory>", "items": [{ "path": "<area-slug>", "title": "...", "files": ["<path relative to target_dir>"], "markers": [{ "file": "...", "line": 0, "text": "..." }], "temp_files": ["..."] }] }`. Each `path` is a short slug (lowercase letters, digits, `-`), not a filesystem path; it names the area's review output. If there is nothing to review, write `{ "target_dir": "...", "items": [] }`.

## 2. Review each area  (dev, iterate=inventory, reads=inventory, output=issues-{unit.path})
Review the area `{unit.path}` from the `inventory` target, under `{{target_dir}}`. Look only at that area's files, markers, and temporary files. Assess the TODOs, dead code, and temporary files, and whether there are undocumented debug print statements left over (such as `fmt.Println`, `console.log`) or obviously redundant/duplicated helper functions. Write a structured list of findings for this area, each with file, line, category, and a one-line description. Do not edit any project files.

## 3. Consolidate technical debt ledger  (research, reads=inventory, issues, output=debt_ledger)
Read the `inventory` target and every file in the `issues` collection produced in step 2. Cross-reference similar patterns (e.g. repeated debug logging or half-finished error handling). Write the `debt_ledger` target as a standardized project technical-debt registry.

## 4. Prioritize and propose  (high, reads=debt_ledger, output=action_plan)
Read the `debt_ledger` target. Prioritize the technical debt items by severity (High/Medium/Low), estimate effort, and write the `action_plan` target: a final action plan showing exactly what decisions to take and how to execute them. Summarize the plan clearly and do not edit any code files.
