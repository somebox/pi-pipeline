# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-08-30

### Added
- **Recipe checkpoints.** Step header flag `checkpoint=<stable-token>` (`src/recipes.ts`, `PlanStep.checkpoint`, manifest step `checkpoint`). When a checkpoint step **completes**, the run is persisted with status `paused` (no blocking UI) and the `pipeline` tool returns the run id, checkpoint token, the step's output paths, the run log path, and the exact resume syntax. `renderPlan` and the run README surface checkpoints.
- **Checkpoint resume params** on the `pipeline` tool: `checkpoint`, `checkpointDecision` (`approve` | `reject` | `revise`), `checkpointNote` — valid only with `resume` on a paused run. The token is validated against the pending checkpoint in the manifest; resuming without a decision or with a mismatched token fails safely; recipe hash drift remains refused.
  - `approve`: the completed checkpoint step is preserved (skipped by `planDelta`), the decision/note is recorded under `manifest.checkpoints`, and a non-empty note is injected into every remaining step as `USER CHECKPOINT FEEDBACK`.
  - `reject`: recorded and the run is finalized `rejected` without executing later steps.
  - `revise`: major-revision feedback recorded, run stopped (`rejected`), and the result instructs starting a fresh run of the same recipe with the note as steering.
- **`paused` / `rejected` run statuses.** Paused runs are discoverable by `latestIncomplete` / `/pipeline-runs`; finalized `rejected` runs are not auto-resumable and do not shadow paused runs.

### Added
- **Recipe checkpoints.** Step header flag `checkpoint=<stable-token>` (`src/recipes.ts`, `PlanStep.checkpoint`, manifest step `checkpoint`). When a checkpoint step **completes**, the run is persisted with status `paused` (no blocking UI) and the `pipeline` tool returns the run id, checkpoint token, the step's output paths, the run log path, and the exact resume syntax. `renderPlan` and the run README surface checkpoints.
- **Checkpoint resume params** on the `pipeline` tool: `checkpoint`, `checkpointDecision` (`approve` | `reject` | `revise`), `checkpointNote` — valid only with `resume` on a paused run. The token is validated against the pending checkpoint in the manifest; resuming without a decision or with a mismatched token fails safely; recipe hash drift remains refused.
  - `approve`: the completed checkpoint step is preserved (skipped by `planDelta`), the decision/note is recorded under `manifest.checkpoints`, and a non-empty note is injected into every remaining step as `USER CHECKPOINT FEEDBACK`.
  - `reject`: recorded and the run is finalized `rejected` without executing later steps.
  - `revise`: major-revision feedback recorded, run stopped (`rejected`), and the result instructs starting a fresh run of the same recipe with the note as steering.
- **`paused` / `rejected` run statuses.** Paused runs are discoverable by `latestIncomplete` / `/pipeline-runs`; finalized `rejected` runs are not auto-resumable and do not shadow paused runs.
- **Durable per-unit outputs in `dispatchIterate`.** When a unit step declares a collection output and the agent (notably read-only `high`) did not write it, the returned text is persisted to the resolved per-unit path and verified; persistence/verification failure marks the unit failed — mirroring singleton output semantics. `persistUnitOutput` / `resolveCollectionOutputAbs` are exported for tests.
- **`pipelines/sprint-planning.md`** — end-to-end sprint recipe: planning-system discovery (local markdown, somebox/cards CLI, `gh` issues, TODO/FIXME/HACK markers, recent git), source/conflict reporting and system-of-record selection, candidate scoring, capped sprint tasks (≤20, overflow to follow-ups) partitioned into low/medium lists, per-task work logs, one per-task `high` review (`review-{unit.path}`), fix pass, verification + docs update, follow-up filing without duplicates, final `high` review, and a completion summary. Pauses at `checkpoint=candidate-sprint`, `checkpoint=sprint-plan-approved` (before any tracker mutation or implementation), and `checkpoint=next-action` (only the explicitly approved action runs; never commits or closes work without explicit instruction).
- **Empty iterate lists** complete the step without dispatch instead of failing, so partitioned task/fix lists may legitimately be empty.
- Iterate steps now inject resolved `reads=` absolute paths into the composed unit task (previously only singletons did).
- `src/checkpoint.ts` — pure checkpoint helpers (`pendingCheckpoint`, `validateResumeDecision`, `applyCheckpointFeedback`, result renderers).
- Tests: `test/checkpoint.test.ts` (parser flow-through, paused `latestIncomplete` discoverability, decision validation, feedback injection, renderers), per-unit persistence tests in `test/dispatcher.test.ts`, checkpoint expectations in `test/recipes.test.ts`.

