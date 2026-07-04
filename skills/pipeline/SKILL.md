---
name: pipeline
description: |
  Multi-agent pipeline that avoids putting expensive models on mechanical
  work. Two ways to run it: (1) a named recipe (markdown file in pipelines/,
  "code-quality", "summarize-files", etc.) — a complete opinionated process,
  optionally with iterate= steps that fan out one bounded subagent per unit
  for small-context-by-construction loops; (2) the generic inferred path with
  two modes, "research" (read-only/extraction, parent writes the spec, no
  high-tier calls in surface/standard) and "implementation" (code changes,
  high plans and accepts), each scaled by an effort knob (surface/standard/
  deep). The pipeline tool returns a numbered plan naming an agent
  (high/research/dev/util/coordinator) per step; for named recipes with
  iteration it also returns a pre-compiled subagent chain to execute
  verbatim. Supports a dryRun flag that prints the plan/cost shape without
  dispatching any subagents.
---

# Pipeline

This is a cost-aware multi-agent pipeline. The premise: high-tier models (sonnet-5) are reserved for planning, judgment, and acceptance; mechanical work goes to util-tier (M3); reviews, debugging, docs, and consolidation go to research-tier (glm-5.2). Best-of-N drafts happen on util-tier; the merge happens on research-tier. The user-supplied or inferred `effort` knob scales the pipeline.

