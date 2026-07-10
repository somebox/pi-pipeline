# Architecture

> What pi-pipeline *is*, the model it's built on, and why. The stable big
> picture. For the recipe grammar see [spec.md](spec.md); for status and
> next steps see [plan.md](plan.md).

## Goal

pi-pipeline is for **building pipelines that iterate over iterable things —
files, projects, bugs, images, ideas — with one focused subagent per unit,
small context by construction.** The whole loop (define → discover →
preview → run → watch → share) needs no TypeScript beyond the dispatcher
itself: a pipeline is a markdown recipe. The runtime enforces small
per-unit context *by structure* — bounded agents that can't explore — rather
than by asking the model to self-limit. The pipeline tool executes the plan
itself (no parent-LLM orchestration), so there's no paraphrase drift to
defend against.

The whole loop (define → discover → preview → run → watch → share) needs no
TypeScript: a pipeline is a markdown recipe. The runtime enforces small
per-unit context *by structure* — bounded agents that can't explore — rather
than by asking the model to self-limit.

This supersedes the earlier "recipe as a fixed checklist with parallel
fan-out" framing. Checklists are still supported, but iteration is the
first-class model and the answer to the context-bloat problem that broke
the original `code-quality` run (a single `util` subagent read 24 files,
accumulated 188k tokens, then 400'd on a model-limit mismatch — see
**Why iteration** below, and the README's "Model limits" section).

## Design principles

1. **Prose first.** A pipeline is a numbered checklist with agent
   annotations. The user's hand-written `code-quality` (see
   [examples.md](examples.md)) is the source of truth — if the format can't
   express that, the format is wrong.
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
   a slim shared onboarding + the prompt — and a **bounded tool set** so
   they *can't* explore. "Bounded" means the agent's normal tools *minus
   exploration tools* (`ls`, `find`, `grep`) — not a fixed `{read, write}`
   allowlist — so it composes with whatever a custom agent brings. A recipe
   step can *declare* `tools=<list>` for documentation/validation, but
   enforcement is **agent-level only**: pi-subagents' compiled chain schema
   (`ChainItem`, `DynamicParallelTemplateSchema`) has no per-task `tools`
   field at all (`additionalProperties: false`), confirmed by the Phase 2
   spike against a real repo. So the real lever is picking (or adding) an
   agent whose own `tools:` frontmatter matches the bound you want — e.g.
   `code-quality` step 8 "Present" should route to an agent whose `tools:`
   is just `read`, not declare `tools=read` on the step. Small context is
   enforced by agent choice, not requested via a step flag that the runtime
   would reject anyway.
6. **Coordinator is opt-in, split into two concerns.** Enumeration is often
   mechanical (a glob — no agent call); authoring a good per-unit prompt is
   judgment (a `coordinator` agent). The parent LLM doesn't write per-unit
   tasks (it paraphrases and drops instructions — observed in the first
   `code-quality` run). When judgment is needed, a `coordinator` writes a
   prompt *template* as its deliverable when recipe prose alone is not enough;
   the orchestrator substitutes `{unit}` and dispatches. The template is an
   optional contract, not a requirement for every iteration. (See **Enumeration
   is two concerns** in [spec.md](spec.md).)
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
  recipe's steps.
- **No replacement of TS built-ins that need logic.** Recipes and TS
  pipelines coexist; the generic inference path and `implementation/deep`
  stay TS.
