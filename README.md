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
1. **A `pipeline` tool** — The LLM calls this with a recipe name and inputs. It returns a structured plan which the LLM executes using its existing `subagent` tools.
2. **A `/pipeline` slash command** — Run a specific recipe directly (`/pipeline <recipe> <task>`) or invoke a generic fallback pipeline (`/pipeline <task>`).
3. **Utility slash commands** — `/pipelines` to browse installed recipes, `/pipeline-costs` for a per-step model cost rollup, and `/pipeline-audit` for detailed diagnostic and error-cascade analysis.
4. **Profiles** — `dev`, `util`, `research`, `high`, and (planned) `coordinator` — mapped to real models in `settings.json`.

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

Add the recommended agent overrides and fallback models to your `~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "agentOverrides": {
      "high":     { "model": "openrouter/anthropic/claude-sonnet-5", "thinking": "high",
                   "fallbackModels": ["~openai/gpt-mini-latest"] },
      "research": { "model": "openrouter/z-ai/glm-5.2",            "thinking": "medium",
                   "fallbackModels": ["google/gemini-3.5-flash", "qwen/qwen3.7-max"] },
      "util":     { "model": "openrouter/minimax/minimax-m3",     "thinking": "low",
                   "fallbackModels": ["moonshotai/kimi-k2.7-code"] },
      "dev":      { "model": "openrouter/moonshotai/kimi-k2.7-code", "thinking": "low",
                   "fallbackModels": ["minimax/minimax-m3"] }
    }
  }
}
```

*Note: `fallbackModels` under `agentOverrides` are fully supported by `pi-subagents`. They perform client-side retries on transient errors (such as 429 rate limits), complementing our server-side OpenRouter fallback arrays.*

---

## Model limits (Why does my subagent error with 400 Context Length?)

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
Verify the limits are pick up by running `pi --list-models`.
