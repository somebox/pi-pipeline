/**
 * Unit tests for src/recipes.ts target parsing and validation (Stage 2).
 * No fs, no pi imports — pure string/struct tests.
 *
 *   node --test --experimental-strip-types test/targets.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isLegacyOutput,
	parseOutputSpec,
	availableTargets,
	validatePlanTargets,
	buildPlanFromRecipe,
	compileRecipeToChain,
} from "../src/recipes.ts";
import type { TargetSpec } from "../src/recipes.ts";
import { createWorkspace, loadArtifactsConfig } from "../src/workspace.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/* ─── helpers ─── */
function mkWs() {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-stage2-${Date.now()}`);
	const cfg = { ...loadArtifactsConfig(), root: ".tmp/run" };
	const ws = createWorkspace(tmp, "summarize-files", cfg);
	return { tmp, ws };
}
function cleanup(tmp: string) {
	fs.rmSync(tmp, { recursive: true, force: true });
}

/* ─────────── isLegacyOutput disambiguation ─────────── */

test("isLegacyOutput: dotted filename is legacy", () => {
	assert.equal(isLegacyOutput("standards.md"), true);
	assert.equal(isLegacyOutput("scope-files.json"), true);
	assert.equal(isLegacyOutput("summary-{unit.path}.md"), true);
});

test("isLegacyOutput: bare name is NOT legacy", () => {
	assert.equal(isLegacyOutput("summary"), false);
	assert.equal(isLegacyOutput("scope"), false);
});

test("isLegacyOutput: explicit scheme is NOT legacy", () => {
	assert.equal(isLegacyOutput("script=temp:migrate.sh"), false);
	assert.equal(isLegacyOutput("readme=project:README.md"), false);
});

test("isLegacyOutput: stripped placeholders determine legacy status", () => {
	// After stripping {unit.path}, the remainder is "summary-" (no dot/slash)
	assert.equal(isLegacyOutput("summary-{unit.path}"), false);
	// After stripping {unit}, the remainder is "log-.md" (has dot)
	assert.equal(isLegacyOutput("log-{unit}.md"), true);
});

/* ─────────── parseOutputSpec shapes ─────────── */

test("parseOutputSpec: bare name → work singleton md", () => {
	const t = parseOutputSpec("summary")!;
	assert.equal(t.name, "summary");
	assert.equal(t.scheme, "work");
	assert.equal(t.kind, "singleton");
	assert.equal(t.ext, "md");
});

test("parseOutputSpec: :json suffix → work singleton json", () => {
	const t = parseOutputSpec("scope:json")!;
	assert.equal(t.name, "scope");
	assert.equal(t.scheme, "work");
	assert.equal(t.kind, "singleton");
	assert.equal(t.ext, "json");
});

test("parseOutputSpec: collection pattern", () => {
	const t = parseOutputSpec("summary-{unit.path}")!;
	assert.equal(t.name, "summary");
	assert.equal(t.kind, "collection");
	assert.equal(t.ext, "md");
	assert.equal(t.unitPattern, "{unit.path}");
});

test("parseOutputSpec: collection with simple {unit}", () => {
	const t = parseOutputSpec("log-{unit}")!;
	assert.equal(t.name, "log");
	assert.equal(t.kind, "collection");
	assert.equal(t.unitPattern, "{unit}");
});

test("parseOutputSpec: explicit temp scheme", () => {
	const t = parseOutputSpec("script=temp:migrate.sh")!;
	assert.equal(t.name, "script");
	assert.equal(t.scheme, "temp");
	assert.equal(t.kind, "singleton");
	assert.equal(t.ext, "sh");
	assert.equal(t.rawPath, "migrate.sh");
});

test("parseOutputSpec: explicit project scheme", () => {
	const t = parseOutputSpec("readme=project:README.md")!;
	assert.equal(t.name, "readme");
	assert.equal(t.scheme, "project");
	assert.equal(t.ext, "md");
	assert.equal(t.rawPath, "README.md");
});

test("parseOutputSpec: legacy returns null", () => {
	assert.equal(parseOutputSpec("standards.md"), null);
	assert.equal(parseOutputSpec("scope-files.json"), null);
	assert.equal(parseOutputSpec("summary-{unit.path}.md"), null);
});

/* ─────────── availableTargets ─────────── */

test("availableTargets: collects names from earlier steps only", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. One (util, output=scope:json)\nA.\n## 2. Two (dev, reads=scope, output=summary-{unit.path})\nB.\n## 3. Three (research, reads=summary, output=final)\nC.",
		nameFallback: "x",
	});
	const avail = availableTargets(plan.steps, 2); // up to step 3 (index 2)
	assert.ok(avail.has("scope"));
	assert.ok(avail.has("summary"));
	assert.ok(!avail.has("final")); // from step 3 itself, not an earlier step
});

/* ─────────── validatePlanTargets ─────────── */

test("validatePlanTargets: passes when all reads resolve", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. One (util, output=scope:json)\nA.\n## 2. Two (dev, reads=scope, output=summary-{unit.path})\nB.\n## 3. Three (research, reads=summary, output=final)\nC.",
		nameFallback: "x",
	});
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, []);
});

test("validatePlanTargets: errors on unresolved named read", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. One (util, output=scope:json)\nA.\n## 2. Two (dev, reads=missing, output=summary)\nB.",
		nameFallback: "x",
	});
	const errors = validatePlanTargets(plan);
	assert.equal(errors.length, 1);
	assert.ok(errors[0]!.includes('reads unresolved target "missing"'));
	assert.ok(errors[0]!.includes("Available: scope"));
});

test("validatePlanTargets: allows project: prefixed reads without targets", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. One (util, reads=project:README.md, output=result:json)\nA.",
		nameFallback: "x",
	});
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, []);
});

test("validatePlanTargets: allows legacy literal reads without targets", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. One (util, reads=legacy.md, output=result:json)\nA.",
		nameFallback: "x",
	});
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, []);
});

/* ─────────── compileRecipeToChain golden fixture ─────────── */

test("compileRecipeToChain: target-based summarize-files with workspace", () => {
	// The fixture from docs/ARTIFACTS.md Compiler output contract (absolute
	// paths shortened to <ws>/ for readability in assertions).
	const raw = `---
name: summarize-files
---
# summarize-files

## 1. Enumerate files  (util, output=scope:json)
List every file matching \`{{glob}}\`. Write \`scope\`.

## 2. Summarize each file  (dev, iterate=scope, output=summary-{unit.path})
For each file in the scope list, read \`{unit.path}\` and write a 100-word summary.

## 3. Merge summaries  (research, reads=summary, output=summaries)
Read the collected summaries and write the synthesis.
`;
	const plan = buildPlanFromRecipe({ raw, nameFallback: "summarize-files" });
	const { tmp, ws } = mkWs();

	// Validate
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);

	const chain = compileRecipeToChain(plan, ws);
	assert.equal(chain.length, 3);

	// Step 1 — singleton JSON target
	const s1 = chain[0];
	assert.equal(s1.agent, "util");
	assert.ok(s1.output.endsWith("targets/scope.json"), `s1.output = ${s1.output}`);
	assert.equal(s1.as, "scope");
	assert.equal(s1.outputSchema?.type, "object");

	// Step 2 — iterate with collection output
	const s2 = chain[1];
	assert.equal(s2.expand.from.output, "scope");
	assert.ok(s2.parallel.output.includes("collections/summary/summary-{unit.path}.md"), `s2.parallel.output = ${s2.parallel.output}`);
	assert.equal(s2.collect.as, "summary");

	// Step 3 — reduce step: collection read injected into task text, no reads field
	const s3 = chain[2];
	assert.equal(s3.agent, "research");
	assert.ok(!s3.reads, "reduce step should not have reads array for collection");
	assert.ok(s3.task.includes("{outputs.summary}"), `s3.task should reference {outputs.summary}: ${s3.task}`);
	assert.ok(s3.output.endsWith("targets/summaries.md"), `s3.output = ${s3.output}`);
	assert.equal(s3.as, "summaries");

	cleanup(tmp);
});

