# Pipeline Build Artifacts

> The build layer of pi-pipeline: how a pipeline run creates a workspace,
> names intermediate targets, records dependencies, resumes work, and leaves
> behind the outputs the parent or user cares about. This is not a general
> artifact backend. It is the pipeline's small build system.

## Status (as of 2026-07-05)

| Stage | Status | Notes |
|---|---|---|
| 1 — workspace + manifest | Done | `src/workspace.ts` + extension hooks; mint/cleanup/retention functional |
| 2 — target syntax | Done | `TargetSpec`/`parseOutputSpec`/`validatePlanTargets` + workspace-aware compiler; golden fixture passes |
| 3 — temp lifecycle | Done (per-run) | Per-step scratch dirs created + injected into task text; per-step teardown becomes trivial once dispatch is owned |
| 4 — recipe migration | Partial | `summarize-files`, `probe`, `docs-audit` migrated; `code-quality`/`verify-source`/`housekeeping` still legacy |
| **D — own dispatch** | **Next** | Drop `@tintinweb/pi-subagents`; dispatch subagents via pi's first-party `createAgentSession` SDK |
| 5 — resume/retry | Not started | Far simpler once dispatch is owned (we control the loop) |
| 6 — external delivery | Not started | Deferred until a real recipe needs it |

**Pivot (decisive):** the review confirmed `@tintinweb/pi-subagents` is a
thin wrapper over pi's first-party SDK (`createAgentSession` from
`@earendil-works/pi-coding-agent`) — the same package we already declare as a
peerDependency. The wrapper has been the sole source of breakage this
session: the chain API our compiler targets does not exist in any published
release, the tool was silently renamed (`subagent` → `Agent`), and every
`event.toolName === "subagent"` hook in `extension.ts` is dead code against
the installed runtime. **We will own the dispatcher and depend on the pi
SDK directly**, not on a third-party extension.

