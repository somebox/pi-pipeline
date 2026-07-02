# Pipeline Recipes — Design Spec

> Status: **draft** — design doc, partially implemented (recipes, profiles,
> RunMetrics, audit). This revision captures the v1.0 identity: **iteration
> over iterable things with focused per-unit subagents and
> coordinator-authored prompts.** Worked examples: `code-quality`,
> `verify-source`, and the iteration examples below.

## Goal

pi-pipeline is for **building pipelines that iterate over iterable things —
files, projects, bugs, images, ideas — with one focused subagent per unit,
small context by construction, and prompts authored by a coordinator agent,
not the parent LLM.**

The whole loop (define → discover → preview → run → watch → share) needs no
TypeScript: a pipeline is a markdown recipe. The runtime enforces small
per-unit context *by structure* — bounded agents that can't explore — rather
than by asking the model to self-limit.

This supersedes the earlier "recipe as a fixed checklist with parallel
fan-out" framing. Checklists are still supported, but iteration is the
first-class model and the answer to the context-bloat problem that broke
the original `code-quality` run (a single `util` subagent read 24 files,
accumulated 188k tokens, then 400'd on a model-limit mismatch — see
**Why iteration** below).

## Design principles

1. **Prose first.** A pipeline is a numbered checklist with agent
   annotations. The user's hand-written `code-quality` (below) is the source
   of truth — if the format can't express that, the format is wrong.
2. **A profile is just an agent.** No separate "cost class" concept. The
   package ships a roster of agents (`dev`, `util`, `research`, `high`, and
   `coordinator`); recipes name agents; the user binds each agent to a real
   model via the existing `subagents.agentOverrides`. The agent's
   `description:` frontmatter *is* the one-sentence profile description.
3. **Same runtime types.** A loaded recipe produces the existing `Plan` /
   `PlanStep` types, so `renderPlan`, `summarizeCost`, live progress, cost
   tracking, and `/pipeline-audit` work unchanged.
4. **Recipes are opinionated processes.** A named recipe is a complete
   process — it has no `mode`/`effort`. The recipe provides the shape; the
   task string provides the specifics. (The unnamed generic path still
   infers mode/effort for "I don't have a specific recipe" cases.)
5. **Context isolation by construction.** Per-unit subagents get one unit +
   a slim shared onboarding + the coordinator's prompt — and a bounded tool
   set (`tools: read, write`) so they *can't* explore. Small context is
   enforced, not requested. (See **Execution model** and **Why iteration**.)
6. **The coordinator authors the per-unit prompt.** The parent LLM doesn't
   write per-unit tasks (it paraphrases and drops instructions — observed in
   the first `code-quality` run). A `coordinator` agent produces the iterable
   + a prompt *template* as its deliverable; the orchestrator substitutes
   `{{unit}}` and dispatches. The template is the contract.
7. **Preview before you spend.** A rich overview TUI gates every run: the
   resolved plan, the agent→model mapping, the estimated cost. Confirm, edit
   inputs, or cancel.
8. **Watch it run.** A dashboard TUI shows live status and cost during a run,
   replacing `/pipeline-costs`.

## Non-goals (for the first cut)

