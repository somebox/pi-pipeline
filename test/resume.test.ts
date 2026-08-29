/**
 * Unit tests for src/resume.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createWorkspace, writeManifestShell, updateManifestStep, hashRecipe } from "../src/workspace.ts";
import { planDelta, recipeHashMismatch, filterUnits, stepId } from "../src/resume.ts";
import type { Plan } from "../src/lib.ts";

const tmpRoot = () => path.join(os.tmpdir(), `pi-pipeline-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const plan: Plan = {
	effort: "standard",
	mode: "research",
	summary: "",
	steps: [
		{ phase: "Enumerate", agent: "util", label: "e", task: "e", outputs: [{ name: "scope", scheme: "work", kind: "singleton", ext: "json" }] },
		{ phase: "Summarize each file", agent: "dev", label: "s", task: "s", iterate: "scope", outputs: [{ name: "summary", scheme: "work", kind: "collection", ext: "md" }] },
		{ phase: "Merge", agent: "research", label: "m", task: "m", outputs: [{ name: "summaries", scheme: "work", kind: "singleton", ext: "md" }] },
	],
};

test("stepId slugifies phase", () => {
	assert.equal(stepId(plan.steps[1]!), "summarize_each_file");
});

test("recipeHashMismatch: equal ok, drift errors", () => {
	const raw = "---\nname: x\n---\n";
	assert.equal(recipeHashMismatch({ recipe_hash: hashRecipe(raw), recipe: "x", run_id: "r" } as any, raw), undefined);
	const err = recipeHashMismatch({ recipe_hash: "deadbeefdeadbeef", recipe: "x", run_id: "r1" } as any, raw);
	assert.ok(err && err.includes("changed"));
	assert.equal(recipeHashMismatch({ recipe: "x", run_id: "r" } as any, raw), undefined);
});

test("planDelta: skip completed-with-outputs; retry failed iterate units; rerun missing", () => {
	const tmp = tmpRoot();
	const ws = createWorkspace(tmp, "summarize-files");
	writeManifestShell(ws, "summarize-files", tmp);
	fs.writeFileSync(path.join(ws.targetsDir, "scope.json"), "{\"items\":[]}");
	updateManifestStep(ws, {
		id: "enumerate",
		phase: "Enumerate",
		agent: "util",
		status: "completed",
		outputs: [{ name: "scope", kind: "singleton", path: "targets/scope.json" }],
	});
	updateManifestStep(ws, {
		id: "summarize_each_file",
		phase: "Summarize each file",
		agent: "dev",
		status: "partial",
		outputs: [{
			name: "summary",
			kind: "collection",
			path: "collections/summary/",
			units: [
				{ key: "a.ts", status: "completed" },
				{ key: "b.ts", status: "failed", error: "boom" },
			],
		}],
	});
	updateManifestStep(ws, {
		id: "merge",
		phase: "Merge",
		agent: "research",
		status: "pending",
		outputs: [{ name: "summaries", kind: "singleton", path: "targets/summaries.md" }],
	});

	const man = JSON.parse(fs.readFileSync(ws.manifestPath, "utf-8"));
	const delta = planDelta(plan, man, ws);
	assert.equal(delta[0]!.action, "skip");
	assert.equal(delta[1]!.action, "retry-units");
	assert.deepEqual(delta[1]!.unitKeys, ["b.ts"]);
	assert.equal(delta[2]!.action, "run");

	fs.unlinkSync(path.join(ws.targetsDir, "scope.json"));
	const delta2 = planDelta(plan, man, ws);
	assert.equal(delta2[0]!.action, "run");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("filterUnits keeps named keys", () => {
	const units = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
	assert.deepEqual(filterUnits(units, ["b.ts"]), [{ path: "b.ts" }]);
});