test("compileRecipeToChain: legacy recipe byte-identical without workspace", () => {
	const raw = `---
name: x
---
# x

## 1. One (util, output=scope-files.json)
A.

## 2. Two (dev, iterate=scope-files, output=summary-{unit}.md)
B.

## 3. Three (research, reads=summary-*.md, output=summaries.md)
C.
`;
	const plan = buildPlanFromRecipe({ raw, nameFallback: "x" });
	const chain = compileRecipeToChain(plan);
	assert.equal(chain.length, 3);
	assert.equal(chain[0].output, "scope-files.json");
	assert.equal(chain[1].parallel.output, "summary-{unit.path}.md");
	assert.deepEqual(chain[1].collect, { as: "collected_scope_files" });
	assert.deepEqual(chain[2].reads, ["summary-*.md"]);
	assert.equal(chain[2].output, "summaries.md");
});

/* ─────────── End-to-end: real migrated recipe files ─────────── */

function loadRecipeFile(name: string): string {
	return fs.readFileSync(path.join(import.meta.dirname, "..", "pipelines", `${name}.md`), "utf-8");
}

test("summarize-files (real file) parses, validates, and compiles with workspace", () => {
	const raw = loadRecipeFile("summarize-files");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "summarize-files" });
	assert.equal(plan.steps.length, 3, `expected 3 steps, got ${plan.steps.length}`);

	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);

	const { tmp, ws } = mkWs();
	const chain = compileRecipeToChain(plan, ws);
	assert.equal(chain.length, 3);
	assert.ok(chain[0].output.endsWith("targets/scope.json"), `step 1 output: ${chain[0].output}`);
	assert.ok(chain[1].parallel.output.includes("collections/summary/"), `step 2 collection: ${chain[1].parallel.output}`);
	assert.equal(chain[1].collect.as, "summary");
	assert.ok(chain[2].task.includes("{outputs.summary}"), `step 3 task should reference collection: ${chain[2].task}`);
	cleanup(tmp);
});