- **No conditional logic in recipes.** A recipe is a fixed sequence with
  optional iteration. Loops/branching *with conditions* stay TS (e.g.
  `implementation/deep`'s kick-back loop). Iteration is a fixed fan-out over
  an enumerated set, not a `while`. We can revisit declarative conditionals
  later.
- **No step composition/includes.** Recipes are flat. No reusing another
  recipe's steps. (Decision: Q3 = no.)
- **No replacement of TS built-ins that need logic.** Recipes and TS
  pipelines coexist; the generic inference path and `implementation/deep`
  stay TS.

## Why iteration (the motivation)

The original `code-quality` step 1 said "identify what code/docs/tests are in
scope... assemble the documentation and selected best practices." The `util`
subagent interpreted this as an invitation to explore: 14–24 `ls`/`read`/
`find` calls, 95k–188k tokens, then a 400 (which compounded a model-limit
mismatch where pi believed `minimax-m3` had a 1M window but Parasail enforces
524k — see README "Model limits"). Even discounting the 400, the run was
slow and expensive because one agent held the whole repo in context.

Soft enforcement (`maxTools` prompt budget) was tried and is unreliable:
the parent LLM rewrites the task before dispatching and drops the budget
instruction. Bounded agents (`tools: read, write`, no `ls`/`find`/`bash`)
are real enforcement but blunt on their own.

**Iteration is the structural answer.** Instead of one subagent summarizing
N files, enumerate the files and dispatch one bounded subagent per file.
Each subagent's context = system prompt + shared onboarding + one file + the
prompt. There is nothing else to read. Bloat is impossible by construction.
The audit then shows N dispatches of ~5k tokens each, not one dispatch of
188k — and any single failure is isolated to one unit, not the whole step.

## Execution model: enumerate → map → reduce

Every iteration step has three phases:

1. **Enumerate** — a `coordinator` agent (or a mechanical glob/listing for
   trivial cases) produces a *structured list of units* as JSON. Units can
   be files, screenshots, ideas, bug reports, a range of N — anything
   iterable. The deliverable is `units.json`, not prose.
2. **Map** — the orchestrator spawns **one bounded subagent per unit**. Each
   subagent receives: the unit itself, a slim shared onboarding (prepared
   once: the card list, the repo standards, etc.), and the **per-unit prompt
   template the coordinator authored**. The orchestrator substitutes
   `{{unit}}` (and any `{{unit.*}}` fields) into the template and dispatches.
   The subagent has `tools: read, write` (plus `bash` only if the step
   needs it) — it cannot explore beyond the unit. Each map step is a set of
   N small, isolated dispatches.
3. **Reduce** — a later step reads the per-unit outputs (`summary-*.md`,
   `findings-*.md`) and synthesizes. The reduce agent has `read` access to
   the per-unit outputs but still no `ls`/`find` — it reads exactly what the
   map step wrote, nothing more.

**Per-unit chaining.** A unit's map subagent can itself be multi-step
("commits → match → review → attach → rename") — that's a focused agent
with its own tool budget, not a nested pipeline. The point is that the
subagent works on *one unit end-to-end* with only that unit in context.

**The iterable is content, not code.** "N ideas" or "2-3 variations" are
prompt-template content the coordinator parameterizes; the orchestrator just
runs the map over whatever list step 1 produced. This is what makes a
pipeline work for ideation (generate N → research each → sketch 2-3 →
review all → iterate) as naturally as for files (summarize each file → merge).

## Iteration steps (recipe syntax)

A step iterates when it declares an iterable:

```markdown
## 2. Summarize each file  (dev, iterate=scope-files, output=summary-{{unit}}.md)
Read `{{unit}}` and write a 100-word summary. Do not read any other file.
```

- `iterate=<name>` — the iterable is the unit list a prior step produced
  (here `scope-files`, written by step 1 as `units.json`).
- `{{unit}}` — the per-unit placeholder the orchestrator substitutes. May
  be a string path, or an object with fields (`{{unit.path}}`, `{{unit.mtime}}`).
- `output=summary-{{unit}}.md` — one output per unit; a later reduce step
  reads `summary-*.md`.
- The step's agent runs **bounded** (`tools: read, write` by default for
  iterate steps; `bash` only if the step declares it needs it).

A reduce step is an ordinary step that reads the per-unit outputs:

```markdown
## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
Read every `summary-*.md`. Cross-check for patterns. Write `summaries.md`.
```

