---
name: summarize-files
description: The simplest mock iteration pipeline. Walks matching files and summarizes in parallel.
inputs:
  - glob
---

# summarize-files

## 1. Enumerate files  (util, output=scope-files.json)
List every file matching `{{glob}}` (relative paths). Exclude `.git/`, `node_modules/`. Write `scope-files.json` as an array of {"path": "..."}.

## 2. Summarize each file  (dev, iterate=scope-files, output=summary-{unit.path}.md)
For each file in the scope list, read `{unit.path}` and write a 100-word summary to `summary-{unit.path}.md`. Do not read any other file.

## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
Read every `summary-*.md`. Cross-check for patterns. Write `summaries.md`.
