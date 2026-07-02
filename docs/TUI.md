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

Live status + cost, replacing `/pipeline-costs`. This view can be toggled
full-screen (like switching tmux panes) or kept as a condensed `setWidget` status
strip.

### Visual Architecture

#### A. Horizontal Pipeline Representation
At the very top, the dashboard displays a compact horizontal pipeline graph
showing exactly where the compile flow stands across stages, with the active
stage highlighted and standard arrow transitions indicating progress:

```
  Inventory [✓]  ──►  Review [⠋ 2/4 Done]  ──►  Merge [ ]  ──►  Plan [ ]
```

The column widths auto-adjust to the terminal width; completed stages display a
green checkmark, active stages a yellow animation spin, and pending stages stay
grey/dimmed.

#### B. Tree-Like Step List & Indentation
Below the horizontal graph, the active process layout is rendered as an indented,
indented-tree outline (utilizing `├──` and `└──` ANSI characters). This represents
subprocesses, active parallel dispatches, and step states:

```
  [⠋] Step 2: Review assigned areas (iterate=shots, dev) · elapsed: 2m 14s
    ├── dev-1 (internal/core)   · 18 tools · 210k tok · completed ✓ (48s)
    ├── dev-2 (internal/sqlite) · 12 tools · 128k tok · running... (elapsed: 14s)
    ├── dev-3 (internal/httpapi)· 32 tools · 483k tok · running... (elapsed: 1m 2s)
    └── dev-4 (internal/cli)    ·  4 tools ·  35k tok · pending ⠠
```

**State Metrics:**
- **Time Since**: Each active section and slot shows real-time elapsed time (e.g. `elapsed: 14s`) updated every second.
- **Turn Metrics**: Displays current `turnCount`, average time per turn (`durationMs / turnCount`), and model name.

#### C. Live Event Log & Log Tailing
To prevent the user from waiting "in the dark," they can focus any active step
or parallel subagent slot in the tree and press a key (such as `L`) to split-pane
or overlay a live event log.
- **Tailed logs**: Displays the raw, un-truncated stdout/stderr output stream
  of that specific subagent's active background process.
- **Event Log**: A chronologically sorted, updating transaction registry:
  ```
  18:07:12 | minimax-m3 | toolCall: read ~/src/cards/go.mod -> ok (21ms)
  18:07:22 | minimax-m3 | toolCall: find {"path":"/home/user/src/cards"} -> ok (142ms)
  18:07:44 | minimax-m3 | thinking: evaluating logic in sqlite_test.go (1.4s)
  ```

#### D. Subagent Live One-Line Summaries
To let subagents communicate their current active progress back to the TUI
interactively, we use the `progress.md` filesystem channel.
- Each subagent in compilation/fan-out is configured with `progress: true`.
- During execution, the subagent writes a simple one-line markdown summary
  (e.g., `*Refactoring Board columns mismatch, validating sqlite migrations...*`)
  to a designated `{chain_dir}/progress-{index}.md` file on its active turn loop.
- The dashboard watcher tails these small files and displays the **subagent's
  exact live self-reported status** right under its tree node, removing the mystery of
  long thinking turns.

#### E. Retry failed units
For partially-failed iterate steps, the user can select an entry marked `✗`, press
`R`, and the dashboard will automatically:
1. Re-read the `<name>.json` unit list.
2. Filter the units to those whose output file (e.g., `summary-{unit.path}.md`) is
   missing or empty on the filesystem.
3. Re-dispatch *only* those missing units, preserving the progress of the successful
   units and avoiding expensive, multi-model reruns of the entire N.

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