`parallel` (the v0 fan-out flag) is subsumed by `iterate=`. A step with
`parallel` but no `iterate=` remains supported as a hint ("fan out, parent
picks N") but is soft; `iterate=` is the enforceable form.

## The coordinator profile

A new agent, `coordinator`, whose job is to **produce the iterable and the
per-unit prompt template** — not to do the work. It is a high-tier agent
(sonnet-5-class) because writing a good per-unit prompt is judgment work.

- Deliverable 1: `units.json` — the enumerated list (paths, or objects with
  fields the template will reference).
- Deliverable 2: `per-unit-prompt.md` — the template, with `{{unit}}` /
  `{{unit.*}}` placeholders, that the orchestrator will substitute per unit.
- The coordinator does **not** run per-unit work. It sets up the map.

This separation is the enforcement backbone: the parent LLM calls
`subagent({agent, task: renderedPrompt})` — it doesn't author the task, so
it can't paraphrase the budget or scope away. The coordinator's template is
the contract; the orchestrator is mechanical.

## Profiles

A **profile** is a named agent. The package ships four:

| Profile | Description (from the agent's frontmatter) |
|---|---|
| `dev` | Low-cost model good at surgical code updates. |
| `util` | Mechanical work: finding files, summarizing, running tests. |
| `research` | Review, debugging, documentation, consolidation. |
| `high` | High-level model for software architecture, planning, judgment. |

- Each profile is an `.md` file in `agents/` (e.g. `agents/dev.md`) with a
  `description:` in frontmatter. Adding a profile = adding an agent file.
- The user binds profiles to models via `subagents.agentOverrides` in
  `~/.pi/agent/settings.json` (existing mechanism — no new config concept).
- Recipes reference agents by name. Any agent (built-in or custom) can be
  referenced; the TUI validates that referenced agents are configured.
- **Cost classes (`$`/`$$`/`$$$`) are dropped.** The plan shows agent names
  and real resolved models, not abstract cost symbols. The cost shape line
  becomes `1 util + 2 dev + 3 research + 1 high` — more honest. Real costs
  are shown in the overview/dashboard per model.

### Migration from the current `tier`/`costClass`

`PlanStep.tier` and `PlanStep.costClass` → just `agent: string`. This touches
`renderPlan`, `summarizeCost`, the tool `details`, and `renderCostReport` —
all straightforward edits in `lib.ts`. Done in the same phase as the recipe
loader so recipes never produce the old fields.

## Recipe format

A recipe is a markdown file with optional YAML frontmatter and a body of
numbered step sections. Discovery is by `*.md` filename in `pipelines/` dirs.

### File location & precedence

Same resolution order as skills/agents/prompts (later wins on name
collision):

1. Built-in TS pipelines (in `src/lib.ts`)
2. `~/.pi/agent/pipelines/` (user-global)
3. `.pi/pipelines/` (project, walking up from cwd)
4. Package `pipelines/` dirs (declared in a package's `pi` manifest, or
   auto-discovered conventionally)

### Frontmatter (optional)

```yaml
---
name: code-quality           # defaults to filename stem
description: one-line, shown by the TUI list
inputs:                      # optional; documents placeholders
  - scope
---
```

`mode`/`effort` are **not** accepted for named recipes — a recipe is a
complete process. (They remain on the generic built-in path only.)

### Body

A `# <name>` H1 (title, ignored) followed by numbered
`## N. Phase (agent[, flags])` sections. Each section is one step.

**Step header grammar:**

```
## <number>. <phase>  ( <agent> [, parallel] [, reads=<files>] [, output=<file>] )
```

- `<agent>` — `dev` | `util` | `research` | `high` | any custom agent name
- `parallel` — marks a fan-out slot (see Fan-out)
- `reads=<a.md,b.md>` — optional explicit reads
- `output=<file>` — optional explicit output filename

The section's body paragraphs are the task text, verbatim.

**Placeholders:** `{{name}}` in any text is substituted at plan-build time
from the invocation's inputs. Missing inputs are surfaced by the overview
TUI (prompt or report).

**Inputs/reads/output inference:** `output` and `reads` are inferred from
prose patterns ("Write `findings.md`" → output; "Read `standards.md`" →
reads) with a simple regex, overridable by explicit flags. (Decision: Q5 =
infer with pattern.) This is the one bit of magic; flags always win.

### What the loader produces

Each recipe parses to the existing `Plan` / `PlanStep` types (with `agent`
replacing `tier`/`costClass`):

```ts
PlanStep {
  phase, agent, label, task, output?, reads?, parallel?
}
Plan {
  name, description, summary, steps[]
}
```

Because the output is `Plan`, everything downstream (plan rendering, dry-run,
live progress, cost tracking, model pinning, OpenRouter fallback) is
inherited with the `costClass` removal as the only breaking change.

## Fan-out (legacy `parallel`) → see Iteration

The v0 `parallel` flag marked a step as a fan-out slot and let the parent
infer N. That was soft and unbounded — the original failure mode. It is
**superseded by `iterate=`** (see **Execution model** and **Iteration
steps**), which makes the iterable explicit and the per-unit agent bounded.

`parallel` remains supported as a hint for cases where the iterable is
genuinely discovered mid-run, but new recipes should prefer `iterate=`.
A later non-iterate step still implicitly waits for all per-unit dispatches
(it reads their `summary-*.md` / `findings-*.md` outputs).

## The TUI

Three views, replacing the current text command + `/pipeline-costs`.

### 1. List view (`/pipeline`)

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

### 2. Overview view (pre-run gate)

Before any dispatch, a rich confirmation:
- The resolved plan: each step with its agent, task snippet, reads/writes
- The agent→model mapping for every agent this recipe uses (`dev → kimi-k2.7`,
  `high → sonnet-5`, …), with each agent's one-sentence description
- Inputs filled in (or prompted if missing)
- Estimated cost shape (agent counts; real cost once models are known)
- Validation: any referenced agent that isn't configured is flagged here
- Actions: **Confirm** / **Edit inputs** / **Edit profiles** / **Cancel**

On Confirm, the tool returns the plan to the LLM, which executes it with
`subagent` calls. The dashboard becomes available.

> **API note:** the overview gates inside the `pipeline` tool handler (the
> LLM calls the tool; the tool blocks on user confirmation). Pi supports
> interactive tools (`ctx.ui.confirm`/`select`). A *rich* scrollable TUI via
> `ctx.ui.custom()` inside a tool handler needs verification — if it doesn't
> work cleanly, v1 ships as a `confirm` with a rendered text block, and the
> rich TUI follows once the API is confirmed.

### 3. Dashboard view (during/after run)

Live status + cost, replacing `/pipeline-costs`:
- Per-step status: pending / running / done / failed, with checkmarks on the
  plan outline
- Per active subagent: current tool, path, tokens, turn count (from
  `tool_execution_update`, same data the status line uses today)
- Cumulative cost by model (from the cost tracking we already have), updating
  live
- When idle (no active run): shows the *last* run's summary + total cost
- Toggle in/out with `/pipeline` (or a keybinding) — the message stream keeps
  accumulating behind it

> **Coexistence note:** during a run the LLM is emitting tool calls into the
> message stream. The dashboard is a full-screen view you toggle into; the
> stream continues behind. v1 may ship as a `setWidget` strip (always-visible
> one-line status + cost) with the full dashboard as v2, if full-screen
> coexistence proves fiddly.

### `/pipeline-costs` is removed

Its function (cost breakdown by step + model) is subsumed by the dashboard
view. When a run is active or has just finished, `/pipeline` shows the
dashboard; when idle and no last run, it shows the list.

## Invocation model

| Surface | Behavior |
|---|---|
| `/pipeline` | Opens the list TUI (or dashboard if a run is active) |
| `/pipeline <name> [inputs]` | Opens the overview TUI for `<name>` (skips list) |
| `/pipeline <name> [inputs] --dry-run` | Overview with a no-dispatch flag |
| Natural language | The `pipeline` skill lists available recipes; the parent picks one and calls the `pipeline` tool, which gates on the overview |
| `pipeline` tool (LLM) | Takes optional `pipeline` name. If named → load recipe → overview gate → return plan. If unnamed → infer generic built-in (mode/effort) → overview gate → return plan. |

The LLM always executes the steps with `subagent` calls after the overview is
confirmed. The command and the tool both route through the same overview
gate, so there's one confirmation path regardless of how the pipeline was
invoked.

## Package sharing

A package declares a `pipelines` dir in its `pi` manifest:

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"],
    "agents": ["./agents"],
    "skills": ["./skills"],
    "pipelines": ["./pipelines"]
  }
}
```

Pi auto-discovers `pipelines/` even without a manifest (conventional dir).
The TUI's "Add" collects any `pi install` source (git URL, local path,
`npm:name`) and shells out — so npm works as a source if you later publish,
but git + local path cover the soft release. Recipes in an installed package
reference agents the same package ships (e.g. `code-quality` references
`dev`, and the package ships `agents/dev.md`), so they're self-contained.

## What stays TS

Built-in pipelines with real logic stay in `src/lib.ts`:

- The generic inference path (unnamed `pipeline` tool call → infer mode/effort
  → pick a built-in template).
- `implementation/deep` — the kick-back loop (high rejects → re-run merge up
  to 3×) is a loop, not a fixed sequence.

The boundary: **fixed checklist → recipe; needs loops/branching → TS.** Most
use cases (review-pr, migrate, test-writing, debug, onboarding, postmortem,
doc-gen, verify-source, code-quality) are fixed checklists → recipes.

## Worked example: `code-quality`

```markdown
---
name: code-quality
description: Audit code & tests in a scope against the repo's own standards, then produce a prioritized action plan.
inputs:
  - scope
