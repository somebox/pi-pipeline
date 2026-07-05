/**
 * Pipeline dispatcher — own the subagent execution loop via pi's first-party
 * SDK (`createAgentSession`). The pipeline tool's `execute` calls
 * `dispatchStep` / `dispatchIterate` for each plan step; usage comes from the
 * session's message history, not from event sniffing. No third-party
 * subagent extension in the execution path.
 *
 * Pure where possible: agent profile loading is a small, well-defined
 * frontmatter parse; model resolution reuses the existing `loadTierModels`.
 * Session creation and dispatch are the only parts that touch the SDK.
 */

import fs from "node:fs";
import path from "node:path";
import { loadTierModels } from "./lib.ts";
import type { PlanStep } from "./lib.ts";
import type { WorkspaceInfo } from "./workspace.ts";
import { updateManifestStep, type ManifestStep, type ManifestUnitEntry } from "./workspace.ts";

/* ──────────────────────── agent profile ──────────────────────── */

export interface AgentProfile {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPromptMode?: "replace" | "append";
	systemPrompt: string;
	maxTurns?: number;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
}

function stripQuotes(s: string): string {
	return s.replace(/^["'](.*)["']$/, "$1");
}

/** Parse a YAML-ish frontmatter block. Returns a flat string→string map of
 *  every key/value (both scalar and short list-of-scalars). Best-effort —
 *  agent files are simple. */
export function parseAgentFrontmatter(raw: string): Record<string, string | string[]> {
	const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fm) return {};
	const out: Record<string, string | string[]> = {};
	let key: string | null = null;
	for (const line of fm[1]!.split(/\r?\n/)) {
		if (/^\s*#/.test(line)) continue; // comment
		const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
		if (kv) {
			key = kv[1]!;
			const val = kv[2]!.trim();
			out[key] = val ? stripQuotes(val) : "";
			continue;
		}
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && key) {
			const v = stripQuotes(item[1]!.trim());
			const existing = out[key];
			if (Array.isArray(existing)) existing.push(v);
			else if (typeof existing === "string" && existing) out[key] = [existing, v];
			else out[key] = [v];
		}
	}
	return out;
}

/** Load a named agent profile from `agents/<name>.md`. Returns the
 *  profile plus the raw file text (for the systemPrompt body). */
export function loadAgentProfile(name: string, agentsDir: string): { profile: AgentProfile; body: string } | null {
	const file = path.join(agentsDir, `${name}.md`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	const fm = parseAgentFrontmatter(raw);
	const body = raw.replace(/^---[\s\S]*?---\r?\n?/, "").trim();
	const toolsRaw = fm["tools"];
	const tools = typeof toolsRaw === "string"
		? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
		: Array.isArray(toolsRaw) ? toolsRaw : undefined;
	const profile: AgentProfile = {
		name: (fm["name"] as string) ?? name,
		description: (fm["description"] as string) ?? "",
		model: typeof fm["model"] === "string" ? fm["model"] : undefined,
		thinking: typeof fm["thinking"] === "string" ? fm["thinking"] : undefined,
		tools,
		systemPromptMode: fm["systemPromptMode"] === "append" ? "append" : "replace",
		systemPrompt: body,
		maxTurns: typeof fm["maxTurns"] === "string" ? Number.parseInt(fm["maxTurns"], 10) : undefined,
		inheritProjectContext: fm["inheritProjectContext"] === "false" ? false : true,
		inheritSkills: fm["inheritSkills"] === "false" ? false : true,
	};
	return { profile, body };
}

/* ──────────────────────── result shape ──────────────────────── */

export interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface StepResult {
	status: "completed" | "failed" | "partial";
	text: string;
	error?: string;
	usage: StepUsage;
	durationMs: number;
	units?: Array<ManifestUnitEntry & { text?: string; error?: string; usage?: StepUsage; durationMs?: number }>;
}

export interface DispatchOpts {
	projectDir: string;
	agentsDir: string;
	// Opaque SDK types — loaded dynamically inside the dispatch functions
	// so the dispatcher can be imported in test contexts without the SDK
	// package being resolvable (pi-pipeline declares it as a peerDep).
	modelRegistry: any;
	authStorage: any;
	concurrency?: number;       // iterate fan-out cap; default 4
	abortSignal?: AbortSignal;
	onProgress?: (text: string) => void; // streamed partial text
}

/* ──────────────────────── helpers ──────────────────────── */

/** Walk a session's messages and return the cumulative usage plus the
 *  terminal status (error/abort) of the run. */
export function extractUsageAndStatus(messages: readonly any[]): {
	usage: StepUsage;
	hadError: boolean;
	hadAborted: boolean;
} {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, turns = 0;
	let hadError = false;
	let hadAborted = false;
	for (const m of messages) {
		if (m?.role === "assistant") {
			turns += 1;
			const u = m.usage;
			if (u) {
				input += u.input ?? 0;
				output += u.output ?? 0;
				cacheRead += u.cacheRead ?? 0;
				cacheWrite += u.cacheWrite ?? 0;
				const c = u.cost;
				if (c) cost += c.total ?? 0;
			}
			if (m.stopReason === "error") hadError = true;
			if (m.stopReason === "aborted") hadAborted = true;
		}
	}
	return {
		usage: { input, output, cacheRead, cacheWrite, cost, turns },
		hadError,
		hadAborted,
	};
}

/** Final assistant text content (concatenated text blocks). */
export function extractText(messages: readonly any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text ?? "")
			.join("");
		if (text) return text;
	}
	return "";
}

