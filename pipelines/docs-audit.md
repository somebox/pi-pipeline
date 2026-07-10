---
name: docs-audit
description: Comprehensive documentation housekeeping: discover repo standards, inventory and analyze docs, build a subject index, plan a better structure (rename, merge, split, archive, frontmatter), execute in phases, fix cross-links, and produce a changelog + summary.
inputs:
  - docs_dir
---

# docs-audit

**Inputs:** `docs_dir` — the path to the directory containing documentation files to audit and restructure (e.g. `docs`, `~/src/pi-pipeline/docs`).

The flow is **discover → analyze → index → plan → execute → fix → summarize**. The pipeline takes a single `docs_dir` and ends with a project changelog and a user-facing summary. Recency and archive decisions are informed by the git log of each file under audit; linting and publishing config inform the frontmatter/naming standardization.

## 1. Repo standards, layout & auto-generated detection  (util, output=repo_standards:json)
Scan the repository root and the area around `{{docs_dir}}`. Identify:
- **Standard top-level files** — `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `AUTHORS`, etc. Record their paths and a short content excerpt.
- **Documentation standards already in the repo** — any `docs/STYLE.md`, contributing guide, or in-`README` style notes that document doc conventions.
- **Linting configuration** — `.markdownlint.{json,yaml,yml,cjs,js}`, `.prettierrc*`, prettier/markdown config inside `package.json`, remark/rehype configs. Note which rules are enabled if you can read them; if a linter is *available* but unconfigured (e.g. `markdownlint-cli` in `devDependencies` with no config), record that too.
- **Publishing / build setup** — GitHub Pages (`.github/workflows/*pages*` or `actions/deploy-pages`), `mkdocs.yml`/`mkdocs.yaml`, `docusaurus.config.{js,ts}`, Jekyll (`_config.yml`), Antora (`antora-playbook.yml`), mdBook (`book.toml`), etc. Whether the site is published, and how, constrains what we can move/rename without breaking the build.
- **Auto-generated markdown to exclude from the audit.** Look at the first ~30 lines of each candidate for "auto-generated" / "do not edit" / "this file is generated" markers. Also exclude markdown under `node_modules/`, `dist/`, `build/`, `site/`, `_site/`, `public/`, `vendor/`, `target/`, and any path listed in `.gitignore` that looks like build output. Be conservative: when in doubt, include the file in the audit and let the planning step decide.
- **The current doc layout** — which directories hold docs, which top-level `.md` files exist, and how files are grouped.
- **Recent doc-related git activity** — `git log --oneline -10 -- {{docs_dir}}` and the same for top-level `.md` files. This is a freshness signal for the planning step.

Write the `repo_standards` target as JSON with these fields: `standard_files`, `linting`, `publishing`, `auto_generated_excludes`, `layout`, `recent_git_activity`. The `auto_generated_excludes` list is **authoritative** for what step 2 excludes from the audit.

## 2. Enumerate docs with metadata  (util, reads=repo_standards, output=inventory:json)
Build the audit scope. Walk `{{docs_dir}}` and any top-level `.md` files at the repo root. Exclude everything in `repo_standards.auto_generated_excludes`. For every kept file, capture:
- `path` (relative to repo root)
- `lines`, `bytes`
- `last_modified` (`git log -1 --format=%cI -- <path>`)
- `last_commit_sha` and `last_commit_date`
- `last_commit_msg`
- `first_commit_date` (the file's oldest commit)
- `commit_count` (total commits touching the file)

Write the `inventory` target as `{ "items": [{ "path": "...", "lines": 123, "last_modified": "...", "last_commit_msg": "...", ... }] }`. This list is the iteration handle for step 3. The `last_commit_msg` field is what step 3 reads to make a freshness judgement — a file untouched for two years is more likely stale than one whose last commit said "fix: refresh outdated section."

## 3. Analyze each file  (dev, iterate=inventory, reads=repo_standards, output=analysis-{unit.path})
For each file in the inventory list:
- Read `{unit.path}`. Do not read any other file.
- Write `analysis-{unit.path}.md` containing:
  - **Summary** — 2-3 sentences: what the file is about, who it serves.
  - **Topics** — 3-7 short tags naming the main subjects the file covers. Tags are `lowercase-with-dashes`, used by the subject-index step to cluster files. Examples: `cli`, `packaging`, `testing`, `troubleshooting`, `architecture-overview`.
  - **Purpose** — what problem it solves; the intended reader.
  - **Freshness** — based on `last_modified` / `commit_count` / `last_commit_msg`, judge whether the file is `current`, `aging`, `stale`, or `abandoned`. Cite the `last_commit_msg` that drove the verdict.
  - **Quality** — `high` / `acceptable` / `low`, with a one-line reason.
  - **Size** — `small` / `appropriate` / `oversized` / `trivial`. Files over ~500 lines are `oversized` and candidates to split; under ~30 lines may be `trivial` and candidates to merge.
  - **Formatting** — frontmatter present? H1 title style, heading hierarchy, code blocks, list style. Note any deviations from the project's own style guide (if `repo_standards` lists one).
  - **Naming** — does the file follow `lowercase-with-dashes.md`? Is it a recognized standard file (`README`, `LICENSE`, `CONTRIBUTING`, `CHANGELOG`, `CODE_OF_CONDUCT`, `SECURITY`, `SUPPORT`)? Else: classify as `compliant` / `noncompliant` and suggest a renamed path. e.g. `trials_something_test_alpha.md` → `trials/something-test-alpha.md` (or just `trials/something-test.md` if the project prefers dropping the redundant `_test_`); `TrialSOMETHING.md` → `something.md`.
  - **Issues** — bulleted, with `file:line` references. Note outdated content, broken or fragile links, missing frontmatter, code examples that won't run, etc.
  - **Suggested improvements** — concrete, minimal suggestions; do not propose rewrites. What should an editor do in 10 minutes?

## 4. Build the subject index  (research, reads=analysis, inventory, repo_standards, output=subject_index)
Read every `analysis-*.md` plus the `inventory` and `repo_standards` targets. Produce a `subject_index` target (markdown) that contains:
- **Topic → files map.** For every topic surfaced in step 3, list the files covering it. Group adjacent topics under named clusters (e.g. "Getting started", "Architecture", "Operations", "Contributing"). The clusters are the seed of the new directory structure.
- **Overlaps.** Files covering the same primary topic — candidates to merge. For each, list the source files, the proposed merged target, and which unique content from each source should survive.
- **Gaps.** Sub-topics in the project's domain that no current file covers (e.g. a CLI tool with no `troubleshooting.md`, a library with no `upgrading.md`).
- **Naming & structure issues.** Files whose path or name breaks the project convention; files that live in the wrong directory given what they cover.
- **Frontmatter inventory.** What frontmatter fields are present across the corpus, which are missing, and which are inconsistent (different ordering, different quoting, different key names for the same concept). Recommend a single frontmatter schema (a list of allowed fields, in order, with allowed-value guidance).
- **Archive candidates.** Files that look abandoned, low-value, or replaced by another file. For each, justify the recommendation.
- **Stale-but-keep candidates.** Files that are outdated but still useful; flag for the planning step to mark for a content refresh (not deletion).

## 5. Plan the restructuring  (high, reads=inventory, analysis, subject_index, repo_standards, output=reorg_plan:json)
Read every prior target. Design the reorganization. The plan is a comprehensive reorganization, not just a move/split list:
- **New layout.** The directory structure that better groups files by topic. Use the subject index clusters as the primary grouping; respect the publishing setup (don't break `mkdocs.yml` / `docusaurus.config.*` nav).
- **File actions.** Per file: `move`, `rename`, `merge` (with target), `split` (with target paths), `archive` (with archive path), `keep`, or `delete`. Each action carries `from_path`, `to_path` (where applicable), and a `reason`. Cover everything — every inventory file gets exactly one action.
- **Frontmatter standardization.** The single frontmatter schema to apply, and the values for every affected file. If the publishing setup reads frontmatter (Docusaurus, Antora, mkdocs with `mkdocs-material`), the schema must align with what those tools expect.
- **Naming standardization.** For each noncompliant file, the new path. Standard files (`README`, `LICENSE`, `CONTRIBUTING`, `CHANGELOG`, `CODE_OF_CONDUCT`, `SECURITY`, `SUPPORT`) stay uppercase; everything else is `lowercase-with-dashes`. Subdirectories are topic-grouped, not file-type-grouped (`docs/cli/install.md`, not `docs/markdown/install.md`).
- **Phased execution.** Group the actions into **phases** that are safe to run independently. Within a phase, actions must not depend on each other (different files, no order dependencies). Between phases, later phases may depend on earlier ones (e.g. delete a file only after its content is merged into the new target; rename a file before another file's link is updated to point at the new path). Each action carries a `verify` clause describing how the executor should confirm success (e.g. "Read new file, confirm frontmatter matches the schema, confirm body is non-empty").

Write the `reorg_plan` target as JSON. The schema is constrained to `{ items: [{ path }] }` by the JSON target contract, so the iteration handle is the top-level `items` array — each element is a **phase** with its actions embedded:

```json
{
  "schema_version": 1,
  "phases": [
    { "id": "p1", "name": "Frontmatter & naming", "description": "...", "item_count": 3 }
  ],
  "items": [
    { "path": "p1", "name": "Frontmatter & naming", "description": "...", "items": [
      { "id": "p1-01", "type": "frontmatter", "from": "docs/foo.md", "to": "docs/foo.md", "reason": "...", "verify": "..." },
      { "id": "p1-02", "type": "naming",      "from": "docs/Old.md",  "to": "docs/old.md",  "reason": "...", "verify": "..." }
    ]},
    { "path": "p2", "name": "Moves and merges", "items": [...] }
  ],
  "rendered_md": "# Reorganization plan\n\n## Phase 1: ...\n\n..."
}
```

- `phases` is a summary list (id, name, description, item_count) for the user-facing rendering.
- `items` is the iteration handle. Each element is a phase; the `path` field is the phase id (reused as the collection output key). The phase's actions live in the embedded `items` field.
- `rendered_md` is a human-readable rendering of the same plan (phases, items, reasoning) so the user can skim it; the summary step includes this in the final report.

The plan author (high-tier) is responsible for:
- Putting every inventory file in exactly one action.
- Phases are safe to run independently: in-phase actions touch different files and have no order dependencies.
- Phase `id`s are simple slugs (`p1`, `p2`, …) — they become the output filename.

## 6. Execute the plan  (dev, iterate=reorg_plan, reads=reorg_plan, repo_standards, output=phase_log-{unit.path})
For each phase in the plan:
- Read `reorg_plan.json` (the full plan). Find the phase whose `path` matches `{unit.path}`.
- Process each action in the phase's `items` list **in order**. For each action:
  - Apply the change using the repo's tooling: `git mv` for moves/renames when possible (preserves history), `edit`/`write` for content changes, `rm` for deletes.
  - For `merge`, read the source files, write the merged file at `to`, then archive or delete the sources.
  - For `split`, read the source, write the parts at the listed `to` paths, then archive or delete the source.
  - For `frontmatter`, apply the standardized schema (add missing fields, normalize order, fix quoting).
  - For `naming`, `git mv` to the suggested new path.
- After each action, perform the listed `verify` check (`ls` the new path, `read` the new file's first 20 lines, `git status` to confirm, etc.). Stop and report the issue if a verify fails.
- After all actions in the phase, verify the phase as a whole (`git status`, confirm the changes match the plan).
- Write `phase_log-{unit.path}.md` describing what was done, what was verified, and any issues encountered.

The plan's `phases` field is the authoritative ordering. Phases are dispatched in parallel; within a phase, actions are processed sequentially by the same subagent. The plan author is responsible for ensuring no in-phase conflict (different files, no order dependencies).

## 7. Fix cross-links, frontmatter, titles, references  (research, reads=phase_log, reorg_plan, repo_standards, output=link_status)
Read every `phase_log-*.md` plus the plan and standards. Sweep the entire docs tree and the main `README.md`:
- **Cross-links.** Every relative markdown link to a moved/renamed/deleted file is updated; broken links to removed files are deleted or rewritten to the merged target; external links are left alone.
- **Frontmatter.** Verify every file in the audit scope has the standardized frontmatter. Add missing fields. Normalize field order and quoting.
- **Titles.** Verify the H1 matches the frontmatter `title` (if present), and matches the canonical project name where relevant.
- **References.** Verify `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, etc. are linked from the right places (top-level README, etc.).
- **Main README.** Verify the main `README.md` (in the repo root) reflects the current docs structure, not the old one. The README is the front door; if the docs moved, the README's table of contents and links must move with them.

Apply targeted `edit`s. Write a `link_status` target enumerating what was checked, what was fixed, and any remaining issues the user should know about (e.g. external links that should be updated manually).

## 8. Spot-check, write changelog, summarize  (high, reads=phase_log, link_status, reorg_plan, repo_standards, output=summary)
Read every prior target. Spot-check a handful of files (including the main `README.md` and the most-touched files in the repo) — confirm the work is consistent and complete.

Write the `summary` target (markdown) with two sections:
- **Changelog** — a chronological list of what was done, in plain markdown, suitable to drop into the project's own `CHANGELOG.md` (or as a standalone record if the project has no changelog). One bullet per file action (move, rename, merge, split, archive, delete, frontmatter, naming) with the new path.
- **Summary** — a short, user-facing report: the audit's scope, the main issues found, the actions taken, the new structure, and any open questions for the user. Surface the decisions to take clearly and concretely. Include `reorg_plan.rendered_md` (the human-readable plan) as an appendix so the user can audit what was decided. Do not start implementing.