Owning dispatch collapses nine open problems into one design decision: the
tool-name mismatch, the manifest status loop (Stage 1.5), per-step temp
teardown, substrate detection (Stage 0), the instruction/chain mode split,
the coordinator/parent-paraphrase pain, Stage 5 resume complexity, the
reduce-step `{outputs.*}` inflation question (OD #4), and tool-name
matching in cost/audit hooks. The parent LLM drops out of the orchestration
loop: the pipeline tool confirms the plan, then executes it internally by
spawning child `AgentSession`s and collecting results + usage directly.

Stages 0 and 1.5 as previously framed are **superseded** — their problems
dissolve once dispatch is owned. The substrate-independent work (workspace,
targets, validation, temp, manifest, recipes) ships as-is. The compiled-chain
serializer (`compileRecipeToChain`) is retired in favour of a real executor.

## Reframe

A pipeline is a prose-authored process, but the artifact side of it is a
build problem:

- a step has **inputs** (`reads`)
- a step produces **targets** (`output`)
- targets live in a **run workspace**
- a later step consumes earlier targets
- fan-out produces a **collection** of targets
- a run should be auditable, retryable, and eventually resumable

This is closer to `make`, GitHub Actions step outputs, or a small DAG runner
than to a pluggable storage backend. The right abstraction is therefore not
"an ArtifactStore". The right abstraction is:

1. a run-scoped build workspace,
2. declared step targets and dependencies,
3. a manifest that records what happened,
4. a compiler that maps recipe syntax onto the underlying subagent runtime
   (named outputs, fan-out collect), rather than duplicating that runtime —
   *when a chain-capable runtime is present* (see "Relationship to pi-subagents
   runtime"; instruction mode is the default today).

Everything else — Trello comments, PR comments, uploaded attachments — is
external delivery. It can be layered on later through skills, but it should
not drive the core build model.

## Goals

1. **Stop repo pollution.** Intermediate files like `standards.md`,
   `summary-*.md`, `findings.md`, and `probe-summary.md` should not land in
   the project root by default.
2. **Prevent run collisions.** Two pipeline runs in the same repo should not
   clobber each other's intermediate files.
3. **Make handoffs explicit.** A downstream step should read a named target,
   not a mystery file path inferred from prose.
4. **Enable retry/resume later.** The run manifest should be designed so a
   future scheduler can re-run only failed or stale steps.
5. **Stay prose-first.** Recipe authors should not write long path templates
   for the common case. The default should be short and obvious.
6. **Compile onto the existing substrate.** pi-pipeline should use the
   subagent chain runtime's own directory/output/collect concepts wherever
   available, not create a parallel namespace.

## Non-goals for this layer

- **No multi-backend artifact store.** Internal build artifacts live in the
  run workspace. If a future use case needs S3, Trello, Linear, or GitHub, it
  should appear as a skill or external delivery integration, not as the
  default artifact model.
- **No new agent tool for ordinary artifacts.** Agents keep using `read`,
  `write`, `edit`, `bash`, and existing skills. The compiler resolves output
  names to paths/chain placeholders.
- **No eager external delivery feature.** `deliver=trello:comment` is useful,
  but no shipped recipe needs it yet. Keep the concept documented; build it
  when the first real recipe needs it.
- **No special temp-retention exception.** If something is a downstream input,
  it is a named target in the run workspace. Temp is only scratch/stage.

## Core mental model

### Run workspace

Every pipeline run gets a workspace:

```text
.pi/run/<run_id>/
  manifest.json
  targets/          # singleton targets: <name>.md / <name>.json
  collections/      # fan-out: <name>/<per-unit files> + <name>.json index
  logs/
  temp/
```

Singleton targets are files in `targets/`. A fan-out collection `<name>`
owns a directory `collections/<name>/` holding the per-unit files (the
declared pattern, e.g. `summary-{unit.path}.md`, resolved per unit) plus an
index file `collections/<name>.json` recording each unit's status — the
index is what the manifest and future retry read.

`<run_id>` should be unique and readable, e.g.
`code-quality-20260704-034a4b`.

The workspace is the pipeline's build directory. It is equivalent in spirit to
GitHub Actions' workspace plus step outputs, or a `make` build dir. The repo
itself remains the source tree.

### Three locations, but only one default

| Scheme | Meaning | Lifecycle | Example |
|---|---|---|---|
| default / `work:` | run-scoped build target | retained until run cleanup | `output=summary` |
| `temp:` | scratch/stage, not a dependency | per step/slot, cleaned after dispatch | `output=script=temp:migrate.sh` only if not read later |
| `project:` | real repo mutation/output | permanent | `output=readme=project:README.md` |

The default is `work:`. Recipe authors should almost never write the full run
path. They should write target names.

```markdown
output=summary
```

means:

```text
.pi/run/<run_id>/targets/summary.md
```

For JSON targets:

```markdown
output=scope:json
```

means:

```text
.pi/run/<run_id>/targets/scope.json
```

A recipe only reaches for a scheme when it is leaving the normal build target
path:

```markdown
output=generated_test=temp:test-auth.ts
output=readme=project:README.md
```

### Targets, not arbitrary files

A step output is a named target. The target's name is the handle downstream
steps use.

```markdown
## 1. Inventory  (util, output=scope:json)
Write the source-file inventory.

## 2. Summarize each file  (dev, iterate=scope, output=summary-{unit.path})
Summarize one file.

## 3. Merge  (research, reads=summary, output=summaries)
Merge the summaries.
```

The recipe does not need to say `.pi/run/.../summary-*.md`. The compiler knows:

- `scope:json` is a singleton target named `scope`
- `summary-{unit.path}` is a fan-out target collection named `summary`
- `summaries` is a singleton target named `summaries`

This is intentionally close to GitHub Actions' `steps.<id>.outputs.<name>`
model because LLMs already understand that vocabulary.

### Reads are dependencies

`reads=` is not just display text. It is the build dependency declaration.

```markdown
reads=scope
reads=summary
reads=project:README.md
```

Rules:

- `reads=<target>` resolves to a previous named target.
- `reads=<fanout-target>` resolves to the collected fan-out result, not a
  filesystem glob.
- `reads=project:<path>` reads from the real repo.
- Ad-hoc literal paths remain allowed for backwards compatibility, but new
  recipes should prefer named targets.

Once reads and outputs are explicit, the numbered order becomes a validation
constraint rather than the only execution model. A future scheduler can derive
parallelism from the dependency graph.

## Fan-out and collections

**Own-dispatch is the execution model.** The dispatcher runs an iterate
step as parallel child `AgentSession`s (one per unit, concurrency-capped),
each writing to its resolved path under `collections/<name>/`. The reduce
step reads collection files by absolute path and selects as it goes — no
runtime placeholder substitution, no `{outputs.*}` inflation. The retired
chain-mode compilation (`expand`/`collect`) is preserved below as a
historical reference but is no longer the contract.

Current recipe shape:

```markdown
## 1. Enumerate files  (util, output=scope-files.json)
## 2. Summarize each file  (dev, iterate=scope-files, output=summary-{unit.path}.md)
## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
```

Target-based shape:

```markdown
## 1. Enumerate files  (util, output=scope:json)
List every file matching `{{glob}}`. Write the `scope` target as
`{ "items": [{ "path": "..." }] }`.

## 2. Summarize each file  (dev, iterate=scope, output=summary-{unit.path})
For each file in `scope`, read `{unit.path}` and write a 100-word summary.

## 3. Merge summaries  (research, reads=summary, output=summaries)
Read the collected `summary` outputs. Cross-check for patterns and write the
`summaries` target.
```

Dispatcher behavior:

- Step 1: `dispatchStep` runs the `util` agent, which writes
  `targets/scope.json`. The dispatcher reads it back to get the unit list.
- Step 2: `dispatchIterate` reads the unit list, spawns N child sessions
  (capped), each writing `collections/summary/<unit-path>.md`. Per-unit
  errors are isolated and recorded in the manifest.
- Step 3: `dispatchStep` runs the `research` agent, which reads the
  collection directory by absolute path and writes `targets/summaries.md`.

Filesystem paths are the stable interface. The collection name is the
logical handle the manifest and reduce step use.

## Compiler output contract (retired)

The compiled-chain JSON below was the contract for the now-retired
`compileRecipeToChain` serializer. It is preserved as a reference for the
path-resolution and target-naming decisions that carry over to the
dispatcher, but the chain output itself is no longer emitted.

This is the exact chain JSON the compiler must emit for the target-based
`summarize-files` above. It is the normative fixture for the Stage 2 golden
test; if the compiler and this block disagree, one of them is wrong.

```json
[
  {
    "phase": "Enumerate files",
    "label": "Enumerate files",
    "agent": "util",
    "task": "List every file matching `src/**/*.ts` ... (composed task text)",
    "output": "/abs/project/.pi/run/summarize-files-20260704-034a4b/targets/scope.json",
    "as": "scope",
    "outputSchema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
          }
        }
      },
      "required": ["items"]
    }
  },
  {
    "phase": "Summarize each file",
    "label": "Summarize each file",
    "expand": {
      "from": { "output": "scope", "path": "/items" },
      "item": "unit",
      "key": "/path",
      "maxItems": 100
    },
    "parallel": {
      "agent": "dev",
      "task": "Read `{unit.path}` and write a 100-word summary ...",
      "output": "/abs/project/.pi/run/summarize-files-20260704-034a4b/collections/summary/summary-{unit.path}.md"
    },
    "collect": { "as": "summary" }
  },
  {
    "phase": "Merge summaries",
    "label": "Merge summaries",
    "agent": "research",
    "task": "Read the collected summaries: {outputs.summary}\n\n...write the synthesis.",
    "output": "/abs/project/.pi/run/summarize-files-20260704-034a4b/targets/summaries.md",
    "as": "summaries"
  }
]
```

Decisions this fixture locks in:

1. **Paths are absolute, resolved at compile time.** pi-pipeline mints the
   workspace before compiling, so it knows the absolute path and does not
   depend on runtime `{chain_dir}` support. Adopting `{chain_dir}` later is
   an internal swap, not a contract change.
2. **Runtime placeholders are only `{unit.*}` and `{outputs.*}`.** Everything
   else is substituted by pi-pipeline at plan-build/compile time.
3. **`collect.as` is the slugified target name itself** (`summary`), not
   `collected_summary`. The `collected_` prefix in the current compiler
   existed because the collect name was auto-derived from the *source* list
   name and would have collided with it; distinct target names remove the
   collision, so the prefix goes away.
4. **A collection read compiles to `{outputs.<name>}` in the task text**, not
   a `reads:` file array and not a filesystem glob. A singleton read compiles
   to the target's absolute path in `reads:`.
5. **`:json` targets get `as` + `outputSchema`** by the same mechanism legacy
   `.json` literal outputs use today; only the trigger syntax is new.

## Manifest: the build record

Every run writes `manifest.json` in the run workspace. This is the single
source of truth for audit, retry, and future resume.

Minimum shape:

```json
{
  "run_id": "code-quality-20260704-034a4b",
  "recipe": "code-quality",
  "started_at": "2026-07-04T15:31:10Z",
  "project_dir": "/Users/foz/src/example",
  "workspace_dir": ".pi/run/code-quality-20260704-034a4b",
  "steps": [
    {
      "id": "standards",
      "phase": "Standards & scope",
      "agent": "util",
      "reads": ["project:package.json", "project:src/**"],
      "outputs": [{ "name": "standards", "kind": "singleton", "path": "targets/standards.md" }],
      "status": "completed",
      "attempts": 1,
      "usage": { "input": 1234, "output": 567, "cost": 0.0012 }
    },
    {
      "id": "review-code",
      "phase": "Review code",
      "agent": "dev",
      "reads": ["standards"],
      "outputs": [{
        "name": "code_issues",
        "kind": "collection",
        "path": "collections/code_issues.json",
        "units": [
          { "key": "src/api.ts", "status": "completed" },
          { "key": "src/auth.ts", "status": "failed", "error": "context-overflow" }
        ]
      }],
      "status": "partial"
    }
  ],
  "deliverables": []
}
```

Design it for tomorrow even if v1 only writes a subset:

- **Audit:** `/pipeline-audit` reads the manifest plus existing subagent
  session files.
- **Retry failed units:** a failed collection records the failed units so the
  orchestrator can re-dispatch only those units.
- **Resume:** a future `--resume <run_id>` skips completed steps whose declared
  inputs have not changed and whose outputs exist.
- **Caching:** later, input hashes can make this make-like: if target inputs
  and prompt hash are unchanged, skip.

### Failure semantics (decided)

- A fan-out step with mixed unit results gets `status: "partial"`; the
  collection target exists and records per-unit `status`/`error`. Downstream
  steps still run against the successful units, and the reduce step's task is
  told the failure count so it can qualify its synthesis.
- A singleton step that fails gets `status: "failed"`; steps whose `reads`
  depend on it are not dispatched and are recorded as `"blocked"`.
- Load-time validation failures (unresolvable `reads=`, `iterate=` referencing
  a non-JSON target, `{unit.field}` not present in the enumerate schema) fail
  the run **before any dispatch**: the `pipeline` tool returns the error text
  naming the step and the available targets; nothing is spent.
- Workspace retention follows `retain_runs`; `failed`/`partial` runs are
  retained under the default policy so `/pipeline-audit` and future retry can
  read them.

This is the biggest missed opportunity in the earlier plan: named outputs are
not just nicer paths; they are the basis for a resumable pipeline.

## Config shape

Global settings, under the existing `pipeline` key:

```json
{
  "pipeline": {
    "artifacts": {
      "root": ".pi/run",
      "retain_runs": "failed",
      "retain_logs": "always",
      "temp_root": null,
      "max_retained_runs": 20
    }
  }
}
```

Meanings:

- `root`: where run workspaces live. Relative paths resolve from
  `project_dir`.
- `retain_runs`: `never` | `failed` | `always`. Default: `failed`.
- `retain_logs`: `never` | `failed` | `always`. Default: `always`, because
  subagent session JSONL is already useful for `/pipeline-audit`.
- `temp_root`: `null` means `<run_dir>/temp`; an absolute path can point to
  OS temp or a faster scratch disk.
- `max_retained_runs`: best-effort cleanup cap per project.

Per-recipe frontmatter can override retention only:

```yaml
---
name: docs-audit
artifacts:
  retain_runs: always
---
```

External delivery is deliberately not in the core config yet. When a real
recipe needs it, add recipe-level `deliverables:` and step-level `deliver=`
as a small extension. Until then, the parent conversation is the default
human-facing delivery channel.

## Recipe syntax proposal

### Output

Supported forms:

```markdown
output=summary                  # work target, markdown by default
output=scope:json               # work target, json extension + schema candidate
output=summary-{unit.path}      # fan-out work target collection
output=script=temp:migrate.sh   # temp scratch/stage, not a dependency by default
output=readme=project:README.md # project output/mutation
```

Rules:

- The token before `=` is the target name when present.
- If no explicit target name appears, derive it from the left side:
  `output=summary` creates target `summary`.
- `:json` on a work target means the compiler should emit/expect structured
  output and can auto-register `as: <target>`.
- `{unit.*}` in an output marks it as a fan-out collection.
- New recipes should not write full `.pi/run/...` paths.

### Reads

Supported forms:

```markdown
reads=summary               # named target or collection
reads=scope                 # named JSON target
reads=project:README.md     # real repo file
reads=project:src/**/*.ts   # real repo glob
```

Bare literal paths still work for backwards compatibility, but new recipes
should prefer explicit `project:` for source reads and named targets for
pipeline build outputs.

### Compatibility: legacy literal paths (decided)

A bare filename output with an extension (`output=standards.md`,
`output=scope-files.json`) is a **legacy literal**: it resolves against the
agent cwd exactly as today, and the existing `.json` auto-`as`/`outputSchema`
behavior is preserved for it. Upgrading pi-pipeline must not silently
relocate an unmigrated recipe's files — the workspace is opt-in per output.

Only the new forms place outputs in the workspace:

- `output=<name>` — bare identifier, no `.` or `/`: singleton work target
- `output=<name>:json` — JSON target
- `output=<name>-{unit.*}` — fan-out collection target
- `output=<name>=<scheme>:<path>` — explicit `temp:` / `project:` / `work:`

Disambiguation rule: strip `{...}` placeholders from the token first; if what
remains contains a `.` or `/` and no scheme prefix, it is legacy. `renderPlan`
tags legacy outputs with `(legacy cwd)` so migration status is visible in
every plan and the shipped-recipe migration can be tracked at a glance.

The Stage 2 regression guard: every currently shipped recipe must compile
byte-identically before and after the target syntax lands.

### Temp

`temp:` outputs are scratch/stage, not stable dependencies. If a downstream
step must read something, write it as a work target instead.

Bad:

```markdown
output=result=temp:result.log
...
reads=result
```

Good:

```markdown
output=result
```

The agent may still create temp files in its `temp_dir`; those are not named
outputs and are cleaned after the step unless the run is retained for failure
analysis.

## Example thought exercises

### 1. `summarize-files`

Recipe:

```markdown
## 1. Enumerate files  (util, output=scope:json)
List every file matching `{{glob}}`. Write `{ "items": [{ "path": "..." }] }`.

## 2. Summarize each file  (dev, iterate=scope, output=summary-{unit.path})
Read `{unit.path}` and write a 100-word summary.

## 3. Merge summaries  (research, reads=summary, output=summaries)
Read the collected summaries and write the synthesis.
```

Run:

- workspace: `.pi/run/summarize-files-20260704-034a4b/`
- step 1 writes target `scope` (`targets/scope.json`) and registers
  `outputs.scope`
- step 2 expands from `outputs.scope` `/items`, creates one subagent per
  file writing under `collections/summary/`, and collects as `summary`
- step 3 reads collection `summary`, writes singleton `targets/summaries.md`
- run cleanup removes the workspace unless retained by policy (`failed`
  default keeps failed/partial runs)

No intermediate files touch the repo. No glob contract is exposed to the
recipe. Retry can later re-run only failed file summaries.

### 2. `docs-audit`

The important case is mixed effects: repo mutation plus build handoff.

```markdown
## 1. Inventory & linkage check  (util, output=inventory:json)
Scan `project:{{docs_dir}}` and write inventory items.

## 2. Propose restructuring plan  (high, reads=inventory, output=reorg_plan)
Read inventory and write the plan.

## 3. Restructure each file  (dev, iterate=inventory, reads=reorg_plan, output=change_log-{unit.path})
For `{unit.path}`, apply the planned doc edits in `project:`. Then write a
short change log for that unit.

## 4. Fix links  (research, reads=change_log, output=link_status)
Read the collected change logs and fix cross-links in `project:`. Write link status.
```

Here, project mutations are explicit in prose and visible in tool-call audit
(`edit`/`write` touched paths under `project_dir`). The build outputs
`inventory`, `reorg_plan`, `change_log`, and `link_status` are targets in the
run workspace.

Open issue remains: two fan-out slots mutating `project:` can race. The lean
answer is still agent-level isolation: ship a `dev-worktree` agent for recipes
that need isolated mutation, rather than inventing per-step tool/isolation
flags that the chain schema may reject.

### 3. Stage/build scratch

```markdown
## 2. Generate and test migration  (dev, output=result)
Create any scripts, configs, and logs you need under your temp directory.
Run the migration against `{{db_url}}`. Write the final pass/fail and relevant
log excerpts to the `result` target. Do not edit `project:`.

## 3. Decide  (research, reads=result, output=decision)
Read the result target and decide whether the migration is safe.
```

The generated script is not a target. It lives in temp and dies. The result is
the target because another step reads it. This keeps the rule simple: if the
pipeline depends on it, it is a work target; if only the current agent depends
on it, it is temp.

### 4. External delivery — defer until demanded

Current behavior is enough for many recipes:

```markdown
## 8. Present to user  (high, reads=action_plan)
Summarize the action plan for the user in their language.
```

The parent conversation is the delivery channel. If a real recipe needs
Trello/GitHub/Jira, add this later:

```markdown
## 8. Present to user  (high, reads=action_plan, deliver=trello:comment)
Post the summary on card `{{card}}` using the trello skill.
```

Runtime responsibilities when this ships:

- gate on skill presence at overview
- record the delivery in `manifest.deliverables`
- let the agent perform the delivery through the skill

Until then, keep it out of the implementation path.

## Relationship to pi-subagents runtime

**We do not depend on `@tintinweb/pi-subagents` for execution.** The review
confirmed it is a thin wrapper over pi's first-party SDK (`createAgentSession`
from `@earendil-works/pi-coding-agent`) — the same package we already declare
as a peerDependency. The wrapper has been the sole source of breakage this
session: the chain API our compiler targeted never existed in any published
release, the tool was silently renamed (`subagent` → `Agent`), and every
`event.toolName === "subagent"` hook was dead code.

**Stage D owns the dispatcher.** The pipeline tool's `execute` spawns child
`AgentSession`s directly via the SDK, collects results + usage from session
state, and updates the manifest inline. The parent LLM drops out of the
orchestration loop. This is a strict reduction in coupling: we depend on the
pi SDK (stable, first-party, already a peerDependency) instead of a
third-party extension that drifts.

The `agents/*.md` profile files stay — we now own their frontmatter contract
(`tools:`, `thinking:`, `systemPromptMode`, `description:`, optional
`maxTurns:`). The compiled-chain serializer (`compileRecipeToChain`) and its
golden fixture are retired: the chain API they targeted was never real.

The `"capability"` failure kind in `lib.ts` is retained for classifying any
future runtime-rejection errors, but is no longer load-bearing.

## Change sites

Where each stage lands in the codebase. Signatures are the contract; names
can shift during implementation.

### Stage 1 — `src/workspace.ts` (new)

```ts
interface WorkspaceInfo {
  runId: string;          // "<recipe>-<yyyymmdd>-<hex6>"
  dir: string;            // absolute: <project>/<artifacts.root>/<runId>
  targetsDir: string;     // <dir>/targets
  collectionsDir: string; // <dir>/collections
  logsDir: string;        // <dir>/logs
  tempRoot: string;       // <dir>/temp (or artifacts.temp_root)
  manifestPath: string;   // <dir>/manifest.json
}

mintRunId(recipe: string, now?: Date): string
createWorkspace(projectDir: string, recipe: string, cfg: ArtifactsConfig): WorkspaceInfo
writeManifestShell(ws: WorkspaceInfo, recipe: string, projectDir: string): void
updateManifestStep(ws: WorkspaceInfo, step: ManifestStep): void
finalizeManifest(ws: WorkspaceInfo, status: "completed" | "failed" | "partial"): void
cleanupRuns(projectDir: string, cfg: ArtifactsConfig): void   // retention + max_retained_runs
loadArtifactsConfig(settingsPath?: string): ArtifactsConfig   // pipeline.artifacts, with defaults
```

Wired from `src/extension.ts`: the `pipeline` tool's `execute` creates the
workspace (non-dryRun, named-recipe path) before dispatching; the
dispatcher calls `updateManifestStep` inline with each step's real
`completed`/`failed`/`partial` status and usage (no event sniffing);
`finalizeManifest(deriveRunStatus(steps))` runs when the run ends;
`cleanupRuns` runs on the next `pipeline` tool call.

### Stage 2 — `src/recipes.ts` + `src/lib.ts` (done)

```ts
interface TargetSpec {
  name: string;                                  // [A-Za-z_][A-Za-z0-9_-]*
  scheme: "work" | "temp" | "project" | "legacy";
  kind: "singleton" | "collection";              // collection iff {unit.*} present
  ext: string;                                   // "md" default, "json" for :json
  rawPath?: string;                              // legacy/scheme paths only
}

parseOutputSpec(token: string): TargetSpec        // unit-tested directly
// parseStepHeaderTail: output/reads become TargetSpec-aware;
//   PlanStep gains outputs?: TargetSpec[] (PlanStep.output stays for back-compat)
// buildPlanFromRecipe: validates reads↔outputs at load time; unresolved
//   reads are errors in the returned plan, surfaced by the pipeline tool
```

`renderPlan` in `lib.ts` shows each target with its scheme and tags legacy
outputs `(legacy cwd)`. Target paths are resolved to absolute workspace
paths by `resolveTargetPath` (extracted from the retired
`compileRecipeToChain` into a shared helper the dispatcher reuses).

### Stage 3 — `src/workspace.ts` + `src/extension.ts` (done, per-run)

Per-step temp dirs are created under `<tempRoot>/<slug>/` and the path is
injected into each step's task text. Cleanup is per-run today; **per-step
teardown lands with Stage D** — `dispatchStep` cleans the step's temp dir
after `session.dispose()`. Per-slot isolation is cheap in `dispatchIterate`
(pass a per-unit temp path into each child); add when a recipe needs it.

### Stage D — `src/dispatcher.ts` (new, the pivot)

```ts
interface AgentProfile {
  name: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPromptMode?: "replace" | "append";
  systemPrompt: string;
  maxTurns?: number;
}

loadAgentProfile(name: string, agentsDir: string): AgentProfile
dispatchStep(step: PlanStep, ws: WorkspaceInfo, profile: AgentProfile, opts: DispatchOpts): Promise<StepResult>
dispatchIterate(step: PlanStep, ws: WorkspaceInfo, profile: AgentProfile, units: Unit[], opts: DispatchOpts): Promise<StepResult>
deriveRunStatus(steps: ManifestStep[]): "completed" | "failed" | "partial"
```

`dispatchStep` creates a child `AgentSession` via the pi SDK
(`createAgentSession`), prompts it with the composed task (workspace paths
resolved), collects the final text + usage from session state, enforces
`maxTurns`, and disposes. `dispatchIterate` does the same over the unit
list with a concurrency cap. No `tool_result` event sniffing — usage comes
from the session directly.

### Stage 5 — `src/workspace.ts`

`readManifest(dir)`, `planDelta(plan, manifest): PlanStep[]` — the resume
core, pure and unit-testable. Far simpler now that the dispatcher owns the
loop and can re-dispatch inline.

## Test plan

All tests follow the existing pattern: pure functions, `node --test`, no pi
imports (except `dispatcher.test.ts` which may mock the SDK).

**`test/workspace.test.ts` (done)**
- `mintRunId` format and uniqueness under same-millisecond calls
- `createWorkspace` produces the documented layout
- manifest shell/update/finalize round-trips match the shape in this doc
- retention: `never`/`failed`/`always` × run-status fixtures;
  `max_retained_runs` prunes oldest first
- `loadArtifactsConfig` defaults when settings are missing or partial
- **(Stage D extension)** `deriveRunStatus` cases; the failed-run retention
  case the current tests can't exercise (now reachable because the
dispatcher writes real statuses)

