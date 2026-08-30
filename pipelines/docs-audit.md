---
name: docs-audit
description: Review and improve documentation organization, naming, and key documents with user steering before cleanup and a focused reviewer pass.
inputs:
  - docs_dir
---

# docs-audit

**Inputs:** `docs_dir` — the path to the documentation area to audit (for example `docs` or `~/src/project/docs`). Top-level standard files such as `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, and `SECURITY.md` are included when relevant.

## Documentation contract

Apply this contract to every recommendation, edit, and review:

- Write factual, concise, plain-language documentation. Be casual rather than formal. Do not be wordy, boastful, or exaggerated.
- Use realistic, relevant code samples when possible. Do not invent APIs or claim that an example was tested when it was not.
- Use terms consistently across prose, class names, commands, fields, and filenames. Prefer the project's established terms when they are clear.
- Put a local `README.md` in folders with substantial local knowledge. Use `docs/` for global project overviews and cross-cutting guidance.
- The main README should explain what the project is for, show useful examples, guide setup and usage, then cover details, contributing, and license.
- Treat MIT as the default license and public open source status unless the repository explicitly states otherwise. Never change legal terms silently.
- Give credit and references when the project gained code or inspiration from another project.
- Preserve useful history. Archive or delete only when the user's steering permits it and the replacement or reason is clear.

## 1. Discover standards and ask for steering  (high, output=steering:json, checkpoint=docs-steering)
Inspect the repository root and `{{docs_dir}}` enough to understand the existing documentation layout, standard files, publishing/build setup, linting rules, generated-file markers, and obvious conflicts between important documents. Do not edit anything.

Before any inventory, cleanup, move, archive, or rewrite, present a short **steering brief** for the user. Ask explicitly:
- How aggressive should cleanup be: **conservative** (fix links/names, preserve questionable docs), **balanced** (archive clear stale/replaced material), or **aggressive** (merge, split, and archive more freely)?
- Which naming style should be preferred when the repository does not already decide: lowercase-with-dashes, topic folders with local READMEs, or another stated convention?
- Which conflicting document or source should be treated as authoritative? List each real conflict and the specific decision needed.
- Should archives stay in the repository, and if so, where?

Give sensible defaults when the repository has no preference: balanced cleanup, lowercase-with-dashes for non-standard filenames, topic folders with local READMEs where local context is substantial, and archives retained under `docs/archive/`. State that a non-empty `checkpointNote` can answer or override these defaults. Write `steering` as JSON: `{ "standard_files": [...], "layout": "...", "publishing": "...", "linting": "...", "generated_excludes": [...], "conflicts": [{ "documents": ["..."], "decision_needed": "..." }], "questions": ["..."], "defaults": { "cleanup": "balanced", "naming": "lowercase-with-dashes", "archive": "docs/archive/" } }`. The run pauses here; do not begin the audit until the user approves and provides steering.

## 2. Inventory documentation  (util, reads=steering, output=inventory:json)
Read `steering` and build the audit scope. Include `{{docs_dir}}` and relevant top-level standard files. Exclude generated/build/vendor content listed by `steering`, but be conservative when a file is ambiguous. For each file record:
- `path` relative to the repository root
- `lines` and `bytes`
- `last_modified`, `last_commit_sha`, `last_commit_date`, `last_commit_msg`
- `first_commit_date` and `commit_count`
- `is_standard_file` and `is_local_readme`

Write `inventory` as `{ "items": [{ "path": "...", "lines": 123, "bytes": 456, "last_modified": "...", "last_commit_msg": "...", "is_standard_file": true|false, "is_local_readme": true|false }] }`. This list is the iteration handle for step 3.

## 3. Analyze each document  (research, iterate=inventory, reads=steering, output=analysis-{unit.path})
For each `{unit.path}`:
- Read only that document and the steering target. Do not explore unrelated files.
- Write `analysis-{unit.path}.md` with concise sections: **Purpose and audience**, **topics**, **freshness**, **quality**, **size**, **naming/location**, **links/examples/frontmatter issues**, and **10-minute improvements**.
- Cite concrete `file:line` references for problems. Distinguish facts from suggestions.
- Check the documentation contract, especially factual tone, consistent terminology, realistic examples, README placement, and whether the document is global or local knowledge.
- Classify each file as `keep`, `refresh`, `move`, `merge`, `split`, `archive`, or `delete-candidate`, but do not make the change.

## 4. Draft the reorganization plan  (high, reads=inventory, analysis, steering, output=reorg_plan:json, checkpoint=docs-plan-approved)
Read the inventory, every analysis, and the user's steering. Produce a practical plan with no unnecessary rewrite work. Include:

- A short current-state summary and the proposed layout.
- A `key_documents` list identifying the main README, setup/usage docs, architecture or reference documents, contributing/legal files, and any documents central to the conflicts.
- Exactly one action for every inventory file: `keep`, `edit`, `move`, `rename`, `merge`, `split`, `archive`, or `delete`. Every action has `from`, optional `to`, a factual reason, and a binary verification.
- Naming decisions and terminology changes, using the user's steering and existing project conventions.
- README changes: purpose, examples, setup, usage, details, contributing, and license in that order where applicable.
- Link, frontmatter, code-example, credit/reference, and license checks.
- Archive/delete safeguards. Do not remove material merely because it is old; identify the replacement or preservation reason.
- 2–5 independently executable phases. Keep actions that touch the same files in different phases; move/merge before link repair.

Write JSON as `{ "items": [{ "path": "phase-1", "name": "...", "description": "...", "actions": [{ "id": "...", "type": "...", "from": "...", "to": "...", "reason": "...", "verify": "..." }] }], "key_documents": ["..."], "layout": "...", "terminology": ["..."], "open_decisions": ["..."], "rendered_md": "..." }`. The `items` array is the phase iteration handle. The run pauses here for plan approval; no files are changed before approval.

## 5. Execute approved reorganization phases  (dev, iterate=reorg_plan, reads=reorg_plan, steering, output=phase-log-{unit.path})
For this phase `{unit.path}`, read its embedded `actions` from `reorg_plan`. Apply only the approved actions and the documentation contract:
- Use `git mv` for moves and renames where possible.
- For merges and splits, preserve accurate content and references; do not pad documents with prose.
- Apply targeted edits only. Do not reformat unrelated files.
- Preserve or create local READMEs only where the plan identifies substantial local knowledge.
- Respect the steering for cleanup and archives. Never silently change legal terms or delete credited material.
- Verify each action immediately using its `verify` instruction. Stop and report if verification fails.

Write `phase-log-{unit.path}.md` with changed files, actions completed, verification results, and `Follow-ups:`. If the phase has no actions, record that it was intentionally empty.

## 6. Review organization and key documents  (high, reads=reorg_plan, phase-log, steering, output=review:json)
Perform a focused review after the approved phases. Inspect the resulting documentation structure, the main `README.md`, every document in `key_documents`, and the most-touched files listed in the phase logs. Do not review unrelated implementation code.

Check:
- The layout separates global overview from local folder knowledge.
- The main README explains purpose, examples, setup, usage, details, contributing, and license appropriately.
- Key documents are concise, factual, plain-language, non-boastful, and consistent in terminology.
- Code samples are realistic and clearly marked if unverified.
- Links, filenames, headings, frontmatter, credits, references, and legal statements are correct.
- The changes follow the user's cleanup, naming, conflict, and archive steering.

Write `review` as `{ "items": [{ "path": "fix-slug", "title": "...", "brief": "smallest concrete fix", "severity": "blocker|major|minor", "verification": "..." }] }`. Include only actionable fixes. An empty list is valid. Do not fix anything in this step.

## 7. Apply review fixes  (dev, iterate=review, reads=reorg_plan, phase-log, steering, output=review-log-{unit.path})
Apply exactly this review item: `{unit.path}`. Make the smallest change that addresses its brief. Do not expand the scope or perform unrelated cleanup. Verify it as specified, and write a short log with the changed files, verification result, and any `Follow-ups:`. If the review list is empty, this step completes without dispatch.

## 8. Verify links, README, references, and final consistency  (research, reads=reorg_plan, phase-log, review-log, steering, output=verification)
Run the repository's available documentation checks once, if configured. Otherwise perform targeted checks:
- Find broken relative Markdown links and update links after moves/renames.
- Check headings, filenames, frontmatter, and terminology for consistency.
- Check the main README against the required purpose → examples → setup → usage → details → contributing → license structure.
- Check local README placement for folders with substantial local knowledge.
- Check code samples for obvious invented commands or APIs; do not claim execution without evidence.
- Check credits and references for borrowed code or inspiration.
- Check license language and preserve the repository's explicit legal decisions. If no license is stated, report that; do not silently add one.

Fix only small, mechanical issues directly. Report larger issues instead. Write `verification` with commands/checks, results, files changed, remaining issues, and follow-ups.

## 9. Final review and summary  (high, reads=verification, review-log, reorg_plan, steering, output=summary)
Perform a final factual review of the completed work. Confirm that every planned action was either completed or clearly reported, key documents were reviewed, the main README is useful, links are repaired, terminology is consistent, and no archive/delete decision exceeded the user's steering.

Write a concise `summary` with:
- **Result** — what changed and the final layout.
- **Checks** — commands and key results.
- **Reviewer findings** — fixed items and remaining issues.
- **Open decisions** — anything that still needs the user.
- **Changelog** — one plain-language bullet per meaningful file action, suitable for the project's changelog.
- **Plan appendix** — include `reorg_plan.rendered_md` so the user can audit the decisions.

Do not make further structural changes in this step.
