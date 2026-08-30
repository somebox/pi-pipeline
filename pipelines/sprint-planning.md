---
name: sprint-planning
description: End-to-end sprint. Discovers the repo's planning system, collects and scores candidate work, pauses for plan approval, executes tasks with per-task high reviews and a fix pass, verifies, and pauses for the user's next action.
inputs:
  - focus
---

# sprint-planning

**Inputs:** `focus` — optional focus area for candidate discovery (e.g. "the auth module"). If `{{focus}}` is not substituted, treat the focus as empty (whole project).

Scope cap: the sprint contains **at most 20 tasks**. Everything beyond the cap is routed to follow-ups, never silently dropped. The run pauses at two checkpoints (`sprint-approved`, `next-action`) and takes no tracker mutation, implementation, commit, or closing action without an explicit user decision.

## 1. Discover and select planning system  (util, output=planning_sources:json)
Find the repo's standards and its actual planning system. Check each source and record whether it is available:
- **Local markdown plans/roadmaps** — bounded scan: top-level `*.md` (README, ROADMAP, PLAN, TODO, CHANGELOG) and `docs/`, `plans/` directories only.
- **somebox / cards CLI** — if a `somebox` or `cards` CLI is on PATH, use its read-only query commands to list cards/issues. If absent, record unavailable.
- **GitHub issues** — if `gh` is on PATH and authenticated (`gh auth status`), list open issues for this repo. If absent or unauthenticated, record unavailable.
- **TODO/FIXME/HACK markers** — grep code and docs; filter meta-markers (e.g. in docs about how to write TODOs, in test fixtures, in comments that are example output) as false positives.
- **Recent git commits** — `git log --oneline -30` plus `git log -1 --format=%cI` (repo HEAD date) as the freshness baseline.

For every source report: name, availability, how you checked, its most recent activity, and freshness relative to the repo HEAD date. Note conflicts between sources (e.g. roadmap lists work the issue tracker marks done). Then **select the system of record** — the one most current and most complete — and an explicit **fallback order** for sources used when the primary is unavailable. Justify the selection in 2-4 sentences. Write the `planning_sources` target as JSON: `{ "items": [{ "path": "<source-name>", "available": true|false, "evidence": "...", "last_activity": "...", "freshness": "current|aging|stale", "notes": "..." }], "head_date": "...", "system_of_record": "<source-name>", "fallback_order": ["..."], "selection_rationale": "..." }`.

## 2. Collect and score candidates  (research, reads=planning_sources, output=scored:json)
Read `planning_sources`. Pull candidate work items from the selected system of record, then from the fallback-order sources, plus the filtered TODO/FIXME/HACK markers and anything recent git commits left unfinished. Cap at 40 candidates; prefer the most relevant to the focus: `{{focus}}`. For each candidate record a stable slug, title, source (which system it came from), location (file:line or issue/card id), and whether its priority is **explicit** (stated in the source) or **inferred** (by you — say why).

Score every candidate on: **clarity** (is the task understandable as written), **freshness / not-abandoned** (is it still live work, not stale), **priority** (explicit or inferred — mark inference explicitly), **blockers** (what would prevent starting), **acceptance criteria** (can you state how "done" is verified), and **plannability** (can it become a small, verifiable task this sprint). Give each a 0-5 score per dimension plus a total, and rank them. Write the `scored` target as JSON: `{ "items": [{ "path": "<slug>", "title": "...", "source": "...", "location": "...", "priority": "explicit|inferred", "priority_basis": "...", "clarity": 0, "freshness": 0, "priority_score": 0, "blockers": "...", "acceptance": "...", "plannability": 0, "total": 0, "rank": 1 }] }`.

## 3. Normalize sprint tasks  (high, reads=scored, planning_sources, output=sprint_tasks:json)
Read `scored` and `planning_sources`. Present the candidate sprint to the user as part of this step's output: the top-ranked items (up to 12) as a compact table with title, score, priority (marking inferences), blockers, and acceptance criteria, and the proposed scope cap (at most 20 tasks) with what would overflow to follow-ups. Then normalize the approved candidates into an **exhaustive** list of sprint tasks: at most **20** total. Each task: a stable slug, a title, a self-contained brief (what to do, in the repo's terms), acceptance criteria, and a concrete verification (command or check that proves it). Anything beyond the cap goes to `overflow_items` (same shape). Write the `sprint_tasks` target as JSON: `{ "items": [{ "path": "<slug>", "title": "...", "brief": "...", "acceptance": "...", "verification": "..." }], "overflow_items": [ ...same shape... ], "candidate_table": "<compact markdown table of the presented candidates>" }`.

