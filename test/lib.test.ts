/**
 * Unit tests for src/lib.ts (pure pipeline logic). No pi imports, no stubs.
 *
 *   node --test --experimental-strip-types test/lib.test.ts
 *
 * Covers the cases called out in the review:
 *  - effort/mode inference precedence
 *  - normalizeModel thinking-suffix anchor (C5)
 *  - cost fallback attribution + per-step↔per-model reconciliation (A2)
 *  - settings readers with a fixture file (D2)
 *  - injectTierModels across single / tasks / chain(+parallel) shapes (the
 *    util-on-glm-5.2 fix)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	inferEffort, inferMode, normalizeModel, fmtTokens, fmtCost,
	summarizeCost, buildPlan, mapResultEntry, rollupByModel, renderCostReport, renderAuditReport,
	loadTierModels, loadModelFallbackOverrides, fallbacksFor, isTierAgent,
	injectTierModels, buildCostStep, newReport,
	toRunMetrics, metricsByModel, metricsTotalCost, metricsTotalDurationMs,
	classifyFailure, isContextOverflow, failureLabel,
	STANDARD_PROFILES, DEFAULT_TIER_MODELS,
	IMPL_TEMPLATES, RESEARCH_TEMPLATES,
} from "../src/lib.ts";

/* ───────────────────────── helpers ───────────────────────── */

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Write a throwaway settings.json fixture and return its path. */
function fixtureSettings(json: object): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
	const f = path.join(dir, "settings.json");
	fs.writeFileSync(f, JSON.stringify(json), "utf8");
	return f;
}

/** A result that fell back: minimax failed ($0.001), glm succeeded ($0.02226261). */
function fallbackResult(): any {
	return {
		agent: "util",
		model: "openrouter/z-ai/glm-5.2:low",
		task: "x".repeat(200),
		exitCode: 0,
		usage: { input: 6937, output: 3120, cacheRead: 35840, cacheWrite: 0, cost: 0.02226261, turns: 4 },
		progressSummary: { toolCount: 7, durationMs: 138277 },
		modelAttempts: [
			{ model: "openrouter/minimax/minimax-m3", success: false, usage: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 } },
			{ model: "openrouter/z-ai/glm-5.2", success: true, usage: { input: 6937, output: 3120, cacheRead: 35840, cacheWrite: 0, cost: 0.02226261, turns: 4 } },
		],
	};
}

/* ───────────────────────── inference ───────────────────────── */

test("inferEffort: deep beats surface", () => {
	assert.equal(inferEffort("deeply summarize the docs"), "deep");
	assert.equal(inferEffort("quickly summarize"), "surface"); // surface keyword
	assert.equal(inferEffort("deep skim"), "deep"); // deep checked first
});

test("inferEffort: defaults to standard", () => {
	assert.equal(inferEffort("extract learnings from the postmortems"), "standard");
});

test("inferMode: implementation verbs win over research when both present", () => {
	assert.equal(inferMode("review and fix the bug"), "implementation");
	assert.equal(inferMode("extract learnings from the postmortem"), "research");
	assert.equal(inferMode("hello world"), "implementation"); // default
});

/* ───────────────────────── formatters ───────────────────────── */

test("normalizeModel: strips openrouter/ prefix and :thinking suffix", () => {
	assert.equal(normalizeModel("openrouter/z-ai/glm-5.2:low"), "z-ai/glm-5.2");
	assert.equal(normalizeModel("minimax/minimax-m3"), "minimax/minimax-m3");
	assert.equal(normalizeModel(undefined), "(unknown)");
	assert.equal(normalizeModel(""), "(unknown)");
});

test("normalizeModel: does NOT strip a non-thinking colon suffix (C5 anchor)", () => {
	// :lowdown must be preserved because it isn't a valid thinking level.
	assert.equal(normalizeModel("openrouter/minimax/minimax-m3:lowdown"), "minimax/minimax-m3:lowdown");
});

test("fmtTokens / fmtCost", () => {
	assert.equal(fmtTokens(5400), "5.4k");
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtCost(1.234), "$1.23");
	assert.equal(fmtCost(0.018), "$0.0180");
	assert.equal(fmtCost(0.0005), "$0.000500");
});

/* ───────────────────────── plans ───────────────────────── */

test("summarizeCost: every template", () => {
	assert.equal(summarizeCost(IMPL_TEMPLATES.surface), "1 util + 1 high");
	assert.equal(summarizeCost(IMPL_TEMPLATES.standard), "2 util + 1 research + 2 high");
	assert.equal(summarizeCost(RESEARCH_TEMPLATES.standard), "1 util + 3 research");
	assert.equal(summarizeCost(RESEARCH_TEMPLATES.surface), "1 util + 1 research");
});

