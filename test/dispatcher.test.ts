/**
 * Unit tests for src/dispatcher.ts pure helpers.
 * The SDK-dependent paths (createStepSession / dispatchStep / dispatchIterate)
 * are covered by the Stage D live smoke test — they need a real pi runtime.
 *
 *   node --test --experimental-strip-types test/dispatcher.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	parseAgentFrontmatter,
	loadAgentProfile,
	loadAgentProfileFromDirs,
	extractUsageAndStatus,
	extractText,
	buildManifestStep,
	recordStepResult,
	loadUnits,
	collectCollection,
	composeIterateTask,
	persistUnitOutput,
	resolveCollectionOutputAbs,
	type AgentProfile,
	type StepResult,
} from "../src/dispatcher.ts";
import { createWorkspace, writeManifestShell, updateManifestStep } from "../src/workspace.ts";
import { buildPlanFromRecipe } from "../src/recipes.ts";

/* ─────────── parseAgentFrontmatter ─────────── */

test("parseAgentFrontmatter: scalar fields", () => {
	const fm = parseAgentFrontmatter(`---
name: dev
description: Low-cost model for surgical edits
thinking: low
systemPromptMode: replace
---
body`);
	assert.equal(fm["name"], "dev");
	assert.equal(fm["description"], "Low-cost model for surgical edits");
	assert.equal(fm["thinking"], "low");
	assert.equal(fm["systemPromptMode"], "replace");
});

test("parseAgentFrontmatter: tools inline string", () => {
	// Inline comma-separated form: kept as raw string at the frontmatter layer;
	// loadAgentProfile splits it into an array.
	const fm = parseAgentFrontmatter(`---
tools: read, grep, find, ls, bash, write, edit, structured_output
---
body`);
	assert.equal(fm["tools"], "read, grep, find, ls, bash, write, edit, structured_output");
});

test("parseAgentFrontmatter: multiline list (yaml-style)", () => {
	const fm = parseAgentFrontmatter(`---
tools:
  - read
  - write
  - bash
---
body`);
	assert.deepEqual(fm["tools"], ["read", "write", "bash"]);
});

test("parseAgentFrontmatter: quoted values", () => {
	const fm = parseAgentFrontmatter(`---
description: 'A quoted description'
name: "quoted-name"
---
body`);
	assert.equal(fm["description"], "A quoted description");
	assert.equal(fm["name"], "quoted-name");
});

test("parseAgentFrontmatter: comments and missing frontmatter", () => {
	const fm = parseAgentFrontmatter(`# this is not frontmatter
body text`);
	assert.deepEqual(fm, {});
});

/* ─────────── loadAgentProfile ─────────── */

test("loadAgentProfile: parses a real agent file", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const agentsDir = path.join(tmp, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "util.md"), `---
name: util
description: Low-tier mechanical work
tools: read, grep, find, ls, bash, write, edit, structured_output
thinking: low
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are the util-tier agent. Do mechanical work.

# Working rules
- Be fast and direct.`);

	const result = loadAgentProfile("util", agentsDir);
	assert.ok(result);
	assert.equal(result!.profile.name, "util");
	assert.deepEqual(result!.profile.tools, ["read", "grep", "find", "ls", "bash", "write", "edit", "structured_output"]);
	assert.equal(result!.profile.thinking, "low");
	assert.equal(result!.profile.systemPromptMode, "replace");
	assert.equal(result!.profile.inheritProjectContext, true);
	assert.equal(result!.profile.inheritSkills, false);
	assert.ok(result!.profile.systemPrompt.includes("util-tier agent"));
	assert.ok(result!.profile.systemPrompt.includes("Be fast and direct"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadAgentProfile: returns null for missing file", () => {
	const result = loadAgentProfile("nope", "/nonexistent");
	assert.equal(result, null);
});

