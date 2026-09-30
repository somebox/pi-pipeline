/**
 * Recipe parser — turns a markdown pipeline recipe into a `Plan`.
 *
 * A recipe is a markdown file with optional YAML frontmatter and a body of
 * numbered `## N. Phase (agent[, flags])` sections. See SPEC.md for the full
 * format. This module is pure (no fs, no pi imports) so it's unit-testable
 * with `node --test`.
 *
 * Grammar (step header):
 *   ## <number>. <phase>  ( <agent> [, parallel] [, reads=<files>] [, output=<file>] )
 *
 * The section body paragraphs are the task text, verbatim. `{{name}}`
 * placeholders are substituted from the invocation's inputs at plan-build
 * time (see buildPlanFromRecipe). `output`/`reads` are inferred from prose
 * patterns ("Write `x.md`" → output; "Read `y.md`" → reads) when not given
 * as flags; explicit flags always win.
 */

import { type Plan, type PlanStep, composeStepTask } from "./lib.ts";

/** Parsed recipe frontmatter. All fields optional. */
export interface RecipeFrontmatter {
	name?: string;
	description?: string;
	inputs?: string[];
	/** Inputs that may be omitted; an omitted optional input substitutes as "". */
	optional_inputs?: string[];
}

/** A discovered recipe on disk (path + raw text + parsed frontmatter). */
export interface DiscoveredRecipe {
	name: string;
	description: string;
	filePath: string;
	source: "user" | "project" | "package";
	frontmatter: RecipeFrontmatter;
	raw: string;
}

export interface RecipeBuildInput {
	/** The recipe's raw markdown text. */
	raw: string;
	/** Defaults to the filename stem if frontmatter omits `name`. */
	nameFallback: string;
	/** Resolved inputs for {{placeholder}} substitution. */
	inputs?: Record<string, string>;
	/** Hints prepended to each step's task (same as the built-in path). */
	hints?: string[];
}

/* ───────────────────────── frontmatter ───────────────────────── */

/** Parse a leading YAML-ish frontmatter block. Best-effort: only the fields
 *  we use (name, description, inputs, optional_inputs), no full YAML. Returns {frontmatter,
 *  body} where body is the markdown without the frontmatter fence. */
export function parseFrontmatter(raw: string): { frontmatter: RecipeFrontmatter; body: string } {
	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!fmMatch) return { frontmatter: {}, body: raw };
	const block = fmMatch[1]!;
	const body = fmMatch[2] ?? "";
	const fm: RecipeFrontmatter = {};
	let currentKey: string | null = null;
	for (const line of block.split(/\r?\n/)) {
		if (/^\s*#/.test(line)) continue; // YAML comment
		const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
		if (kv) {
			currentKey = kv[1]!;
			const val = kv[2]!.trim();
			if (currentKey === "name" || currentKey === "description") {
				if (val) (fm as any)[currentKey] = stripQuotes(val);
			} else if (currentKey === "inputs" || currentKey === "optional_inputs") {
				// a list; value on this line (if any) ignored, expect `- item` below
				fm[currentKey] ??= [];
			}
			continue;
		}
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && (currentKey === "inputs" || currentKey === "optional_inputs")) {
			const v = item[1]!.trim();
			if (v) (fm[currentKey] ??= []).push(stripQuotes(v));
		}
	}
	return { frontmatter: fm, body: body.replace(/^[\r\n]+/, "") };
}

