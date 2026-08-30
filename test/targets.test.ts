/**
 * Unit tests for src/recipes.ts target parsing and validation.
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
} from "../src/recipes.ts";
import type { TargetSpec } from "../src/recipes.ts";

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

/* ─────────── End-to-end: real recipe files parse + validate ─────────── */

import fs from "node:fs";
import path from "node:path";

function loadRecipeFile(name: string): string {
	return fs.readFileSync(path.join(import.meta.dirname, "..", "pipelines", `${name}.md`), "utf-8");
}

test("summarize-files (real file) parses and validates", () => {
	const raw = loadRecipeFile("summarize-files");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "summarize-files" });
	assert.equal(plan.steps.length, 3, `expected 3 steps, got ${plan.steps.length}`);
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);
});

test("probe (real file) parses and validates", () => {
	const raw = loadRecipeFile("probe");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "probe" });
	assert.equal(plan.steps.length, 1);
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);
});

test("docs-audit (real file) parses and validates", () => {
	const raw = loadRecipeFile("docs-audit");
	const plan = buildPlanFromRecipe({ raw, nameFallback: "docs-audit" });
	assert.equal(plan.steps.length, 8, `expected 8 steps, got ${plan.steps.length}`);
	const errors = validatePlanTargets(plan);
	assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);
});

for (const recipeName of ["code-quality", "verify-source", "housekeeping"]) {
	test(`${recipeName} (real file) parses and validates`, () => {
		const raw = loadRecipeFile(recipeName);
		const plan = buildPlanFromRecipe({ raw, nameFallback: recipeName });
		assert.ok(plan.steps.length > 0, `${recipeName} should have steps`);
		const errors = validatePlanTargets(plan);
		assert.deepEqual(errors, [], `validation errors: ${errors.join("; ")}`);
	});
}
