---
name: verify-source
description: Scan docs, verify every quote/citation against its original source.
inputs:
  - target
---

# verify-source

**Inputs:** `target` — the docs to scan (path or glob).

## 1. Inventory citations  (util)
Scan `{{target}}`. List every quote and citation with its location and the
source it claims. Write `citations.md`.

## 2. Fetch & verify  (dev, parallel)
Read `citations.md`. For your assigned batch, find the original source
carefully and confirm the quote is exact and the citation is correct. Mark
each verified / mismatched / unfindable. Write `verify-<batch>.md`.

## 3. Flag mismatches  (research)
Read every `verify-*.md`. List mismatches and unfindable sources with
severity. Write `issues.md`.

## 4. Report  (high)
Summarize `issues.md` for the user: what's verified, what's broken, what
needs a human to track down.
