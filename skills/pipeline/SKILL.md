---
name: pipeline
description: |
  Effort-scaled multi-agent pipeline that uses three tiers (high / research / util)
  and avoids putting expensive models on mechanical work. Use when the user wants
  a structured multi-step task done with cost awareness. Two modes: "research"
  (read-only/extraction, parent writes the spec, no high-tier calls in
  surface/standard) and "implementation" (code changes, high plans and accepts).
  The pipeline tool returns a numbered plan with per-step cost class ($ / $$ /
  $$$); the parent executes each step with subagent calls. Supports a dryRun
  flag that prints the cost shape without dispatching any subagents.
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

Call the `pipeline` tool with up to four parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `task`    | string | The task description, in the user's words or paraphrased. |
| `mode`    | `"research"` \| `"implementation"` (optional) | Pick the pipeline shape. Omit to infer from the task. |
| `effort`  | `"surface"` \| `"standard"` \| `"deep"` (optional) | The depth. Omit to infer. |
| `hints`   | string[] (optional) | Constraints, prior decisions, non-default requirements, files of interest. |
| `dryRun`  | boolean (optional) | If true, print the plan with cost shape but dispatch no subagents. Default false. |

The tool returns a structured **plan** as text. The plan is a numbered list of steps. Each step names a tier (high / research / util) and gives a concrete subagent task. You execute each step with a `subagent` call.

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

## Three tiers (one-liner reference)

| Tier | Agent name | Tools | When |
|------|------------|-------|------|
| `high` | `high` | read-only | plan, judgment, accept. Never edits. |
| `research` | `research` | read, write, edit | review, debug, consolidate, docs. |
| `util` | `util` | read, write, edit, bash | mechanical: gather, edit, test, fetch, git. |

These are the only three agents the pipeline references. The package's `agentOverrides` in `~/.pi/agent/settings.json` maps each tier to an explicit openrouter model. The mapping is at the package level, not the skill — the user configures it once.
