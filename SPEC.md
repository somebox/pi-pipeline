# Pipeline Recipes — Design Spec

> Status: **draft** — design doc, not yet implemented. Refine here before
> writing the loader. The worked example throughout is `code-quality`.

## Goal

Let a user define, share, and refine a multi-step pipeline as **prose**, not
code — and have it run through the existing `pipeline` tool surface (plan
rendering, dry-run, live progress, `/pipeline-costs`, model pinning/fallback).

Today the only way to define a pipeline is to edit `src/lib.ts` and add a TS
`Plan` object. That doesn't scale: every team's "how we review", "how we
migrate", "how we write tests" is a pipeline, and users won't (and shouldn't)
write TS for each. Recipes are the pi-native answer — markdown, the same
format pi already uses for skills and agents.

## Non-goals (for the first cut)

- **No conditional logic in recipes.** A recipe is a fixed sequence of steps
  with optional parallel fan-out. If a workflow needs real branching
  ("if tests fail, re-run step 2"), it stays a TS built-in. The
  `implementation/deep` kick-back loop is the canonical example and stays in
  TS. We can revisit declarative conditionals later; spec'ing them now
  risks a half-language.
- **No new agent system.** Recipes name existing tier agents
  (`util` / `research` / `high`) and any custom agent the user has
  configured. They don't define agents.
- **No replacement of the TS built-ins.** Recipes and TS pipelines coexist;
  `/pipelines` lists both, the tool dispatches both through the same
  `Plan`/`PlanStep` types.

## Design principles

1. **Prose first.** A pipeline is a numbered checklist with tier annotations.
   The user's example (below) is the source of truth for what the format must
   express. If it can't express that, the format is wrong.
2. **Same types, same runtime.** A loaded recipe produces the exact `Plan`
   object the built-in templates already produce, so `renderPlan`,
   `summarizeCost`, `renderProgressStatus`, `renderCostReport`, model
   pinning, and OpenRouter fallback all work unchanged.
3. **Inputs are explicit.** A recipe can declare placeholders the user fills
   at invocation (`{{scope}}`, `{{diff-ref}}`). The tool surfaces missing
   inputs and the command can prompt for them.
4. **Discoverable.** `/pipelines` lists every available recipe (built-in +
   user + project + package) with its description and cost shape — the same
   affordance `pi list` gives for packages.
5. **Sharable & versionable.** Recipes live in `pipelines/` dirs and ship in
   packages via the `pi` manifest, exactly like skills/agents/prompts.

## The worked example: `code-quality`

This is the pipeline the user wrote by hand. It's the spec's north star —
every field in the format exists to let this be written *as-is* and run.

> Combine prompts and various fan-outs. Define it as written here, capture it
> in a shareable pipeline, refine it over time.

```markdown
---
name: code-quality
description: Audit code & tests in a scope against the repo's own standards, then produce a prioritized action plan.
---

# code-quality

**Inputs:** `scope` — what's in scope (e.g. "frontend code", "api", "tests").

## 1. Standards & scope  (util, $)
Identify what code/docs/tests are in scope for this task (`{{scope}}`).
Assemble the documentation and selected best practices for this repo;
check for linting config and established standards. Write `standards.md`
with: the in-scope file set, the standards that apply, and any gaps.

## 2. Review code  (util, $$, parallel)
Read `standards.md`. For your assigned code area, look for issues with
logic evaluation, error handling, duplicated code, naming, parameters/args,
and types. List each as `file:line — issue — severity`. Write
`code-issues-<area>.md`. Do not edit code.

## 3. Review tests  (util, $$, parallel)
Read `standards.md` and the in-scope test files. Verify the tests actually
prove code behavior and that assertions are trustworthy. Look for issues
with setup/teardown, mocks, over-lenient expectations, and whether test
cases are focused and small. Write `test-issues-<area>.md`.

## 4. Merge findings & update standards  (research, $$)
Read `standards.md` and every `*-issues-*.md`. Cross-check for patterns
across code and tests. Update `standards.md` with any strengthened
reference standards implied by the findings. Write `findings.md`
summarizing the patterns.

## 5. Followup & action points  (high, $$$)
Read `findings.md`. Suggest followup checks or clarifications to do, and
collect the initial action points for planning. Write `actions-draft.md`.

## 6. Investigate stated issues  (research, $$)
Read `actions-draft.md` and the original `*-issues-*.md`. For the top
items, investigate the stated issues in the code/tests and confirm or
refute each with `file:line` evidence. Write `investigation.md`.

## 7. Final action plan  (high, $$$)
Read `actions-draft.md` and `investigation.md`. Develop the final,
prioritized action plan. Write `action-plan.md`.

## 8. Present to user  (high, $$$)
Summarize `action-plan.md` for the user in their language. Surface the
decisions to take clearly and concretely. Do not start implementing.
```

What the recipe had to express, and how the format covers it:

