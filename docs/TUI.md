# TUI — List / Overview / Dashboard

> The three user-facing views, replacing the current text commands. For the
> invocation model see [SPEC.md](SPEC.md); for status see [PLAN.md](PLAN.md).

Three views, replacing the current text command + `/pipeline-costs`.

## 1. List view (`/pipeline`)

Browse every available pipeline (built-in TS + recipes). Per entry: name,
description, step count, agents used, source (built-in / user / project /
package). Select one to:
- **Launch** → go to the overview view
- **View steps** → read the full step list + descriptions
- **Edit recipe** → open the `.md` in the external editor (recipes only)
- **Edit profiles** → show the agent→model mapping for this pipeline's
  agents; edit writes to `subagents.agentOverrides` in settings.json
- **Remove** → for installed packages, shell out to `pi remove <source>`
- **Add** → prompt for a source string (git URL, local path, or `npm:name`),
  shell out to `pi install <source>`, prompt `/reload`

## 2. Overview view (pre-run gate)

Before any dispatch, a rich confirmation. **One principle: surface every
automated decision before the first dispatch and let the user veto it** —
recipe selection, per-unit prompt, agent mapping, and structural validation
are all instances of this, not separate features.
- The resolved plan: each step with its agent, task snippet, reads/writes
- The agent→model mapping for every agent this recipe uses (`dev → kimi-k2.7`,
  `high → sonnet-5`, …), with each agent's one-sentence description
- Inputs filled in (or prompted if missing)
- Estimated cost shape (agent counts; real cost once models are known)
- **Structural validation** (fail at preview, not mid-run):
  - any referenced agent that isn't configured
  - any `iterate=<name>` whose `<name>.json` has no producing step
  - any `{unit.field}` referenced in an iterate step that the producing
    step's unit schema doesn't declare (e.g. `{unit.mtime}` but objects have
    no `mtime` field)
- **Coordinator trust:** if the recipe uses a `coordinator` to author a
  `per-unit-prompt.md`, show that prompt here before dispatching — a bad
  coordinator = bad whole run.
- Actions: **Confirm** / **Edit inputs** / **Edit profiles** / **Cancel**

On Confirm, the tool returns the plan to the LLM, which executes it with
`subagent` calls. The dashboard becomes available.

> **API note:** the overview gates inside the `pipeline` tool handler (the
> LLM calls the tool; the tool blocks on user confirmation). Pi supports
> interactive tools (`ctx.ui.confirm`/`select`). A *rich* scrollable TUI via
> `ctx.ui.custom()` inside a tool handler needs verification — if it doesn't
> work cleanly, v1 ships as a `confirm` with a rendered text block, and the
> rich TUI follows once the API is confirmed.

## 3. Dashboard view (during/after run)

Live status + cost, replacing `/pipeline-costs`:
- Per-step status: pending / running / done / failed, with checkmarks on the
  plan outline
- Per active subagent: current tool, path, tokens, turn count (from
  `tool_execution_update`, same data the status line uses today)
- Cumulative cost by model (from the cost tracking we already have), updating
  live
- When idle (no active run): shows the *last* run's summary + total cost
- **Retry failed units:** for a partially-failed iterate step, re-read the
  `<name>.json` unit list, filter to units whose output file
  (`summary-{unit.path}.md`, etc.) doesn't exist, and re-dispatch only those —
  not the whole N. Falls out naturally from the unit→output naming convention;
  cheap to design now, expensive to retrofit after the dashboard's data model
  is fixed. (Per-unit failure handling: proceed + flag at reduce; see PLAN.md.)
- Toggle in/out with `/pipeline` (or a keybinding) — the message stream keeps
  accumulating behind it

> **Coexistence note:** during a run the LLM is emitting tool calls into the
> message stream. The dashboard is a full-screen view you toggle into; the
> stream continues behind. v1 may ship as a `setWidget` strip (always-visible
> one-line status + cost) with the full dashboard as v2, if full-screen
> coexistence proves fiddly.

## `/pipeline-costs` is removed

Its function (cost breakdown by step + model) is subsumed by the dashboard
view. When a run is active or has just finished, `/pipeline` shows the
dashboard; when idle and no last run, it shows the list.