**`test/targets.test.ts` (done)**
- `parseOutputSpec`: bare name → work/md singleton; `:json` → json + schema;
  `{unit.path}` → collection; `temp:`/`project:`/`work:` schemes; dotted
  filename → legacy; placeholder-stripping before the legacy dot test
- reads resolution: named target resolves; unknown name is a load-time error
  naming available targets; collection read flags task substitution
- name validation: rejects names that don't slugify to a valid runtime `as`

**`test/recipes.test.ts` (done)**
- regression guard: every shipped legacy recipe parses and validates
- load-time validation errors: unresolvable `reads=`, `iterate=` pointing at
  a non-json target, `{unit.field}` missing from the enumerate schema

**`test/dispatcher.test.ts` (new, Stage D)**
- `loadAgentProfile` parses a fixture agent file → `AgentProfile`
- `deriveRunStatus` across step-status fixtures
- (The actual `dispatchStep` is an integration test — see the smoke test.)

**Live verification (Stage D milestone)** — run
`/pipeline summarize-files "*.md in docs"` against a real repo. Validates
the *real* path: the dispatcher spawns child sessions, workspace/manifest/
temp behave, fan-out runs with the concurrency cap, the reduce step reads
collection files by path, and `/pipeline-audit` reads a manifest with true
step statuses. **Not yet done** — all current tests are unit tests against
fixtures; this is the highest-value validation still pending.