### Changed
- `buildManifestStep` records collection outputs at `collections/<name>` (previously a misleading `targets/<name>.<ext>`), matching what `recordStepResult` writes.
- `docs/spec.md` documents the checkpoint syntax and semantics; `docs/artifacts.md`, `docs/plan.md`, and `docs/examples.md` updated for the new statuses and the `sprint-planning` recipe.
- **`sprint-planning` reworked: 23 steps → 11, 3 checkpoints → 2.** Discover+select
  and collect+score are each merged into one step. The low/medium tier split and
  its four mechanical partition steps are gone — the dispatcher fans out one
  bounded `dev` per task and a `high` review + review-driven fix pass covers
  judgment tasks without a tier split. The separate candidate-sprint checkpoint
  is gone (the plan-approval checkpoint is the single pre-implementation gate).
  The pre-execution tracker mutation is gone — tracker updates happen only on
  the user-approved `next-action`. Two checkpoints remain: `sprint-approved`
  (before any implementation) and `next-action` (commit/close only when
  explicitly approved).

### Removed
- **`compileRecipeToChain` and the chain compiler** (`src/recipes.ts`) — the
  pi-subagents `expand`/`parallel`/`collect` chain it compiled onto was
  abandoned for the owned dispatcher; the compiler was dead at runtime, kept
  only by golden-file tests. Deleted along with its dead helpers
  (`slugifyAs`, `resolveTargetPath`, `resolveReadPath`, `injectCollectionRef`)
  and the chain tests in `test/recipes.test.ts` / `test/targets.test.ts`.
  `test/targets.test.ts` now asserts only parse + `validatePlanTargets` for real
  recipe files.