- **Task-string phrasing does not retroactively add iteration.** The
  recipe's structure is authoritative. Typing `/pipeline code-quality audit
  every file in src/` does not turn a non-iterating recipe into an iterating
  one — the recipe's steps run as written. Iteration is declared in the
  recipe, not inferred from the user's phrasing. (Documented so it's a
  decision, not a silent gap someone reports as a bug.)
- **`maxTools` is deprecated.** Phase 1.5's soft tool-call budget proved
  unreliable (the parent rewrites the task and drops it). It's superseded by
  the bounded-`tools=` mechanism. Kept in code for one release as a no-op
  hint; removed in Phase 2. New recipes should not use it.

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

1. **Enumerate** — produce a *structured list of units* as JSON. For trivial
   cases (a glob, a directory listing) this is **mechanical** — no agent
   call. For judgment cases ("generate 8 ideas", "match screenshots to
   cards") an agent produces the list. The deliverable is `<name>.json`, not
   prose. (See "Enumeration is two concerns" in [spec.md](spec.md).)
2. **Map** — the orchestrator spawns **one bounded subagent per unit**. Each
   subagent receives: the unit itself, a slim shared onboarding (prepared
   once: the card list, the repo standards, etc.), and the **per-unit prompt
   template**. The orchestrator substitutes `{unit}` (and any `{unit.*}`
   fields) into the template and dispatches. The subagent has a bounded tool
   set — it cannot explore beyond the unit. Each map step is a set of N
   small, isolated dispatches.
3. **Reduce** — a later step reads the per-unit outputs (`summary-*.md`,
   `findings-*.md`) and synthesizes. The reduce agent reads exactly what the
   map step wrote, nothing more.

**Per-unit chaining.** A unit's map subagent can itself be multi-step
("commits → match → review → attach → rename") — that's a focused agent
with its own tool budget, not a nested pipeline. The point is that the
subagent works on *one unit end-to-end* with only that unit in context.

**The iterable is content, not code.** "N ideas" or "2-3 variations" are
prompt-template content; the orchestrator just runs the map over whatever
list the enumerate step produced. This is what makes a pipeline work for
ideation (generate N → research each → sketch 2-3 → review all → iterate)
as naturally as for files (summarize each file → merge).

## Implementation strategy: own the dispatcher

**The pipeline tool executes plans itself.** When a named recipe runs (not
a dry-run), the tool's `execute` method:

1. Resolves the plan from the recipe
2. Creates a run workspace (`.pi/run/<run_id>/targets/`, `collections/`,
   `logs/`, `temp/`) and a manifest shell
3. For each step, spawns a child `AgentSession` via pi's first-party SDK
   (`createAgentSession` from `@earendil-works/pi-coding-agent`), prompting
   it with the composed task text (workspace paths resolved, temp dir
   injected, reads/outputs from the new `output=summary` / `reads=summary`
   target grammar)
4. For iterate steps, reads the prior step's `targets/<name>.json` unit
   list and dispatches N child sessions in parallel with a concurrency cap
   (default 4)
5. Updates the manifest inline with each step's real `completed` /
   `failed` / `partial` status and usage extracted from the session
6. Finalizes the manifest with `deriveRunStatus` (any failed → `failed`;
   any partial → `partial`; all completed → `completed`)
7. Returns a summary with the cost rollup

The parent LLM does **not** orchestrate subagent dispatch. There is no
"MUST immediately call the subagent tool with this chain" instruction;
there is no risk of the parent paraphrasing or dropping the task. The
pipeline runs deterministically inside the tool's `execute`.

### Why own the dispatcher (not pi-subagents)

The 0.5.0 plan assumed `@tintinweb/pi-subagents` would provide a chain
runtime (`expand`/`collect`/`{outputs.*}`) and we'd compile onto it.
Review against the published package (0.12.0 installed, 0.13.0 latest)
found:

- The chain API does not exist in any published release
- The tool was silently renamed `subagent` → `Agent`, leaving every
  `event.toolName === "subagent"` hook in the extension dead
- No local fork was recoverable

`@tintinweb/pi-subagents` is a thin wrapper over pi's first-party SDK — the
same package we already declare as a peerDependency. Owning the dispatcher
depends on the SDK directly, eliminating the third-party extension as a
variable. See [artifacts.md](artifacts.md) §Relationship to pi-subagents
runtime for the full rationale.

### The runtime contract

Each step gets:
- A `cwd` (the project root, so the agent sees the real repo)
- A bounded `tools:` allowlist from the agent profile (e.g. `read, write,
  edit, bash, structured_output`)
- A `systemPrompt` from the agent's markdown body (with `replace` or
  `append` mode)
- A `model` resolved from the agent profile → tier defaults (from
  `subagents.agentOverrides` in settings.json) → registry default
- A `sessionManager.inMemory(cwd)` (no on-disk session persistence for
  pipeline steps; full sessions are recorded via the existing subagent
  session JSONL path if the agent has `persist_session: true`)
- A `resourceLoader` (`DefaultResourceLoader` with `noPromptTemplates`,
  `noThemes`, `noContextFiles`; system prompt overridden) so built-in tools,
  skills, and extensions are properly loaded — a hand-rolled stub silently
  broke `structured_output` registration during development

The agent runs to completion, we extract `usage` and the final `text` from
`session.messages`, and `session.dispose()` to free resources. Per-unit
isolation in iterate steps comes from the worker pool (`Promise.all` over a
bounded number of in-flight dispatches); per-unit errors are caught and
recorded in the manifest as `failed` with the error string.

The coordinator profile and a separate per-unit prompt template are no longer
mandatory for ordinary iteration. The parent LLM no longer rewrites per-unit
tasks, so there's no paraphrase drift to defend against. Recipes carry the
full task text as prose; the dispatcher injects paths and dispatches verbatim.
Use `coordinator` only when judgment-heavy enumeration or a reviewer-visible
prompt template is valuable.

## Profiles

A **profile** is a named agent. The package ships five:

| Profile | Description (from the agent's frontmatter) |
|---|---|
| `dev` | Low-cost model good at surgical code updates. |
| `util` | Mechanical work: finding files, summarizing, running tests. |
| `research` | Review, debugging, documentation, consolidation. |
| `high` | High-level model for software architecture, planning, judgment. |
| `coordinator` | Authors the per-unit prompt template for complex iteration (opt-in; see "Enumeration is two concerns" in [spec.md](spec.md)). |

- Each profile is an `.md` file in `agents/` (e.g. `agents/dev.md`) with a
  `description:` in frontmatter. Adding a profile = adding an agent file.
- The user binds profiles to models via `subagents.agentOverrides` in
  `~/.pi/agent/settings.json` (existing mechanism — no new config concept).
  To reduce first-run friction, the package ships sane zero-config model
  defaults per profile; the overview TUI's "Edit profiles" is the first-run
  setup wizard (pick models for any unbound profiles before the first run).
- Recipes reference agents by name. Any agent (built-in or custom) can be
  referenced; the overview TUI validates that referenced agents are configured.
- **Cost classes (`$`/`$$`/`$$$`) are dropped.** The plan shows agent names
  and real resolved models, not abstract cost symbols. The cost shape line
  becomes `1 util + 2 dev + 3 research + 1 high` — more honest. Real costs
  are shown in the overview/dashboard per model.

### Profiles → agents

Recipes reference agents by name. Any agent (built-in or custom) can be
referenced; the dispatcher loads the named profile from `agents/<name>.md`
at run time. The agent frontmatter (`tools:`, `thinking:`,
`systemPromptMode:`, `model:`, `maxTurns:`) is the contract. The user binds
profiles to models via `subagents.agentOverrides` in
`~/.pi/agent/settings.json` (existing mechanism — no new config concept).

## What stays TS

Built-in pipelines with real logic stay in `src/lib.ts`:

- The generic inference path (unnamed `pipeline` tool call → infer mode/effort
  → pick a built-in template).
- `implementation/deep` — the kick-back loop (high rejects → re-run merge up
  to 3×) is a loop, not a fixed sequence.

The boundary: **fixed checklist → recipe; needs loops/branching → TS.** Most
use cases (review-pr, migrate, test-writing, debug, onboarding, postmortem,
doc-gen, verify-source, code-quality) are fixed checklists → recipes.
