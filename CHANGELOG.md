# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Removed
- Nothing (first standalone release).