| Need in the example | How it's expressed |
|---|---|
| A scope input the user fills | frontmatter-less `**Inputs:**` line + `{{scope}}` placeholder |
| Per-step tier + cost class | `(util, $)` / `(util, $$, parallel)` / `(research, $$)` / `(high, $$$)` |
| A parallel fan-out ("your assigned code area") | the `parallel` keyword on steps 2 & 3 |
| Steps that read previous steps' outputs | prose naming the `.md` files + an implicit `reads` |
| A merge/consolidation step | step 4 reads all `*-issues-*.md` |
| A strong model for judgment, a code model for investigation | `high` for 5/7/8, `research` for 6 |
| "Present to user" as a real step | step 8 — a step whose task is to summarize, not write a file |

## Recipe format

A recipe is a markdown file with optional YAML frontmatter and a body of
numbered step sections. Discovery is by filename (`*.md`) in `pipelines/`
dirs; the `name` defaults to the filename stem unless frontmatter overrides.

### File location & precedence

Same resolution order as skills/agents/prompts (later wins on name
collision):

1. Built-in TS pipelines (in `src/lib.ts`)
2. `~/.pi/agent/pipelines/` (user-global)
3. `.pi/pipelines/` (project, walking up from cwd)
4. Package `pipelines/` dirs (declared in a package's `pi` manifest)

### Frontmatter (optional)

```yaml
---
name: code-quality           # defaults to filename stem
description: one-line, shown by /pipelines
mode: research               # optional; default effort/framing hint
effort: standard             # optional default; overridable at invocation
inputs:                      # optional; documents placeholders
  - scope
  - diff-ref
---
```

All fields optional. `inputs` is documentation + a prompt list; placeholders
work whether or not they're declared here.

### Body

The body is a `# <name>` H1 (ignored, just a title) followed by numbered
`## N. Phase (tier, cost[, flags])` sections. Each section is one step.

**Step header grammar:**

```
## <number>. <phase>  ( <tier> , <cost> [, parallel] [, reads=<files>] [, output=<file>] )
```

- `<tier>` — `util` | `research` | `high` (or a custom agent name; cost class
  falls back to `$$` for unknown agents, overridable in frontmatter)
- `<cost>` — `$` | `$$` | `$$$`
- `parallel` — marks this step as a parallel fan-out slot. The orchestrator
  runs it N times; the task text tells each slot its assigned area. (N is
  decided by the parent from the project, not hardcoded — see "Fan-out"
  below.)
- `reads=<a.md,b.md>` — optional explicit reads (in addition to files named
  in the prose)
- `output=<file>` — optional explicit output filename

Anything in parentheses is optional except tier and cost. The step's body
paragraphs are the task text, verbatim.

**Placeholders:** `{{name}}` in any frontmatter/step text is substituted at
plan-build time from the invocation's `inputs`. Missing inputs are surfaced
to the user (the `/pipeline` command prompts; the tool reports which are
missing).

### What the loader produces

Each recipe parses to the existing `Plan` / `PlanStep` types — no new
runtime types:

```ts
PlanStep {
  phase, tier, agent, label, task, output?, reads?, parallel?, costClass
}
```

- `phase` ← the header's phase text
- `tier` / `agent` ← the header's tier (agent name == tier for the three
  built-ins; for a custom agent, `tier` is the closest class default and
  `agent` is the named agent)
- `label` ← a short label derived from the phase (or an explicit `label=`
  flag)
- `task` ← the section body, with `{{inputs}}` substituted and a `HINTS:`
  block prepended if the invocation passed hints
- `output` / `reads` / `parallel` ← from flags or prose inference

Because the output is the same `Plan`, everything downstream (plan rendering,
dry-run, `summarizeCost`, live progress, `/pipeline-costs`, model pinning,
OpenRouter fallback) is inherited for free.

## Fan-out: parallel steps

A step marked `parallel` is a *fan-out slot*. The recipe doesn't hardcode N
— the parent decides N from the project (e.g. one slot per in-scope area
identified in step 1). Concretely:

- The plan renders a `parallel` step as: "Run this step N times, once per
  `<area>`. Replace `<area>` in the task with each slot's assignment. Pass
  the per-area file list as `reads`."
- The parent's `subagent` call uses the `tasks[]` (parallel) shape, one task
  per area.
- `parallel` steps in the *same* phase group run concurrently; a later
  non-parallel step implicitly waits for all of them (it reads their
  `*-<area>.md` outputs).

This matches how `research/standard` already works (partition → parallel
extracts → merge). The recipe just makes the pattern declarative.