test("probe (real file) parses, validates, and compiles with workspace", () => {
	const raw = loadRecipeFile("probe");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "probe" });
	assert.equal(plan.steps.length, 1);

	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);

	const { tmp, ws } = mkWs();
	const chain = compileRecipeToChain(plan, ws);
	assert.equal(chain.length, 1);
	assert.ok(chain[0].output.endsWith("targets/probe_summary.md"), `step 1 output: ${chain[0].output}`);
	// project: reads compile to bare paths (no workspace prefix)
	assert.deepEqual(chain[0].reads, ["AGENTS.md", "go.mod"]);
	cleanup(tmp);
});

test("docs-audit (real file) parses, validates, and compiles with workspace", () => {
	const raw = loadRecipeFile("docs-audit");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "docs-audit" });
	assert.equal(plan.steps.length, 5);

	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);

	const { tmp, ws } = mkWs();
	const chain = compileRecipeToChain(plan, ws);
	assert.equal(chain.length, 5);

	// Step 1: JSON singleton target
	assert.ok(chain[0].output.endsWith("targets/inventory.json"), `step 1 output: ${chain[0].output}`);
	assert.equal(chain[0].as, "inventory");

	// Step 2: reads inventory singleton, writes reorg_plan singleton
	assert.ok(chain[1].output.endsWith("targets/reorg_plan.md"), `step 2 output: ${chain[1].output}`);

	// Step 3: iterate over inventory, writes log collection
	assert.equal(chain[2].expand.from.output, "inventory");
	assert.ok(chain[2].parallel.output.includes("collections/log/"), `step 3 collection: ${chain[2].parallel.output}`);
	assert.equal(chain[2].collect.as, "log");

	// Step 4: reads reorg_plan and log collection, writes link_status
	assert.ok(chain[3].output.endsWith("targets/link_status.md"), `step 4 output: ${chain[3].output}`);

	cleanup(tmp);
});

/* ─────────── Regression: legacy recipes compile unchanged ─────────── */

for (const recipeName of ["code-quality", "verify-source", "housekeeping"]) {
	test(`${recipeName} (legacy) parses, validates, and compiles identically`, () => {
		const raw = loadRecipeFile(recipeName);
		const plan = buildPlanFromRecipe({ raw, nameFallback: recipeName });
		assert.ok(plan.steps.length > 0, `${recipeName} should have steps`);

		// No named-read errors (all reads are legacy literals)
		const errors = validatePlanTargets(plan);
		assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);

		// Without workspace: legacy compilation
		const chainNoWs = compileRecipeToChain(plan);

		// With workspace: legacy compilation should be identical
		const { tmp, ws } = mkWs();
		const chainWs = compileRecipeToChain(plan, ws);
		// Legacy compilation should have identical structural fields.
		// Task text is allowed to differ because Stage 3 injects temp-dir
		// instructions when a workspace is present.
		assert.equal(chainWs.length, chainNoWs.length, `${recipeName}: chain length differs`);
		for (let i = 0; i < chainWs.length; i++) {
			const a = chainWs[i];
			const b = chainNoWs[i];
			assert.equal(a.agent, b.agent, `step ${i} agent`);
			assert.equal(a.output ?? a.parallel?.output, b.output ?? b.parallel?.output, `step ${i} output`);
			assert.deepEqual(a.reads ?? a.parallel?.reads, b.reads ?? b.parallel?.reads, `step ${i} reads`);
			assert.deepEqual(a.as, b.as, `step ${i} as`);
			assert.deepEqual(a.collect, b.collect, `step ${i} collect`);
		}
		cleanup(tmp);
	});
}
