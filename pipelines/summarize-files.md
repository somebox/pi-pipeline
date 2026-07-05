---
name: summarize-files
description: The simplest mock iteration pipeline. Walks matching files and summarizes in parallel.
inputs:
  - glob
---

# summarize-files

## 1. Enumerate files  (util, output=scope:json)
List every file matching `{{glob}}` (relative paths). Exclude `.git/`, `node_modules/`. Write the `scope` target as `{ "items": [{ "path": "..." }] }`.

## 2. Summarize each file  (dev, iterate=scope, output=summary-{unit.path})
For each file in the scope list, read `{unit.path}` and write a 100-word summary. Do not read any other file.

## 3. Merge summaries  (research, reads=summary, output=summaries)
Read the collected `summary` outputs. Cross-check for patterns. Write the `summaries` target.
