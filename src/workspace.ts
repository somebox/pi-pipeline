/**
 * Pipeline workspace — one flat folder per run under `.pi/pipeline/`.
 * Pure: node builtins only, unit-testable with `node --test`.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

export const PIPELINE_ROOT = ".pi/pipeline";
export const MAX_FULL_WORKSPACES = 20;
const KEEP_AFTER_PRUNE = new Set(["README.md", "metrics.json"]);

export interface WorkspaceInfo {
	runId: string; // YYYY-MM-DD-HHMMSS-<slug>[, -N]
	dir: string;
	targetsDir: string;
	collectionsDir: string;
	logsDir: string;
	scratchRoot: string;
	manifestPath: string;
	readmePath: string;
	metricsPath: string;
	projectDir: string;
	pipelineRoot: string;
}

export interface ManifestUnitEntry {
	key: string;
	status: "completed" | "failed";
	error?: string;
}

/** A recorded checkpoint decision on a resumed run. Keyed by checkpoint token
 *  in `Manifest.checkpoints`. */
export interface CheckpointRecord {
	step_id: string;
	decision: "approve" | "reject" | "revise";
	note?: string;
	decided_at: string;
}

export interface ManifestOutputEntry {
	name: string;
	kind: "singleton" | "collection";
	path: string; // relative to workspace root
	units?: ManifestUnitEntry[];
}

export interface ManifestStep {
	id: string;
	phase: string;
	agent: string;
	reads?: string[];
	outputs?: ManifestOutputEntry[];
	status: "pending" | "running" | "completed" | "failed" | "partial" | "blocked" | "aborted";
	attempts?: number;
	durationMs?: number;
	error?: string;
	/** Checkpoint token declared by the recipe step; the run pauses after this
	 *  step completes and records its decision under manifest.checkpoints. */
	checkpoint?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost: number;
	};
	targets?: Record<string, unknown>;
}

export type RunStatus = "completed" | "failed" | "partial" | "aborted" | "running" | "paused" | "rejected";

export interface Manifest {
	run_id: string;
	recipe: string;
	recipe_hash?: string;
	task?: string;
	inputs?: Record<string, string>;
	git_head?: string;
	started_at: string;
	project_dir: string;
	workspace_dir: string;
	steps: ManifestStep[];
	deliverables: unknown[];
	finalized_at?: string;
	status?: RunStatus;
	/** Checkpoint decisions recorded when a paused run is resumed. Keyed by
	 *  checkpoint token. */
	checkpoints?: Record<string, CheckpointRecord>;
}

export interface RunListing {
	runId: string;
	dir: string;
	status?: RunStatus;
	recipe?: string;
	task?: string;
	cost?: number;
	started_at?: string;
	pruned: boolean;
	mtime: number;
}

export interface ManifestShellExtras {
	task?: string;
	inputs?: Record<string, string>;
	recipeHash?: string;
	gitHead?: string;
}

/* ──────────────────────── ids ──────────────────────── */

export function slugifyRecipe(recipe: string): string {
	return recipe.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pipeline";
}

export function hashRecipe(raw: string): string {
	return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** UTC id: `YYYY-MM-DD-HHMMSS-<slug>`. Pass `suffix > 1` for same-second collisions. */
export function mintRunId(recipe: string, now?: Date, suffix = 1): string {
	const d = now ?? new Date();
	const date = d.toISOString().slice(0, 10);
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	const ss = String(d.getUTCSeconds()).padStart(2, "0");
	const base = `${date}-${hh}${mm}${ss}-${slugifyRecipe(recipe)}`;
	return suffix > 1 ? `${base}-${suffix}` : base;
}

export function pipelineRoot(projectDir: string): string {
	return path.resolve(projectDir, PIPELINE_ROOT);
}

export function gitHead(projectDir: string): string | undefined {
	try {
		const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 2000,
		});
		if (r.status === 0) {
			const s = (r.stdout ?? "").trim();
			if (s) return s;
		}
	} catch {
		/* not a git repo / git missing */
	}
	return undefined;
}

function dirsOf(wsDir: string, projectDir: string, runId: string): WorkspaceInfo {
	const pipeline = pipelineRoot(projectDir);
	return {
		runId,
		dir: wsDir,
		targetsDir: path.join(wsDir, "targets"),
		collectionsDir: path.join(wsDir, "collections"),
		logsDir: path.join(wsDir, "logs"),
		scratchRoot: path.join(wsDir, "scratch"),
		manifestPath: path.join(wsDir, "manifest.json"),
		readmePath: path.join(wsDir, "README.md"),
		metricsPath: path.join(wsDir, "metrics.json"),
		projectDir,
		pipelineRoot: pipeline,
	};
}

export function workspaceFromDir(dir: string, projectDir: string): WorkspaceInfo {
	return dirsOf(path.resolve(dir), projectDir, path.basename(dir));
}

