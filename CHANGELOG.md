# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Package agent discovery (`resolvePackageAgentDirs`) and `loadAgentProfileFromDirs`, so recipes can use a package's bundled agents when the target repo has no local `agents/` directory (project/user still override).
- Dispatcher persists missing singleton/collection outputs from the agent's final response when the tool profile can't write files, validates required JSON outputs after a step, and surfaces named singleton `targets` on `StepResult` / the manifest.
- `pipeline` tool `review` flag (and review-ish hints) opens an interactive confirm before dispatching a named recipe; cancel returns the plan with no steps run.
- Abort handling: mid-run interrupt marks pending/running steps `blocked` and leaves remaining steps unstarted; per-session abort signals stop the active subagent session.

### Changed
- `docs-audit` recipe expanded to an 8-step flow: discover standards → inventory with git metadata → per-file analysis → subject index → phased reorg plan → execute per phase → fix links/frontmatter → changelog + summary.
- Documentation housekeeping: lowercase docs paths (`docs/architecture.md` etc.), link fixes, and small stale-status cleanups.
- Manifest step recording preserves prior phase/agent/outputs and increments `attempts` across retries.

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