> **Install location** (for the LLM's reference only — do not guess paths): this package may be installed from git (`pi install git:github.com/somebox/pi-pipeline`) or loaded from a local dev path. The skill catalog entry already has the correct `filePath`; trust it instead of guessing a path on disk.

## When to use

Use the `pipeline` tool when:

- The task is multi-step and the user has hinted at depth ("quick survey", "standard", "deep", "iterate", "subproject", "break into parts", "dig deep").
- The user wants a structured plan and execution with cost awareness.
- The work would otherwise require picking from many subagent roles by hand.

Do **not** use the `pipeline` tool when:

- The task is a single, simple operation (just use your built-in tools or a direct subagent call).
- The user wants raw control of which agents are called (`/run`, `/chain`, `/parallel` are better for that).
- The task is "chat about X" — pipeline is for execution, not discussion.

## Modes

The tool has two modes. Pick (or let the tool infer) the one that matches the shape of the work:

- **`implementation`** (default for code changes, build, refactor, fix, edit, add, create, port, migrate, patch). High plans and accepts. Standard = 5 steps, deep = 7 steps with parallel drafts and a kick-back loop.
- **`research`** (default for read-only/extraction, review, audit, learnings, postmortem, retrospect, what-did-we-learn, summarize, analyze). Parent writes the spec itself. Surface/standard have **no high-tier calls** — the plan uses util to partition and N research subagents in parallel. Deep adds one final high accept.

Inference: "implement/build/refactor/fix/edit/add/create/port/migrate/patch" → implementation. "research/extract/review/audit/learnings/postmortem/retrospect/what did we learn/summarize the docs/analyze" → research. If neither, default to implementation.

## Effort levels

- **`surface`** — quick skim + review. 1–2 calls. Read-only; do not edit code.
- **`standard`** — full plan/do/review/accept (implementation) or partition/parallel-extract/merge (research). 3–5 calls.
- **`deep`** — adds estimator (implementation) and best-of-N drafts with a kick-back loop (impl) or a comprehensive synthesis + high accept (research). 5–8 calls.

Inference: "quick/skim/survey/briefly/tl;dr/summary/is X feasible" → surface. "deep/thoroughly/carefully/iterate/subproject/break into parts/dig deep/production-ready" → deep. Default → standard.

## Cost classes

Each step in the plan is labeled with a cost class:

- `$` — util-tier (M3-class). The bulk of mechanical work.
- `$$` — research-tier (glm-5.2-class). Review, debug, docs, consolidation.
- `$$$` — high-tier (sonnet-5-class). Plan, judgment, accept. Used sparingly.

The plan's `**Cost shape:**` line summarizes the bill at a glance. In research mode at standard effort, the cost shape is typically `1 util + 2–4 research` (no $$$). In implementation mode at standard effort, it's `1 util + 1 high + 1 util + 1 research + 1 high` (2 $$$ calls).

If a step is too expensive, override per-run: pass `[model=openrouter/.../...cheap-model]` in the `subagent` call for that step.

## How to use

Call the `pipeline` tool with up to five parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `task`    | string | The task description, in the user's words or paraphrased. |
| `pipeline` | string (optional) | Name of a shipped/discovered recipe (see **Named recipes** below) instead of the generic inferred path. |
| `mode`    | `"research"` \| `"implementation"` (optional) | Pick the pipeline shape. Omit to infer from the task. Ignored when `pipeline` is set — a named recipe is a complete process. |
| `effort`  | `"surface"` \| `"standard"` \| `"deep"` (optional) | The depth. Omit to infer. Ignored when `pipeline` is set. |
| `hints`   | string[] (optional) | Constraints, prior decisions, non-default requirements, files of interest. |
| `inputs`  | object (optional) | Named `{{placeholder}}` values a recipe declares (e.g. `{ glob: "src/*.ts" }`). |
| `dryRun`  | boolean (optional) | If true, print the plan with cost shape but dispatch no subagents. Default false. |

The tool returns a structured **plan** as text. The plan is a numbered list of steps. Each step names an agent (high / research / util / dev / coordinator / custom) and gives a concrete subagent task. You execute each step with a `subagent` call.

### Named recipes and iteration

Run `/pipelines` to list discovered recipes (user `~/.pi/agent/pipelines/`,
project `.pi/pipelines/`, and package `pipelines/` dirs, later wins on name
collision) plus the built-in generic path. Pass `pipeline: "<name>"` to run
one instead of inferring mode/effort — a named recipe is a complete process
with no `mode`/`effort` knobs.

Some recipe steps declare `iterate=<name>`: one bounded subagent per unit in
a prior step's enumerated list (small context by construction, not one
subagent reading everything). When you call `pipeline` on a named recipe
(and it's not a `dryRun`), the tool returns a pre-compiled `pi-subagents`
chain (in the response text and in `details.chain`) with `expand`/`parallel`/
`collect` blocks already wired up — **call `subagent` with that exact chain
argument, verbatim.** Do not hand-author or edit the chain yourself: the
compiled shape accounts for runtime constraints (e.g. safe output-name
characters, the mandatory `collect` block) that are easy to get wrong by
hand.

### Execution

After the tool returns the plan, execute each step with `subagent` calls. Use the chain shorthand when the plan is sequential:

```
subagent({
  chain: [
    { agent: "util", task: "..." },
    { agent: "research", task: "..." }
  ]
})
```

For parallel extractions (research mode standard/deep), use the `tasks` array:

```
subagent({
  tasks: [
    { agent: "research", task: "Extract theme-1 findings..." },
    { agent: "research", task: "Extract theme-2 findings..." }
  ]
})
```

Pass the user's `hints` into every step's `task` string verbatim, prefixed with `HINTS:` so the subagent sees them as a separate block.

### Output to the user

After the plan completes, summarize in the user's language:

- What was done, in one or two sentences.
- The final accept/kick-back verdict (implementation mode) or the synthesis highlights (research mode).
- For kick-back: the top 1–2 things to do next.
- **Cost shape**: quote the plan's `**Cost shape:**` line verbatim so the user can see the bill.

## Slash command

The package also registers a `/pipeline` slash command. The user can invoke it directly with `/pipeline <task>`, or with mode/effort flags:

```
/pipeline research standard <task>
/pipeline implementation deep <task>
/pipeline dryrun <task>     # show the cost shape without dispatching
```

The slash command prepends a "use the pipeline tool" instruction to your context; you then proceed as if the user asked normally.

## Agent roster (one-liner reference)

| Agent | Tools | When |
|-------|-------|------|
| `high` | read-only | plan, judgment, accept. Never edits. |
| `research` | read, write, edit | review, debug, consolidate, docs. |
| `dev` | read, write, edit, bash | surgical code updates — reads code, reasons about it, makes targeted edits. |
| `util` | read, write, edit, bash | mechanical: gather, edit, test, fetch, git. Follows explicit specs. |
| `coordinator` | read, write, edit | opt-in, judgment-heavy enumeration — writes per-unit prompt templates and unit lists. Not used unless a recipe names it. |

A profile is just an agent — there's no separate cost-class concept. The
package's `agentOverrides` in `~/.pi/agent/settings.json` maps each agent
name to an explicit model. The mapping is at the package level, not the
skill — the user configures it once.
