---
name: docs-audit
description: Comprehensive documentation housekeeping: inventory files, plan a better structure, split/merge bulky docs, localize Readmes, prune outdated pages, fix cross-links, and commit.
inputs:
  - docs_dir
---

# docs-audit

**Inputs:** `docs_dir` — the path to the directory containing documentation files to audit and restructure (e.g. `docs`, `~/src/pi-pipeline/docs`).

## 1. Inventory & linkage check  (util, output=inventory:json)
Scan the directory `{{docs_dir}}` (and any top-level `.md` files at repo root). Identify all documentation files, check their file lengths (lines/bytes), and inspect them for internal and external links. Categorize which files are candidate topics, which look outdated or duplicated, and write the `inventory` target as `{ "items": [{ "path": "...", "lines": 123 }] }`.

## 2. Propose restructuring plan  (high, reads=inventory, output=reorg_plan)
Read the `inventory` target. Propose an optimized layout for `{{docs_dir}}`:
- Group related documents into topical subdirectories.
- Identify bulky pages that should be split into smaller, focused files.
- Locate documents that should be localized as `README.md` files next to the source code (e.g. `src/` subdirectories).
- Designate outdated or retired pages for deletion.
- Propose a multi-phase execution order. Write the `reorg_plan` target.

## 3. Restructure and resize  (dev, iterate=inventory, reads=reorg_plan, output=log-{unit.path})
Read the `reorg_plan` target. For the documentation file `{unit.path}`, execute the planned restructuring in `project:`:
- Split the file if it exceeds proportional bounds (e.g. >500 lines).
- Trim any redundant sentences ("fat") or outdated references.
- Correct any labels, section numbering, or head title formats.
- Rename, move, or merge into localized `README.md` files as specified in the plan.
- Write a short change log for that unit to the `log` collection target.

## 4. Fix and verify cross-links  (research, reads=reorg_plan,log, output=link_status)
Read the `reorg_plan` and `log` targets. Scan all re-arranged and newly written markdown files. Detect broken links caused by file movements, splits, or renames. Apply targeted edits to update all cross-links so they are 100% accurate, functional, and relative. Write the `link_status` target logging what was verified and patched.

## 5. Spot-check, commit, and summarize  (high, reads=reorg_plan, link_status)
Read the `reorg_plan` and `link_status` targets. Conduct a quick, rigorous spot-check of the directories in `project:`. Commit the changes cleanly (run `git add` and `git commit` with a concise summary), update any project changelogs, and provide a clear, readable summary of what was retired, split, localized, and fixed for the user.
