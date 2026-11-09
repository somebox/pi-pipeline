# pi-pipeline

Multi-agent pipelines for pi. Define a pipeline as a **markdown recipe** (a numbered checklist with agent/profile annotations) and run it over anything iterable (files, screenshots, ideas, bug reports) with focused, bounded subagents and small context by construction.

For detailed design, grammar, and next steps, see the documentation in `docs/`:
- [Architecture & Design Principles](docs/architecture.md) — Why we build pipelines, profiles/agents, execution models, and context-isolation design.
- [Specification / Recipe Format](docs/spec.md) — The normative spec for writing pipeline markdown files, header syntax, variables, and resolution rules.
- [Project Roadmap (PLAN)](docs/plan.md) — Status, implementation stages (Phases 1–6), resolved questions, and open challenges.
- [Worked Examples](docs/examples.md) — Real-world pipeline recipes like `code-quality` and `verify-source` with walk-throughs.
- [Artifacts](docs/artifacts.md) — How steps name, store, and hand off outputs: the directory model, named outputs, and skill-based delivery.
- [TUI & Dashboards](docs/tui.md) — User interface design for list views, pre-run confirmations, and live run dashboards.

---

## What it is

This package provides:
1. **A `pipeline` tool** — The LLM calls this with a recipe name and inputs. For named recipes it previews the plan (optionally via confirm) and runs the steps itself via the owned dispatcher; dry-run returns the plan only. Recipe steps can declare `checkpoint=<token>` approval gates: after such a step completes the run pauses (status `paused`) and the tool result carries the run id, token, output paths, and exact resume syntax (`resume` + `checkpoint` + `checkpointDecision: approve|reject|revise` + optional `checkpointNote`, injected into remaining steps as `USER CHECKPOINT FEEDBACK` on approve).
2. **A `/pipeline` slash command** — Run a specific recipe directly (`/pipeline <recipe> <task>`) or invoke a generic fallback pipeline (`/pipeline <task>`).
3. **Utility slash commands** — `/pipelines` to browse installed recipes, `/pipeline-runs` to list runs in `.pi/pipeline/`, `/pipeline-resume [id]` to continue an aborted or failed run, `/pipeline-clean` to prune workspaces to the summary+metrics, `/pipeline-costs` for a per-step model cost rollup, and `/pipeline-audit` for detailed diagnostic and error-cascade analysis.

Named recipe runs live in `.pi/pipeline/<YYYY-MM-DD-HHMMSS-recipe>/`. Open that folder's `README.md` for status, the step log, time, and cost. Successful runs keep only `README.md` and `metrics.json`.
4. **Profiles** — `dev`, `util`, `research`, `high`, and `coordinator` — mapped to real models in `settings.json`.
5. **Recipes** — the package ships `sprint-planning` (an 11-step end-to-end sprint with three approval checkpoints: initial planning steering, plan approval before implementation, and a final next-action gate that only commits or closes work when explicitly approved), plus `code-quality`, `docs-audit`, `housekeeping`, `probe`, `summarize-files`, and `verify-source`.

---

## Install

### Public Install (production)
```bash
pi install git:github.com/somebox/pi-pipeline
```
Update using `pi update git:github.com/somebox/pi-pipeline`.

### Local Install (for development)
Clone the repository:
```bash
git clone git@github.com:somebox/pi-pipeline.git ~/src/pi-pipeline
```
Add the absolute path to your `~/.pi/agent/settings.json`:
```json
{
  "packages": ["/home/user/src/pi-pipeline"]
}
```
Run `/reload` inside pi to hot-reload changes. You can run the test suite using `node --test --experimental-strip-types test/*.test.ts` (requires Node ≥22, no external dependencies).

---

## Configuration

pi-pipeline reads its model settings from `~/.pi/agent/settings.json` and
never writes that file. For example:

```json
{
  "subagents": {
    "agentOverrides": {
      "util":     { "model": "openrouter/minimax/minimax-m3" },
      "dev":      { "model": "openrouter/~openai/gpt-luna-latest", "thinking": "low" },
      "research": { "model": "openrouter/~z-ai/glm-latest", "thinking": "high" },
      "high":     { "model": "openrouter/~anthropic/claude-sonnet-latest", "thinking": "high" }
    }
  },
  "pipeline": {
    "modelFallbacks": {
      "utility":  ["minimax/minimax-m3", "~z-ai/glm-flash-latest", "~deepseek/deepseek-v4-flash-latest"],
      "coding":   ["~z-ai/glm-latest", "~openai/gpt-luna-latest", "~deepseek/deepseek-v4-flash-latest"],
      "stronger": ["~anthropic/claude-sonnet-latest", "~openai/gpt-terra-latest", "~anthropic/claude-opus-latest"]
    },
    "modelClasses": {
      "openrouter/~x-ai/grok-latest": "stronger"
    }
  }
}
```