- **`tools=` per-step flag** — never honored by the runtime (the owned
  dispatcher only reads the agent profile's `tools:`). Removed from the parser,
  `PlanStep`, `ParsedStepHeader`, and the spec. Tool bounding is agent-level
  only (documented).
- **`maxTools` soft tool-call budget** (`PlanStep.maxTools`, `toolBudgetInstruction`,
  `withToolBudget`, the `maxTools=N` header flag, the `[budget: N tools]` render
  tag, the `probe` recipe's `maxTools=5`). It was unreliable (the parent
  rewrites the task and drops it); real enforcement is bounded agent `tools:`
  allowlists.

## [0.6.0] — 2026-08-29

### Added
- Flat per-run folders under `.pi/pipeline/<YYYY-MM-DD-HHMMSS-recipe>/` with a live `README.md` log, `metrics.json`, `targets/`, `collections/`, `logs/`, and purgeable `scratch/`.
- Mechanical end-of-run summary (no extra model call): status, step table, totals, optional recipe `summary`/`report` target embedded in the run README. Always reported to the user with path + cost + time.
- `/pipeline-runs`, `/pipeline-resume [id]`, `/pipeline-clean` (`--failed`, `--all`). Pipeline tool `resume` param (`latest` or a run id/prefix). `planDelta` skips completed steps and retries only failed iterate units.
- Best-effort `.gitignore` bootstrap for `.pi/pipeline/` when the project file exists and does not already ignore `.pi/`.

- Package agent discovery (`resolvePackageAgentDirs`) and `loadAgentProfileFromDirs`, so recipes can use a package's bundled agents when the target repo has no local `agents/` directory (project/user still override).
- Dispatcher persists missing singleton/collection outputs from the agent's final response when the tool profile can't write files, validates required JSON outputs after a step, and surfaces named singleton `targets` on `StepResult` / the manifest.
- `pipeline` tool `review` flag (and review-ish hints) opens an interactive confirm before dispatching a named recipe; cancel returns the plan with no steps run.
- Abort handling: mid-run interrupt marks the current step `aborted` and later steps `blocked`; per-session abort signals stop the active subagent session.

### Changed
- Run artifacts moved from `.pi/run/<recipe>-<date>-<hex>/` to `.pi/pipeline/<YYYY-MM-DD-HHMMSS-recipe>/`. Successful runs prune immediately to README + metrics. Scratch is always project-local (`scratch/`), never a configurable external temp root.
- `docs-audit` recipe expanded to an 8-step flow: discover standards → inventory with git metadata → per-file analysis → subject index → phased reorg plan → execute per phase → fix links/frontmatter → changelog + summary.
- Documentation housekeeping: lowercase docs paths (`docs/architecture.md` etc.), link fixes, and small stale-status cleanups.
- Manifest step recording preserves prior phase/agent/outputs and increments `attempts` across retries.

### Removed
- `pipeline.artifacts` settings (`root`, `retain_runs`, `retain_logs`, `temp_root`, `max_retained_runs`). No migration of existing `.pi/run/` folders.

## 0.5.0 — 2026-07-04

Phase 2: iteration via compile-to-chain, verified live against a real repo.
Recipes can now declare an `iterate=<name>` step that compiles to a native
`pi-subagents` dynamic-fanout chain (`expand`/`parallel`/`collect`) instead of
a hand-rolled dispatcher — one bounded subagent per unit, small context by
construction.

### Added
- `iterate=<name>` step flag (`src/recipes.ts`): binds a step to a prior
  step's `<name>.json` unit list. `{unit}` / `{unit.field}` per-unit
  placeholders, matching pi-subagents' `{item.x}` convention.
- `tools=<list>` step flag: parsed onto `PlanStep.tools` for
  validation/display. **Not compiled into the chain** — see "Fixed" below.
- `compileRecipeToChain(plan)`: translates a parsed `Plan` into a
  `pi-subagents` chain array. Iterate steps become
  `{ expand, parallel, collect }` dynamic-fanout blocks; steps writing a
  `.json` file auto-register `as: <slugified-stem>` plus an `outputSchema`
  requiring `{ items: [{ path }] }`, forcing the `structured_output` tool
  path so downstream `iterate=` references are well-typed.
- `pipeline` tool now emits the compiled chain (`details.chain`) and an
  instruction block telling the parent LLM to call `subagent` with it
  directly, for any named recipe run (not the generic inferred path, not
  `dryRun`).
- `agents/coordinator.md` — opt-in high-tier profile for judgment
  enumeration (writing a per-unit prompt template), as distinct from
  mechanical enumeration (a plain `util`/glob step).
- `pipelines/summarize-files.md`, `pipelines/docs-audit.md`,
  `pipelines/housekeeping.md` — new shipped recipes; `summarize-files` is
  the iteration proof-of-concept, verified live end-to-end.
- `test/agents.test.ts` — guards that every shipped agent with an explicit
  `tools:` allowlist includes `structured_output`.
- `docs/{architecture,spec,plan,examples,tui}.md` — split from a single
  `SPEC.md` into a modular docs directory.

### Fixed (found via a live spike against a real Go repo, `~/src/cards`)
- **Dynamic-parallel steps require a `collect` block.** pi-subagents'
  `isDynamicParallelStep` type guard checks for `"collect" in step`; a
  compiled iterate step missing it was misclassified as a plain sequential
  step, producing `Unknown agent: undefined`. `compileRecipeToChain` now
  always emits `collect: { as }`.
- **Auto-derived `as`/`collect.as` names must not contain hyphens.**
  pi-subagents validates output names against
  `/^[A-Za-z_][A-Za-z0-9_]*$/`; names derived from a hyphenated filename
  stem (e.g. `scope-files.json` → `scope-files`) failed validation.
  `compileRecipeToChain` now slugifies every derived name to underscores
  (`scope_files`, `collected_scope_files`).
- **Per-step `tools=` cannot be compiled through to the chain.**
  pi-subagents' `ChainItem` and `DynamicParallelTemplateSchema` both set
  `additionalProperties: false` and declare no `tools` field — a compiled
  step carrying `tools` is rejected by the tool call schema before the
  chain runs. `compileRecipeToChain` no longer emits `step.tools` into
  compiled output (was attempted, always failed validation); tool bounding
  is agent-level only (an agent's own `tools:` frontmatter).
- **Agents with an explicit `tools:` allowlist silently lost
  `structured_output`.** `--tools` allowlists built-in, extension, *and*
  dynamically-registered tools; `structured_output` is registered
  per-step by the runtime (only when a step declares `outputSchema`), not
  a built-in. Every shipped agent (`dev`, `util`, `research`, `high`,
  `coordinator`) declared an explicit `tools:` list that omitted it,
  so any `outputSchema` step routed to them failed with "Missing
  structured_output call" even when the model behaved correctly. Added
  `structured_output` to all five agents' `tools:` lines.
- **Package metadata version corrected.** The `package.json` version lag noted
  in the 0.4.0 backfill was corrected as part of the 0.5.0 release.

### Removed
- `/pipeline-spike` debug command — a hand-authored, machine-specific,
  already-stale test chain (missing `collect`, hyphenated names, a
  nonexistent `tools` field on the parallel block) used during Phase 2
  development. Superseded by the real `summarize-files` recipe and the
  `pipeline` tool's own compiled-chain output; kept as debug scaffolding
  would just drift again.

## 0.4.0 — 2026-07-02

Phase 1: recipes, profiles, metrics. (Tagged at the time; this entry
backfills the changelog record — `package.json`'s `version` field was not
bumped alongside the tag, corrected in 0.5.0.)

### Added
- Markdown recipe parser (`src/recipes.ts`) and discovery
  (`src/discovery.ts`): user (`~/.pi/agent/pipelines/`), project
  (`.pi/pipelines/`, walking up from cwd), and package
  (`<package>/pipelines/`) sources, later wins on name collision.
- `pipeline` tool's `pipeline`/`inputs` params: run a named recipe instead
  of the generic inferred path.
- `/pipelines` command: list discovered recipes plus the built-in generic
  path, with cost shape per recipe.
- `agents/dev.md` — low-cost surgical-edit profile between `util` and
  `research`. Dropped `costClass`/`tier` in favor of a plain `agent` field;
  a profile is just an agent (see `docs/architecture.md` principle #2).
- `RunMetrics` as the single source of truth for `/pipeline-audit` (task,
  model, errors, attempts, tool calls, artifact paths, context-overflow
  flag).
- Shipped `pipelines/code-quality.md` and `pipelines/verify-source.md`.

## 0.3.0 — 2026-07-02

Initial soft release. Extracted from a personal pi-config directory into a
standalone, git-installable pi package. The extension, agents, and skill are
unchanged from the in-tree 0.2.x version; this release is about packaging,
test coverage, and repo hygiene.

### Added
- `src/lib.ts` — pure-logic module (plan builders, cost rollup, model
  resolution, formatters) extracted from `src/extension.ts`, with no pi
  imports. Unit-testable with plain `node --test`.
- `test/lib.test.ts` — 28 unit tests (inference precedence, all 6
  mode×effort template selections, hint injection, fallback cost attribution
  + per-step↔per-model reconciliation, settings readers with fixtures, and
  `injectTierModels` across single / `tasks` / `chain`+`parallel` shapes).
- `tsconfig.json` — strict, `noEmit`, `allowImportingTsExtensions`. Run
  `npm run typecheck` when `typescript` is installed.
- `package.json` scripts: `test`, `test:verbose`, `typecheck`.
- `/pipeline-costs` command — breakdown of the last pipeline operation by
  step and model (tokens/cost per model and per step, with fallback
  attempts charged to the model that served them).
- Live progress in the status line while a subagent runs (agent / tool /
  path / tokens), via `tool_execution_update`.
- Tier-model pinning: at every `subagent` `tool_call`, the configured
  tier→model map is read from the live `~/.pi/agent/settings.json` and
  injected into the tool args for `util` / `research` / `high` when the
  caller didn't set one. Defends against the parent process having stale
  `agentOverrides` (the "util steps run on glm-5.2" failure mode).
- Model fallback via OpenRouter's native server-side `models` array, keyed
  by tier class. Tunable via `pipeline.modelFallbacks` in settings.json.

### Changed
- `src/extension.ts` is now a thin wiring shell (~270 lines) that imports
  from `./lib.ts`; the pure logic is testable without pi.
- Cost report per-step total now sums model attempts when present, so the
  per-step and per-model rollups reconcile (previously they could disagree
  by the cost of a failed fallback attempt).
- `normalizeModel`'s thinking-suffix regex is anchored so non-thinking
  colon suffixes (e.g. `:lowdown`) are not stripped.
- Cost state is reset on `session_start` so `/pipeline-costs` never leaks
  data from a previous session in a long-lived process.

