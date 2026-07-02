# Examples

> Walked recipes with commentary. The recipe files themselves are the single
> source of truth — this doc *describes* them and links to the real files
> rather than duplicating them, so the two can't drift apart. For the format
> see [SPEC.md](SPEC.md); for the model see [ARCHITECTURE.md](ARCHITECTURE.md).

## Shipped recipes

The package ships four recipes in [`pipelines/`](../pipelines/). Each
illustrates a different shape.

### `code-quality` — a fixed checklist (no iteration)

File: [`pipelines/code-quality.md`](../pipelines/code-quality.md)

The original non-iterating pipeline: audit code & tests in a scope against
the repo's own standards, then produce a prioritized action plan. Eight
steps, three profiles (`util` → `dev` × 2 → `research` → `high` → `dev` →
`high` × 2). This is the "fixed checklist" shape — the simplest recipe form,
no `iterate=`. It's also the failure case that motivated the iteration model
(see ARCHITECTURE.md "Why iteration"): its step 1 invited the `util` agent to
explore the whole repo, which bloated context. The recipe is kept as-shipped
for the checklist shape; a future `code-quality` v2 would rework steps 1–3
as iteration over the in-scope files.

### `verify-source` — a small fixed checklist with a parallel step

File: [`pipelines/verify-source.md`](../pipelines/verify-source.md)

Scan docs, verify every quote/citation against its original source. Four
steps; step 2 uses the legacy `parallel` flag (soft fan-out). A good minimal
example of a non-iterating recipe with fan-out.

### `summarize-files` — the simplest iteration (proof-of-concept)

File: [`pipelines/summarize-files.md`](../pipelines/summarize-files.md) *(to be added in Phase 2)*

The proof-of-concept for context isolation by construction. Mechanical
enumeration (a `util` step writes `scope-files.json` from a glob — no
`coordinator`); the step's own prose is the per-unit prompt (no
`per-unit-prompt.md`); one bounded `dev` per file; a `research` reduce step.
Each map dispatch is ~5k tokens and isolated — bloat is impossible by
construction. This is the recipe to validate against a real repo in Phase 2:
the audit should show N small dispatches vs one bloated one.

Reference shape (target, not yet shipped):
```markdown
## 1. Enumerate files  (util, output=scope-files.json, tools=read)
## 2. Summarize each file  (dev, iterate=scope-files, output=summary-{unit.path}.md)
## 3. Merge summaries  (research, reads=summary-*.md, output=summaries.md)
```

### `screenshot-worklog` — iteration over non-files, with a coordinator

File: `pipelines/screenshot-worklog.md` *(to be added in Phase 2)*

The richer iteration case: for every screenshot in `~/screenshots`, look for
commits after it, match to a card/feature, review the image, attach to the
relevant card, rename to `feature-date`, and file in the worklog dir. This is
the "judgment enumeration" case — a `coordinator` step loads the engineering
board and writes both `shots.json` and `per-unit-prompt.md` (the matching
logic is complex enough to warrant an authored template). Step 2 is a
per-unit *chain* (commits → match → review → attach → rename → file) owned
by one focused `dev` with `tools=read,write,bash`. The small-context
guarantee holds because the subagent sees one screenshot + the shared board
list + the prompt — not the whole repo or all screenshots.

Reference shape (target):
```markdown
## 1. Enumerate screenshots + load board  (coordinator, output=shots.json, tools=read,bash)
## 2. Process each screenshot  (dev, iterate=shots, reads=per-unit-prompt.md, board.json, output=worklog-{unit.path}.md, tools=read,write,bash)
## 3. Report  (research, reads=worklog-*.md, output=report.md)
```

## Note: iteration where N is content (not code)

The same enumerate→map→reduce pattern works when the iterable isn't files but
*ideas* (or bugs, cards, proposals): an enumerate step ("generate 8 ideas
based on `{{brief}}`") produces `<name>.json`, a map step iterates over it
(`research-{unit.id}.md` per idea), a reduce step picks finalists
(`finalists.json`), and a second map step iterates over *that* list
(`sketch-{unit.id}.md`). N ("8 ideas", "3 finalists") is prompt-template
content in the enumerate step's prose — the orchestrator runs the map over
whatever list each enumerate step produced.

This needs no new syntax beyond what `summarize-files` shows; the only
difference is the unit objects have domain fields (`id`, `summary`, `angle`)
instead of `path`, and a recipe can have two iteration phases alive at once
because each `iterate=<name>` reads its own `<name>.json`. Left as an
exercise rather than a shipped recipe — the mechanism is identical to
`screenshot-worklog`; only the unit schema differs.

## Authoring a new recipe

Until `pi pipeline new` ships (Phase 3), copy the closest shipped recipe and
edit. The three shapes above cover the common cases:

- **Fixed checklist** → copy `verify-source` (simplest) or `code-quality` (multi-step).
- **Iteration over files** → copy `summarize-files` (when it ships) and change the glob + the per-unit task.
- **Iteration over non-files / judgment enumeration** → copy `screenshot-worklog` (when it ships) and change the enumerate logic + per-unit prompt.

See [SPEC.md](SPEC.md) for the full grammar (frontmatter, step header flags,
placeholders, inference rules).
