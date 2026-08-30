# Plan — Status & Next Steps

> What's done, what's next, and what's still open. Living roadmap. For the
> *what/why* see [architecture.md](architecture.md); for the format see
> [spec.md](spec.md). For versioned history see [CHANGELOG.md](../CHANGELOG.md).

## Implementation phasing

Shipped in slices — each phase is independently useful. **Recipes, profiles,
metrics, iteration, owned dispatch, flat `.pi/pipeline/` run artifacts
(resume/clean), and recipe checkpoints with the `sprint-planning` recipe are
done; the next big lever is the overview TUI.**

**Checkpoints + `sprint-planning` (DONE).**
- `checkpoint=<token>` step flag: fires after the step completes; the run
  pauses (status `paused`) with no blocking UI; the tool result carries run
  id, token, output paths, and exact resume syntax.
- `pipeline` tool params `checkpoint` / `checkpointDecision`
  (`approve`|`reject`|`revise`) / `checkpointNote`, validated against the
  pending checkpoint in the manifest; missing decision or mismatched token
  fails safely; recipe drift still refused. Approve preserves the completed
  checkpoint step and injects a non-empty note as USER CHECKPOINT FEEDBACK
  into remaining steps; reject/revise finalize the run `rejected` and
  (for revise) instruct a fresh run with the note as steering.
- Paused runs are discoverable by `latestIncomplete`; `rejected` runs are not
  auto-resumable.
- `dispatchIterate` persists a unit's returned text when the agent did not
  write its collection output (read-only `high`), verifies it, and marks the
  unit failed on persistence/verification failure.
- Shipped `pipelines/sprint-planning.md` — 11 steps, 2 checkpoints
  (`sprint-approved`, `next-action`); ≤20-task cap; a single execute step with
  per-task `high` review and a review-driven fix pass; tracker updates only
  against the detected, confirmed planning system, and only on the
  user-approved `next-action`.

**Simplification pass (DONE).** Removed dead/abandoned surfaces: the
`compileRecipeToChain` pi-subagents chain compiler (and its tests), the
`tools=` per-step flag (never honored by the runtime), and the `maxTools`
soft budget (unreliable). Recipes are now executed solely by the owned
dispatcher; tool bounding is agent-level only.

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
- Model-limit override docs (`~/.pi/agent/models.json`) — the actual cause
  of the original 400s. (The `maxTools` soft budget from this phase was
  removed in the simplification pass — real enforcement is bounded agents.)

**Phase 2 — Iteration via the owned dispatcher (DONE; the v1.0 identity).**
- **Spike confirmed live against a real repo (`~/src/cards`):** the owned
  dispatcher reads a prior step's `<name>.json`, fans out one bounded
  subagent per unit with `{unit}` / `{unit.field}` substitution, and executes
  end-to-end.
- `coordinator` profile (`agents/coordinator.md`) — opt-in, judgment only.
- `iterate=<name>` step kind: parse + render. `{unit}` / `{unit.*}`
  substitution (single braces, distinguishing per-unit placeholders from
  `{{input}}` placeholders substituted at plan-build time).
- **Tool bounding is agent-level only.** The earlier `tools=` per-step flag
  was never honored by the runtime and is removed; pick (or add) an agent
  whose own `tools:` frontmatter matches the bound you want.
- **Agent `tools:` allowlist gotcha (found live):** `--tools` allowlists
  built-in, extension, *and* dynamically-registered tools. `structured_output`
  is registered per-step by the runtime (only when `outputSchema` is
  present), not a built-in — so any agent with an explicit `tools:` list that
  omits `structured_output` silently fails every `outputSchema` step with
  "Missing structured_output call", even though the model behaved correctly.
  All 5 shipped agents (`dev`, `util`, `research`, `high`, `coordinator`) now
  include `structured_output` in their `tools:` line; `test/agents.test.ts`
  guards the invariant.
- `<name>.json` as the inter-step iterable contract (not a bare `units.json`).
- Follow-ups carried out of Phase 2:
  - `iterate=glob:<pattern>` shorthand for mechanical enumeration (no agent)
    is **not yet implemented**.
  - Structural validation at load time (`iterate=` references resolve;
    `{unit.field}` fields exist in the producing step's schema) is **not yet
    implemented**; fold it into Phase 3's overview TUI validation pass.
- Proof-of-concept: `summarize-files` validated against a real repo
  (`~/src/cards`, Go codebase) — enumerate step wrote 3 files via
  `structured_output`, 3 parallel `dev` slots each read one file and wrote a
  correct, distinct summary. N small dispatches, not one bloated one.
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

## Open and recently resolved questions

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
5. **`tools=` per-step override — resolved then removed: agent-level only.**
   A per-step `tools=` flag was never honored by the runtime (the compiled
   chain it targeted was abandoned, and the owned dispatcher only reads the
   agent profile's `tools:`). It was kept for a while as a display-only flag
   and has now been deleted entirely from the parser and `PlanStep`. Real
   tool bounding is agent-level only: pick an agent (or add a bounded
   variant, e.g. `dev-bounded.md`) whose own `tools:` frontmatter matches
   what the step needs.
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
8. **Per-unit concurrency — resolved: own dispatcher with the same cap.** The
   dispatcher owns the per-unit worker pool directly and keeps the same
   default concurrency cap (4), overridable in the recipe. (Was open Q8;
   originally settled by the compile strategy, then preserved by the
   own-dispatch pivot.)
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
12. **Doc structure — resolved: split done.** The single 850-line root
    `SPEC.md` is now a shim to `docs/{architecture,spec,plan,examples,tui}.md`
    with distinct jobs. Worked examples point at the real recipe files
    (single source of truth, no duplication).