test("buildPlan: selects the right template for all 6 mode×effort combos", () => {
	for (const effort of ["surface", "standard", "deep"] as const) {
		const impl = buildPlan({ task: "x", mode: "implementation", effort });
		assert.equal(impl.mode, "implementation");
		assert.equal(impl.effort, effort);
		assert.equal(impl.steps.length, IMPL_TEMPLATES[effort].steps.length);
		const res = buildPlan({ task: "x", mode: "research", effort });
		assert.equal(res.mode, "research");
		assert.equal(res.effort, effort);
		assert.equal(res.steps.length, RESEARCH_TEMPLATES[effort].steps.length);
	}
});

test("buildPlan: hints are injected into every step as a HINTS block", () => {
	const plan = buildPlan({ task: "x", mode: "research", effort: "standard", hints: ["no new deps", "  ", "keep the API"] });
	for (const s of plan.steps) {
		assert.match(s.task, /^HINTS:\n- no new deps\n- keep the API\n\nTASK: /);
	}
});

test("buildPlan: empty/whitespace hints are dropped (no HINTS block)", () => {
	const plan = buildPlan({ task: "x", mode: "research", effort: "standard", hints: ["   ", ""] });
	for (const s of plan.steps) assert.doesNotMatch(s.task, /^HINTS:/);
});

/* ───────────────────────── cost rollup + reconciliation (A2) ───────────────────────── */

test("mapResultEntry + rollupByModel: fallback attempts charged to the model that served them", () => {
	const r = mapResultEntry(fallbackResult());
	assert.equal(r.attempts.length, 2);
	const byM = rollupByModel({ steps: [{ stepIndex: 1, mode: "single", agent: "util", task: "t", results: [r] }] });
	assert.ok(Math.abs(byM.get("minimax/minimax-m3")!.cost - 0.001) < 1e-9);
	assert.ok(Math.abs(byM.get("z-ai/glm-5.2")!.cost - 0.02226261) < 1e-9);
	assert.equal(byM.get("minimax/minimax-m3")!.calls, 1);
	assert.equal(byM.get("z-ai/glm-5.2")!.calls, 1);
});

test("A2: per-step total reconciles with per-model rollup when a model fell back", () => {
	const report = {
		planMode: "research", planEffort: "standard",
		planCostShape: "1 util + 3 research",
		steps: [{
			stepIndex: 1, mode: "single", agent: "util", task: "t",
			results: [mapResultEntry(fallbackResult())],
		}],
	};
	// Per-model total (the authoritative rollup).
	const perModelTotal = [...rollupByModel(report).values()].reduce((a, t) => a + t.cost, 0);
	// Per-step total computed the same way renderCostReport now does it:
	// sum of attempts when attempts exist, else the result's own usage.
	const perStepTotal = report.steps.reduce((a, step) => a + step.results.reduce((b, r) => {
		const summed = r.attempts.length > 0 ? r.attempts.reduce((c, x) => c + (x.usage?.cost ?? 0), 0) : (r.usage?.cost ?? 0);
		return b + summed;
	}, 0), 0);
	assert.ok(Math.abs(perStepTotal - perModelTotal) < 1e-9, "per-step and per-model totals must match");
	// The rendered Total line agrees with the rollup (within fmtCost's rounding).
	const rendered = renderCostReport(report);
	const renderedTotal = Number((rendered.lines[rendered.lines.length - 1].match(/\$[\d.]+/) || ["$0"])[0].slice(1));
	assert.ok(Math.abs(renderedTotal - perModelTotal) < 1e-4, "rendered Total must match the rollup within fmtCost rounding");
});

test("renderCostReport: empty report has a friendly message", () => {
	const { title, lines } = renderCostReport({ steps: [] });
	assert.match(title, /no pipeline op recorded yet/);
	assert.ok(lines.length > 0);
});

/* ───────────────────────── settings readers (D2) ───────────────────────── */

test("loadTierModels: overrides win, defaults otherwise", () => {
	const f = fixtureSettings({ subagents: { agentOverrides: {
		util: { model: "openrouter/kimi/kimi-k2.7", thinking: "low" },
		high: { model: "openrouter/anthropic/claude-opus-4", thinking: "high" },
	} } });
	const m = loadTierModels(f);
	assert.equal(m.util, "openrouter/kimi/kimi-k2.7");
	assert.equal(m.high, "openrouter/anthropic/claude-opus-4");
	assert.equal(m.research, "openrouter/z-ai/glm-5.2"); // default, not overridden
});