---

# code-quality

**Inputs:** `scope` — what's in scope (e.g. "frontend code", "api", "tests").

## 1. Standards & scope  (util)
Identify what code/docs/tests are in scope for this task (`{{scope}}`).
Assemble the documentation and selected best practices for this repo;
check for linting config and established standards. Write `standards.md`
with: the in-scope file set, the standards that apply, and any gaps.

## 2. Review code  (dev, parallel)
Read `standards.md`. For your assigned code area, look for issues with
logic evaluation, error handling, duplicated code, naming, parameters/args,
and types. List each as `file:line — issue — severity`. Write
`code-issues-<area>.md`. Do not edit code.

## 3. Review tests  (dev, parallel)
Read `standards.md` and the in-scope test files. Verify the tests actually
prove code behavior and that assertions are trustworthy. Look for issues
with setup/teardown, mocks, over-lenient expectations, and whether test
cases are focused and small. Write `test-issues-<area>.md`.

## 4. Merge findings & update standards  (research)
Read `standards.md` and every `*-issues-*.md`. Cross-check for patterns
across code and tests. Update `standards.md` with any strengthened
reference standards implied by the findings. Write `findings.md`
summarizing the patterns.

## 5. Followup & action points  (high)
Read `findings.md`. Suggest followup checks or clarifications to do, and
collect the initial action points for planning. Write `actions-draft.md`.