> Open question: should a recipe be able to say *which* earlier step's
> output defines the fan-out keys (e.g. "fan out over the areas listed in
> `standards.md`")? For the first cut, no — the parent infers it from the
> task text, same as today. We can add a `fanout-from=<file>` flag later
> if inference is unreliable.

## Invocation & UX

### `/pipelines` — discovery

Lists every available pipeline (built-in + recipes) with description, cost
shape, and source. A `--verbose` form shows the full step list. Example:

```
code-quality            8 steps · 3$ + 3$$ + 2$$$ · audit code & tests, produce action plan
review-pr               4 steps · 1$ + 2$$ + 1$$$ · audit a diff
research:standard       4 steps · 1$ + 3$$     · multi-source extraction (built-in)
implementation:deep     7 steps · ...          · drafts + accept loop (built-in)
```

### `/pipeline <name> [inputs] [--effort=] [--dryrun]`

Named invocation. Inputs can be inline (`/pipeline code-quality scope="api"`)
or prompted (`ctx.ui.input`) if a declared input is missing. `--dryrun`
shows the plan + bill, no dispatch (already implemented for the built-ins).

### Natural language

The `pipeline` skill is extended to list available recipes, so the parent
can pick `code-quality` from a task like "audit the api code quality and
give me an action plan" — no command needed. This is how skills get
discovered today; recipes inherit the same path.

### `pi pipeline new <name>`

Scaffolds a recipe file in `.pi/pipelines/<name>.md` with frontmatter + a
3-step skeleton, opened in the external editor. Save → `/reload` → it
appears in `/pipelines`.

## Package shipping

A package declares a `pipelines` dir in its `pi` manifest, mirroring
`skills`/`agents`:

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

Pi auto-discovers `pipelines/` even without a manifest (conventional dir),
same as the others. A team's "how we review" recipe ships in their shared
package and is immediately available to everyone who installs it.

## What stays TS

Built-in pipelines with real logic stay in `src/lib.ts`:

- `implementation/deep` — the kick-back loop (high rejects → re-run merge up
  to 3×) is a loop, not a fixed sequence.
- Anything that dynamically sizes fan-out from a subagent's *structured
  output* (vs. the parent inferring N from prose).

The boundary is: **if the workflow is a fixed checklist, it's a recipe; if it
needs loops or structured branching, it's TS.** Most of the use-case table
from the design discussion (review-pr, migrate, test-writing, debug,
onboarding, postmortem, doc-gen, verify-and-ship) is a fixed checklist and
becomes a recipe. `code-quality` is a fixed checklist — it becomes a recipe.

## Implementation sketch (not part of this spec, just to sanity-check feasibility)

1. `src/recipes.ts` — a markdown parser that turns a recipe file into a
   `Plan`. Reuses the existing `PlanStep` type. ~150 lines; a real parser
   needs a small grammar for the step header (tier/cost/flags) but the body
   is just "collect paragraphs until the next `## `."
2. `src/discovery.ts` — walk the four `pipelines/` sources, dedupe by name
   with precedence, return `{name, description, plan, source}[]`.
3. `pipeline` tool — accept an optional `pipeline` param (a name). If
   present, load that recipe; else fall back to the current built-in
   mode+effort inference.
4. `/pipelines` command — render the discovery list.
5. `pi pipeline new` — scaffolder (writes a skeleton recipe, opens editor).
6. Convert two built-ins to recipes (`research-surface`, a new `review-pr`)
   to prove coexistence; leave `implementation/deep` in TS.

No changes to `renderPlan`, `summarizeCost`, `renderProgressStatus`,
`renderCostReport`, `injectTierModels`, `buildCostStep`, or the
`before_provider_request` fallback — they all operate on `Plan`/`PlanStep`,
which recipes produce unchanged.

## Open questions

1. **Custom agents & cost class.** If a step names a custom agent (not
   util/research/high), what cost class does it get? Default `$$`? Or
   require the recipe to declare it in frontmatter
   (`agents: { custom: $$ }`)? Lean: default `$$`, overridable in frontmatter.
2. **Fan-out key inference.** For a `parallel` step, is inferring N from
   prose ("your assigned area") reliable enough, or do we need
   `fanout-from=<file>` in the first cut? Lean: ship without it, add if
   users hit it.
3. **Step reuse / includes.** Should a recipe be able to include another
   recipe's steps (e.g. `code-quality` reuses `review-pr`'s review steps)?
   Lean: no for the first cut — recipes are flat. Composition can come later
   if a real need surfaces.
4. **`mode`/`effort` for recipes.** A recipe isn't really "research" or
   "implementation" — it's its own thing. Should `mode`/`effort` even apply
   to named recipes, or only to the unnamed built-in inference path? Lean:
   `effort` still works as a depth knob (a recipe can declare
   effort-conditional steps — future); `mode` is ignored for named recipes.
5. **Where do `output`/`reads` come from when not in flags?** Infer from
   prose ("Write `findings.md`" → output; "Read `standards.md`" → reads)?
   Lean: infer with a simple pattern, fall back to "no explicit output."
   This is the riskiest bit of magic; make it overridable via flags.