function stripQuotes(s: string): string {
	return s.replace(/^["'](.*)["']$/, "$1");
}

export interface TargetSpec {
  /** Target identifier, used in reads= references and the manifest. */
  name: string;
  /** Where the target lives. */
  scheme: "work" | "temp" | "project" | "legacy";
  /** Singleton = one file; collection = one per fan-out unit. */
  kind: "singleton" | "collection";
  /** File extension (md, json, etc.). */
  ext: string;
  /** For scheme=temp/project/legacy: the raw path literal from the recipe. */
  rawPath?: string;
  /** For collections: the unit placeholder pattern (e.g. "{unit.path}"). */
  unitPattern?: string;
}

/** Determine whether an output token is a legacy literal path (contains . or /
 *  after stripping {…} placeholders) or a new target name. */
export function isLegacyOutput(token: string): boolean {
  // Strip all {…} placeholder expressions.
  const stripped = token.replace(/\{[^{}]*\}/g, "");
  // If there is an explicit scheme prefix it is never legacy.
  if (/^(?:temp|project|work):/.test(token)) return false;
  // If there is an explicit scheme assignment (name=scheme:...) it is never legacy.
  if (/^[A-Za-z_][A-Za-z0-9_-]*=(?:temp|project|work):/.test(token)) return false;
  // If the stripped text contains a dot or slash it is a filesystem path.
  return /[./]/.test(stripped);
}

/** Parse an `output=` token into a structured target spec. Returns `null` for
 *  legacy literals so the caller keeps the raw string in `PlanStep.output`. */
export function parseOutputSpec(token: string): TargetSpec | null {
  if (isLegacyOutput(token)) return null;

  // Explicit scheme form: name=scheme:path
  const explicitScheme = token.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(temp|project|work):(.+)$/);
  if (explicitScheme) {
    const name = explicitScheme[1];
    const scheme = explicitScheme[2] as TargetSpec["scheme"];
    const rawPath = explicitScheme[3];
    const ext = rawPath.includes(".") ? rawPath.split(".").pop()! : "md";
    return { name, scheme, kind: "singleton", ext, rawPath };
  }

  // JSON shorthand: name:json
  const jsonForm = token.match(/^([A-Za-z_][A-Za-z0-9_-]*):json$/);
  if (jsonForm) {
    return { name: jsonForm[1], scheme: "work", kind: "singleton", ext: "json" };
  }

  // Collection form: name-{unit.XXX}
  const collForm = token.match(/^([A-Za-z_][A-Za-z0-9_-]*)-\{(unit(?:\.[A-Za-z0-9_-]+)?)\}$/);
  if (collForm) {
    return { name: collForm[1], scheme: "work", kind: "collection", ext: "md", unitPattern: `{${collForm[2]}}` };
  }

  // Bare name → work singleton, default ext md
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) {
    return { name: token, scheme: "work", kind: "singleton", ext: "md" };
  }

  // Unrecognised but not legacy → treat as work singleton with the literal as ext
  return { name: token, scheme: "work", kind: "singleton", ext: "md" };
}

/** Build a set of target names declared by earlier steps, for read validation. */
export function availableTargets(steps: readonly PlanStep[], upToIndex: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < upToIndex; i++) {
    for (const t of steps[i]?.outputs ?? []) set.add(t.name);
  }
  return set;
}

/** Validate that every read reference resolves to an earlier target or explicit scheme.
 *  Returns an empty array when valid, otherwise a list of human-readable errors. */
export function validatePlanTargets(plan: Plan): string[] {
  const errors: string[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const avail = availableTargets(plan.steps, i);
    for (const read of step?.reads ?? []) {
      if (read.startsWith("project:")) continue;
      if (isLegacyOutput(read)) continue;     // legacy literals are not validated
      if (!avail.has(read)) {
        errors.push(
          `Step "${step.phase}" reads unresolved target "${read}". Available: ${[...avail].join(", ") || "(none)"}.`,
        );
      }
    }
  }
  return errors;
}

/* ───────────────────────── step header ───────────────────────── */

export interface ParsedStepHeader {
	phase: string;
	agent: string;
	parallel: boolean;
	reads: string[];
	output: string | undefined;
	iterate: string | undefined;
	checkpoint: string | undefined;
}

/** Parse a `(agent, flags)` header tail. Returns null if no parenthesized tail. */
export function parseStepHeaderTail(tail: string): { agent: string; parallel: boolean; reads: string[]; output: string | undefined; iterate: string | undefined; checkpoint: string | undefined } | null {
	const m = tail.match(/^\(([^)]*)\)\s*$/);
	if (!m) return null;
	const parts = m[1]!.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
	if (parts.length === 0) return null;
	const agent = parts[0]!;
	let parallel = false;
	let reads: string[] = [];
	let output: string | undefined;
	let iterate: string | undefined;
	let checkpoint: string | undefined;
	for (let i = 1; i < parts.length; i++) {
		const p = parts[i]!;
		if (p === "parallel") parallel = true;
		else if (p.startsWith("reads=")) reads = p.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
		else if (p.startsWith("output=")) output = p.slice(7).trim();
		else if (p.startsWith("iterate=")) iterate = p.slice(8).trim();
		else if (p.startsWith("checkpoint=")) {
			const tok = p.slice(11).trim();
			// Stable token: letters, digits, underscore, hyphen. Invalid tokens
			// are ignored.
			if (/^[A-Za-z0-9_-]+$/.test(tok)) checkpoint = tok;
		}
		// Unknown flags are ignored — keeps the grammar forward-compatible.
	}
	return { agent, parallel, reads, output, iterate, checkpoint };
}

/* ───────────────────────── prose inference ───────────────────────── */

/** Infer output filename from prose like "Write `findings.md`". Returns the
 *  last backticked .md file mentioned with a write verb, or undefined. */