## 6. Investigate stated issues  (dev)
Read `actions-draft.md` and the original `*-issues-*.md`. For the top
items, investigate the stated issues in the code/tests and confirm or
refute each with `file:line` evidence. Write `investigation.md`.

## 7. Final action plan  (high)
Read `actions-draft.md` and `investigation.md`. Develop the final,
prioritized action plan. Write `action-plan.md`.

## 8. Present to user  (high)
Summarize `action-plan.md` for the user in their language. Surface the
decisions to take clearly and concretely. Do not start implementing.
```

## Worked example: `verify-source`

```markdown
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
```

Invoked as:
```
/pipeline verify-source "scan /docs and check all links, find the original
carefully and ensure quotes are exact and citations are verified"
```
The task string fills `{{target}}` (or the overview prompts for it), the
recipe provides the 4-step shape, the overview shows the agent→model mapping,
and the dashboard tracks the run.

## Worked example: `summarize-files` (iteration)

The simplest iteration recipe — and the proof-of-concept for context
isolation by construction. One bounded `dev` subagent per file; no `ls`/
`find`/`bash`.

```markdown
---
name: summarize-files
inputs:
  - glob
---

# summarize-files

## 1. Enumerate files  (coordinator, output=units.json)
List every file matching `{{glob}}` (relative paths). Exclude `.git/`,
`node_modules/`. Write `units.json` as an array of {"path": "..."}. Then
write `per-unit-prompt.md`: a one-paragraph prompt telling a `dev` agent to
read exactly one file and write a 100-word summary. The prompt must say: do
not read any other file.

## 2. Summarize each file  (dev, iterate=units, reads=per-unit-prompt.md, output=summary-{{unit.path}}.md)
Follow `per-unit-prompt.md` for the unit `{{unit.path}}`. Read only that
file. Write `summary-{{unit.path}}.md`. Do not read any other file.

## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
Read every `summary-*.md`. Cross-check for patterns. Write `summaries.md`.
```

Step 1 produces the iterable + the per-unit prompt (the coordinator's two
deliverables). Step 2 is the map: the orchestrator substitutes `{{unit.path}}`
and dispatches one bounded `dev` per file. Step 3 is the reduce. Each step-2
dispatch is ~5k tokens and isolated — bloat is impossible.

## Worked example: `screenshot-worklog` (iteration over non-files)

The user's example: for every screenshot in `~/screenshots`, look for
commits after it, match to a card/feature, review the image, attach to the
relevant card, rename to `feature-date`, and file in the worklog dir.

```markdown
---
name: screenshot-worklog
inputs:
  - screenshots-dir
  - board-url
---

# screenshot-worklog

## 1. Enumerate screenshots + load board  (coordinator, output=units.json)
List every image in `{{screenshots-dir}}` with its mtime. Load the
engineering board at `{{board-url}}` and produce a compact card/feature
list. Write `units.json` as [{"path": "...", "mtime": 1234567890}].
Write `per-unit-prompt.md`: for one screenshot, find commits since its
mtime, match to a card from the shared list, review the image, attach to
that card, rename to `<feature>-<date>.png`, move to `worklog/`.

