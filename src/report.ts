/**
 * Mechanical run README + root index + metrics.json.
 * Pure aside from filesystem writes.
 */

import fs from "node:fs";
import path from "node:path";
import { fmtCost, fmtTokens } from "./lib.ts";
import type { Plan } from "./lib.ts";
import type { Manifest, ManifestStep, RunListing, WorkspaceInfo } from "./workspace.ts";
import { pipelineRoot, readManifest } from "./workspace.ts";
import { pendingCheckpoint } from "./checkpoint.ts";

export interface RunMetricsFile {
	run_id: string;
	recipe: string;
	status: string;
	started_at: string;
	ended_at?: string;
	duration_ms: number;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	steps: Array<{
		id: string;
		phase: string;
		agent: string;
		status: string;
		durationMs: number;
		cost: number;
		tokens: number;
	}>;
}

export function fmtDuration(ms: number | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function outputHint(step: ManifestStep): string {
	const o = step.outputs?.[0];
	if (!o) return "";
	if (o.kind === "collection") return ` → \`${o.path}\``;
	return ` → \`${o.path}\``;
}

function planLinesFrom(manifest: Manifest, plan?: Plan): string[] {
	if (plan) {
		return plan.steps.map((s, i) => {
			const out = s.outputs?.[0];
			const dest = out
				? out.kind === "collection"
					? `collections/${out.name}/`
					: `targets/${out.name}.${out.ext}`
				: s.output;
			const iterate = s.iterate ? `, iterate=${s.iterate}` : "";
			return `${i + 1}. ${s.phase} (${s.agent}${iterate})${dest ? ` → \`${dest}\`` : ""}`;
		});
	}
	return manifest.steps.map((s, i) => `${i + 1}. ${s.phase} (${s.agent})${outputHint(s)}`);
}

function logRow(i: number, s: ManifestStep): string {
	const dur = fmtDuration(s.durationMs);
	const cost = s.usage ? fmtCost(s.usage.cost) : "—";
	let status: string = s.status;
	const units = s.outputs?.[0]?.units;
	if (units && units.length > 0 && (s.status === "running" || s.status === "partial")) {
		const failed = units.filter((u) => u.status === "failed").length;
		const completed = units.filter((u) => u.status === "completed").length;
		status = s.status === "running"
			? `running (${completed}/${units.length} done, ${failed} failed)`
			: `partial (${failed}/${units.length} failed)`;
	}
	return `| ${i + 1} | ${s.phase} | ${s.agent} | ${status} | ${dur} | ${cost} |`;
}

function totals(steps: ManifestStep[]): { durationMs: number; cost: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number } {
	let durationMs = 0, cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
	for (const s of steps) {
		durationMs += s.durationMs ?? 0;
		cost += s.usage?.cost ?? 0;
		input += s.usage?.input ?? 0;
		output += s.usage?.output ?? 0;
		cacheRead += s.usage?.cacheRead ?? 0;
		cacheWrite += s.usage?.cacheWrite ?? 0;
	}
	return { durationMs, cost, tokens: input + output + cacheRead, input, output, cacheRead, cacheWrite };
}

function embedReportBody(ws: WorkspaceInfo): string | undefined {
	for (const name of ["summary", "report"]) {
		for (const ext of ["md", "txt"]) {
			const p = path.join(ws.targetsDir, `${name}.${ext}`);
			try {
				const body = fs.readFileSync(p, "utf-8").trim();
				if (body) return body;
			} catch {
				/* missing */
			}
		}
	}
	return undefined;
}

export function renderRunReadme(
	ws: WorkspaceInfo,
	manifest: Manifest,
	opts?: { plan?: Plan },
): string {
	const status = manifest.status ?? "running";
	const lines: string[] = [];
	lines.push(`# ${manifest.recipe} · ${manifest.run_id}`);
	const abortedAt = manifest.steps.findIndex((s) => s.status === "aborted" || s.status === "failed");
	let statusLine = `Status: **${status}**`;
	if (status === "aborted" && abortedAt >= 0) statusLine += ` (aborted at step ${abortedAt + 1})`;
	else if (status === "failed" && abortedAt >= 0) statusLine += ` (failed at step ${abortedAt + 1})`;
	lines.push(statusLine);
	lines.push(`Recipe: ${manifest.recipe}`);
	if (manifest.task) lines.push(`Task: ${manifest.task}`);
	if (manifest.started_at) {
		const d = manifest.started_at.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
		lines.push(`Started: ${d}`);
	}
	if (manifest.git_head) lines.push(`Git: ${manifest.git_head}`);
	lines.push("");
	lines.push("## Plan");
	const plan = planLinesFrom(manifest, opts?.plan);
	lines.push(plan.length ? plan.join("\n") : "(no steps)");
	lines.push("");
	lines.push("## Log");
	lines.push("| # | Step | Agent | Status | Duration | Cost |");
	lines.push("|---|------|-------|--------|----------|------|");
	if (manifest.steps.length === 0) {
		lines.push("| — | — | — | — | — | — |");
	} else {
		manifest.steps.forEach((s, i) => lines.push(logRow(i, s)));
	}
	const t = totals(manifest.steps);
	lines.push("");
	lines.push(`**Totals:** ${fmtDuration(t.durationMs)} · ${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} tok`);
	lines.push("");
	lines.push("## Outputs");
	const outs: string[] = [];
	for (const s of manifest.steps) {
		for (const o of s.outputs ?? []) {
			if (o.kind === "collection") {
				const units = o.units;
				const extra = units ? ` (${units.filter((u) => u.status === "completed").length}/${units.length} units)` : "";
				outs.push(`- \`${o.path}\`${extra}`);
			} else {
				outs.push(`- \`${o.path}\``);
			}
		}
	}
	lines.push(outs.length ? outs.join("\n") : "(none yet)");
	if (status !== "completed") {
		lines.push("");
		lines.push("## Resume");
		if (status === "paused") {
			const pending = pendingCheckpoint(manifest);
			lines.push(`**Paused at checkpoint \`${pending?.token ?? "?"}\`** — resume with the pipeline tool: ` +
				`\`resume: "${manifest.run_id}", checkpoint: "${pending?.token ?? "?"}", checkpointDecision: "approve | reject | revise"\` (+ optional checkpointNote).`);
		} else {
			lines.push(`\`/pipeline-resume ${manifest.run_id}\``);
		}
	}
	const report = embedReportBody(ws);
	if (report) {
		lines.push("");
		lines.push("## Report");
		lines.push(report);
	}
	lines.push("");
	return lines.join("\n");
}

export function writeRunReadme(ws: WorkspaceInfo, plan?: Plan): void {
	let manifest: Manifest;
	try {
		manifest = readManifest(ws.manifestPath);
	} catch {
		return;
	}
	fs.writeFileSync(ws.readmePath, renderRunReadme(ws, manifest, { plan }));
}

export function buildMetrics(manifest: Manifest): RunMetricsFile {
	const t = totals(manifest.steps);
	return {
		run_id: manifest.run_id,
		recipe: manifest.recipe,
		status: manifest.status ?? "running",
		started_at: manifest.started_at,
		ended_at: manifest.finalized_at,
		duration_ms: t.durationMs,
		cost: t.cost,
		tokens: {
			input: t.input,
			output: t.output,
			cacheRead: t.cacheRead,
			cacheWrite: t.cacheWrite,
			total: t.tokens,
		},
		steps: manifest.steps.map((s) => ({
			id: s.id,
			phase: s.phase,
			agent: s.agent,
			status: s.status,
			durationMs: s.durationMs ?? 0,
			cost: s.usage?.cost ?? 0,
			tokens: (s.usage?.input ?? 0) + (s.usage?.output ?? 0) + (s.usage?.cacheRead ?? 0),
		})),
	};
}

export function writeMetrics(ws: WorkspaceInfo, manifest?: Manifest): RunMetricsFile {
	const m = manifest ?? readManifest(ws.manifestPath);
	const metrics = buildMetrics(m);
	fs.writeFileSync(ws.metricsPath, JSON.stringify(metrics, null, 2));
	return metrics;
}

export function writeStepLog(
	ws: WorkspaceInfo,
	index: number,
	step: ManifestStep,
	prompt: string,
	resultText: string,
): void {
	fs.mkdirSync(ws.logsDir, { recursive: true });
	const slug = step.id || step.phase.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	const nn = String(index).padStart(2, "0");
	const file = path.join(ws.logsDir, `${nn}-${slug}.md`);
	const lines = [
		`# ${index}. ${step.phase}`,
		`Agent: ${step.agent}`,
		`Status: ${step.status}`,
		`Duration: ${fmtDuration(step.durationMs)}`,
		`Cost: ${step.usage ? fmtCost(step.usage.cost) : "—"}`,
		"",
		"## Prompt",
		"",
		prompt.trim() ? prompt.trim() : "(none)",
		"",
		"## Result",
		"",
		resultText.trim() ? resultText.trim() : "(none)",
		"",
	];
	if (step.error) {
		lines.push("## Error", "", step.error, "");
	}
	fs.writeFileSync(file, lines.join("\n"));
}

export function renderRootIndex(runs: RunListing[]): string {
	const lines = [
		"# Pipeline runs",
		"",
		"Newest first. Open a run folder's `README.md` for the log, costs, and outputs.",
		"",
		"| Run | Status | Recipe | Cost |",
		"|-----|--------|--------|------|",
	];
	if (runs.length === 0) {
		lines.push("| — | — | — | — |");
	} else {
		for (const r of runs) {
			const cost = r.cost != null ? fmtCost(r.cost) : "—";
			const status = r.status ?? (r.pruned ? "completed" : "running");
			lines.push(`| [\`${r.runId}\`](./${r.runId}/) | ${status} | ${r.recipe ?? "—"} | ${cost} |`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

export function writeRootIndex(projectDir: string, runs: RunListing[]): void {
	const root = pipelineRoot(projectDir);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "README.md"), renderRootIndex(runs));
}

export function userFacingSummary(ws: WorkspaceInfo, metrics: RunMetricsFile): string {
	const lines = [
		`**Run:** \`${ws.runId}\``,
		`**Status:** ${metrics.status}`,
		`**Path:** \`${ws.dir}\``,
		`**Totals:** ${fmtDuration(metrics.duration_ms)} · ${fmtCost(metrics.cost)} · ${fmtTokens(metrics.tokens.total)} tok`,
	];
	if (metrics.status !== "completed") {
		lines.push(`**Resume:** \`/pipeline-resume ${ws.runId}\``);
	}
	return lines.join("\n");
}