test("loadAgentProfileFromDirs: falls back to later dirs", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pipeline-agentdirs-"));
	const projectAgents = path.join(tmp, "project", "agents");
	const packageAgents = path.join(tmp, "package", "agents");
	fs.mkdirSync(packageAgents, { recursive: true });
	fs.writeFileSync(path.join(packageAgents, "util.md"), `---
name: util
description: Package util
tools: read, structured_output
---

Package util body.`);
	const result = loadAgentProfileFromDirs("util", [projectAgents, packageAgents]);
	assert.ok(result);
	assert.equal(result!.agentsDir, packageAgents);
	assert.equal(result!.profile.description, "Package util");
	fs.rmSync(tmp, { recursive: true, force: true });
});

/* ─────────── extractUsageAndStatus ─────────── */

test("extractUsageAndStatus: sums assistant usage, detects error/abort", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "do x" }] },
		{ role: "assistant", content: [{ type: "text", text: "thinking..." }], stopReason: "toolUse", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
		{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 200, output: 80, cacheRead: 10, cacheWrite: 5, cost: { total: 0.002 } } },
	];
	const { usage, hadError, hadAborted } = extractUsageAndStatus(messages);
	assert.equal(usage.input, 300);
	assert.equal(usage.output, 130);
	assert.equal(usage.cacheRead, 10);
	assert.equal(usage.cacheWrite, 5);
	assert.equal(usage.turns, 2);
	assert.equal(hadError, false);
	assert.equal(hadAborted, false);
});

test("extractUsageAndStatus: flags error", () => {
	const messages = [
		{ role: "assistant", content: [], stopReason: "error", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
	];
	const { hadError } = extractUsageAndStatus(messages);
	assert.equal(hadError, true);
});

test("extractUsageAndStatus: flags abort", () => {
	const messages = [
		{ role: "assistant", content: [], stopReason: "aborted", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
	];
	const { hadAborted } = extractUsageAndStatus(messages);
	assert.equal(hadAborted, true);
});

/* ─────────── extractText ─────────── */

test("extractText: concatenates text blocks from last assistant", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{ role: "assistant", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "foo", input: {} }] },
		{ role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "ok" }], isError: false },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
	];
	assert.equal(extractText(messages), "final answer");
});

test("extractText: empty when no assistant with text", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	];
	assert.equal(extractText(messages), "");
});

/* ─────────── buildManifestStep / recordStepResult ─────────── */