## Implementation plan

Sequencing rationale: Stage D (own dispatch) is the pivot — it makes the
pipeline a real build runner and dissolves Stages 0, 1.5, and the
instruction/chain split. The substrate-independent work (Stages 1–4) is
already done. After Stage D lands and the live smoke test passes, the
remaining work is recipe migration (user value) and resume (built on the
now-owned loop).

### Stage D — own the dispatcher (the pivot)

**Goal:** the pipeline tool's `execute` confirms the plan, then runs it
internally by spawning child `AgentSession`s via pi's first-party SDK — no
parent-LLM orchestration, no third-party subagent extension.

**Drop:** the `@tintinweb/pi-subagents` dependency from the execution path
(keep the `agents/*.md` profiles; we own their frontmatter contract now).
Retire `compileRecipeToChain` and its golden fixture (the chain API it
targeted never existed publicly).

**New module `src/dispatcher.ts`:**
- `loadAgentProfile(name, agentsDir): AgentProfile` — parse `agents/*.md`
  frontmatter → `{ model, thinking, tools, systemPromptMode, systemPrompt }`.
  Reuses the existing `loadTierModels` for model resolution.
- `dispatchStep(step, ws, profile, opts): StepResult` — create an
  `AgentSession` with the resolved model/tools/system-prompt, `prompt(task)`,
  collect final text + usage, enforce `maxTurns`, `dispose()`. Resolves
  workspace paths into the task (reuses existing path resolution from
  `compileRecipeToChain`'s helpers — extract them into a shared module).
- `dispatchIterate(step, ws, profile, units, opts): StepResult` — same, but
  `Promise.all` with a concurrency cap (config `max_concurrency`, default ~4)
  over the unit list; per-unit error isolation; aggregate into the
  collection's `units[]` manifest entry.
- Usage comes from the session directly — no `tool_result` event sniffing.

**`extension.ts` changes:**
- The `pipeline` tool's `execute` becomes: resolve plan → validate →
  (non-dryRun) create workspace → for each step: `dispatchStep`/
  `dispatchIterate` → `updateManifestStep` inline with real status →
  `finalizeManifest(deriveRunStatus(steps))` → return summary.
- Remove the `subagent`/`Agent` `tool_call`/`tool_result`/`tool_execution_*`
  hooks — they're dead against the installed runtime and unnecessary once we
  own dispatch. Cost tracking moves into the dispatcher (usage from session
  state). Keep `/pipeline-costs` and `/pipeline-audit` reading the report
  the dispatcher populates.
- Keep the `before_provider_request` model-fallback hook (unaffected).

**`workspace.ts` additions:**
- `deriveRunStatus(steps): "completed" | "failed" | "partial"` — any failed
  step → `failed`; any partial collection → `partial`; else `completed`.
- `finalizeManifest` calls `deriveRunStatus` internally (drop the hardcoded
  status param).

**Agent frontmatter contract (ours now):** keep the existing keys
(`tools:`, `thinking:`, `systemPromptMode: replace`, `description:`) — they
were already pi-subagents' convention, and changing them is a one-time
migration we control. Add `maxTurns?:` as an optional per-agent cap.

**Tests:**
- `test/dispatcher.test.ts`: `loadAgentProfile` parses a fixture agent file;
  `deriveRunStatus` across step-status fixtures. (The actual `dispatchStep`
  is an integration test — see the smoke test.)
- `test/workspace.test.ts` extended: `deriveRunStatus` cases; the failed-run
  retention case that the current tests can't exercise (now reachable because
  the dispatcher writes real statuses).