test("loadTierModels: missing file -> defaults, no throw", () => {
	const m = loadTierModels(path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".json"));
	assert.equal(m.util, "openrouter/minimax/minimax-m3");
	assert.equal(m.research, "openrouter/z-ai/glm-5.2");
	assert.equal(m.high, "openrouter/anthropic/claude-sonnet-5");
});

test("loadModelFallbackOverrides + fallbacksFor: override by class", () => {
	const f = fixtureSettings({ pipeline: { modelFallbacks: {
		coding: ["z-ai/glm-5.2", "my-org/custom-coding"],
	} } });
	const o = loadModelFallbackOverrides(f);
	assert.deepEqual(o.coding, ["z-ai/glm-5.2", "my-org/custom-coding"]);
	// fallbacksFor returns the override for a coding-class primary.
	assert.deepEqual(fallbacksFor("z-ai/glm-5.2", f), ["z-ai/glm-5.2", "my-org/custom-coding"]);
	// Unknown primary -> undefined (no chain injected).
	assert.equal(fallbacksFor("some/unknown-model", f), undefined);
	// Default class (utility) unaffected by the coding-only override.
	assert.deepEqual(fallbacksFor("minimax/minimax-m3", f), ["minimax/minimax-m3", "moonshotai/kimi-k2.7-code"]);
});

test("loadModelFallbackOverrides: memoized per filePath", () => {
	const f = fixtureSettings({ pipeline: { modelFallbacks: { utility: ["a/b"] } } });
	const a = loadModelFallbackOverrides(f);
	const b = loadModelFallbackOverrides(f);
	assert.equal(a, b, "same object reference (cached)");
});

/* ───────────────────────── injectTierModels (the glm-5.2 fix) ───────────────────────── */

const TM = {
	util: "openrouter/minimax/minimax-m3",
	research: "openrouter/z-ai/glm-5.2",
	high: "openrouter/anthropic/claude-sonnet-5",
};

test("injectTierModels: single shape injects util model", () => {
	const input: any = { agent: "util", task: "t" };
	injectTierModels(input, TM);
	assert.equal(input.model, "openrouter/minimax/minimax-m3");
});

test("injectTierModels: explicit model is not overwritten", () => {
	const input: any = { agent: "util", task: "t", model: "manual/override" };
	injectTierModels(input, TM);
	assert.equal(input.model, "manual/override");
});

test("injectTierModels: tasks[] (parallel) shape", () => {
	const input: any = { tasks: [{ agent: "util", task: "a" }, { agent: "research", task: "b" }] };
	injectTierModels(input, TM);
	assert.equal(input.tasks[0].model, "openrouter/minimax/minimax-m3");
	assert.equal(input.tasks[1].model, "openrouter/z-ai/glm-5.2");
});

test("injectTierModels: chain shape with a parallel fanout group", () => {
	const input: any = { chain: [
		{ agent: "research", task: "step" },
		{ parallel: [{ agent: "high", task: "p1" }, { agent: "util", task: "p2" }] },
	] };
	injectTierModels(input, TM);
	assert.equal(input.chain[0].model, "openrouter/z-ai/glm-5.2");
	assert.equal(input.chain[1].parallel[0].model, "openrouter/anthropic/claude-sonnet-5");
	assert.equal(input.chain[1].parallel[1].model, "openrouter/minimax/minimax-m3");
});

test("injectTierModels: non-tier agents are untouched", () => {
	const input: any = { agent: "worker", task: "t" };
	injectTierModels(input, TM);
	assert.equal(input.model, undefined);
});

test("isTierAgent", () => {
	assert.equal(isTierAgent("util"), true);
	assert.equal(isTierAgent("research"), true);
	assert.equal(isTierAgent("high"), true);
	assert.equal(isTierAgent("dev"), true);          // new fourth profile
	assert.equal(isTierAgent("worker"), false);
	assert.equal(isTierAgent(undefined), false);
});

/* ───────────────────────── profiles (dev is standard) ───────────────────────── */

test("STANDARD_PROFILES includes dev as the fourth profile", () => {
	assert.deepEqual([...STANDARD_PROFILES], ["dev", "util", "research", "high"]);
});