## 4. Build sprint plan  (high, reads=sprint_tasks, planning_sources, output=sprint_plan, checkpoint=sprint-approved)
Read `sprint_tasks` and `planning_sources`. Write the `sprint_plan` target: a detailed sprint plan — the ordered task list with per-task brief/acceptance/verification, how follow-ups will be filed against the planning system (append/minimal/version-safe), and the expected overflow follow-ups. This is the last step before any implementation. The run pauses after this step until the user approves the plan.

## 5. Execute tasks  (dev, iterate=sprint_tasks, reads=sprint_plan, output=worklog-{unit.path})
Execute this sprint task. Title: {unit.title}. Brief: {unit.brief}. Acceptance: {unit.acceptance}. Verification: {unit.verification}. Follow the sprint plan and the repo's own standards; make the smallest change that satisfies the task. Write the work log to the output path: what you changed (files), the verification you ran with its output, and a `Follow-ups:` section listing anything new you discovered (may be empty).

## 6. Review each task  (high, iterate=sprint_tasks, reads=sprint_plan, worklog, output=review-{unit.path})
Review exactly this one task: {unit.path} ({unit.title}). Read its brief, acceptance criteria, and verification from the `sprint_tasks` target; read its work log in the `worklog` collection; and read the changed files the work log lists (that is the diff). Issue a **one-shot verdict**: `accept` or `kick back`, with 1-3 concrete reasons citing `file:line`. If the verdict is `kick back`, include a one-line **fix brief** describing the smallest change that would flip it to accept. Do not fix anything. Do not review any other task. If no work log exists for this task, verdict is `kick back` with reason "no work log".

## 7. Apply fixes from reviews  (dev, iterate=sprint_tasks, reads=sprint_plan, review, output=fixlog-{unit.path})
Read this task's review for {unit.path} — the file `review-{unit.path}.md` in the `review` collection (if the collection directory is empty or the file is missing, the review set was empty; write a one-line fix log noting "no review" and stop). If the verdict is `accept`, write a one-line fix log noting "no fix needed" and stop. If the verdict is `kick back`, apply the review's fix brief: make the smallest change that resolves the stated reasons, verify it the way the sprint plan's verification says, and write the fix log to the output path: what changed, the review reasons addressed, verification output, and any new follow-ups.

## 8. Verify and update docs  (util, reads=sprint_plan, worklog, fixlog, output=verification)
Run the project's own tests and checks (check `package.json` / `pyproject.toml` / `Makefile` once; use what's there). If a collection directory listed above does not exist, that set was empty. Fix only trivial breakage your verification reveals (a typo, a missing import); anything larger goes to your output. Update documentation to the repo's own standards where the sprint work changed behavior. Write the `verification` target: the commands you ran, their results (pass/fail with key output), any doc updates made, and remaining issues.

## 9. File new follow-ups  (util, reads=verification, worklog, fixlog, sprint_tasks, planning_sources, output=followup_update)
Collect every newly discovered follow-up: the `Follow-ups:` sections of all work logs and fix logs, plus `overflow_items` from the `sprint_tasks` target. Add each to the **selected planning system** (per `planning_sources`; never a system the user did not confirm) **without duplicates** — check existing entries first and skip anything already tracked. Use append/minimal/version-safe edits; do not reformat. Write the `followup_update` target: each follow-up, where it was filed (or why skipped as duplicate), and the edit used.

## 10. Final review and completion summary  (high, reads=verification, followup_update, sprint_plan, output=completion, checkpoint=next-action)
Read `verification`, `followup_update`, and `sprint_plan`. Perform the final aggregate review: was every sprint task verified, are the tests green, is the documentation consistent, are all follow-ups filed? Write the `completion` target with a one-line verdict (`accept` or `kick back`) plus up to 3 specific points, a concise completion summary (what was done, verification result, follow-ups filed), and the options mapped to how to answer this checkpoint:
- **commit** — approve with `checkpointNote` = "commit" (optionally a commit message).
- **close/update tracker items** — approve with a `checkpointNote` naming exactly which items.
- **revise work** — answer `revise` with the steering as the note; a fresh run starts.
- **exit** — approve with `checkpointNote` = "exit"; nothing further is done.
Do not edit anything. The run pauses after this step; no commit or closing happens without the explicit note.

## 11. Perform approved next action  (util, reads=completion, planning_sources, output=next_action)
Read `completion` and the USER CHECKPOINT FEEDBACK above (the user's approved note). Perform **only** the explicitly approved action:
- Note says commit → stage the sprint's changes and create the commit (use the note as the message if it reads like one).
- Note names tracker items to close/update → update exactly those items in the selected planning system.
- Note is "exit" or empty, or names no action → do **nothing** mutating: do not commit, do not close or update any tracker item.
Then write the `next_action` target: the action performed (or "none — no explicit instruction"), its evidence, and closing instructions — either "sprint complete, exit" or the exact invocation to start a fresh sprint-planning run. Never commit or close work without explicit instruction.
