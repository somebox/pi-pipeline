/**
 * Unit tests for src/recipes.ts (recipe parser). No pi imports, no fs, no stubs.
 *
 *   node --test --experimental-strip-types test/recipes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseFrontmatter, parseStepHeaderTail, inferOutput, inferReads,
	substituteInputs, parseSteps, buildPlanFromRecipe, declaredInputs,
	usedPlaceholders,
} from "../src/recipes.ts";

/* ───────────────────────── frontmatter ───────────────────────── */

test("parseFrontmatter: name + description + inputs list", () => {
	const raw = `---
name: code-quality
description: Audit code & tests, produce an action plan.
inputs:
  - scope
  - diff-ref
---

# code-quality

## 1. First  (util)
do the thing`;
	const { frontmatter, body } = parseFrontmatter(raw);
	assert.equal(frontmatter.name, "code-quality");
	assert.equal(frontmatter.description, "Audit code & tests, produce an action plan.");
	assert.deepEqual(frontmatter.inputs, ["scope", "diff-ref"]);
	assert.ok(body.startsWith("# code-quality"));
});

test("parseFrontmatter: quoted strings, comments, no frontmatter", () => {
	const { frontmatter: fm1 } = parseFrontmatter(`---
name: "quoted name"
# a comment
description: 'single quoted'
---
body`);
	assert.equal(fm1.name, "quoted name");
	assert.equal(fm1.description, "single quoted");
	const { frontmatter: fm2 } = parseFrontmatter("# just a title\n\n## 1. x (util)\nt");
	assert.deepEqual(fm2, {});
});

/* ───────────────────────── step header tail ───────────────────────── */

test("parseStepHeaderTail: agent only", () => {
	assert.deepEqual(parseStepHeaderTail("(util)"), { agent: "util", parallel: false, reads: [], output: undefined, maxTools: undefined, iterate: undefined, tools: undefined });
});

test("parseStepHeaderTail: agent + parallel + flags", () => {
	assert.deepEqual(parseStepHeaderTail("(dev, parallel, reads=a.md,b.md, output=c.md)"), {
		agent: "dev", parallel: true, reads: ["a.md", "b.md"], output: "c.md", maxTools: undefined, iterate: undefined, tools: undefined,
	});
});

test("parseStepHeaderTail: custom agent name", () => {
	assert.deepEqual(parseStepHeaderTail("(my-custom-agent)"), {
		agent: "my-custom-agent", parallel: false, reads: [], output: undefined, maxTools: undefined, iterate: undefined, tools: undefined,
	});
});

test("parseStepHeaderTail: no parens -> null", () => {
	assert.equal(parseStepHeaderTail("no parens here"), null);
});

/* ───────────────────────── prose inference ───────────────────────── */

test("inferOutput: Write `x.md`", () => {
	assert.equal(inferOutput("Read standards.md. Write `findings.md` with the patterns."), "findings.md");
});

test("inferOutput: bare filename", () => {
	assert.equal(inferOutput("Write findings.md summarizing the patterns."), "findings.md");
});

test("inferOutput: no write verb -> undefined", () => {
	assert.equal(inferOutput("List the issues with file:line references."), undefined);
});

test("inferReads: Read `x.md` and every `*-issues-*.md`", () => {
	const reads = inferReads("Read `standards.md` and every `*-issues-*.md` produced by the extracts.");
	assert.deepEqual(reads, ["standards.md", "*-issues-*.md"]);
});

test("inferReads: no read verb -> empty", () => {
	assert.deepEqual(inferReads("Summarize the findings."), []);
});

/* ───────────────────────── placeholders ───────────────────────── */

test("substituteInputs: replaces declared, leaves missing", () => {
	assert.equal(substituteInputs("scan {{target}} and {{scope}}", { target: "/docs" }), "scan /docs and {{scope}}");
});

test("substituteInputs: no inputs -> unchanged", () => {
	assert.equal(substituteInputs("scan {{target}}"), "scan {{target}}");
});

