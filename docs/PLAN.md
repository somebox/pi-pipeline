# Plan — Status & Next Steps

> What's done, what's next, and what's still open. Living roadmap. For the
> *what/why* see [ARCHITECTURE.md](ARCHITECTURE.md); for the format see
> [SPEC.md](SPEC.md).

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

**Phase 2 — Iteration via compile-to-chain (NEXT; the v1.0 identity).**
- **Spike first (half-day):** confirm pi-subagents' `chain` `expand` step
  reads a prior structured output, fans out N tasks with `{item.x}`
  substitution, and that the runtime `tools` per-task override works
  end-to-end. If yes → compile target; if no → fall back to bounded *agents*
  (`dev-bounded.md`) instead of per-step `tools=`.
- `coordinator` profile (`agents/coordinator.md`) — opt-in, judgment only.
- `iterate=<name>` step kind: parse + render. `{unit}` / `{unit.*}`
  substitution (single braces, matching `{item.x}`).
- **Compiler:** translate an iterate step to a pi-subagents chain with an
  `expand` step, reusing their fanout/collect/concurrency. Write far less
  orchestration code than a from-scratch dispatcher.
- Per-step `tools=` override (general, not iteration-only): agent's tools
  minus exploration tools (`ls`/`find`/`grep`) by default; `bash` opt-in.
- `iterate=glob:<pattern>` shorthand for mechanical enumeration (no agent).
- `<name>.json` as the inter-step iterable contract (not a bare `units.json`).
- **Deprecate `maxTools`** (no-op hint for one release, then remove).
- Structural validation at load time: `iterate=` references resolve;
  `{unit.field}` fields exist in the producing step's schema.
- Proof-of-concept: `summarize-files` recipe validated against a real repo —
  audit shows N small dispatches vs one bloated one.
- Reduce steps read `summary-*.md` / `findings-*.md` (existing `reads=`
  glob already handles this).

**Phase 3 — Overview TUI (preview gate) + `pi pipeline new`.**
- Rich pre-run confirmation (or `confirm`+text v1 if `ctx.ui.custom()` in a
  tool handler needs API work).
- Agent→model mapping display + validation; first-run profile setup wizard.
- Input prompting; generic-path check.
- Structural validation surfaced (iterate refs, unit fields, agents).
- Coordinator-trust: show `per-unit-prompt.md` before dispatch.
- Metrics drive the cost estimate.
- **`pi pipeline new`** moved here from Phase 6 — iteration recipes have
  3-part enumerate/map/reduce structure worth scaffolding early; generate a
  filled-in skeleton so authors edit rather than wire from scratch.

**Phase 4 — List TUI.**
- `/pipeline` opens the browse list (replaces the interim `/pipelines` text
  command). Launch / view steps / edit recipe / edit profiles.

**Phase 5 — Dashboard TUI (replaces `/pipeline-costs`).**
- Live status + cost during a run, driven by `RunMetrics`.
- Last-run summary when idle.
- **Retry failed units** for partially-failed iterate steps (re-dispatch
  only units whose output file is missing).

**Phase 6 — Add/remove from the TUI.**
- Install/remove sources (`git:`/local/`npm:`).

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
5. **`tools=` per-step override — resolved as general, not iteration-only.**
   Any step can declare `tools=`; default is the agent's tools minus
   exploration tools (`ls`/`find`/`grep`), `bash` opt-in. (Was open Q5;
   settled by review.) **Still open:** whether pi-subagents' `expand` step
   honors a per-task `tools` override end-to-end — the runtime allowlist
   (`RUNNER_DYNAMIC_PARALLEL_KEYS`) includes `tools` but the schema I read
   didn't. The Phase 2 spike answers this; if it doesn't, fall back to
   bounded *agents* (`dev-bounded.md`) rather than per-step `tools=`.
6. **Trivial-iterable enumeration — resolved.** `iterate=glob:<pattern>`
   globs mechanically (no agent); judgment enumeration uses an agent
   (`high` or `coordinator`) that writes `<name>.json`. The coordinator is
   opt-in, not mandatory. (Was open Q6; settled by review.)
7. **Per-unit failure handling — resolved: proceed + flag + retry.** If one
   of N map dispatches fails, the step continues; the reduce step proceeds
   with successful outputs and flags the gap; the dashboard offers
   "retry failed units" (re-dispatch only units whose output file is
   missing). This replaces the parent's observed 5× blind retry loop.
   (Was open Q7; settled by review.)
8. **Per-unit concurrency — resolved: inherit from pi-subagents.** The
   compile-to-chain strategy reuses pi-subagents' `concurrency` param
   rather than building our own. Default 4; overridable in the recipe.
   (Was open Q8; settled by the compile strategy.)
9. **Coordinator trust — resolved: show in overview.** If a `coordinator`
   authored `per-unit-prompt.md`, the overview TUI shows it before
   dispatching. (Was open Q9; settled by review.)
10. **Unit schema declaration** — should an enumerate step declare its unit
    schema (e.g. `units: [path, mtime]` in frontmatter) so `{unit.field}`
    references can be validated at load time? Lean: yes — this is what makes
    the overview's structural validation (a `{unit.mtime}` typo failing at
    preview, not mid-run) actually work. Needs the schema syntax pinned down.
11. **Step identity for `iterate=` references** — `iterate=scope-files`
    currently binds to a step by its `<name>.json` filename, which means
    renaming the file breaks the reference. Should steps have an explicit
    `id:` (defaulting to the slugified phase or step number) that `iterate=`
    references instead? Lean: yes — decouples wiring from prose edits.
12. **Doc structure — resolved: split done.** The single 850-line SPEC.md
    is now `docs/{ARCHITECTURE,SPEC,PLAN,EXAMPLES,TUI}.md` with distinct
    jobs. Worked examples point at the real recipe files (single source of
    truth, no duplication).