test("DEFAULT_TIER_MODELS binds every standard profile", () => {
	for (const p of STANDARD_PROFILES) {
		assert.ok(DEFAULT_TIER_MODELS[p], `missing default model for ${p}`);
	}
});

test("injectTierModels: dev profile gets its model injected", () => {
	const input: any = { agent: "dev", task: "t" };
	injectTierModels(input, DEFAULT_TIER_MODELS);
	assert.equal(input.model, "openrouter/moonshotai/kimi-k2.7-code");
});

test("PlanStep no longer has tier/costClass fields", () => {
	const plan = buildPlan({ task: "x", mode: "implementation", effort: "surface" });
	for (const s of plan.steps) {
		assert.equal("tier" in s, false, `step ${s.phase} should not have tier`);
		assert.equal("costClass" in s, false, `step ${s.phase} should not have costClass`);
		assert.ok(typeof s.agent === "string" && s.agent.length > 0);
	}
});

/* ───────────────────────── buildCostStep / newReport ───────────────────────── */

test("buildCostStep: single shape", () => {
	const step = buildCostStep(
		{ agent: "util", task: "do work here" },
		{ mode: "single", results: [{ agent: "util", model: "x", task: "do work here", exitCode: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } }] },
		3,
	);
	assert.equal(step.stepIndex, 3);
	assert.equal(step.mode, "single");
	assert.equal(step.agent, "util");
	assert.equal(step.results.length, 1);
});

test("buildCostStep: parallel shape summarizes N tasks", () => {
	const step = buildCostStep(
		{ tasks: [{ agent: "high", task: "accept" }, { agent: "research", task: "merge" }] },
		{ mode: "parallel", results: [
			{ agent: "high", model: "h", task: "accept", exitCode: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 } },
			{ agent: "research", model: "r", task: "merge", exitCode: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } },
		] },
		1,
	);
	assert.equal(step.mode, "parallel");
	assert.equal(step.agent, "high,research");
	assert.match(step.task, /^2 tasks · /);
});

test("buildCostStep: empty results -> null", () => {
	assert.equal(buildCostStep({ agent: "util", task: "t" }, { mode: "single", results: [] }, 1), null);
	assert.equal(buildCostStep({ agent: "util", task: "t" }, {}, 1), null);
});

test("newReport: seeds plan metadata with empty steps", () => {
	const plan = buildPlan({ task: "x", mode: "implementation", effort: "surface" });
	const rep = newReport(plan, false);
	assert.equal(rep.planMode, "implementation");
	assert.equal(rep.planEffort, "surface");
	assert.equal(rep.planStepCount, plan.steps.length);
	assert.equal(rep.dryRun, false);
	assert.deepEqual(rep.steps, []);
});

test("newReport: dryRun flag propagated", () => {
	const plan = buildPlan({ task: "x", mode: "research", effort: "deep" });
	assert.equal(newReport(plan, true).dryRun, true);
});

/* ───────────────────────── RunMetrics (single source of truth) ───────────────────────── */

test("toRunMetrics: snapshots a report with plan metadata + per-step duration", () => {
	const plan = buildPlan({ task: "x", mode: "implementation", effort: "surface" });
	const report = newReport(plan, false);
	// Simulate one accumulated step with a result that has durationMs.
	const step = buildCostStep(
		{ agent: "util", task: "do work" },
		{ mode: "single", results: [{ agent: "util", model: "minimax/minimax-m3", task: "do work", exitCode: 0, usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 }, progressSummary: { toolCount: 3, durationMs: 5000 } }] },
		1,
	);
	if (step) report.steps.push(step);
	const metrics = toRunMetrics(report, 1000, 2000, "my-recipe");
	assert.equal(metrics.planName, "my-recipe");
	assert.equal(metrics.dryRun, false);
	assert.equal(metrics.startedAt, 1000);
	assert.equal(metrics.endedAt, 2000);
	assert.equal(metrics.steps.length, 1);
	assert.equal(metrics.steps[0].durationMs, 5000);
	assert.equal(metrics.steps[0].agent, "util");
});

test("metricsByModel + metricsTotalCost: fallback attempts charged correctly", () => {
	const report = newReport(buildPlan({ task: "x", mode: "research", effort: "standard" }), false);
	const step = buildCostStep(
		{ agent: "util", task: "t" },
		{ mode: "single", results: [fallbackResult()] },
		1,
	);
	if (step) report.steps.push(step);
	const metrics = toRunMetrics(report, 0);
	const byM = metricsByModel(metrics);
	assert.ok(Math.abs(byM.get("minimax/minimax-m3")!.cost - 0.001) < 1e-9);
	assert.ok(Math.abs(byM.get("z-ai/glm-5.2")!.cost - 0.02226261) < 1e-9);
	// total = 0.001 + 0.02226261
	assert.ok(Math.abs(metricsTotalCost(metrics) - 0.02326261) < 1e-9);
});

