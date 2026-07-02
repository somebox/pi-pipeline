# pi-pipeline

Effort-scaled multi-agent pipeline for pi. The premise: high-tier models (sonnet-5) are reserved for planning, judgment, and acceptance. Mechanical work (finding files, summarizing raw context, editing, running tests, fetching remote content) goes to util-tier (M3). Reviews, debugging, documentation, and consolidation go to research-tier (glm-5.2).

Best-of-N drafts happen on util-tier; the merge happens on research-tier. High tier is *only* called at the entry (plan), the merge checkpoint, and the exit (accept). This keeps expensive model calls bounded.

## What it is

This package provides:

1. **A `pipeline` tool** that the LLM can call. Returns a numbered plan with per-step cost class (`$` / `$$` / `$$$`); the LLM then executes each step with its existing `subagent` tool.
2. **A `/pipeline` slash command** for explicit invocation, with `mode` / `effort` / `dryRun` flags.
3. **Three tier agents** (`high`, `research`, `util`) that pi-subagents discovers automatically.
4. **A `pipeline` skill** so the parent knows when and how to call the tool.

## Two modes

The pipeline has two modes. The tool infers from the task wording, or you can set it explicitly:

- **`implementation`** (default for code changes — "implement", "build", "refactor", "fix", "edit", "add", "create", "port", "migrate", "patch"). High plans and accepts. The 5-step standard / 7-step deep templates.
- **`research`** (default for read-only/extraction — "research", "extract", "review", "audit", "learnings", "postmortem", "retrospect", "what did we learn", "summarize the docs", "analyze"). **Parent writes the spec itself**; util partitions by theme; N research subagents fan out in parallel; research merges. **No high-tier calls in surface/standard**, so the bill is `1 util + 2–4 research` instead of `1 high + 1 util + 1 research + 1 high`.

The mode switch is the cost lever for the 75%-sonnet-5 problem. When the task is extraction (read-only), the standard template's high-tier plan/accept calls are pure overhead — the research mode skips them. When the task is implementation, the high tier is the right gate.

## Three effort levels

Each mode has three effort levels:

| Effort | Implementation (code change) | Research (read-only) |
|---|---|---|
| `surface` | 1 util skim + 1 high judgment (1 $$$ call) | 1 util skim + 1 research review (0 $$$) |
| `standard` | 1 high plan + 1 util persist + 1 util do + 1 research review + 1 high accept (2 $$$) | 1 util partition + 2 research parallel extracts + 1 research merge (0 $$$) |
| `deep` | + estimator, best-of-N drafts, merge, kick-back loop up to 3 rounds (2–5 $$$) | + 1 more parallel extract + 1 high accept (1 $$$) |

The `effort` knob scales the *depth* of work, the `mode` knob scales the *kind* of work. They compose.

## Cost classes

Each step in the plan is labeled with a cost class:

- `$` — util-tier (M3-class). Mechanical work.
- `$$` — research-tier (glm-5.2-class). Review, debug, docs, consolidation.
- `$$$` — high-tier (sonnet-5-class). Plan, judgment, accept. Used sparingly.

The plan's `**Cost shape:**` line summarizes the bill at a glance. Examples:

- `1 util-tier ($) + 1 high-tier ($$$)` (surface implementation)
- `1 util-tier ($) + 3 research-tier ($$)` (standard research — no $$$)
- `2 util-tier ($) + 1 research-tier ($$) + 2 high-tier ($$$)` (standard implementation)
- `1 util-tier ($) + 4 research-tier ($$) + 1 high-tier ($$$)` (deep research — single $$$)

Override a step's model per-run by passing `[model=openrouter/.../...]` in the `subagent` call for that step.

## Install

From GitHub (recommended for end users):

```bash
pi install git:github.com/somebox/pi-pipeline
```

Updates: `pi update git:github.com/somebox/pi-pipeline` (or pin a tag/commit with `@<ref>`).

### For development

Clone the repo and point pi at the local path:

```bash
git clone git@github.com:somebox/pi-pipeline.git ~/src/pi-pipeline
```

Then in `~/.pi/agent/settings.json`, add the absolute path to `packages`:

```json
{
  "packages": ["/home/<you>/src/pi-pipeline"]
}
```

Edit files under `~/src/pi-pipeline/` and run `/reload` in pi to pick up changes. Run the test suite with `node --test --experimental-strip-types test/*.test.ts` (Node ≥22, no deps).

## Configuration

The three tier agents are mapped to models via `subagents.agentOverrides` in `~/.pi/agent/settings.json`. Recommended:

```json
{
  "subagents": {
    "agentOverrides": {
      "high":     { "model": "openrouter/anthropic/claude-sonnet-5", "thinking": "high" },
      "research": { "model": "openrouter/z-ai/glm-5.2",            "thinking": "medium" },
      "util":     { "model": "openrouter/minimax/minimax-m3",     "thinking": "low" }
    }
  }
}
```

> **Note:** pi's `agentOverrides.<agent>.fallbackModels` field is currently a **no-op** (as of pi 0.80.x) — pi-ai only does same-model retry. Rate-limit / downtime failover is handled instead by this package's `before_provider_request` hook (see **Model fallback** below); you do **not** need `fallbackModels` here.