export function inferOutput(prose: string): string | undefined {
	const writeMatch = prose.match(/\b(?:write|writes|save|output to)\s+`([^`]+\.md)`/i);
	if (writeMatch) return writeMatch[1]!;
	// "Write findings.md" (no backticks)
	const writeMatch2 = prose.match(/\b(?:write|writes|save|output to)\s+([A-Za-z0-9_./-]+\.md)\b/i);
	return writeMatch2 ? writeMatch2[1] : undefined;
}

/** Infer reads from prose: every backticked `.md` reference is a read
 *  (glob patterns like `*-issues-*.md` and templated names like
 *  `code-issues-<area>.md` count). The output file is subtracted by the caller. */
export function inferReads(prose: string): string[] {
	const reads: string[] = [];
	const re = /`([^`]*\.md)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(prose)) !== null) {
		if (!reads.includes(m[1]!)) reads.push(m[1]!);
	}
	return reads;
}

/* ───────────────────────── placeholder substitution ───────────────────────── */

/** Substitute {{name}} placeholders from inputs. Missing inputs are left as-is
 *  so `checkRecipeInputs` can report them; a run refuses to start while any
 *  remain. */
export function substituteInputs(text: string, inputs?: Record<string, string>): string {
	if (!inputs) return text;
	return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (whole, key: string) => {
		return Object.prototype.hasOwnProperty.call(inputs, key) ? inputs[key]! : whole;
	});
}

/* ───────────────────────── step parsing ───────────────────────── */

/** Parse the recipe body into steps. Each step is a `## N. Phase (tail)` H2
 *  followed by paragraphs (the task text). */
export function parseSteps(body: string): Array<{ header: ParsedStepHeader; task: string }> {
	const lines = body.split(/\r?\n/);
	const steps: Array<{ header: ParsedStepHeader; task: string }> = [];
	let i = 0;
	// Skip the H1 title line(s) — everything before the first `## ` step.
	while (i < lines.length && !/^##\s+\d+\./.test(lines[i]!)) i++;
	while (i < lines.length) {
		const headerLine = lines[i]!;
		// `## N. Phase (tail)` or `## N. Phase`
		const hm = headerLine.match(/^##\s+\d+\.\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/);
		if (!hm) { i++; continue; }
		const phase = hm[1]!.trim();
		const tail = hm[2];
		const parsed = tail ? parseStepHeaderTail(`(${tail})`) : null;
		const header: ParsedStepHeader = {
			phase,
			agent: parsed?.agent ?? "util",
			parallel: parsed?.parallel ?? false,
			reads: parsed?.reads ?? [],
			output: parsed?.output,
			iterate: parsed?.iterate,
			checkpoint: parsed?.checkpoint,
		};
		// Collect body paragraphs until the next `## ` step.
		i++;
		const bodyLines: string[] = [];
		while (i < lines.length && !/^##\s+/.test(lines[i]!)) {
			bodyLines.push(lines[i]!);
			i++;
		}
		// Trim leading/trailing blank lines, collapse to a single paragraph block
		// but preserve internal blank-line paragraph breaks.
		const task = bodyLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
		steps.push({ header, task });
	}
	return steps;
}

/* ───────────────────────── plan building ───────────────────────── */

/** Build a Plan from a recipe. This is the recipe equivalent of
 *  `buildPlan(params)` in lib.ts — same output type, so renderPlan /
 *  summarizeCost / the cost tracker / model pinning all work unchanged. */
export function buildPlanFromRecipe(input: RecipeBuildInput): Plan {
	const { frontmatter, body } = parseFrontmatter(input.raw);
	const name = frontmatter.name ?? input.nameFallback;
	const parsedSteps = parseSteps(body);
	const inputs = effectiveInputs(frontmatter, input.inputs);

	const steps: PlanStep[] = parsedSteps.map(({ header, task }) => {
		const resolvedTask = substituteInputs(task, inputs);
		const outputRaw = header.output ?? inferOutput(resolvedTask);
		// Reads: explicit flag wins; otherwise infer all backticked .md refs and
		// subtract the output (the file this step writes is not a read).
		let reads = header.reads.length > 0 ? header.reads : inferReads(resolvedTask);
		if (outputRaw) reads = reads.filter((r) => r !== outputRaw);

		// Parse output token into structured targets (Stage 2). Legacy literals
		// stay in `output`; new targets populate `outputs`.
		const outputs: TargetSpec[] | undefined = outputRaw ? (() => {
			const spec = parseOutputSpec(outputRaw);
			return spec ? [spec] : undefined;
		})() : undefined;

		// Infer iterate from prose: "For each `{unit}` in scope-files..."
		const iterateMatch = resolvedTask.match(/for each `{unit(?:\.[A-Za-z0-9_-]+)?}` in ([A-Za-z0-9_-]+)/i);
		const inferredIterate = iterateMatch ? iterateMatch[1] : undefined;
		const iterate = header.iterate ?? inferredIterate;

		return {
			phase: header.phase,
			agent: header.agent,
			label: header.phase, // label == phase for recipes; renderPlan shows it
			task: resolvedTask,
			output: outputRaw,
			outputs,
			reads: reads.length > 0 ? reads : undefined,
			parallel: header.parallel ? 1 : undefined,
			iterate,
			checkpoint: header.checkpoint,
		};
	});

	// Compose each step's task: hints prefix the base task (composeStepTask
	// handles the HINTS/TASK: marker consistently).
	const finalSteps = steps.map((s) => ({
		...s,
		task: composeStepTask(s.task, input.hints),
	}));

	return {
		// Recipes don't have mode/effort; use placeholder values so the Plan
		// shape is satisfied. renderPlan prints these but they're meaningless
		// for a named recipe (the overview TUI shows the recipe name instead).
		effort: "standard" as const,
		mode: "research" as const,
		summary: frontmatter.description ?? `${name} pipeline (${steps.length} steps)`,
		steps: finalSteps,
	};
}

/** Extract the required inputs declared in frontmatter (`inputs:`). */
export function declaredInputs(raw: string): string[] {
	return parseFrontmatter(raw).frontmatter.inputs ?? [];
}

/** The supplied inputs plus "" for every omitted optional input. */
function effectiveInputs(fm: RecipeFrontmatter, inputs?: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of fm.optional_inputs ?? []) out[name] = "";
	return { ...out, ...inputs };
}

export interface InputProblems {
	/** Required inputs (frontmatter `inputs:`) that were not supplied or are blank. */
	missing: string[];
	/** Placeholders still in a step's task after substitution that are not
	 *  declared inputs — the recipe uses a name it forgot to declare. */
	undeclared: Array<{ step: number; phase: string; names: string[] }>;
}

/** Check a recipe invocation's inputs before a run starts. Returns undefined
 *  when every placeholder resolves. Listing and dry runs may build a plan
 *  without inputs; only starting a run must pass this check. */
export function checkRecipeInputs(raw: string, inputs?: Record<string, string>): InputProblems | undefined {
	const { frontmatter, body } = parseFrontmatter(raw);
	const required = frontmatter.inputs ?? [];
	const missing = required.filter((name) => !(inputs?.[name] ?? "").trim());
	// Blank required inputs count as missing; keep them unsubstituted so they
	// are not reported twice.
	const supplied = Object.fromEntries(Object.entries(inputs ?? {}).filter(([k]) => !missing.includes(k)));
	const resolved = effectiveInputs(frontmatter, supplied);
	const undeclared: InputProblems["undeclared"] = [];
	parseSteps(body).forEach(({ header, task }, i) => {
		const names = usedPlaceholders(substituteInputs(task, resolved)).filter((n) => !missing.includes(n));
		if (names.length > 0) undeclared.push({ step: i + 1, phase: header.phase, names });
	});
	return missing.length > 0 || undeclared.length > 0 ? { missing, undeclared } : undefined;
}

/** Human-readable refusal for `checkRecipeInputs` problems. */
export function formatInputProblems(recipeName: string, problems: InputProblems): string {
	const code = (n: string) => `\`${n}\``;
	const lines: string[] = [];
	if (problems.missing.length > 0) {
		lines.push(`Recipe "${recipeName}" requires input(s) that were not supplied or are empty: ${problems.missing.map(code).join(", ")}.`);
	}
	for (const u of problems.undeclared) {
		lines.push(`Step ${u.step} "${u.phase}" uses placeholder(s) ${u.names.map((n) => code(`{{${n}}}`)).join(", ")} that the recipe does not declare and no input supplied.`);
	}
	const names = [...problems.missing, ...problems.undeclared.flatMap((u) => u.names)];
	const example = JSON.stringify(Object.fromEntries([...new Set(names)].map((n) => [n, "..."])));
	lines.push(`Pass values in the pipeline tool's \`inputs\` parameter, e.g. \`inputs: ${example}\`. If the task does not say what a value should be, ask the user rather than guessing.`);
	if (problems.undeclared.length > 0) {
		lines.push(`If an undeclared placeholder is a recipe bug, declare it under \`inputs:\` (or \`optional_inputs:\`) in the recipe frontmatter.`);
	}
	return lines.join("\n");
}

/** Find {{placeholder}} names actually used in the text. */
export function usedPlaceholders(raw: string): string[] {
	const set = new Set<string>();
	const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) set.add(m[1]!);
	return [...set];
}