export function createWorkspace(projectDir: string, recipe: string, now?: Date): WorkspaceInfo {
	const root = pipelineRoot(projectDir);
	fs.mkdirSync(root, { recursive: true });
	let suffix = 1;
	let runId = mintRunId(recipe, now, suffix);
	let dir = path.join(root, runId);
	while (fs.existsSync(dir)) {
		suffix += 1;
		if (suffix > 99) throw new Error(`Could not mint a unique run id under ${root}`);
		runId = mintRunId(recipe, now, suffix);
		dir = path.join(root, runId);
	}
	const ws = dirsOf(dir, projectDir, runId);
	fs.mkdirSync(ws.targetsDir, { recursive: true });
	fs.mkdirSync(ws.collectionsDir, { recursive: true });
	fs.mkdirSync(ws.logsDir, { recursive: true });
	fs.mkdirSync(ws.scratchRoot, { recursive: true });
	return ws;
}

export function openWorkspace(projectDir: string, runId: string): WorkspaceInfo | null {
	const dir = path.join(pipelineRoot(projectDir), runId);
	try {
		if (!fs.statSync(dir).isDirectory()) return null;
	} catch {
		return null;
	}
	return workspaceFromDir(dir, projectDir);
}

/* ──────────────────────── manifest I/O ──────────────────────── */

export function writeManifestShell(
	ws: WorkspaceInfo,
	recipe: string,
	projectDir: string,
	extras?: ManifestShellExtras,
): void {
	const manifest: Manifest = {
		run_id: ws.runId,
		recipe,
		started_at: new Date().toISOString(),
		project_dir: projectDir,
		workspace_dir: path.relative(projectDir, ws.dir),
		steps: [],
		deliverables: [],
		status: "running",
	};
	if (extras?.task) manifest.task = extras.task;
	if (extras?.inputs && Object.keys(extras.inputs).length > 0) manifest.inputs = extras.inputs;
	if (extras?.recipeHash) manifest.recipe_hash = extras.recipeHash;
	if (extras?.gitHead) manifest.git_head = extras.gitHead;
	fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
}

export function readManifest(manifestPath: string): Manifest {
	return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

export function updateManifestStep(ws: WorkspaceInfo, step: ManifestStep): void {
	const manifest = readManifest(ws.manifestPath);
	const idx = manifest.steps.findIndex((s) => s.id === step.id);
	if (idx >= 0) manifest.steps[idx] = step;
	else manifest.steps.push(step);
	fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
}

export function patchManifest(ws: WorkspaceInfo, patch: Partial<Manifest>): Manifest {
	const manifest = readManifest(ws.manifestPath);
	Object.assign(manifest, patch);
	fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
	return manifest;
}

/** Any aborted → aborted; any failed → failed; any partial → partial;
 *  all completed → completed; otherwise undefined (still in flight). */
export function deriveRunStatus(steps: ManifestStep[]): Manifest["status"] {
	let anyAborted = false;
	let anyFailed = false;
	let anyPartial = false;
	let allCompleted = steps.length > 0;
	for (const step of steps) {
		if (step.status === "aborted") anyAborted = true;
		if (step.status === "failed") anyFailed = true;
		if (step.status === "partial") anyPartial = true;
		if (step.status !== "completed") allCompleted = false;
	}
	if (anyAborted) return "aborted";
	if (anyFailed) return "failed";
	if (anyPartial) return "partial";
	if (allCompleted) return "completed";
	return undefined;
}

export function finalizeManifest(ws: WorkspaceInfo, status?: Manifest["status"]): Manifest {
	const manifest = readManifest(ws.manifestPath);
	manifest.finalized_at = new Date().toISOString();
	manifest.status = status ?? deriveRunStatus(manifest.steps);
	fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
	return manifest;
}

/* ──────────────────────── scratch ──────────────────────── */

export function unitScratchDir(ws: WorkspaceInfo, unitKey: string): string {
	const parts = unitKey.split(/[\\/]+/).filter(Boolean);
	return path.join(ws.scratchRoot, ...parts);
}

export function clearScratch(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		/* best effort */
	}
}

/* ──────────────────────── prune / list ──────────────────────── */