/** Resolve a model string like "openrouter/anthropic/claude-sonnet-5" or
 *  "anthropic/claude-sonnet-5" against the ModelRegistry. Splits on the
 *  first `/` to get provider + modelId, since `ModelRegistry.find` takes
 *  them separately. For OpenRouter, the provider is `openrouter` and the
 *  modelId is the nested `vendor/model` string (e.g. `moonshotai/kimi-latest`). */
function resolveModel(modelId: string, registry: any): any {
	if (typeof registry.find !== "function") return null;
	// Split into provider + modelId on the first slash.
	const slash = modelId.indexOf("/");
	if (slash < 0) {
		// Bare id: try matching against any model whose id field equals it.
		const all = typeof registry.getAll === "function" ? registry.getAll() : [];
		return all.find((m: any) => m.id === modelId || m.fullId === modelId) ?? null;
	}
	const provider = modelId.slice(0, slash);
	const rest = modelId.slice(slash + 1);
	// For openrouter, the modelId is the nested vendor/model (e.g.
	// "moonshotai/kimi-k2.7-code") — don't split further.
	const found = registry.find(provider, rest);
	if (found) return found;
	// Fall back to a loose scan in case the split was wrong.
	const all = typeof registry.getAll === "function" ? registry.getAll() : [];
	return all.find((m: any) =>
		m.id === modelId ||
		m.fullId === modelId ||
		`${m.provider}/${m.id}` === modelId,
	) ?? null;
}

/** Resolve a profile's model id to a `Model` object, using tier defaults as
 *  fallback when the profile has no explicit model. */
export function resolveProfileModel(profile: AgentProfile, _agentsDir: string, registry: any): any | undefined {
	if (profile.model) {
		const m = resolveModel(profile.model, registry);
		if (m) return m;
	}
	const tier = profile.name;
	if (tier === "dev" || tier === "util" || tier === "research" || tier === "high") {
		const tierMap = loadTierModels();
		const tierId = tierMap[tier];
		if (tierId) {
			const m = resolveModel(tierId, registry);
			if (m) return m;
		}
	}
	// Last resort: the first available model with configured auth.
	if (typeof registry.getAvailable === "function") {
		const avail = registry.getAvailable();
		if (avail.length > 0) return avail[0];
	}
	if (typeof registry.getAll === "function") {
		const all = registry.getAll();
		if (all.length > 0) return all[0];
	}
	return undefined;
}

/* ──────────────────────── session creation ──────────────────────── */

interface SessionOpts {
	profile: AgentProfile;
	task: string;
	projectDir: string;
	agentsDir: string;
	modelRegistry: any;
	authStorage: any;
	abortSignal?: AbortSignal;
	onProgress?: (text: string) => void;
	unitId?: string;
}

/** Create an `AgentSession` for one step. Returns the session and a dispose
 *  function. The session is NOT prompted yet. */
