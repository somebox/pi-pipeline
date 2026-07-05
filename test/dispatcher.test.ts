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
	extractUsageAndStatus,
	extractText,
	buildManifestStep,
	recordStepResult,
	loadUnits,
	collectCollection,
	type AgentProfile,
	type StepResult,
} from "../src/dispatcher.ts";
import { createWorkspace, loadArtifactsConfig, writeManifestShell } from "../src/workspace.ts";
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
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
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
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
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

test("loadUnits: reads target JSON from workspace targets/", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-loadunits-${Date.now()}`);
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
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
	const ws = createWorkspace(path.join(tmp, "ws"), "x", loadArtifactsConfig());
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
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
	assert.deepEqual(loadUnits(ws, "nope"), []);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("collectCollection: lists per-unit output paths in sorted order", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-collect-${Date.now()}`);
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
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

test("recordStepResult: partial iterate result carries units[]", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-dispatcher-${Date.now()}`);
	const ws = createWorkspace(tmp, "x", loadArtifactsConfig());
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