**What dissolves:**
- Stage 0 (substrate detection) — no external runtime to detect.
- Stage 1.5 (manifest status loop + tool-name fix) — we know step start/end
  directly; no event to mismatch.
- Instruction mode — there is one execution path now.
- Per-step temp teardown — `dispatchStep` cleans the step's temp dir after
  the session disposes.
- OD #4 (reduce-step `{outputs.*}` inflation) — reduce reads collection
  files by path.
- Coordinator/parent-paraphrase pain — the parent doesn't orchestrate.

### Stage 1 — run workspace and manifest shell ✅ DONE

- mint `run_id`
- create `.pi/run/<run_id>/`
- create `manifest.json` with recipe, project_dir, run_id, started_at
- `WorkspaceInfo` passed to the dispatcher for path resolution (Decided #2)
- retain or clean by `pipeline.artifacts.retain_runs`

### Stage 2 — target syntax and validation ✅ DONE

- parse `output=summary`, `output=scope:json`, `output=summary-{unit.path}`
- parse `reads=summary`, `reads=project:README.md`
- validate that named reads resolve to earlier outputs
- targets resolved to absolute workspace paths for the dispatcher
- record targets in `manifest.json`

### Stage 3 — temp lifecycle ✅ DONE (per-run; per-step lands with Stage D)

- per-step temp dirs created + injected into task text
- per-run cleanup today; per-step teardown becomes trivial in Stage D
  (`dispatchStep` cleans after `session.dispose()`)
- retain logs on failure via workspace retention

### Milestone: live smoke test (after Stage D)

Run `/pipeline summarize-files "*.md in docs"` against a real repo. Now
validates the *real* path: the dispatcher spawns child sessions, workspace/
manifest/temp behave, fan-out runs with the concurrency cap, the reduce
step reads collection files by path, and `/pipeline-audit` reads a manifest
with true step statuses. This is the test that proves the build layer is real.

### Stage 4 — migrate shipped recipes (after the smoke test)

- ✅ `summarize-files`, `probe`, `docs-audit` migrated
- `renderPlan` legacy tags: tag outputs `(legacy cwd)` when `step.outputs`
  is unset but `step.output` is — makes migration status visible
- migrate legacy `parallel` recipes (`code-quality`, `verify-source`,
  `housekeeping`) to `iterate=`. The `<area>`/`<batch>` parent-invented
  tokens become enumerate steps producing unit lists. Do `verify-source`
  first (simplest), validated by the live-run loop.

### Stage 5 — resume/retry (far simpler once dispatch is owned)

- `readManifest(dir)`, `planDelta(plan, manifest): PlanStep[]` — pure,
  unit-testable
- retry failed units from fan-out collections (re-dispatch inline)
- skip completed singleton steps when outputs exist and input hashes match
- `--resume <run_id>` / tool parameter equivalent

### Stage 6 — external delivery, only when needed

Add `deliver=skill:action`, overview gating, and manifest deliverables when a
real recipe needs external delivery. Do not build this before a concrete
Trello/GitHub/Jira recipe exists.


## Decided

1. **Legacy literals stay in cwd.** Dotted/pathed outputs compile exactly as
   today; only the new target forms use the workspace. Upgrading is
   non-breaking; migration is per-recipe and visible in `renderPlan`.
2. **Compile-time absolute paths.** The workspace is minted before dispatch;
   the dispatcher resolves target paths to absolute workspace paths.
   `{unit.*}` is the only runtime placeholder (substituted per dispatch in
   iterate steps); `{outputs.*}` and `{chain_dir}` are not used.
3. **Collection identity = the target name.** A fan-out target `summary`
   owns `collections/summary/`; the reduce step reads that directory by
   path. The retired chain-mode `collect.as`/`collected_` distinction is
   moot — there is no runtime collection handle, just a filesystem one.
4. **Target names** match `[A-Za-z_][A-Za-z0-9_-]*`; hyphens slugify to
   underscores for the runtime `as` field. `output=scope:json` and legacy
   `output=scope-files.json` share the same auto-schema mechanism.
5. **`work:` is a valid explicit scheme**, identical to the default; it
   exists so a recipe can be fully explicit when teaching or debugging.
6. **`retain_runs` defaults to `failed`.**
7. **Partial fan-out failure** yields `status: "partial"`, a populated
   collection with per-unit status, and a reduce step told the failure count
   (see "Failure semantics").

## Open decisions

1. **Worktree mutation policy.** Two fan-out slots mutating `project:` can
   race. Lean: ship a `dev-worktree` agent variant (agent-level isolation,
   consistent with the tools-bounding principle). With own-dispatch this is
   a per-step flag the dispatcher can honor directly.
2. **Concurrency cap.** `max_concurrency` for iterate fan-out (default ~4).
   Config under `pipeline.dispatch`. Replaces the old `maxItems` chain field.
3. **Run cleanup UX.** `/pipeline-runs`, `/pipeline-clean`,
   `/pipeline-resume` commands. Out of scope until Stage 5; the manifest
   shape already anticipates them.
4. **Reduce-step input size.** **Dissolved by own-dispatch:** the reduce
   step reads collection files by absolute path and selects as it goes — no
   `{outputs.*}` substitution, no inflation. Revisit only if a future
   execution mode re-introduces runtime placeholders.
5. **Per-slot temp isolation.** Iterate slots currently share the step's
   temp dir. With own-dispatch, per-slot subdirs are cheap (`dispatchIterate`
   can pass a per-unit temp path into each child session). Lean: add when a
   recipe demonstrates a collision.
6. **Live smoke test still outstanding.** All 121 tests are unit tests
   against fixtures; no run against a real dispatch backend has been
   performed. This is the highest-value validation still pending and is
   gated into the Stage D milestone.

## Summary

The artifact plan should be the build part of the pipeline, not a generalized
backend abstraction:

- default outputs are named targets in a run workspace
- reads are dependencies
- fan-out outputs are collections
- the manifest is designed for audit, retry, and resume
- temp is scratch only
- project mutations are explicit and audited
- external delivery is deferred until a real recipe demands it

This gives us the flexibility we wanted — cleaner handoffs, isolated run
artifacts, staged build/test scratch, future retry/resume — with much less
surface area than a pluggable artifact backend.
