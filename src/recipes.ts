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

import type { Plan, PlanStep } from "./lib.ts";

/** Parsed recipe frontmatter. All fields optional. */
export interface RecipeFrontmatter {
	name?: string;
	description?: string;
	inputs?: string[];
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
 *  we use (name, description, inputs), no full YAML. Returns {frontmatter,
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
			} else if (currentKey === "inputs") {
				// inputs is a list; value on this line (if any) ignored, expect `- item` below
				if (!fm.inputs) fm.inputs = [];
			}
			continue;
		}
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && currentKey === "inputs") {
			const v = item[1]!.trim();
			if (v) (fm.inputs ??= []).push(stripQuotes(v));
		}
	}
	return { frontmatter: fm, body: body.replace(/^[\r\n]+/, "") };
}

function stripQuotes(s: string): string {
	return s.replace(/^["'](.*)["']$/, "$1");
}

/* ───────────────────────── step header ───────────────────────── */

export interface ParsedStepHeader {
	phase: string;
	agent: string;
	parallel: boolean;
	reads: string[];
	output: string | undefined;
}

/** Parse a `(agent, flags)` header tail. Returns null if no parenthesized tail. */
export function parseStepHeaderTail(tail: string): { agent: string; parallel: boolean; reads: string[]; output: string | undefined } | null {
	const m = tail.match(/^\(([^)]*)\)\s*$/);
	if (!m) return null;
	const parts = m[1]!.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
	if (parts.length === 0) return null;
	const agent = parts[0]!;
	let parallel = false;
	let reads: string[] = [];
	let output: string | undefined;
	for (let i = 1; i < parts.length; i++) {
		const p = parts[i]!;
		if (p === "parallel") parallel = true;
		else if (p.startsWith("reads=")) reads = p.slice(6).split(",").map((s) => s.trim()).filter(Boolean);
		else if (p.startsWith("output=")) output = p.slice(7).trim();
	}
	return { agent, parallel, reads, output };
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
 *  (the overview TUI surfaces them before run). */
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

	const steps: PlanStep[] = parsedSteps.map(({ header, task }) => {
		const resolvedTask = substituteInputs(task, input.inputs);
		const output = header.output ?? inferOutput(resolvedTask);
		// Reads: explicit flag wins; otherwise infer all backticked .md refs and
		// subtract the output (the file this step writes is not a read).
		let reads = header.reads.length > 0 ? header.reads : inferReads(resolvedTask);
		if (output) reads = reads.filter((r) => r !== output);
		return {
			phase: header.phase,
			agent: header.agent,
			label: header.phase, // label == phase for recipes; renderPlan shows it
			task: resolvedTask,
			output,
			reads: reads.length > 0 ? reads : undefined,
			parallel: header.parallel ? 1 : undefined,
		};
	});

	// Hints block, same shape as the built-in path.
	let taskPrefix = "";
	if (input.hints && input.hints.length > 0) {
		taskPrefix = `HINTS:\n${input.hints.map((h) => `- ${h}`).join("\n")}\n\nTASK: `;
	}
	const finalSteps = taskPrefix
		? steps.map((s) => ({ ...s, task: `${taskPrefix}${s.task}` }))
		: steps;

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

/** Extract declared inputs from frontmatter (for the overview TUI to prompt). */
export function declaredInputs(raw: string): string[] {
	return parseFrontmatter(raw).frontmatter.inputs ?? [];
}

/** Find {{placeholder}} names actually used in the recipe text (a superset
 *  safety check — if a placeholder is used but not declared, the TUI still
 *  knows to prompt for it). */
export function usedPlaceholders(raw: string): string[] {
	const set = new Set<string>();
	const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) set.add(m[1]!);
	return [...set];
}