export function pruneToReport(ws: WorkspaceInfo): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(ws.dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (KEEP_AFTER_PRUNE.has(name)) continue;
		try {
			fs.rmSync(path.join(ws.dir, name), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

export function isFullWorkspace(dir: string): boolean {
	return fs.existsSync(path.join(dir, "manifest.json"));
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

export function listRuns(projectDir: string): RunListing[] {
	const root = pipelineRoot(projectDir);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RunListing[] = [];
	for (const name of names) {
		if (name === "scratch" || name.startsWith(".")) continue;
		const dir = path.join(root, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(dir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const listing: RunListing = {
			runId: name,
			dir,
			pruned: !isFullWorkspace(dir),
			mtime: stat.mtime.getTime(),
		};
		const manifest = readJson(path.join(dir, "manifest.json"));
		const metrics = readJson(path.join(dir, "metrics.json"));
		if (manifest) {
			listing.status = (manifest.status as RunStatus | undefined) ?? "running";
			listing.recipe = typeof manifest.recipe === "string" ? manifest.recipe : undefined;
			listing.task = typeof manifest.task === "string" ? manifest.task : undefined;
			listing.started_at = typeof manifest.started_at === "string" ? manifest.started_at : undefined;
			const steps = Array.isArray(manifest.steps) ? manifest.steps as Array<{ usage?: { cost?: number } }> : [];
			listing.cost = steps.reduce((a, s) => a + (s.usage?.cost ?? 0), 0);
		}
		if (metrics) {
			if (typeof metrics.status === "string") listing.status = metrics.status as RunStatus;
			if (typeof metrics.recipe === "string") listing.recipe = metrics.recipe;
			if (typeof metrics.cost === "number") listing.cost = metrics.cost;
			if (typeof metrics.started_at === "string") listing.started_at = metrics.started_at;
			if (typeof metrics.run_id === "string") listing.runId = metrics.run_id;
		}
		out.push(listing);
	}
	out.sort((a, b) => {
		const at = a.started_at ?? "";
		const bt = b.started_at ?? "";
		if (at !== bt) return bt.localeCompare(at);
		return b.mtime - a.mtime;
	});
	return out;
}

export function findRun(projectDir: string, idOrPrefix: string): { ws: WorkspaceInfo } | { error: string } {
	const runs = listRuns(projectDir);
	const exact = runs.find((r) => r.runId === idOrPrefix);
	if (exact) return { ws: workspaceFromDir(exact.dir, projectDir) };
	const matches = runs.filter((r) => r.runId.startsWith(idOrPrefix));
	if (matches.length === 1) return { ws: workspaceFromDir(matches[0]!.dir, projectDir) };
	if (matches.length === 0) return { error: `No pipeline run matching "${idOrPrefix}" under ${PIPELINE_ROOT}/.` };
	return {
		error: `Ambiguous run id "${idOrPrefix}". Matches: ${matches.map((m) => m.runId).join(", ")}`,
	};
}

const INCOMPLETE: RunStatus[] = ["aborted", "failed", "partial", "running", "paused"];

export function latestIncomplete(projectDir: string): WorkspaceInfo | null {
	for (const r of listRuns(projectDir)) {
		if (r.pruned) continue;
		if (!r.status || INCOMPLETE.includes(r.status)) {
			return workspaceFromDir(r.dir, projectDir);
		}
	}
	return null;
}

export function enforceFullWorkspaceCap(projectDir: string, keepRunId?: string): void {
	const full = listRuns(projectDir).filter((r) => !r.pruned && r.runId !== keepRunId);
	if (full.length <= MAX_FULL_WORKSPACES) return;
	const oldest = [...full].sort((a, b) => a.mtime - b.mtime);
	const extra = oldest.slice(0, full.length - MAX_FULL_WORKSPACES);
	for (const r of extra) {
		pruneToReport(workspaceFromDir(r.dir, projectDir));
	}
}

export function cleanScratchTrees(projectDir: string): void {
	clearScratch(path.join(pipelineRoot(projectDir), "scratch"));
	for (const r of listRuns(projectDir)) {
		if (r.pruned) continue;
		clearScratch(path.join(r.dir, "scratch"));
	}
}

export function pruneLeftoverCompleted(projectDir: string): number {
	let n = 0;
	for (const r of listRuns(projectDir)) {
		if (r.pruned) continue;
		if (r.status === "completed") {
			pruneToReport(workspaceFromDir(r.dir, projectDir));
			n++;
		}
	}
	return n;
}

export function pruneIncompleteToReport(projectDir: string): number {
	let n = 0;
	for (const r of listRuns(projectDir)) {
		if (r.pruned) continue;
		if (r.status !== "completed") {
			pruneToReport(workspaceFromDir(r.dir, projectDir));
			n++;
		}
	}
	return n;
}

export function cleanAllRuns(projectDir: string): void {
	const root = pipelineRoot(projectDir);
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	fs.mkdirSync(root, { recursive: true });
}

/* ──────────────────────── gitignore ──────────────────────── */

const GITIGNORE_BLOCK = [
	"",
	"# pi-pipeline run artifacts (local; not committed)",
	".pi/pipeline/",
	"",
].join("\n");

export function bootstrapGitignore(projectDir: string): boolean {
	const gi = path.join(projectDir, ".gitignore");
	let raw: string;
	try {
		raw = fs.readFileSync(gi, "utf-8");
	} catch {
		return false;
	}
	if (/(?:^|[\n\r])\s*\.pi\/(?:pipeline\/?)?\s*(?:$|[\n\r])/.test(raw) || /(?:^|[\n\r])\s*\.pi\/?\s*(?:$|[\n\r])/.test(raw)) {
		return false;
	}
	const prefix = raw.endsWith("\n") || raw.length === 0 ? "" : "\n";
	fs.writeFileSync(gi, raw + prefix + GITIGNORE_BLOCK);
	return true;
}