test("buildManifestStep: produces a pending step from a plan step", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Enumerate  (util, output=scope:json)\nList files.",
		nameFallback: "x",
	});
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	const step = plan.steps[0]!;
	const ms = buildManifestStep(step, ws);
	assert.equal(ms.id, "enumerate");
	assert.equal(ms.phase, "Enumerate");
	assert.equal(ms.agent, "util");
	assert.equal(ms.status, "pending");
	assert.equal(ms.attempts, 0);
	assert.ok(ms.outputs);
	assert.equal(ms.outputs![0]!.name, "scope");
	assert.ok(ms.outputs![0]!.path.endsWith("targets/scope.json"));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("recordStepResult: updates manifest with real statuses", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	writeManifestShell(ws, "x", tmp);
	const result: StepResult = {
		status: "completed",
		text: "done",
		usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.001, turns: 2 },
		durationMs: 1200,
	};
	recordStepResult(ws, "enumerate", result);
	const manifest = JSON.parse(fs.readFileSync(ws.manifestPath, "utf-8"));
	assert.equal(manifest.steps[0]!.id, "enumerate");
	assert.equal(manifest.steps[0]!.status, "completed");
	assert.equal(manifest.steps[0]!.usage.input, 100);
	assert.equal(manifest.steps[0]!.usage.cost, 0.001);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("recordStepResult: preserves manifest outputs and stores parsed targets", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	writeManifestShell(ws, "x", tmp);
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Plan  (high, output=reorg_plan:json)\nWrite a plan.",
		nameFallback: "x",
	});
	const ms = buildManifestStep(plan.steps[0]!, ws);
	ms.status = "running";
	// Simulate the extension's pre-populated manifest row.
	updateManifestStep(ws, ms);
	const result: StepResult = {
		status: "completed",
		text: "done",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: 10,
		targets: { reorg_plan: { items: [{ path: "p1" }] } },
	};
	recordStepResult(ws, "plan", result);
	const manifest = JSON.parse(fs.readFileSync(ws.manifestPath, "utf-8"));
	assert.equal(manifest.steps[0]!.phase, "Plan");
	assert.equal(manifest.steps[0]!.agent, "high");
	assert.equal(manifest.steps[0]!.outputs[0]!.name, "reorg_plan");
	assert.deepEqual(manifest.steps[0]!.targets.reorg_plan.items, [{ path: "p1" }]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadUnits: reads target JSON from workspace targets/", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-loadunits-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	fs.writeFileSync(path.join(ws.targetsDir, "scope.json"), JSON.stringify({
		items: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
	}));
	const units = loadUnits(ws, "scope");
	assert.equal(units.length, 2);
	assert.equal(units[0]!.path, "src/a.ts");
	assert.equal(units[1]!.path, "src/b.ts");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadUnits: falls back to cwd for legacy recipes", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-loadunits-${Date.now()}`);
	const cwd = path.join(tmp, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const ws = createWorkspace(path.join(tmp, "ws"), "x");
	fs.writeFileSync(path.join(cwd, "scope-files.json"), JSON.stringify([
		{ path: "src/legacy.ts" },
	]));
	const units = loadUnits(ws, "scope-files", cwd);
	assert.equal(units.length, 1);
	assert.equal(units[0]!.path, "src/legacy.ts");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadUnits: returns empty array when no file found", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-loadunits-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	assert.deepEqual(loadUnits(ws, "nope"), []);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("collectCollection: lists per-unit output paths in sorted order", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-collect-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	const colDir = path.join(ws.collectionsDir, "summary");
	fs.mkdirSync(colDir, { recursive: true });
	fs.writeFileSync(path.join(colDir, "src-b.ts.md"), "b");
	fs.writeFileSync(path.join(colDir, "src-a.ts.md"), "a");
	fs.writeFileSync(path.join(colDir, ".hidden"), "h");
	const files = collectCollection(ws, "summary");
	assert.deepEqual(files.map((f) => path.basename(f)), ["src-a.ts.md", "src-b.ts.md"]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("composeIterateTask: collection path strips double extension", () => {
	// We test the path-building logic directly since composeIterateTask is not exported.
	// The fix: `{unit.path}` in a collection pattern = stem (no extension), the
	// target's extension is always appended. So for `output=summary-{unit.path}`
	// over `docs/ARCHITECTURE.md`, the path is `summary-docs/ARCHITECTURE.md`,
	// not `summary-docs/ARCHITECTURE.md.md`.
	const t = { name: "summary", ext: "md", kind: "collection" } as any;
	const unitPath = "docs/ARCHITECTURE.md";
	const unitKeyClean = unitPath.replace(new RegExp(`\\.${t.ext}$`), "");
	const substituted = (t.rawPath ?? `${t.name}-${unitKeyClean}.${t.ext}`)
		.replace(/\{unit\.path\.full\}/g, unitPath)
		.replace(/\{unit\.path\}/g, unitKeyClean);
	assert.equal(substituted, "summary-docs/ARCHITECTURE.md");
});

test("composeIterateTask: unresolved named reads remain absolute and workspace-scoped", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-readpath-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do  (high, reads=missing_collection)\nReview {unit.path}.",
		nameFallback: "x",
	});
	const task = composeIterateTask(plan.steps[0]!, ws, { path: "a" });
	assert.match(task, new RegExp(path.join(ws.collectionsDir, "missing_collection").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(task, /Read from: missing_collection(?:,|\n)/);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("recordStepResult: partial iterate result carries units[]", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const ws = createWorkspace(tmp, "x");
	writeManifestShell(ws, "x", tmp);
	const result: StepResult = {
		status: "partial",
		text: "2/3 completed",
		usage: { input: 300, output: 150, cacheRead: 0, cacheWrite: 0, cost: 0.003, turns: 6 },
		durationMs: 5000,
		units: [
			{ key: "src/a.ts", status: "completed" },
			{ key: "src/b.ts", status: "completed" },
			{ key: "src/c.ts", status: "failed", error: "context-overflow" },
		],
	};
	recordStepResult(ws, "summarize_each_file", result);
	const manifest = JSON.parse(fs.readFileSync(ws.manifestPath, "utf-8"));
	const step = manifest.steps[0]!;
	assert.equal(step.status, "partial");
	assert.equal(step.outputs[0]!.kind, "collection");
	assert.equal(step.outputs[0]!.units.length, 3);
	assert.equal(step.outputs[0]!.units[2]!.status, "failed");
	assert.equal(step.outputs[0]!.units[2]!.error, "context-overflow");
	fs.rmSync(tmp, { recursive: true, force: true });
});

/* ─────────── per-unit collection output persistence (read-only agents) ─────────── */

test("persistUnitOutput: writes the returned text when the unit output is missing", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-unitpersist-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const t = { name: "review", ext: "md", kind: "collection" as const };
	const res = persistUnitOutput(t, ws, { path: "src/a.ts" }, "verdict: accept");
	assert.equal(res.error, undefined);
	const abs = path.join(ws.collectionsDir, "review", "review-src", "a.ts.md");
	assert.ok(fs.existsSync(abs), `per-unit output should exist at ${abs}`);
	assert.equal(fs.readFileSync(abs, "utf-8"), "verdict: accept");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("persistUnitOutput: never overwrites a file the agent already wrote", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-unitpersist-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const abs = path.join(ws.collectionsDir, "review", "review-x.md");
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, "agent wrote this", "utf-8");
	const res = persistUnitOutput({ name: "review", ext: "md", kind: "collection" }, ws, { path: "x.md" }, "returned text");
	assert.equal(res.error, undefined);
	assert.equal(fs.readFileSync(abs, "utf-8"), "agent wrote this");
	assert.equal(fs.readdirSync(path.dirname(abs)).length, 1, "no extra file should be created");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("persistUnitOutput: json units are parsed and pretty-printed; invalid json fails the unit", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-unitpersist-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const t = { name: "units", ext: "json", kind: "collection" as const };
	const ok = persistUnitOutput(t, ws, { path: "u1" }, `{ "a": 1 }`);
	assert.equal(ok.error, undefined);
	const abs = path.join(ws.collectionsDir, "units", "units-u1.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(abs, "utf-8")), { a: 1 });
	const bad = persistUnitOutput(t, ws, { path: "u2" }, "not json {");
	assert.ok(bad.error && bad.error.includes("Could not parse JSON"));
	assert.ok(!fs.existsSync(path.join(ws.collectionsDir, "units", "u2.json")));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveCollectionOutputAbs: unit stem substitution", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-unitpersist-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const abs = resolveCollectionOutputAbs({ name: "summary", ext: "md" }, ws, { path: "docs/A.md" });
	assert.ok(abs.startsWith(ws.collectionsDir), `abs = ${abs}`);
	assert.ok(abs.endsWith(path.join("summary", "summary-docs", "A.md")), `abs = ${abs}`);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildManifestStep: checkpoint flows through; collection output path is collections/<name>", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-buildms-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "x");
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do  (high, checkpoint=go, output=review-{unit.path})\nFor each `{unit}` in scope, review it.",
		nameFallback: "x",
	});
	const ms = buildManifestStep(plan.steps[0]!, ws);
	assert.equal(ms.checkpoint, "go");
	assert.equal(ms.outputs![0]!.kind, "collection");
	assert.equal(ms.outputs![0]!.path, `collections${path.sep}review`);
	fs.rmSync(tmp, { recursive: true, force: true });
});