export async function createStepSession(opts: SessionOpts): Promise<{ session: any; dispose: () => void }> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const { createAgentSession, SessionManager, DefaultResourceLoader } = sdk as any;
	const model = resolveProfileModel(opts.profile, opts.agentsDir, opts.modelRegistry);
	if (!model) throw new Error(`No model resolved for agent "${opts.profile.name}"`);

	const tools: string[] | undefined = opts.profile.tools && opts.profile.tools.length > 0
		? opts.profile.tools
		: undefined;

	const sessionManager = SessionManager.inMemory(opts.projectDir);
	const mode = opts.profile.systemPromptMode ?? "replace";

	// Use DefaultResourceLoader (the same loader pi-subagents uses) so that
	// built-in tools, extensions, and skills are discovered properly. A
	// hand-rolled stub returned empty arrays and silently broke tooling
	// (e.g. `structured_output` was never registered).
	const loader = new DefaultResourceLoader({
		cwd: opts.projectDir,
		agentDir: opts.agentsDir,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// systemPromptOverride replaces the base prompt; for `append` mode we
		// leave the base intact and append the agent body instead.
		systemPromptOverride: mode === "replace" ? () => opts.profile.systemPrompt : undefined,
		appendSystemPromptOverride: mode === "append" ? () => [opts.profile.systemPrompt] : undefined,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: opts.projectDir,
		agentDir: opts.agentsDir,
		model,
		tools,
		authStorage: opts.authStorage,
		modelRegistry: opts.modelRegistry,
		resourceLoader: loader,
		sessionManager,
		thinkingLevel: opts.profile.thinking as any,
	});

	if (opts.unitId) {
		try { session.setSessionName?.(`${opts.profile.name}#${opts.unitId.slice(0, 8)}`); }
		catch { /* non-fatal */ }
	}

	if (opts.onProgress) {
		let buffer = "";
		session.subscribe((event: any) => {
			if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				buffer += event.assistantMessageEvent.delta ?? "";
				opts.onProgress!(buffer);
			}
		});
	}

	return { session, dispose: () => session.dispose() };
}

/* ──────────────────────── single-step dispatch ──────────────────────── */

export async function dispatchStep(
	step: PlanStep,
	ws: WorkspaceInfo,
	profile: AgentProfile,
	opts: DispatchOpts,
): Promise<StepResult> {
	const start = Date.now();
	const task = composeTask(step, ws);
	const { session, dispose } = await createStepSession({
		profile,
		task,
		projectDir: opts.projectDir,
		agentsDir: opts.agentsDir,
		modelRegistry: opts.modelRegistry,
		authStorage: opts.authStorage,
		abortSignal: opts.abortSignal,
		onProgress: opts.onProgress,
	});
	try {
		await session.prompt(task);
		const messages = session.messages ?? [];
		const { usage, hadError, hadAborted } = extractUsageAndStatus(messages);
		const text = extractText(messages);
		const status: StepResult["status"] = hadError || hadAborted ? "failed" : "completed";
		const result: StepResult = {
			status,
			text,
			usage,
			durationMs: Date.now() - start,
		};
		if (hadError) result.error = "agent error";
		if (hadAborted) result.error = "aborted";
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "failed",
			text: "",
			error: msg,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			durationMs: Date.now() - start,
		};
	} finally {
		dispose();
	}
}

/* ──────────────────────── iterate dispatch ──────────────────────── */

export interface IterateUnit {
	[key: string]: any;
}

