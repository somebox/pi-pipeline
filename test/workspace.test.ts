/**
 * Unit tests for src/workspace.ts (flat run folders, prune, gitignore).
 *
 *   node --test --experimental-strip-types test/workspace.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	mintRunId,
	createWorkspace,
	writeManifestShell,
	readManifest,
	updateManifestStep,
	finalizeManifest,
	deriveRunStatus,
	pruneToReport,
	listRuns,
	findRun,
	latestIncomplete,
	bootstrapGitignore,
	clearScratch,
	unitScratchDir,
	hashRecipe,
	PIPELINE_ROOT,
} from "../src/workspace.ts";

const TEST_DIR = (title: string) =>
	path.join(os.tmpdir(), `pi-pipeline-test-${title.replace(/\s+/g, "-")}-${Date.now()}`);

test("mintRunId: UTC date-time-slug, no hex", () => {
	const now = new Date("2026-07-05T12:13:14Z");
	assert.equal(mintRunId("code-quality", now), "2026-07-05-121314-code-quality");
	assert.equal(mintRunId("code-quality", now, 2), "2026-07-05-121314-code-quality-2");
	assert.equal(mintRunId("Docs Audit!", now), "2026-07-05-121314-docs-audit");
});

test("createWorkspace: flat folder under .pi/pipeline with documented layout", () => {
	const tmp = TEST_DIR("createWorkspace");
	const ws = createWorkspace(tmp, "probe", new Date("2026-07-19T14:23:55Z"));
	assert.equal(ws.runId, "2026-07-19-142355-probe");
	assert.equal(ws.dir, path.join(tmp, PIPELINE_ROOT, ws.runId));
	assert.ok(fs.existsSync(ws.targetsDir));
	assert.ok(fs.existsSync(ws.collectionsDir));
	assert.ok(fs.existsSync(ws.logsDir));
	assert.ok(fs.existsSync(ws.scratchRoot));
	assert.ok(ws.scratchRoot.endsWith(`${path.sep}scratch`));
	assert.ok(!ws.dir.includes(`${path.sep}runs${path.sep}`));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("createWorkspace: same-second collision appends -2", () => {
	const tmp = TEST_DIR("collision");
	const now = new Date("2026-07-19T14:23:55Z");
	const a = createWorkspace(tmp, "probe", now);
	const b = createWorkspace(tmp, "probe", now);
	assert.equal(a.runId, "2026-07-19-142355-probe");
	assert.equal(b.runId, "2026-07-19-142355-probe-2");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("manifest shell/update/finalize round-trip", () => {
	const tmp = TEST_DIR("manifest-roundtrip");
	const ws = createWorkspace(tmp, "summarize-files");
	writeManifestShell(ws, "summarize-files", tmp, { task: "docs", recipeHash: "abc", gitHead: "deadbee" });
	const shell = readManifest(ws.manifestPath);
	assert.equal(shell.run_id, ws.runId);
	assert.equal(shell.recipe, "summarize-files");
	assert.equal(shell.task, "docs");
	assert.equal(shell.recipe_hash, "abc");
	assert.equal(shell.git_head, "deadbee");
	assert.equal(shell.status, "running");

	updateManifestStep(ws, {
		id: "enumerate",
		phase: "Enumerate files",
		agent: "util",
		status: "completed",
		outputs: [{ name: "scope", kind: "singleton", path: "targets/scope.json" }],
	});
	finalizeManifest(ws, "completed");
	const done = readManifest(ws.manifestPath);
	assert.equal(done.status, "completed");
	assert.ok(done.finalized_at);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("deriveRunStatus: aborted beats failed; empty → undefined", () => {
	assert.equal(deriveRunStatus([]), undefined);
	assert.equal(
		deriveRunStatus([
			{ id: "a", phase: "A", agent: "util", status: "completed" },
			{ id: "b", phase: "B", agent: "dev", status: "completed" },
		]),
		"completed",
	);
	assert.equal(
		deriveRunStatus([
			{ id: "a", phase: "A", agent: "util", status: "completed" },
			{ id: "b", phase: "B", agent: "dev", status: "failed" },
		]),
		"failed",
	);
	assert.equal(
		deriveRunStatus([
			{ id: "a", phase: "A", agent: "util", status: "aborted" },
			{ id: "b", phase: "B", agent: "dev", status: "failed" },
		]),
		"aborted",
	);
	assert.equal(
		deriveRunStatus([
			{ id: "a", phase: "A", agent: "util", status: "completed" },
			{ id: "b", phase: "B", agent: "dev", status: "partial" },
		]),
		"partial",
	);
});

test("pruneToReport: keeps only README.md and metrics.json", () => {
	const tmp = TEST_DIR("prune");
	const ws = createWorkspace(tmp, "probe");
	writeManifestShell(ws, "probe", tmp);
	fs.writeFileSync(ws.readmePath, "# hi\n");
	fs.writeFileSync(ws.metricsPath, "{\"cost\":1}");
	fs.writeFileSync(path.join(ws.targetsDir, "x.md"), "x");
	fs.writeFileSync(path.join(ws.scratchRoot, "t.txt"), "t");
	pruneToReport(ws);
	const names = fs.readdirSync(ws.dir).sort();
	assert.deepEqual(names, ["README.md", "metrics.json"]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("listRuns: newest first; findRun prefix; latestIncomplete skips pruned", () => {
	const tmp = TEST_DIR("list");
	const a = createWorkspace(tmp, "alpha", new Date("2026-07-19T10:00:00Z"));
	writeManifestShell(a, "alpha", tmp);
	finalizeManifest(a, "completed");
	fs.writeFileSync(a.readmePath, "a");
	fs.writeFileSync(a.metricsPath, JSON.stringify({ cost: 0.1, status: "completed", recipe: "alpha" }));
	pruneToReport(a);

	const b = createWorkspace(tmp, "beta", new Date("2026-07-19T11:00:00Z"));
	writeManifestShell(b, "beta", tmp);
	finalizeManifest(b, "failed");

	const runs = listRuns(tmp);
	assert.equal(runs[0]!.runId, b.runId);
	assert.equal(runs[1]!.runId, a.runId);
	assert.equal(runs[1]!.pruned, true);

	const found = findRun(tmp, "2026-07-19-110000");
	assert.ok("ws" in found);
	if ("ws" in found) assert.equal(found.ws.runId, b.runId);

	const latest = latestIncomplete(tmp);
	assert.ok(latest);
	assert.equal(latest!.runId, b.runId);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("unitScratchDir nests unit path under scratch/", () => {
	const tmp = TEST_DIR("scratch-unit");
	const ws = createWorkspace(tmp, "x");
	const d = unitScratchDir(ws, "src/foo.ts");
	assert.equal(d, path.join(ws.scratchRoot, "src", "foo.ts"));
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(d, "tmp.txt"), "1");
	clearScratch(ws.scratchRoot);
	assert.ok(fs.existsSync(ws.scratchRoot));
	assert.equal(fs.readdirSync(ws.scratchRoot).length, 0);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("bootstrapGitignore: append once; skip when .pi/ present; missing file is no-op", () => {
	const tmp = TEST_DIR("gi");
	fs.mkdirSync(tmp, { recursive: true });
	assert.equal(bootstrapGitignore(tmp), false);

	fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n");
	assert.equal(bootstrapGitignore(tmp), true);
	const once = fs.readFileSync(path.join(tmp, ".gitignore"), "utf-8");
	assert.ok(once.includes(".pi/pipeline/"));
	assert.equal(bootstrapGitignore(tmp), false);

	const tmp2 = TEST_DIR("gi2");
	fs.mkdirSync(tmp2, { recursive: true });
	fs.writeFileSync(path.join(tmp2, ".gitignore"), "dist/\n.pi/\n");
	assert.equal(bootstrapGitignore(tmp2), false);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(tmp2, { recursive: true, force: true });
});

test("hashRecipe: stable short hex", () => {
	assert.equal(hashRecipe("abc"), hashRecipe("abc"));
	assert.notEqual(hashRecipe("abc"), hashRecipe("abd"));
	assert.equal(hashRecipe("abc").length, 16);
});
