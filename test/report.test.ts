/**
 * Unit tests for src/report.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	createWorkspace,
	writeManifestShell,
	updateManifestStep,
	finalizeManifest,
} from "../src/workspace.ts";
import {
	renderRunReadme,
	renderRootIndex,
	writeRunReadme,
	writeMetrics,
	writeStepLog,
	fmtDuration,
} from "../src/report.ts";
import type { Manifest } from "../src/workspace.ts";
import type { Plan } from "../src/lib.ts";

const tmpRoot = () => path.join(os.tmpdir(), `pi-pipeline-report-${Date.now()}-${Math.random().toString(16).slice(2)}`);

test("fmtDuration", () => {
	assert.equal(fmtDuration(undefined), "—");
	assert.equal(fmtDuration(12), "12ms");
	assert.equal(fmtDuration(1200), "1.2s");
});

test("renderRunReadme: status, log rows, totals, resume only when not completed", () => {
	const manifest: Manifest = {
		run_id: "2026-07-19-142355-code-quality",
		recipe: "code-quality",
		task: "audit src/",
		started_at: "2026-07-19T14:23:55Z",
		git_head: "abc1234",
		project_dir: "/x",
		workspace_dir: ".pi/pipeline/2026-07-19-142355-code-quality",
		status: "failed",
		steps: [
			{
				id: "scope",
				phase: "Scope",
				agent: "util",
				status: "completed",
				durationMs: 12000,
				usage: { input: 100, output: 50, cost: 0.002 },
				outputs: [{ name: "scope", kind: "singleton", path: "targets/scope.json" }],
			},
			{
				id: "review",
				phase: "Review",
				agent: "dev",
				status: "partial",
				durationMs: 41000,
				usage: { input: 200, output: 80, cost: 0.018 },
				outputs: [{
					name: "review",
					kind: "collection",
					path: "collections/review/",
					units: [
						{ key: "a", status: "completed" },
						{ key: "b", status: "failed" },
					],
				}],
			},
		],
		deliverables: [],
	};
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "code-quality", new Date("2026-07-19T14:23:55Z"));
	const md = renderRunReadme(ws, manifest);
	assert.ok(md.includes("Status: **failed**"));
	assert.ok(md.includes("| 1 | Scope | util | completed |"));
	assert.ok(md.includes("partial (1/2 failed)"));
	assert.ok(md.includes("**Totals:**"));
	assert.ok(md.includes("$0.020") || md.includes("$0.02"));
	assert.ok(md.includes("/pipeline-resume 2026-07-19-142355-code-quality"));
	assert.ok(md.includes("`targets/scope.json`"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("renderRunReadme: no resume section when completed; embeds summary target", () => {
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "probe");
	writeManifestShell(ws, "probe", tmp, { task: "t" });
	updateManifestStep(ws, {
		id: "read",
		phase: "Read",
		agent: "util",
		status: "completed",
		durationMs: 1000,
		usage: { input: 10, output: 10, cost: 0.001 },
		outputs: [{ name: "summary", kind: "singleton", path: "targets/summary.md" }],
	});
	finalizeManifest(ws, "completed");
	fs.writeFileSync(path.join(ws.targetsDir, "summary.md"), "Hello from recipe.\n");
	writeRunReadme(ws);
	const md = fs.readFileSync(ws.readmePath, "utf-8");
	assert.ok(md.includes("Status: **completed**"));
	assert.ok(!md.includes("## Resume"));
	assert.ok(md.includes("## Report"));
	assert.ok(md.includes("Hello from recipe."));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeMetrics + root index newest-first", () => {
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "probe");
	writeManifestShell(ws, "probe", tmp);
	updateManifestStep(ws, {
		id: "a",
		phase: "A",
		agent: "util",
		status: "completed",
		durationMs: 5000,
		usage: { input: 20, output: 10, cacheRead: 5, cost: 0.01 },
	});
	const man = finalizeManifest(ws, "completed");
	const metrics = writeMetrics(ws, man);
	assert.equal(metrics.cost, 0.01);
	assert.equal(metrics.duration_ms, 5000);
	assert.equal(metrics.tokens.total, 35);
	const idx = renderRootIndex([
		{ runId: "newer", dir: "/n", status: "failed", recipe: "b", cost: 1, pruned: false, mtime: 2 },
		{ runId: "older", dir: "/o", status: "completed", recipe: "a", cost: 0.5, pruned: true, mtime: 1 },
	]);
	const firstData = idx.split("\n").find((l) => l.startsWith("| [`"));
	assert.ok(firstData?.includes("newer"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeStepLog writes logs/NN-slug.md", () => {
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "probe");
	writeStepLog(ws, 1, {
		id: "scope",
		phase: "Scope",
		agent: "util",
		status: "completed",
		durationMs: 100,
		usage: { input: 1, output: 1, cost: 0 },
	}, "PROMPT TEXT", "RESULT TEXT");
	const file = path.join(ws.logsDir, "01-scope.md");
	const body = fs.readFileSync(file, "utf-8");
	assert.ok(body.includes("PROMPT TEXT"));
	assert.ok(body.includes("RESULT TEXT"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("renderRunReadme plan section from Plan", () => {
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "x");
	const manifest: Manifest = {
		run_id: ws.runId,
		recipe: "x",
		started_at: new Date().toISOString(),
		project_dir: tmp,
		workspace_dir: ws.dir,
		steps: [],
		deliverables: [],
		status: "running",
	};
	const plan: Plan = {
		effort: "standard",
		mode: "research",
		summary: "",
		steps: [{
			phase: "Scope",
			agent: "util",
			label: "Scope",
			task: "do",
			outputs: [{ name: "scope", scheme: "work", kind: "singleton", ext: "json" }],
		}],
	};
	const md = renderRunReadme(ws, manifest, { plan });
	assert.ok(md.includes("1. Scope (util) → `targets/scope.json`"));
	fs.rmSync(tmp, { recursive: true, force: true });
});