test("usedPlaceholders: collects all {{names}}", () => {
	assert.deepEqual(usedPlaceholders("scan {{target}} and {{scope}} and {{target}}").sort(), ["scope", "target"]);
});

test("declaredInputs: from frontmatter", () => {
	assert.deepEqual(declaredInputs("---\ninputs:\n  - a\n  - b\n---\n# x"), ["a", "b"]);
});

/* ───────────────────────── step parsing ───────────────────────── */

test("parseSteps: collects phase/agent/task across multiple steps", () => {
	const body = `# title

## 1. First  (util)
Do the first thing. Write \`a.md\`.

## 2. Second  (dev, parallel)
Read \`a.md\`. For your area, find issues. Write \`b-<area>.md\`.
`;
	const steps = parseSteps(body);
	assert.equal(steps.length, 2);
	assert.equal(steps[0].header.phase, "First");
	assert.equal(steps[0].header.agent, "util");
	assert.equal(steps[1].header.agent, "dev");
	assert.equal(steps[1].header.parallel, true);
	assert.match(steps[1].task, /^Read `a.md`/);
});

test("parseSteps: step with no paren tail defaults to util", () => {
	const steps = parseSteps("# t\n\n## 1. x\ntask text");
	assert.equal(steps[0].header.agent, "util");
	assert.equal(steps[0].header.parallel, false);
});

/* ───────────────────────── full plan build (code-quality excerpt) ───────────────────────── */

const CODE_QUALITY_EXCERPT = `---
name: code-quality
description: Audit code & tests in a scope, produce an action plan.
inputs:
  - scope
---

# code-quality

**Inputs:** \`scope\` — what's in scope.

## 1. Standards & scope  (util)
Identify what code/docs/tests are in scope for this task (\`{{scope}}\`).
Assemble the documentation and best practices for this repo. Write \`standards.md\`.

## 2. Review code  (dev, parallel)
Read \`standards.md\`. For your assigned code area, look for issues. Write \`code-issues-<area>.md\`.

## 3. Merge findings  (research)
Read \`standards.md\` and every \`*-issues-*.md\`. Cross-check patterns. Write \`findings.md\`.

## 4. Present to user  (high)
Summarize \`findings.md\` for the user.
`;

test("buildPlanFromRecipe: code-quality excerpt produces a correct Plan", () => {
	const plan = buildPlanFromRecipe({
		raw: CODE_QUALITY_EXCERPT,
		nameFallback: "code-quality",
		inputs: { scope: "frontend code" },
	});
	assert.equal(plan.summary, "Audit code & tests in a scope, produce an action plan.");
	assert.equal(plan.steps.length, 4);
	// Step 1: util, {{scope}} substituted, output inferred
	assert.equal(plan.steps[0].agent, "util");
	assert.match(plan.steps[0].task, /`frontend code`/);
	assert.equal(plan.steps[0].output, "standards.md");
	// Step 2: dev, parallel, reads inferred, output inferred
	assert.equal(plan.steps[1].agent, "dev");
	assert.equal(plan.steps[1].parallel, 1);
	assert.deepEqual(plan.steps[1].reads, ["standards.md"]);
	assert.equal(plan.steps[1].output, "code-issues-<area>.md");
	// Step 3: research, two reads inferred
	assert.equal(plan.steps[2].agent, "research");
	assert.deepEqual(plan.steps[2].reads, ["standards.md", "*-issues-*.md"]);
	assert.equal(plan.steps[2].output, "findings.md");
	// Step 4: high, output undefined (no write verb), reads inferred
	assert.equal(plan.steps[3].agent, "high");
	assert.equal(plan.steps[3].output, undefined);
	assert.deepEqual(plan.steps[3].reads, ["findings.md"]);
});

test("buildPlanFromRecipe: explicit flags override prose inference", () => {
	const raw = `---
name: x
---

# x

## 1. Do  (util, reads=explicit.md, output=out.md)
Read \`wrong.md\`. Write \`also-wrong.md\`.
`;
	const plan = buildPlanFromRecipe({ raw, nameFallback: "x" });
	assert.equal(plan.steps[0].output, "out.md");      // flag wins
	assert.deepEqual(plan.steps[0].reads, ["explicit.md"]); // flag wins
});

