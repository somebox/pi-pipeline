/**
 * Unit tests for src/workspace.ts (workspace, manifest, retention).
 * Requires node:fs; cleans up after itself.
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
	cleanupRuns,
	loadArtifactsConfig,
	deriveRunStatus,
} from "../src/workspace.ts";
import type { ArtifactsConfig } from "../src/workspace.ts";

/* ─── helpers ─── */
const TEST_DIR = (title: string) => path.join(os.tmpdir(), `pi-pipeline-test-${title.replace(/\s+/g, "-")}-${Date.now()}`);

/* ─────────── mintRunId ─────────── */

test("mintRunId: format and uniqueness", () => {
	const now = new Date("2026-07-05T12:13:14Z");
	const id = mintRunId("code-quality", now);
	assert.ok(id.startsWith("code-quality-20260705-"), `got ${id}`);
	assert.match(id, /^code-quality-\d{8}-[a-f0-9]{6}$/);
});

test("mintRunId: same-millisecond calls are unique", () => {
	const now = new Date();
	const ids = new Set(Array.from({ length: 20 }, () => mintRunId("probe", now)));
	assert.equal(ids.size, 20, "expected 20 unique ids from same-millisecond burst");
});

/* ─────────── createWorkspace ─────────── */

test("createWorkspace: produces documented directory layout", () => {
	const tmp = TEST_DIR("createWorkspace");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: ".tmp/run" };
	const ws = createWorkspace(tmp, "probe", cfg);

	assert.ok(fs.existsSync(ws.targetsDir), "targetsDir");
	assert.ok(fs.existsSync(ws.collectionsDir), "collectionsDir");
	assert.ok(fs.existsSync(ws.logsDir), "logsDir");
	assert.ok(fs.existsSync(ws.tempRoot), "tempRoot");
	// manifest.json is created by writeManifestShell, not createWorkspace
	assert.ok(ws.manifestPath.endsWith("manifest.json"), "manifestPath");

	// cleanup
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("createWorkspace: temp_root overrides internal temp", () => {
	const tmp = TEST_DIR("createWorkspace-temp-root");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: ".tmp/run", temp_root: ".tmp/xtmp" };
	const ws = createWorkspace(tmp, "probe", cfg);
	assert.ok(ws.tempRoot.includes(".tmp/xtmp"), `expected external temp_root, got ${ws.tempRoot}`);
	fs.rmSync(tmp, { recursive: true, force: true });
});

/* ─────────── manifest round-trip ─────────── */