## 2. Process each screenshot  (dev, iterate=units, reads=per-unit-prompt.md, board.json, output=worklog-{{unit.path}}.md)
Follow `per-unit-prompt.md` for `{{unit.path}}` (mtime `{{unit.mtime}}`).
The board list is in `board.json`. Do not read other screenshots.

## 3. Report  (research, reads=worklog-*.md, output=report.md)
Summarize what was processed and any screenshots that couldn't be matched.
```

Step 2 is a per-unit *chain* (commits → match → review → attach → rename →
file) owned by one focused `dev` agent with `bash` (for git/attach/rename).
The small-context guarantee holds because the subagent sees one screenshot
+ the shared board list + the prompt — not the whole repo or all screenshots.

## Worked example: `ideation` (iteration where N is content)

The user's example: generate N ideas → research each → sketch 2-3 → review
all → iterate.

```markdown
---
name: ideation
inputs:
  - brief
---

# ideation

## 1. Generate ideas  (high, output=units.json)
Based on `{{brief}}`, generate 8 distinct ideas. Write `units.json` as
[{"id": "...", "summary": "...", "angle": "..."}].

## 2. Research each idea  (research, iterate=units, output=research-{{unit.id}}.md)
Gather source material for idea `{{unit.summary}}` (angle: `{{unit.angle}}`).
Write `research-{{unit.id}}.md`. Do not research other ideas.

## 3. Pick finalists  (high, reads=research-*.md, output=finalists.json)
Read every `research-*.md`. Pick the 3 strongest. Write `finalists.json`
as [{"id": "...", "summary": "..."}].

## 4. Sketch each finalist  (dev, iterate=finalists, reads=research-{{unit.id}}.md, output=sketch-{{unit.id}}.md)
Sketch a pitch and spec for `{{unit.summary}}`. Read its research file.
Write `sketch-{{unit.id}}.md`.