`subagents.agentOverrides.<agent>` sets one model and thinking level per agent,
for pi-subagents and for pipeline steps alike (see
[Model configuration](#model-configuration)). pi-subagents removed
`fallbackModels` in 0.68.0 and now rejects an override that sets it, so
fallbacks are configured under `pipeline` instead.

### Model fallbacks

Before every provider request (the main session's and every subagent's), the
extension adds OpenRouter's `models` array for the request's model. OpenRouter
tries `model` first, then the `models` entries in order, on rate limits,
downtime, moderation or context-length errors
([OpenRouter docs](https://openrouter.ai/docs/guides/routing/model-fallbacks)).
The class of the request's model chooses the list:

- `pipeline.modelFallbacks` maps a class to its list of OpenRouter model ids,
  with or without the `openrouter/` prefix. The request's own model is left out
  of the array, since OpenRouter tries it first anyway. OpenRouter accepts at
  most 3, so the rest is cut to the first 3. A class you leave out keeps the
  package default (`DEFAULT_MODEL_FALLBACKS` in [`src/lib.ts`](src/lib.ts)).
- `pipeline.modelClasses` maps a model id, with or without the `openrouter/`
  prefix, to its class. It wins over the package's built-in map
  (`PRIMARY_TO_CLASS` in [`src/lib.ts`](src/lib.ts)), which covers the default
  models and the current `~…-latest` aliases. It may name a class that only
  `pipeline.modelFallbacks` defines. If it names a class with no list, the
  built-in class still applies.

A model with no class gets no `models` array, and neither does a request that
already carries `models` or `fallbacks`, or one for the session's model when
that model's provider is not OpenRouter. Both keys are read once per load, so
run `/reload` in pi after changing them.

---

## Model limits

If a subagent fails with a `400: maximum context length` warning even on tiny inputs, it's caused by pi requesting the model's absolute maximum output length (such as 512,000 tokens for `minimax/minimax-m3`), leaving no room for the input context. 

To fix this, put these model overrides in `~/.pi/agent/models.json` (create the file if it's missing) to force sane output budgets:

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "minimax/minimax-m3": {
          "contextWindow": 524288,
          "maxTokens": 65536
        },
        "moonshotai/kimi-k2.7-code": {
          "contextWindow": 262144,
          "maxTokens": 16384
        }
      }
    }
  }
}
```
Verify the limits are picked up by running `pi --list-models`.

## Model configuration

Model overrides come from `subagents.agentOverrides` in
`~/.pi/agent/settings.json`, which you maintain by hand or with whatever manages
your pi config. pi-pipeline only reads it. (The author's setup writes
`enabledModels`, `subagents.agentOverrides`, `modelThinkingLevels` and
`pipeline.modelFallbacks` from one models file in a separate config repo.)
Write model ids with their provider prefix (for example
`openrouter/~openai/gpt-sol-latest`) so they match `enabledModels` exactly.
If you change a model, run `/reload` in pi before starting new agents.

Each pipeline step's model is chosen in this order, the same as pi-subagents:

1. `subagents.agentOverrides.<agent>.model` (and `.thinking`) in `~/.pi/agent/settings.json`
2. `model:` in the agent file's frontmatter
3. [`config/models.json`](config/models.json) in this package: defaults for
   pipeline steps whose agent has no override and no `model:`. pi-subagents
   does not read this file, so its own agents (`reviewer`, `scout`, …) need
   overrides in `settings.json` to use these models.

There is no other fallback. Before a run dispatches anything, it resolves the
model for every agent the plan uses and refuses to start if an agent has no
model, a model is missing from pi's registry, `settings.json` cannot be parsed,
or a model is outside `enabledModels` (the `/scoped-models` list, matched with
pi's own pattern rules). The tool output lists the model chosen for each agent.

Every step records its model, thinking level, duration, tokens, and cost in the
run manifest, `metrics.json` (with a `by_model` rollup), the run `README.md`,
and `logs/NN-<step>.md`. When the provider serves a different model than the one
requested (for example an OpenRouter `~…-latest` alias), the served model is
recorded as well.