### Model fallback (rate-limits / downtime)

This package wires OpenRouter's native server-side failover: before every provider call (parent **and** subagents), a `before_provider_request` handler injects a `models` array into the payload based on which class the current primary `model` belongs to. OpenRouter then tries the primary first and falls through to the rest on rate-limits, downtime, moderation, or context-length errors — no client retry logic required. (Docs: https://openrouter.ai/docs/guides/routing/model-fallbacks)

The three pipeline tiers map to three fallback classes:

| Tier | Class | Primary | Fallbacks |
|---|---|---|---|
| `util` ($) | utility | `minimax/minimax-m3` | `moonshotai/kimi-k2.7-code` |
| `research` ($$) | coding | `z-ai/glm-5.2` | `google/gemini-3.5-flash` → `qwen/qwen3.7-max` |
| `high` ($$$) | stronger | `anthropic/claude-sonnet-5` | `~openai/gpt-mini-latest` |

This composes with pi's existing same-model retry (which still retries the *same* model on transient 429/network errors) — the fallback chain only engages when OpenRouter itself returns an error for the primary.

Override any class without editing the package by setting `pipeline.modelFallbacks` in `~/.pi/agent/settings.json`. Classes you omit fall back to the defaults above; reload (`/reload`) to pick up changes:

```json
{
  "pipeline": {
    "modelFallbacks": {
      "coding":  ["z-ai/glm-5.2", "my-org/custom-coding-model"],
      "stronger": ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4.8", "~openai/gpt-mini-latest"]
    }
  }
}
```

Notes:
- OpenRouter model ids are bare `vendor/model` (no `openrouter/` prefix). The `~` prefix is OpenRouter's "latest" alias.
- Some ids (e.g. `qwen/qwen3.7-max`) exist on OpenRouter's live catalog but not in pi's bundled model snapshot — that's fine, the `models` array is opaque to pi and resolved server-side.
- Only the three tier primaries above trigger injection; any other `model` (including a manual per-step `[model=...]` override) is left untouched unless it matches a class primary. If you set `models` manually in a payload, the handler leaves it alone.

## Usage

### Plain language

Just ask. The parent reads the `pipeline` skill and decides:

- "Use the pipeline: refactor the auth module to use refresh tokens." → implementation standard
- "Use the pipeline to extract learnings from the postmortems." → research standard
- "Deep pipeline: iterate on the new search feature until it's right." → implementation deep
- "Quick survey: skim these three files." → implementation surface

### Slash command

```
/pipeline <task>                                      # auto-detect mode + effort
/pipeline research <task>                            # force research mode
/pipeline implementation deep <task>                 # force impl + deep
/pipeline dryrun <task>                              # show plan + cost shape, no execution
```

Argument completion: `research`, `implementation`, `surface`, `standard`, `deep`, `dryrun`.

### Programmatic (LLM)

```
pipeline({
  task: "extract learnings from the postmortems",
  mode: "research",          // optional, inferred if omitted
  effort: "standard",        // optional, inferred if omitted
  hints: ["limit to last 30 days"],
  dryRun: true               // optional, just show the cost shape
})
```

The tool returns a plan; the LLM executes each step with `subagent` calls.

## On startup

When a session starts, the extension:

1. Sets a persistent status line: `pipeline extension loaded · /pipeline [research|impl] [effort] <task> · /pipeline-costs`.
2. Sends a one-time notification explaining the surface, modes, cost classes, and the `/pipeline-costs` command.

These are intentionally quiet — no modal popups, no log spam.

## Live progress

While a subagent runs, the extension rewrites the `pipeline` status line in real time from the subagent tool's progress updates, so you can see what each step is actually doing without expanding tool output:

```
pipeline ▸ util read spec.md · 3 tools · 1 turns · 5.4k tok
```

For parallel dispatches the per-slot states are joined with `|`:

```
pipeline ▸ research read findings-1.md · 4 tools · 2 turns · 12k tok | research write synthesis.md · 3 tools · 1 turns · 8k tok
```

When the dispatch finishes the status line falls back to the static `pipeline extension loaded …` text.

## Cost inspection — `/pipeline-costs`

`/pipeline-costs` renders a breakdown of the **most recent pipeline operation** (the run started by the last `pipeline` tool call / `/pipeline` command). It opens a scrollable list with three sections:

- **Per step** — one row per subagent dispatch (in dispatch order): `#N [mode] agent — task snippet`, then a line per result with the model that actually served it, cost, tokens, duration, tool count, and exit code. When a step fell back across models, each attempt is listed (`✗ minimax/minimax-m3 $0.001` → `✓ z-ai/glm-5.2 $0.0223`).
- **Per model** — a rollup of cost / tokens / call-count per model, charged to the model that actually served each attempt (so a util step that fell back to glm-5.2 is counted under glm-5.2, not minimax).
- **Total** — summed cost, tokens, step count, call count.

The report is held in memory and is reset each time a new `pipeline` tool call starts. Example:

```
Pipeline costs · mode=research effort=standard · 4 dispatch(es)
Plan cost shape: 1 util-tier ($) + 3 research-tier ($$)

── Per step ──
#1 [single] util — Read spec.md and extract learnings into findings.md…
    minimax/minimax-m3 · $0.0223 · 45.9k tok · 138.3s · 7 tools
#2 [single] research — Review context.md and write synthesis.md…
    z-ai/glm-5.2 · $0.0180 · 57.0k tok · 90.0s · 4 tools
#3 [single] util — Skim repo root: AGENTS.md, package.json, README.md for consistency.
    z-ai/glm-5.2 · $0.0223 · 45.9k tok · 138.3s · 7 tools
      ✗ minimax/minimax-m3 $0.001000
      ✓ z-ai/glm-5.2 $0.0223
#4 [parallel] high,research — 2 tasks · Accept or kick back.
    anthropic/claude-sonnet-5 · $0.1800 · 35.2k tok · 20.0s · 2 tools
    z-ai/glm-5.2 · $0.0120 · 31.0k tok · 60.0s · 3 tools

── Per model ──
anthropic/claude-sonnet-5 — $0.1800 · 35.2k tok · 1 call(s)
z-ai/glm-5.2 — $0.0523 · 134k tok · 3 call(s)
minimax/minimax-m3 — $0.0233 · 47.1k tok · 2 call(s)

── Total ──
$0.2555 · 216k tok · 4 step(s) · 6 call(s)
```

Step #3 above is the “utility model went to glm-5.2” case made visible (see below).

## Why did my util step run on glm-5.2?

pi-subagents resolves a child's model as `resolveSubagentModelOverride(params.model ?? agent.model, ctx.model, …)`. When the parent calls `subagent({agent:"util", task:…})` **without a `model` field** and the `util` agent's `model` override is *not loaded in the running parent process* (the session started before the override was added to `settings.json`, or `settings.json` was edited without `/reload`), `agent.model` is unset, so the child **inherits the parent session's in-memory model** — here `z-ai/glm-5.2`. The agent's `thinking` level still applies (it comes from the agent frontmatter, independently of overrides), which is why you observe `glm-5.2:low` for util steps and the thinking level still varies (low/medium/high) while the model does not.

This extension now defends against that: at every `subagent` `tool_call` it reads the tier→model map from the **live** `~/.pi/agent/settings.json` (`subagents.agentOverrides.<tier>.model`) and injects `model` into the tool args for the `util` / `research` / `high` agents when the caller didn't set one. So the correct tier model is used regardless of whether the parent process has reloaded its agent overrides. A `/reload` (or restart) is still recommended so pi-subagents' own mapping is consistent. `/pipeline-costs` is the quickest way to confirm which model each step actually used.

## Cost model

The `mode` switch is the dominant cost lever. Within a mode, `effort` scales the depth:

- **Research mode at standard effort**: 0 $$$ calls, 3 $$ calls, 1 $ call. ~5–10× cheaper than implementation standard.
- **Implementation mode at standard effort**: 2 $$$ calls, 1 $$ call, 2 $ calls. Same as before.
- **Research mode at deep effort**: 1 $$$ call (the final accept), 4 $$ calls, 1 $ call. Cheaper than implementation standard.
- **Implementation mode at deep effort**: 2–5 $$$ calls (depends on kick-back rounds), 1 $$ call, 5–8 $ calls.

The research mode is the right choice whenever the task is read-only — extraction, audit, review, postmortem, retrospect. The high tier adds nothing for those tasks because there's no implementation to accept.

## Files

```
pipeline/
├── package.json                # pi-package manifest
├── README.md                   # this file
├── src/extension.ts            # the extension (tool + commands + startup banner + tier-model pinning + live progress + cost tracking + effort/mode templates)
├── agents/
│   ├── high.md                 # read-only, sonnet-5
│   ├── research.md             # read/write/edit, glm-5.2
│   └── util.md                 # full tools, M3
└── skills/pipeline/
    └── SKILL.md                # teaches the parent when/how to use the pipeline tool
```

## Limitations (MVP)

- The cost class is tier-derived, not settings-derived. If you map `research` to a different (more expensive) model, the plan still labels it `$$`. This is a feature: the cost class is a *tier* annotation, not a price quote. Per-run `[model=...]` overrides give you price control.
- Best-of-N is hard-coded to N=2 in `implementation/standard` and N=3 in `research/standard`. Customizable per-run by editing the plan.
- The research mode's partition step has the util agent decide themes. If the user partitioned explicitly in their task, the util step just persists their partition.
- No automated re-estimation mid-pipeline.
- No automated acceptance gates — the high-tier "accept" call is the gate in implementation mode.
- The `dryRun` flag is honor-system: the parent is told the plan is a dry run and to not dispatch, but it could in principle ignore that. Useful for the user to see the cost shape before they say "go."

## Removing

```bash
pi remove git:github.com/somebox/pi-pipeline
# or, if installed from a local path
pi remove /home/<you>/src/pi-pipeline
```

The three tier agents and the skill are removed; the model overrides in `~/.pi/agent/settings.json` are not touched.