test("metricsTotalDurationMs: sums per-step durations", () => {
	const report = newReport(buildPlan({ task: "x", mode: "research", effort: "surface" }), false);
	for (let i = 0; i < 2; i++) {
		const step = buildCostStep(
			{ agent: "util", task: `t${i}` },
			{ mode: "single", results: [{ agent: "util", model: "m", task: `t${i}`, exitCode: 0, progressSummary: { toolCount: 1, durationMs: 3000 + i * 1000 } }] },
			i + 1,
		);
		if (step) report.steps.push(step);
	}
	const metrics = toRunMetrics(report, 0);
	assert.equal(metricsTotalDurationMs(metrics), 7000); // 3000 + 4000
});

test("metricsByModel: empty run yields empty map, zero totals", () => {
	const report = newReport(buildPlan({ task: "x", mode: "research", effort: "surface" }), false);
	const metrics = toRunMetrics(report, 0);
	assert.equal(metricsByModel(metrics).size, 0);
	assert.equal(metricsTotalCost(metrics), 0);
	assert.equal(metricsTotalDurationMs(metrics), 0);
});

/* ───────────────────────── error classification ───────────────────────── */

test("classifyFailure: context-overflow from the real 400 message", () => {
	const err = '400: {"message":"This endpoint\'s maximum context length is 524288 tokens. However, you requested about 524458 tokens..."}';
	assert.equal(classifyFailure(err), "context-overflow");
	assert.equal(isContextOverflow(err), true);
	assert.equal(failureLabel(err), "context-overflow");
});

test("classifyFailure: rate-limit from the real 429/Parasail message", () => {
	const err = "Provider returned error. minimax/minimax-m3 is temporarily rate-limited upstream. 429";
	assert.equal(classifyFailure(err), "rate-limit");
	assert.equal(isContextOverflow(err), false);
});

test("classifyFailure: auth, timeout, model-unavailable, unknown", () => {
	assert.equal(classifyFailure("401 Unauthorized: invalid api key"), "auth");
	assert.equal(classifyFailure("403 Forbidden"), "auth");
	assert.equal(classifyFailure("Request timed out after 60s"), "timeout");
	assert.equal(classifyFailure("model minimax-m3 not found"), "model-unavailable");
	assert.equal(classifyFailure("something weird happened"), "unknown");
});

test("classifyFailure: undefined/empty -> unknown", () => {
	assert.equal(classifyFailure(undefined), "unknown");
	assert.equal(classifyFailure(null), "unknown");
	assert.equal(classifyFailure(""), "unknown");
});

/* ───────────────────────── audit capture (mapResultEntry) ───────────────────────── */

test("mapResultEntry: captures error, attempts[].error, full task, finalOutput, toolCalls, sessionFile, artifactPaths", () => {
	const r = {
		agent: "util", model: "openrouter/minimax/minimax-m3:low", task: "x".repeat(200), exitCode: 1,
		error: "400: maximum context length is 524288 tokens",
		usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		progressSummary: { toolCount: 2, durationMs: 5000 },
		finalOutput: "partial output here",
		toolCalls: [{ text: "read spec.md", expandedText: "read spec.md offset=1 limit=100" }],
		sessionFile: "/path/to/session.jsonl",
		artifactPaths: { inputPath: "/a/in.md", outputPath: "/a/out.md", jsonlPath: "/a/s.jsonl", metadataPath: "/a/m.json" },
		modelAttempts: [
			{ model: "openrouter/minimax/minimax-m3", success: false, exitCode: 1, error: "429 rate-limited", usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 } },
			{ model: "openrouter/kimi/kimi-k2.7", success: false, exitCode: 1, error: "400: maximum context length", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } },
		],
	};
	const e = mapResultEntry(r);
	assert.equal(e.exitCode, 1);
	assert.equal(e.error, "400: maximum context length is 524288 tokens");
	assert.equal(e.task.length, 200, "task should be FULL, not snippeted");
	assert.equal(e.finalOutput, "partial output here");
	assert.equal(e.sessionFile, "/path/to/session.jsonl");
	assert.deepEqual(e.artifactPaths, { inputPath: "/a/in.md", outputPath: "/a/out.md", jsonlPath: "/a/s.jsonl", metadataPath: "/a/m.json" });
	assert.equal(e.toolCalls?.length, 1);
	assert.equal(e.toolCalls?.[0].text, "read spec.md");
	assert.equal(e.attempts.length, 2);
	assert.equal(e.attempts[0].success, false);
	assert.equal(e.attempts[0].error, "429 rate-limited");
	assert.equal(e.attempts[0].exitCode, 1);
	assert.equal(e.attempts[1].error, "400: maximum context length");
});