test("manifest shell/update/finalize round-trip", () => {
	const tmpDir = TEST_DIR("manifest-roundtrip");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: ".tmp/run" };
	const ws = createWorkspace(tmpDir, "summarize-files", cfg);
	const projectDir = "/Users/foz/src/example";
	writeManifestShell(ws, "summarize-files", projectDir);

	const shell = readManifest(ws.manifestPath);
	assert.equal(shell.run_id, ws.runId);
	assert.equal(shell.recipe, "summarize-files");
	assert.equal(shell.project_dir, projectDir);
	assert.equal(shell.steps.length, 0);
	assert.ok(shell.started_at, "started_at present");

	updateManifestStep(ws, {
		id: "enumerate",
		phase: "Enumerate files",
		agent: "util",
		status: "completed",
		outputs: [{ name: "scope", kind: "singleton", path: "targets/scope.json" }],
	});

	const mid = readManifest(ws.manifestPath);
	assert.equal(mid.steps.length, 1);
	assert.equal(mid.steps[0]!.status, "completed");
	assert.equal(mid.steps[0]!.outputs![0]!.name, "scope");

	updateManifestStep(ws, {
		id: "reduce",
		phase: "Merge",
		agent: "research",
		status: "running",
	});

	const running = readManifest(ws.manifestPath);
	assert.equal(running.steps.length, 2);
	assert.equal(running.steps[1]!.status, "running");

	finalizeManifest(ws, "completed");
	const done = readManifest(ws.manifestPath);
	assert.equal(done.status, "completed");
	assert.ok(done.finalized_at, "finalized_at present");

	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ─────────── loadArtifactsConfig ─────────── */

test("loadArtifactsConfig: defaults when settings missing", () => {
	const cfg = loadArtifactsConfig(path.join(os.tmpdir(), `__nonexistent_settings_${Date.now()}.json`));
	assert.equal(cfg.root, ".pi/run");
	assert.equal(cfg.retain_runs, "failed");
	assert.equal(cfg.retain_logs, "always");
	assert.equal(cfg.temp_root, null);
	assert.equal(cfg.max_retained_runs, 20);
});

test("loadArtifactsConfig: reads pipeline.artifacts from settings", () => {
	const settingsPath = path.join(os.tmpdir(), `settings_${Date.now()}.json`);
	const settings = {
		pipeline: {
			artifacts: {
				root: "_work",
				retain_runs: "never",
				retain_logs: "failed",
				temp_root: "/tmp/pi-pipeline-temp",
				max_retained_runs: 5,
			},
		},
	};
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	const cfg = loadArtifactsConfig(settingsPath);
	assert.equal(cfg.root, "_work");
	assert.equal(cfg.retain_runs, "never");
	assert.equal(cfg.retain_logs, "failed");
	assert.equal(cfg.temp_root, "/tmp/pi-pipeline-temp");
	assert.equal(cfg.max_retained_runs, 5);
	fs.unlinkSync(settingsPath);
});

/* ─────────── cleanupRuns ─────────── */

function makeRunDirs(root: string, names: string[], statuses?: (string | undefined)[]) {
	const dirs = names.map((n, i) => {
		const dir = path.join(root, n);
		fs.mkdirSync(dir, { recursive: true });
		const manifestPath = path.join(dir, "manifest.json");
		const manifest = {
			run_id: n,
			recipe: "test",
			started_at: new Date(Date.now() - i * 1000).toISOString(),
			project_dir: root,
			workspace_dir: n,
			steps: [],
			deliverables: [],
		};
		if (statuses?.[i] !== undefined) {
			(manifest as any).status = statuses[i];
		}
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		return dir;
	});
	return dirs;
}

test("cleanupRuns: never policy deletes all", () => {
	const tmp = TEST_DIR("cleanup-never");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: tmp, retain_runs: "never", max_retained_runs: 100 };
	makeRunDirs(tmp, ["r1", "r2", "r3"]);
	cleanupRuns(tmp, cfg);
	const survivors = fs.readdirSync(tmp).filter((n) => !n.startsWith("."));
	assert.deepEqual(survivors, []);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("cleanupRuns: failed policy keeps failed/partial, deletes completed", () => {
	const tmp = TEST_DIR("cleanup-failed");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: tmp, retain_runs: "failed", max_retained_runs: 100 };
	makeRunDirs(tmp, ["completed", "failed", "partial", "unknown-no-manifest"],
		["completed", "failed", "partial", undefined]);
	cleanupRuns(tmp, cfg);
	const names = fs.readdirSync(tmp).filter((n) => !n.startsWith("."));
	assert.equal(names.length, 2, `expected 2 survivors, got ${names.join(", ")}`);
	assert.ok(names.includes("failed"));
	assert.ok(names.includes("partial"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("deriveRunStatus: all completed -> completed", () => {
  const steps = [
    { id: "a", phase: "A", agent: "util", status: "completed" },
    { id: "b", phase: "B", agent: "dev", status: "completed" },
  ] as any;
  assert.equal(deriveRunStatus(steps), "completed");
});

test("deriveRunStatus: any failed -> failed", () => {
  const steps = [
    { id: "a", phase: "A", agent: "util", status: "completed" },
    { id: "b", phase: "B", agent: "dev", status: "failed" },
  ] as any;
  assert.equal(deriveRunStatus(steps), "failed");
});

test("deriveRunStatus: any partial (no failures) -> partial", () => {
  const steps = [
    { id: "a", phase: "A", agent: "util", status: "completed" },
    { id: "b", phase: "B", agent: "dev", status: "partial" },
  ] as any;
  assert.equal(deriveRunStatus(steps), "partial");
});

test("deriveRunStatus: failed beats partial", () => {
  const steps = [
    { id: "a", phase: "A", agent: "util", status: "failed" },
    { id: "b", phase: "B", agent: "dev", status: "partial" },
  ] as any;
  assert.equal(deriveRunStatus(steps), "failed");
});

test("deriveRunStatus: pending/running leaves run uncompleted (undefined)", () => {
  const steps = [
    { id: "a", phase: "A", agent: "util", status: "completed" },
    { id: "b", phase: "B", agent: "dev", status: "running" },
  ] as any;
  assert.equal(deriveRunStatus(steps), undefined);
});

test("deriveRunStatus: empty steps -> undefined", () => {
  assert.equal(deriveRunStatus([]), undefined);
});

test("finalizeManifest: derives status from steps when not given", () => {
  const tmp = TEST_DIR("finalize-derive");
  const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: ".tmp/run" };
  const ws = createWorkspace(tmp, "x", cfg);
  writeManifestShell(ws, "x", tmp);
  updateManifestStep(ws, { id: "a", phase: "A", agent: "util", status: "completed" });
  updateManifestStep(ws, { id: "b", phase: "B", agent: "dev", status: "failed" });
  finalizeManifest(ws); // no status arg -> derive
  const m = readManifest(ws.manifestPath);
  assert.equal(m.status, "failed");
  assert.ok(m.finalized_at);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("cleanupRuns: max_retained_runs prunes oldest first", () => {
	const tmp = TEST_DIR("cleanup-max");
	const cfg: ArtifactsConfig = { ...loadArtifactsConfig(), root: tmp, retain_runs: "always", max_retained_runs: 3 };
	makeRunDirs(tmp, ["a", "b", "c", "d", "e"]);
	// age is 0 → oldest
	const aDir = fs.readdirSync(path.join(tmp, "a"));
	const bDir = fs.readdirSync(path.join(tmp, "b"));
	cleanupRuns(tmp, cfg);
	const names = fs.readdirSync(tmp).filter((n) => !n.startsWith("."));
	assert.equal(names.length, 3);
	assert.ok(!names.includes("a"), "oldest 'a' should be pruned");
	assert.ok(!names.includes("b"), "second-oldest 'b' should be pruned");
	assert.ok(names.includes("c"));
	assert.ok(names.includes("d"));
	assert.ok(names.includes("e"));
	fs.rmSync(tmp, { recursive: true, force: true });
});