export async function dispatchIterate(
	step: PlanStep,
	ws: WorkspaceInfo,
	profile: AgentProfile,
	units: IterateUnit[],
	opts: DispatchOpts,
): Promise<StepResult> {
	const start = Date.now();
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	const total = units.length;

	const results: Array<{
		key: string; status: "completed" | "failed"; text?: string;
		error?: string; usage?: StepUsage; durationMs?: number;
	} | undefined> = new Array(total);

	async function runOne(i: number) {
		const unit = units[i]!;
		const key = (unit.path ?? unit.id ?? `unit-${i}`) as string;
		const task = composeIterateTask(step, ws, unit);
		const slotStart = Date.now();
		const { session, dispose } = await createStepSession({
			profile,
			task,
			projectDir: opts.projectDir,
			agentsDir: opts.agentsDir,
			modelRegistry: opts.modelRegistry,
			authStorage: opts.authStorage,
			abortSignal: opts.abortSignal,
			unitId: key,
		});
		try {
			await session.prompt(task);
			const messages = session.messages ?? [];
			const { usage, hadError, hadAborted } = extractUsageAndStatus(messages);
			const text = extractText(messages);
			const r: {
				key: string; status: "completed" | "failed"; text?: string;
				error?: string; usage?: StepUsage; durationMs?: number;
			} = {
				key,
				status: hadError || hadAborted ? "failed" : "completed",
				usage,
				durationMs: Date.now() - slotStart,
			};
			if (text) r.text = text;
			if (hadError) r.error = "agent error";
			if (hadAborted) r.error = "aborted";
			results[i] = r;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			results[i] = {
				key,
				status: "failed",
				error: msg,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				durationMs: Date.now() - slotStart,
			};
		} finally {
			dispose();
		}
	}

	// Simple worker pool
	let cursor = 0;
	const workers: Promise<void>[] = [];
	for (let w = 0; w < Math.min(concurrency, total); w++) {
		workers.push((async () => {
			while (true) {
				const i = cursor++;
				if (i >= total) return;
				await runOne(i);
			}
		})());
	}
	await Promise.all(workers);

	const completed = results.filter((r) => r?.status === "completed").length;
	const failed = total - completed;
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, turns = 0;
	for (const r of results) {
		if (r?.usage) {
			input += r.usage.input;
			output += r.usage.output;
			cacheRead += r.usage.cacheRead;
			cacheWrite += r.usage.cacheWrite;
			cost += r.usage.cost;
			turns += r.usage.turns;
		}
	}
	const status: StepResult["status"] = failed === 0 ? "completed" : failed === total ? "failed" : "partial";
	const unitsOut: NonNullable<StepResult["units"]> = results.map((r) => {
		const e: ManifestUnitEntry & { text?: string; error?: string; usage?: StepUsage; durationMs?: number } = {
			key: r?.key ?? "?",
			status: r?.status === "failed" ? "failed" : "completed",
		};
		if (r?.text !== undefined) e.text = r.text;
		if (r?.error !== undefined) e.error = r.error;
		if (r?.usage !== undefined) e.usage = r.usage;
		if (r?.durationMs !== undefined) e.durationMs = r.durationMs;
		return e;
	});
	return {
		status,
		text: `${completed}/${total} unit(s) completed`,
		usage: { input, output, cacheRead, cacheWrite, cost, turns },
		durationMs: Date.now() - start,
		units: unitsOut,
	};
}

/* ──────────────────────── task composition ──────────────────────── */

function composeTask(step: PlanStep, ws: WorkspaceInfo): string {
	const lines: string[] = [];
	const stepSlug = step.phase.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	const tempDir = path.join(ws.tempRoot, stepSlug);
	lines.push(`Use the scratch directory ${tempDir} for any temporary files you create.`);
	lines.push(`Do not write your main output there; use the output path specified below.`);
	lines.push("");
	if (step.outputs && step.outputs[0]) {
		const t = step.outputs[0];
		const abs = resolveOutputAbs(t, ws);
		lines.push(`Write your output to: ${abs}`);
	} else if (step.output) {
		lines.push(`Write your output to: ${step.output}`);
	}
	if (step.reads && step.reads.length > 0) {
		const absReads = step.reads.map((r) => resolveReadAbs(r, ws));
		lines.push(`Read from: ${absReads.join(", ")}`);
	}
	lines.push("");
	lines.push(step.task);
	return lines.join("\n");
}