test("buildPlanFromRecipe: hints prepended to every step", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. a (util)\ntask text",
		nameFallback: "x",
		hints: ["no new deps", "keep the API"],
	});
	assert.match(plan.steps[0].task, /^HINTS:\n- no new deps\n- keep the API\n\nTASK: task text/);
});

test("buildPlanFromRecipe: missing input left as {{name}}", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\ninputs:\n  - scope\n---\n# x\n\n## 1. a (util)\nscan {{scope}}",
		nameFallback: "x",
		// no inputs provided
	});
	assert.match(plan.steps[0].task, /\{\{scope\}\}/);
});

/* ───────────────────────── maxTools budget ───────────────────────── */

test("parseStepHeaderTail: parses maxTools=N", () => {
	assert.deepEqual(parseStepHeaderTail("(util, maxTools=5)"), {
		agent: "util", parallel: false, reads: [], output: undefined, maxTools: 5, iterate: undefined, tools: undefined,
	});
	assert.deepEqual(parseStepHeaderTail("(util, parallel, reads=a.md, maxTools=10, output=b.md)"), {
		agent: "util", parallel: true, reads: ["a.md"], output: "b.md", maxTools: 10, iterate: undefined, tools: undefined,
	});
});

test("parseStepHeaderTail: invalid maxTools is ignored (not a positive integer)", () => {
	assert.equal(parseStepHeaderTail("(util, maxTools=0)")!.maxTools, undefined);
	assert.equal(parseStepHeaderTail("(util, maxTools=abc)")!.maxTools, undefined);
});

test("buildPlanFromRecipe: maxTools flows through to PlanStep", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (util, maxTools=3)\nread files and write out.md",
		nameFallback: "x",
	});
	assert.equal(plan.steps[0].maxTools, 3);
});

test("buildPlanFromRecipe: budget instruction injected into task when maxTools set", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (util, maxTools=5)\nread files and write out.md",
		nameFallback: "x",
	});
	assert.match(plan.steps[0].task, /TOOL BUDGET: You may make at most 5 tool calls total/);
	assert.match(plan.steps[0].task, /Do not exceed 5 calls/);
});

test("buildPlanFromRecipe: no maxTools means no budget instruction", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (util)\nread files and write out.md",
		nameFallback: "x",
	});
	assert.doesNotMatch(plan.steps[0].task, /TOOL BUDGET/);
	assert.equal(plan.steps[0].maxTools, undefined);
});

test("buildPlanFromRecipe: budget composes with hints (hints then budget)", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (util, maxTools=4)\nread files and write out.md",
		nameFallback: "x",
		hints: ["no new deps"],
	});
	const t = plan.steps[0].task;
	assert.match(t, /^HINTS:\n- no new deps\n\n/);
	assert.match(t, /TOOL BUDGET:.*at most 4 tool calls/);
});

/* ───────────────────────── iterate + tools (Phase 2) ───────────────────────── */

test("parseStepHeaderTail: parses iterate=name and tools=a,b", () => {
	assert.deepEqual(parseStepHeaderTail("(dev, iterate=scope-files, tools=read,write)"), {
		agent: "dev", parallel: false, reads: [], output: undefined, maxTools: undefined,
		iterate: "scope-files", tools: ["read", "write"],
	});
});

test("buildPlanFromRecipe: iterate and tools flow through to PlanStep", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (dev, iterate=scope-files, tools=read,write)\nread files and write out.md",
		nameFallback: "x",
	});
	assert.equal(plan.steps[0].iterate, "scope-files");
	assert.deepEqual(plan.steps[0].tools, ["read", "write"]);
});

test("buildPlanFromRecipe: infers iterate from prose", () => {
	const plan = buildPlanFromRecipe({
		raw: "---\nname: x\n---\n# x\n\n## 1. Do (dev)\nFor each `{unit}` in scope-files, read `{unit.path}` and summarize.",
		nameFallback: "x",
	});
	assert.equal(plan.steps[0].iterate, "scope-files");
});

