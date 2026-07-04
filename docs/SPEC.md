# Spec — Recipe Format

> The normative contract. If you implement exactly this, you're correct. For
> the *why* see [ARCHITECTURE.md](ARCHITECTURE.md); for examples see
> [EXAMPLES.md](EXAMPLES.md).

## Recipe format

A recipe is a markdown file with optional YAML frontmatter and a body of
numbered step sections. Discovery is by `*.md` filename in `pipelines/` dirs.

### File location & precedence

Same resolution order as skills/agents/prompts (later wins on name
collision):

1. Built-in TS pipelines (in `src/lib.ts`)
2. `~/.pi/agent/pipelines/` (user-global)
3. `.pi/pipelines/` (project, walking up from cwd)
4. Package `pipelines/` dirs (declared in a package's `pi` manifest, or
   auto-discovered conventionally)

### Frontmatter (optional)

```yaml
---
name: code-quality           # defaults to filename stem
description: one-line, shown by the TUI list
inputs:                      # optional; documents placeholders
  - scope
---
```

`mode`/`effort` are **not** accepted for named recipes — a recipe is a
complete process. (They remain on the generic built-in path only.)

### Body

A `# <name>` H1 (title, ignored) followed by numbered
`## N. Phase (agent[, flags])` sections. Each section is one step.

**Step header grammar:**

```
## <number>. <phase>  ( <agent> [, reads=<files>] [, output=<file>] [, iterate=<name>] [, tools=<list>] )
```

- `<agent>` — `dev` | `util` | `research` | `high` | `coordinator` | any custom agent name
- `reads=<a.md,b.md>` — optional explicit reads (else inferred from prose)
- `output=<file>` — optional explicit output filename (else inferred). May
  contain `{unit}` for iterate steps.
- `iterate=<name>` — bind to a prior step's `<name>.json` unit list (see
  **Iteration steps**). Also inferrable from "For each `{unit}` in <name>..." prose.
- `tools=<list>` — documents an intended tool bound for this step (e.g.
  `tools=read,write`); parsed onto `PlanStep.tools` for validation/display, but
  **not emitted into the compiled chain** — pi-subagents' `ChainItem` and
  `DynamicParallelTemplateSchema` both reject unknown keys (`additionalProperties:
  false`) and neither has a `tools` field, so a per-step override is rejected
  outright by the tool call schema. Real enforcement is agent-level only: pick
  an agent (or add a bounded variant, e.g. `dev-bounded.md`) whose own
  `tools:` frontmatter matches what you want. See ARCHITECTURE.md principle #5
  and docs/PLAN.md open question #5.

  **Agent `tools:` gotcha:** any agent with an explicit `tools:` allowlist
  must include `structured_output`, or every step with `outputSchema` routed
  to it fails with "Missing structured_output call" — `--tools` allowlists
  built-in, extension, *and* dynamically-registered tools, and
  `structured_output` is registered per-step by the runtime, not a built-in.
- `parallel` (legacy) — soft fan-out hint; superseded by `iterate=`.
- `maxTools` (deprecated) — see ARCHITECTURE.md Non-goals.

The section's body paragraphs are the task text, verbatim.

**Placeholders — two syntaxes, two timings:**
- `{{name}}` — **input** placeholder, substituted once at plan-build time
  from the invocation's `inputs`. Double braces.