test("mapResultEntry: missing audit fields are undefined, not crashes", () => {
	const e = mapResultEntry({ agent: "util", model: "m", task: "t", exitCode: 0 });
	assert.equal(e.error, undefined);
	assert.equal(e.finalOutput, undefined);
	assert.equal(e.toolCalls, undefined);
	assert.equal(e.sessionFile, undefined);
	assert.equal(e.artifactPaths, undefined);
	assert.deepEqual(e.attempts, []);
});

test("mapResultEntry: a context-overflow step is classifiable from the captured error", () => {
	const e = mapResultEntry({ agent: "util", model: "m", task: "t", exitCode: 1, error: "400: maximum context length is 524288 tokens" });
	assert.equal(isContextOverflow(e.error), true);
	assert.equal(isContextOverflow(e.attempts[0]?.error), false);  // no attempts
});

/* ───────────────────────── renderAuditReport ───────────────────────── */

test("renderAuditReport: empty report has a friendly message", () => {
	const { title, lines } = renderAuditReport({ steps: [] });
	assert.match(title, /no pipeline op recorded yet/);
	assert.ok(lines.length > 0);
});

test("renderAuditReport: surfaces a 429→400 context-overflow cascade", () => {
	const report = {
		planName: "code-quality",
		steps: [{
			stepIndex: 1, mode: "single", agent: "util", task: "Review code for issues",
			results: [{
				agent: "util", model: "minimax/minimax-m3", task: "Review code for issues", exitCode: 1,
				error: "400: maximum context length is 524288 tokens",
				usage: { input: 524458, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 },
				progressSummary: { toolCount: 0, durationMs: 2000 },
				finalOutput: undefined,
				toolCalls: [{ text: "read bigfile.ts" }],
				artifactPaths: { inputPath: "/a/in.md", outputPath: "/a/out.md", jsonlPath: "/a/s.jsonl", metadataPath: "/a/m.json" },
				attempts: [
					{ model: "minimax/minimax-m3", success: false, exitCode: 1, error: "429 rate-limited upstream" },
					{ model: "kimi/kimi-k2.7", success: false, exitCode: 1, error: "400: maximum context length is 524288 tokens" },
				],
			}],
		}],
	};
	const { title, lines } = renderAuditReport(report);
	const joined = lines.join("\n");
	// Failed step marker
	assert.ok(joined.includes("✗ #1"), "failed step should be marked ✗");
	// The cascade: attempt 1 rate-limit, attempt 2 context-overflow with the ⚠ flag
	assert.ok(joined.includes("rate-limit"), "first attempt classified as rate-limit");
	assert.ok(joined.includes("context-overflow"), "second attempt classified as context-overflow");
	assert.ok(joined.includes("⚠ context overflow"), "context-overflow flag rendered");
	assert.ok(joined.includes("fell back to"), "fallback noted");
	// Summary counts
	assert.match(title, /1 failed/);
	assert.ok(joined.includes("1 of 1 step(s) failed"), "summary line");
	assert.ok(joined.includes("context overflow(s)"), "overflow count in summary");
	// Artifacts mentioned
	assert.ok(joined.includes("artifacts:"), "artifact paths listed");
});

test("renderAuditReport: successful step shows ✓ and no error block", () => {
	const report = {
		steps: [{
			stepIndex: 1, mode: "single", agent: "dev", task: "do work",
			results: [{
				agent: "dev", model: "kimi/kimi-k2.7", task: "do work", exitCode: 0,
				usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
				progressSummary: { toolCount: 3, durationMs: 10000 },
				finalOutput: "done",
				attempts: [{ model: "kimi/kimi-k2.7", success: true, exitCode: 0 }],
			}],
		}],
	};
	const { lines } = renderAuditReport(report);
	const joined = lines.join("\n");
	assert.ok(joined.includes("✓ #1"), "successful step marked ✓");
	assert.ok(!joined.includes("error:"), "no error block for a successful step");
	assert.ok(joined.includes("0 of 1 step(s) failed"), "summary shows 0 failed");
});