function composeIterateTask(step: PlanStep, ws: WorkspaceInfo, unit: IterateUnit): string {
	const lines: string[] = [];
	const stepSlug = step.phase.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	const unitKey = (unit.path ?? unit.id ?? "unit") as string;
	const tempDir = path.join(ws.tempRoot, stepSlug, unitKey);
	lines.push(`Use the scratch directory ${tempDir} for any temporary files you create.`);
	lines.push(`Do not write your main output there; use the output path specified below.`);
	if (step.outputs && step.outputs[0]?.kind === "collection") {
		const t = step.outputs[0];
		// `{unit.path}` in a collection pattern means the unit's *stem* (no
		// extension) — the target's extension is always appended. This avoids
		// double-`.md` on markdown units. `{unit.path.full}` keeps the full
		// path including extension for callers who want it.
		const unitKeyClean = unitKey.replace(new RegExp(`\\.${t.ext}$`), "");
		const substituted = (t.rawPath ?? `${t.name}-${unitKeyClean}.${t.ext}`)
			.replace(/\{unit\.path\.full\}/g, unitKey)
			.replace(/\{unit\.path\}/g, unitKeyClean);
		const abs = path.join(ws.collectionsDir, t.name, substituted);
		lines.push(`Write your output to: ${abs}`);
	}
	lines.push("");
	let task = step.task;
	for (const [k, v] of Object.entries(unit)) {
		task = task.replace(new RegExp(`\\{unit\\.${k}\\}`, "g"), String(v));
	}
	lines.push(task);
	return lines.join("\n");
}

/* ──────────────────────── path helpers ──────────────────────── */

function resolveOutputAbs(t: { scheme: string; rawPath?: string; name: string; ext: string }, ws: WorkspaceInfo): string {
	if (t.scheme === "work") return path.join(ws.targetsDir, `${t.name}.${t.ext}`);
	if (t.scheme === "temp") return path.join(ws.tempRoot, t.rawPath ?? `${t.name}.${t.ext}`);
	if (t.scheme === "project") return path.resolve(t.rawPath ?? t.name);
	return t.rawPath ?? t.name;
}

function resolveReadAbs(read: string, _ws: WorkspaceInfo): string {
	if (read.startsWith("project:")) return read.slice(8);
	return read;
}

/* ──────────────────────── manifest update helper ──────────────────────── */

export function buildManifestStep(
	step: PlanStep,
	ws: WorkspaceInfo,
): ManifestStep {
	const id = step.phase.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	const ms: ManifestStep = {
		id,
		phase: step.phase,
		agent: step.agent,
		reads: step.reads,
		status: "pending",
		attempts: 0,
	};
	if (step.outputs) {
		ms.outputs = step.outputs.map((t) => {
			const abs = resolveOutputAbs(t, ws);
			return {
				name: t.name,
				kind: t.kind,
				path: path.relative(ws.dir, abs),
			};
		});
	}
	return ms;
}

/* ──────────────────────── iterate support ──────────────────────── */

/** Load a unit list from a prior step's output. Looks first in the
 *  workspace's targets dir (target-based recipes), then in cwd (legacy
 *  recipes writing literal `.json` files). Returns an empty array if the
 *  file is missing or unparseable. */
export function loadUnits(ws: WorkspaceInfo, name: string, cwdFallback?: string): IterateUnit[] {
	const candidates = [
		path.join(ws.targetsDir, `${name}.json`),
	];
	if (cwdFallback) candidates.push(path.join(cwdFallback, `${name}.json`));
	for (const file of candidates) {
		try {
			const raw = fs.readFileSync(file, "utf-8");
			const parsed = JSON.parse(raw);
			const items = parsed?.items;
			if (Array.isArray(items)) return items as IterateUnit[];
			if (Array.isArray(parsed)) return parsed as IterateUnit[]; // legacy: bare array
		} catch { /* try next */ }
	}
	return [];
}

/** Collect the per-unit output paths in a collection directory. */
export function collectCollection(ws: WorkspaceInfo, name: string): string[] {
	const dir = path.join(ws.collectionsDir, name);
	try {
		const entries = fs.readdirSync(dir);
		return entries
			.filter((e) => !e.startsWith("."))
			.map((e) => path.join(dir, e))
			.sort();
	} catch {
		return [];
	}
}

export function recordStepResult(
	ws: WorkspaceInfo,
	stepId: string,
	result: StepResult,
	collectionName?: string,
): void {
	const name = collectionName ?? stepId;
	const step: ManifestStep = {
		id: stepId,
		phase: stepId,
		agent: "",
		status: result.status,
		attempts: 1,
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite,
			cost: result.usage.cost,
		},
	};
	if (result.error) (step as any).error = result.error;
	if (result.units) {
		(step as any).outputs = [{
			name,
			kind: "collection",
			path: `collections/${name}/`,
			units: result.units,
		}];
	}
	updateManifestStep(ws, step);
}