- `{unit}` / `{unit.field}` — **per-unit** placeholder, substituted once per
  dispatch in an iterate step. Single braces (matches pi-subagents' `{item.x}`
  convention, minimizing compile-translation cost). Missing inputs are
  surfaced by the overview TUI; a missing `{unit.field}` (e.g. the step
  references `{unit.mtime}` but the enumerate step's objects have no `mtime`)
  is a **validation error at load time**, not a silent no-op.

**Inputs/reads/output inference:** `output` and `reads` are inferred from
prose patterns ("Write `findings.md`" → output; "Read `standards.md`" →
reads) with a simple regex, overridable by explicit flags. `iterate=` is
inferrable from "For each `{unit}` in <name>...". Flags always win. The
common iterate step needs zero header flags.

### What the loader produces

Each recipe parses to the existing `Plan` / `PlanStep` types (with `agent`
replacing `tier`/`costClass`):

```ts
PlanStep {
  phase, agent, label, task,
  output?, reads?,
  iterate?,        // name of a prior step's <name>.json unit list
  tools?,          // optional per-step tool allowlist/override
  parallel?,       // legacy soft fan-out hint
}
Plan {
  name, description, summary, steps[]
}
```

Because the output is `Plan`, everything downstream (plan rendering, dry-run,
live progress, cost tracking, model pinning, OpenRouter fallback) is
inherited with the `costClass` removal as the only breaking change.

## Iteration steps

A step iterates when it declares an iterable, either explicitly via
`iterate=<name>` or inferred from "For each `{unit}` in..." prose:

```markdown
## 2. Summarize each file  (dev, iterate=scope-files, output=summary-{unit}.md)
For each file in the scope list, read `{unit.path}` and write a 100-word summary.
Do not read any other file.
```

- `iterate=<name>` — binds to the unit list a prior step wrote to
  `<name>.json` (here step 1 wrote `scope-files.json`). The `<name>` is the
  contract; `iterate=scope-files` reads `scope-files.json`, never a bare
  `units.json`. This lets a recipe have two iteration phases alive at once
  (e.g. `ideas` then `finalists`) without filename collisions.
- `{unit}` / `{unit.path}` / `{unit.mtime}` — the per-unit placeholder,
  substituted at **dispatch time** (one substitution per unit). Single braces
  distinguish it from `{{input}}` placeholders (substituted once at
  plan-build time) and match pi-subagents' own `{item.x}` convention.
- `output=summary-{unit}.md` — one output per unit; a later reduce step reads
  `summary-*.md`.
- Inference: "For each `{unit}` in <list>..." in the prose implies
  `iterate=<list>` with no header flag. The flag is an override for when
  inference is ambiguous.

A reduce step is an ordinary step that reads the per-unit outputs:

```markdown
## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
Read every `summary-*.md`. Cross-check for patterns. Write `summaries.md`.
```

`parallel` (the v0 fan-out flag) is subsumed by `iterate=`. A step with
`parallel` but no `iterate=` remains supported as a legacy hint ("fan out,
parent picks N") but is soft; `iterate=` is the enforceable form. New
recipes should use `iterate=`.

## Enumeration is two concerns (split the coordinator)

The original "coordinator" bundled two unrelated jobs: (a) producing the
iterable and (b) authoring a good per-unit prompt. They have different
shapes — (a) is often mechanical (a glob), (b) is always judgment. Split
them:

- **`enumerate`** — mechanical, no agent call for trivial cases. A
  `iterate=glob:*.go` shorthand globs directly and writes `glob.json`. For
  judgment enumeration ("generate 8 ideas", "match screenshots to cards"),
  any agent (typically `high`) writes `<name>.json` as a normal step output.
- **`plan-prompt`** — optional, uses the `coordinator` agent, and *only*
  writes `per-unit-prompt.md` given the units. Reach for it when the
  per-unit prompt genuinely needs judgment (screenshot→card matching); skip
  it when the step's own prose is already a good per-unit prompt (most file
  iterations).

The `coordinator` profile is therefore **opt-in**, not mandatory. A simple
`summarize-files` recipe uses mechanical enumeration + the step's own prose
as the prompt — zero coordinator calls. A `screenshot-worklog` recipe uses
a judgment enumerate step (which also writes `per-unit-prompt.md` since the
matching logic is complex). This removes a forced LLM call from the common
case and lets the two concerns evolve independently.

This separation is the enforcement backbone: the parent LLM calls
`subagent({agent, task: renderedPrompt})` — it doesn't author the task, so
it can't paraphrase the budget or scope away. The coordinator's template is
the contract; the orchestrator is mechanical.

## Fan-out (legacy `parallel`)

The v0 `parallel` flag marked a step as a fan-out slot and let the parent
infer N. That was soft and unbounded — the original failure mode. It is
**superseded by `iterate=`** (see **Iteration steps**), which makes the
iterable explicit and the per-unit agent bounded.

`parallel` remains supported as a hint for cases where the iterable is
genuinely discovered mid-run, but new recipes should prefer `iterate=`.
A later non-iterate step still implicitly waits for all per-unit dispatches
(it reads their `summary-*.md` / `findings-*.md` outputs).

## Package sharing

A package declares a `pipelines` dir in its `pi` manifest:

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"],
    "agents": ["./agents"],
    "skills": ["./skills"],
    "pipelines": ["./pipelines"]
  }
}
```

Pi auto-discovers `pipelines/` even without a manifest (conventional dir).
The TUI's "Add" collects any `pi install` source (git URL, local path,
`npm:name`) and shells out — so npm works as a source if you later publish,
but git + local path cover the soft release. Recipes in an installed package
reference agents the same package ships (e.g. `code-quality` references
`dev`, and the package ships `agents/dev.md`), so they're self-contained.

## Invocation model

| Surface | Behavior |
|---|---|
| `/pipeline` | Opens the list TUI (or dashboard if a run is active) |
| `/pipeline <name> [inputs]` | Opens the overview TUI for `<name>` (skips list) |
| `/pipeline <name> [inputs] --dry-run` | Overview with a no-dispatch flag |
| Natural language | The `pipeline` skill lists available recipes; the parent picks one and calls the `pipeline` tool, which gates on the overview |
| `pipeline` tool (LLM) | Takes optional `pipeline` name. If named → load recipe → overview gate → return plan. If unnamed → infer generic built-in (mode/effort) → overview gate → return plan. |

The LLM always executes the steps with `subagent` calls after the overview is
confirmed. The command and the tool both route through the same overview
gate, so there's one confirmation path regardless of how the pipeline was
invoked.
