# Pipeline Recipes — Design Spec

> Status: **draft** — design doc, not yet implemented. Refine here before
> writing the loader. Worked examples: `code-quality` and `verify-source`.

## Goal

Let a user define, share, and run a multi-step pipeline as **prose**, and
give them a **TUI** to browse, preview, confirm, and monitor pipelines — so
the whole loop (define → discover → preview → run → watch → share) needs no
TypeScript and no text-dump commands.

Today pipelines are hardcoded TS templates in `src/lib.ts`, invoked by a
text command, with cost inspection via a separate `/pipeline-costs` command.
This spec replaces that with: **recipes** (markdown), **profiles** (named
agents, not cost classes), and a **TUI** (list / overview / dashboard).

## Design principles

1. **Prose first.** A pipeline is a numbered checklist with agent
   annotations. The user's hand-written `code-quality` (below) is the source
   of truth — if the format can't express that, the format is wrong.
2. **A profile is just an agent.** No separate "cost class" concept. The
   package ships a roster of agents (`dev`, `util`, `research`, `high`);
   recipes name agents; the user binds each agent to a real model via the
   existing `subagents.agentOverrides`. The agent's `description:` frontmatter
   *is* the one-sentence profile description.
3. **Same runtime types.** A loaded recipe produces the existing `Plan` /
   `PlanStep` types (minus `costClass` — see Profiles), so `renderPlan`,
   `summarizeCost`, live progress, and cost tracking work with minimal changes.
4. **Recipes are opinionated processes.** A named recipe is a complete
   process — it has no `mode`/`effort`. The recipe provides the shape; the
   task string provides the specifics. (The unnamed generic path still
   infers mode/effort for "I don't have a specific recipe" cases.)
5. **Preview before you spend.** A rich overview TUI gates every run: the
   resolved plan, the agent→model mapping, the estimated cost. Confirm, edit
   inputs, or cancel.
6. **Watch it run.** A dashboard TUI shows live status and cost during a run,
   replacing `/pipeline-costs`.

## Non-goals (for the first cut)

- **No conditional logic in recipes.** A recipe is a fixed sequence with
  optional parallel fan-out. Loops/branching stay TS (e.g.
  `implementation/deep`'s kick-back loop). We can revisit declarative
  conditionals later.
- **No step composition/includes.** Recipes are flat. No reusing another
  recipe's steps. (Decision: Q3 = no.)
- **No replacement of TS built-ins that need logic.** Recipes and TS
  pipelines coexist; the generic inference path and `implementation/deep`
  stay TS.

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

## Fan-out: parallel steps

A step marked `parallel` is a fan-out slot. The recipe doesn't hardcode N —
the parent decides N from the project (e.g. one slot per in-scope area found
in an earlier step). (Decision: Q2 = infer N from prose.)

- The plan renders a `parallel` step as: "Run this step N times, once per
  `<area>`. Replace `<area>` in the task with each slot's assignment."
- The parent's `subagent` call uses the `tasks[]` (parallel) shape.
- A later non-parallel step implicitly waits for all parallel slots (it reads
  their `*-<area>.md` outputs).

Matches how `research/standard` already works (partition → parallel extracts
→ merge). The recipe just makes it declarative.

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

## Implementation phasing

The TUI is larger than the recipe loader, so we ship in slices — each phase
is independently useful:

**Phase 1 — Recipes + profiles (the core).**
- Add `agents/dev.md`, drop `costClass`/`tier` → `agent` across `lib.ts`.
- Recipe parser (`src/recipes.ts`): markdown → `Plan`.
- Discovery (`src/discovery.ts`): walk the four `pipelines/` sources.
- `pipeline` tool: accept optional `pipeline` name; load recipe or infer.
- `/pipelines` text command (interim, until the TUI list ships).
- Convert two built-ins to recipes to prove coexistence.
- Tests for the parser + discovery + profile migration.

**Phase 2 — Overview TUI (preview gate).**
- Rich pre-run confirmation (or `confirm`+text v1 if `ctx.ui.custom()` in a
  tool handler needs API work).
- Agent→model mapping display + validation.
- Input prompting.

**Phase 3 — List TUI.**
- `/pipeline` opens the browse list (replaces the interim `/pipelines` text
  command).
- Launch / view steps / edit recipe / edit profiles.

**Phase 4 — Dashboard TUI (replaces `/pipeline-costs`).**
- Live status + cost during a run.
- Last-run summary when idle.
- Remove `/pipeline-costs`.

**Phase 5 — Add/remove from the TUI.**
- Collect source, shell out to `pi install`/`pi remove`, prompt reload.

**Phase 6 — `pi pipeline new <name>` scaffolder.**
- Skeleton recipe + external editor.

## Resolved open questions

1. **Profiles** → a flat roster of named agents (`dev`, `util`, `research`,
   `high`), each with a one-sentence description from its agent frontmatter.
   The user binds them to models via `subagents.agentOverrides` and confirms
   the mapping in the overview TUI. Cost classes (`$`/`$$`/`$$$`) dropped.
2. **Fan-out N** → inferred from prose by the parent. (No `fanout-from`
   flag in v1.)
3. **Step composition** → no. Recipes are flat.
4. **Mode/effort for named recipes** → not applicable. A recipe is an
   opinionated process; the task string implies the specifics. Mode/effort
   only exists on the unnamed generic inference path.
5. **Output/reads** → inferred from prose with a simple pattern, overridable
   by explicit flags.

## Remaining open questions

1. **Dashboard coexistence** — full-screen toggle vs. always-visible widget
   strip for v1? Lean: ship a `setWidget` strip in Phase 4, full dashboard
   when coexistence is proven.
2. **`ctx.ui.custom()` in a tool handler** — does the rich overview TUI work
   inside the `pipeline` tool's `execute`? If not, v1 overview is
   `confirm`+text. Needs an API spike before Phase 2.
3. **Per-recipe profile notes** — should a recipe be able to add a per-use
   sentence to a profile ("in this recipe, `dev` reads code and finds
   issues")? Lean: no for v1; the global agent description is enough.
4. **Generic inference path survival** — keep the unnamed `pipeline` tool
   call (infer mode/effort → built-in template) as a fallback, or require
   every invocation to name a recipe? Lean: keep it; it's the "I don't have
   a recipe for this" escape hatch.