## 5. Review all proposals  (high, reads=sketch-*.md, output=review.md)
Read every `sketch-*.md`. Recommend which to pursue and what to iterate.
```

N (8 ideas, 3 finalists) is prompt-template content — step 1's prompt says
"generate 8"; step 3 says "pick 3." The orchestrator runs the map over
whatever list each enumerate step produced. This is the same iterate→map→
reduce pattern over a non-file iterable (ideas), proving the model is
content-agnostic.

## Implementation phasing

Shipped in slices — each phase is independently useful. **Phases 1 and the
audit are done; the next big lever is the iteration runtime.**

**Phase 1 — Recipes + profiles + metrics (DONE).**
- `agents/dev.md`; dropped `costClass`/`tier` → `agent`.
- `RunMetrics` (single source of truth) + `/pipeline-audit` (per-step task,
  model, errors, attempts, tool calls, artifact paths; context-overflow flag).
- Recipe parser (`src/recipes.ts`), discovery (`src/discovery.ts`),
  `pipeline` tool `pipeline`/`inputs` params, `/pipelines` command.
- Shipped `code-quality` + `verify-source` recipes.

**Phase 1.5 — Diagnostics + enforcement groundwork (DONE).**
- Audit capture of full task / errors / attempts / toolCalls / artifactPaths.
- `classifyFailure` / `isContextOverflow` (context-overflow vs rate-limit vs
  auth vs timeout vs model-unavailable).
- `maxTools` soft budget (proven unreliable: the parent drops it when it
  rewrites the task). Kept as a hint; real enforcement is iteration.
- Model-limit override docs (`~/.pi/agent/models.json`) — the actual cause
  of the original 400s.

**Phase 2 — Iteration runtime (NEXT; the v1.0 identity).**
- `coordinator` profile (`agents/coordinator.md`).
- `iterate=<name>` step kind: parse, render, and execute via the
  `subagent` `tasks[]` shape with one bounded dispatch per unit.
- `{{unit}}` / `{{unit.*}}` substitution in iterate step tasks and outputs.
- Bounded tool set for iterate steps (`tools: read, write`; `bash` opt-in).
- `units.json` as the inter-step iterable contract.
- Proof-of-concept: `summarize-files` recipe validated against a real repo —
  audit shows N small dispatches vs one bloated one.
- Reduce steps read `summary-*.md` / `findings-*.md` (existing `reads=`
  glob already handles this).

**Phase 3 — Overview TUI (preview gate).**
- Rich pre-run confirmation (or `confirm`+text v1 if `ctx.ui.custom()` in a
  tool handler needs API work).
- Agent→model mapping display + validation.
- Input prompting; generic-path check.
- Metrics drive the cost estimate.

**Phase 4 — List TUI.**
- `/pipeline` opens the browse list (replaces the interim `/pipelines` text
  command). Launch / view steps / edit recipe / edit profiles.

**Phase 5 — Dashboard TUI (replaces `/pipeline-costs`).**
- Live status + cost during a run, driven by `RunMetrics`.
- Last-run summary when idle.

**Phase 6 — Add/remove from the TUI + `pi pipeline new`.**
- Install/remove sources; scaffolder for new recipes.

## Resolved open questions

1. **Profiles** → a flat roster of named agents (`dev`, `util`, `research`,
   `high`), each with a one-sentence description from its agent frontmatter.
   The user binds them to models via `subagents.agentOverrides` and confirms
   the mapping in the overview TUI. Cost classes (`$`/`$$`/`$$$`) dropped.
   `dev` is a standard fourth profile ("low-cost model good at surgical code
   updates").
2. **Fan-out N** → inferred from prose by the parent. (No `fanout-from`
   flag in v1.)
3. **Step composition** → no. Recipes are flat.
4. **Mode/effort for named recipes** → not applicable. A recipe is an
   opinionated process; the task string implies the specifics. Mode/effort
   only exists on the unnamed generic inference path.
5. **Output/reads** → inferred from prose with a simple pattern, overridable
   by explicit flags.
6. **Generic inference path** → kept as the "I don't have a recipe" escape
   hatch, but the overview gate surfaces that no specific recipe was selected
   and offers a pick-list of close recipes before confirming. So the user is
   always aware they're on the generic path and can flip to a named recipe.
   Covers both `/pipeline <task>` (no name) and unnamed `pipeline` tool calls,
   including when the LLM infers generic where a named recipe would fit better.
7. **Metrics** → every run captures a typed `RunMetrics` record (per-step,
   per-attempt, per-model usage: input/output/cacheRead/cacheWrite/cost/turns,
   plus durationMs and toolCount). This is the single source of truth for all
   future consumers — overview TUI, dashboard, footer widget, reports — so they
   answer "per-step cost", "per-model cost", "total run cost", "session
   cumulative", and "time per step/model" without re-deriving. Captured for
   every run regardless of whether a cost command is invoked.

## Remaining open questions

1. **Dashboard coexistence** — full-screen toggle vs. always-visible widget
   strip for v1? Lean: ship a `setWidget` strip in Phase 5, full dashboard
   when coexistence is proven.
2. **`ctx.ui.custom()` in a tool handler** — does the rich overview TUI work
   inside the `pipeline` tool's `execute`? If not, v1 overview is
   `confirm`+text. Needs an API spike before Phase 3.
3. **Per-recipe profile notes** — should a recipe be able to add a per-use
   sentence to a profile ("in this recipe, `dev` reads code and finds
   issues")? Lean: no for v1; the global agent description is enough.
4. **Generic inference path survival** — keep the unnamed `pipeline` tool
   call (infer mode/effort → built-in template) as a fallback, or require
   every invocation to name a recipe? Lean: keep it; it's the "I don't have
   a recipe for this" escape hatch.
5. **Iteration: bounded tools per step** — should the bounded tool set
   (`read`, `write`, +opt-in `bash`) be the default for *all* iterate steps,
   or declared per-step (`tools=read,write` in the header)? Lean: default
   bounded, opt-out via a `tools=` flag.
6. **Iteration: who enumerates trivial iterables?** — for `iterate=files`
   where the list is a glob, do we skip the coordinator and glob directly,
   or always go through the coordinator (consistency)? Lean: a `iterate=glob:*.go`
   shorthand for mechanical globs; coordinator for anything that needs
   judgment (ideas, screenshots with mtimes, matched entities).
7. **Iteration: per-unit failure handling** — if one of N map dispatches
   fails, does the whole step fail, or does the reduce proceed with the
   successful outputs and flag the gap? Lean: proceed + flag; the parent's
   5× blind retry loop (observed) should be replaced by "fail this unit,
   continue, report at reduce."
8. **Iteration: per-unit concurrency** — default cap on concurrent map
   dispatches (the `subagent` `concurrency` param)? Lean: yes, default 4;
   overridable in the recipe.
9. **Coordinator trust** — the coordinator authors the per-unit prompt, so a
   bad coordinator = bad whole run. Should the overview TUI show the
   coordinator's `per-unit-prompt.md` before dispatching? Lean: yes.
