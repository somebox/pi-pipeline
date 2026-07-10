/**
 * Pipeline Extension
 *
 * Effort-scaled multi-agent pipeline. Cheap models (util) do mechanical work;
 * mid-tier (research) does review/debug/docs; high-tier is reserved for
 * planning, judgment, and acceptance.
 *
 * Two modes:
 *   - implementation (default for code changes): high plans, util does,
 *     research reviews, high accepts. The 5-step standard / 7-step deep
 *     templates below.
 *   - research (default for read-only/extraction): parent writes the spec
 *     itself, util partitions by theme, N research subagents fan out in
 *     parallel, research merges. No high-tier calls in surface/standard.
 *     Saves the plan/accept overhead when there is no implementation to
 *     gate.
 *
 * Three effort levels within each mode:
 *   - surface: 1–2 calls total.
 *   - standard: util → research (or high → util → research → high).
 *   - deep: estimator + parallel drafts + merge + accept loop.
 *
 * Three surfaces:
 *   1. Startup banner via session_start + a persistent status line.
 *   2. `pipeline` tool for the LLM — returns a structured plan that the
 *      parent executes with its existing subagent tool.
 *   3. `/pipeline` slash command for explicit user invocation.
 *
 * Cost display: each step shows its cost class ($ / $$ / $$$) so the user
 * can see what they're about to spend before the parent dispatches.
 * Mapping: util = $ (M3-class), research = $$ (glm-5.2-class), high = $$$
 * (sonnet-5-class). The parent can override per-step via the subagent
 * `[model=...]` syntax.
 *
 * Agent identity lives in `agents/{high,research,util}.md` (discovered by
 * pi-subagents). The tier templates that build plans are inlined here as TS
 * strings — see IMPLEMENTATION_TEMPLATES and RESEARCH_TEMPLATES below.
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
	type PipelineParams,
	type PipelineCostReport,
	type Plan,
	buildPlan,
	summarizeCost,
	renderPlan,
	fallbacksFor,
	renderCostReport,
	renderAuditReport,
	renderStepAudit,
	STATIC_STATUS,
} from "./lib.ts";
import { buildPlanFromRecipe, validatePlanTargets } from "./recipes.ts";
import { discoverRecipes, findProjectPipelineDirs, resolvePackagePipelineDirs, resolvePackageAgentDirs } from "./discovery.ts";
import {
	loadAgentProfileFromDirs,
	dispatchStep,
	dispatchIterate,
	buildManifestStep,
	recordStepResult,
	loadUnits,
	collectCollection,
} from "./dispatcher.ts";
import type { StepResult, StepUsage, AgentProfile, IterateUnit } from "./dispatcher.ts";
import {
	mintRunId,
	createWorkspace,
	writeManifestShell,
	updateManifestStep,
	finalizeManifest,
	cleanupRuns,
	loadArtifactsConfig,
} from "./workspace.ts";
import type { WorkspaceInfo, ManifestStep } from "./workspace.ts";

/* ──────────────────────── discovery helper ────────────────────────
 *
 * Build the discovery options from the live settings.json `packages` field
 * + the standard pi install roots. Used by resolvePlan, /pipeline, and
 * /pipelines so they all see the same recipe set. */
function readConfiguredPackages(settingsDir: string): string[] {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"));
		return Array.isArray(settings?.packages) ? settings.packages.filter((p: unknown) => typeof p === "string") : [];
	} catch {
		return [];
	}
}

function packageRoots(settingsDir: string) {
	return {
		npmRoot: path.join(settingsDir, "npm", "node_modules"),
		gitRoot: path.join(settingsDir, "git"),
	};
}

function discoverAllRecipes(cwd = process.cwd()) {
	const home = os.homedir();
	const settingsDir = path.join(home, ".pi", "agent");
	const packages = readConfiguredPackages(settingsDir);
	const { npmRoot, gitRoot } = packageRoots(settingsDir);
	return discoverRecipes({
		userDir: path.join(settingsDir, "pipelines"),
		projectDirs: findProjectPipelineDirs(cwd),
		// Pass settingsDir so relative paths in settings (`../../src/foo`)
		// resolve against the settings file's directory, not process.cwd().
		// Without this, the TUI's cwd breaks discovery when it differs
		// from the directory the user edited settings.json from.
		packageDirs: resolvePackagePipelineDirs(packages, npmRoot, gitRoot, settingsDir),
	});
}

function discoverAgentDirs(projectDir: string): string[] {
	const home = os.homedir();
	const settingsDir = path.join(home, ".pi", "agent");
	const packages = readConfiguredPackages(settingsDir);
	const { npmRoot, gitRoot } = packageRoots(settingsDir);
	return [
		path.resolve(projectDir, "agents"),
		path.join(settingsDir, "agents"),
		...resolvePackageAgentDirs(packages, npmRoot, gitRoot, settingsDir),
	];
}

/* ──────────────────────── session-scoped state ────────────────────────
 *
 * Workspace + cost state. The dispatcher populates the manifest inline; cost
 * rollup is rebuilt from the dispatcher's `StepResult`s (not sniffed from
 * `subagent` tool events, which were dead code against the installed
 * runtime). */

let currentWorkspace: WorkspaceInfo | undefined;
let lastRunSteps: Array<{ step: ManifestStep; result: StepResult }> = [];
let currentArtifactsConfig = loadArtifactsConfig();

/* ──────────────────────── plan resolution ────────────────────────
 *
 * Resolve a `pipeline` tool invocation to a Plan. If `pipeline` (a recipe
 * name) is given, load it from the discovered recipes; else fall back to the
 * generic built-in inference path (mode/effort). Returns {plan, name?, error?}.
 */
interface ResolvedPlan {
	plan: Plan;
	name?: string;       // recipe name, if a named recipe was used
	error?: string;       // human-readable error when the plan couldn't be built
}

function resolvePlan(input: PipelineParams & { pipeline?: string; inputs?: Record<string, string> }): ResolvedPlan {
	if (input.pipeline) {
		const recipes = discoverAllRecipes();
		const recipe = recipes.find((r) => r.name === input.pipeline);
		if (!recipe) {
			return {
				plan: buildPlan(input), // fall back to generic so the tool still returns something
				error: `No pipeline recipe named "${input.pipeline}" was found. Available: ${recipes.map((r) => r.name).join(", ") || "(none)"}. Falling back to the generic pipeline.`,
			};
		}
		const plan = buildPlanFromRecipe({
			raw: recipe.raw,
			nameFallback: recipe.name,
			inputs: input.inputs,
			hints: input.hints,
		});
		const validation = validatePlanTargets(plan);
		return {
			plan,
			name: recipe.name,
			error: validation.length > 0 ? validation.join("; ") : undefined,
		};
	}
	return { plan: buildPlan(input) }; // generic inference path
}


/* ──────────────────────── tool & command ──────────────────────── */

/* ──────────────────────── helpers ──────────────────────── */

function emptyUsage(): StepUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function lastRunReport(): PipelineCostReport {
	if (lastRunSteps.length === 0) {
		return { steps: [] };
	}
	// Use a minimal plan-shaped object; only step count is used downstream.
	const fakePlan: Plan = {
		effort: "standard",
		mode: "research",
		summary: "",
		steps: lastRunSteps.map((s) => ({
			phase: s.step.phase,
			agent: s.step.agent,
			label: s.step.phase,
			task: s.step.phase,
		} as any)),
	};
	return buildCostReport(fakePlan, undefined, lastRunSteps, false);
}

function buildCostReport(
	plan: Plan,
	name: string | undefined,
	steps: Array<{ step: ManifestStep; result: StepResult }>,
	dryRun: boolean,
): PipelineCostReport {
	const stepEntries = steps.map(({ step, result }, i) => ({
		stepIndex: i + 1,
		mode: result.units ? "parallel" : "single",
		agent: step.agent,
		task: step.phase,
		results: [{
			agent: step.agent,
			model: "(dispatcher)",
			task: step.phase,
			exitCode: result.status === "completed" ? 0 : 1,
			error: result.error,
			usage: {
				input: result.usage.input,
				output: result.usage.output,
				cacheRead: result.usage.cacheRead,
				cacheWrite: result.usage.cacheWrite,
				cost: result.usage.cost,
				turns: result.usage.turns,
			},
			durationMs: result.durationMs,
			toolCount: 0,
			finalOutput: result.text,
			attempts: [],
		}],
	}));
	return {
		planName: name,
		planMode: plan.mode,
		planEffort: plan.effort,
		planStepCount: plan.steps.length,
		planCostShape: summarizeCost(plan),
		dryRun,
		steps: stepEntries,
	};
}

function pipelineDetails(plan: Plan, name: string | undefined, dryRun: boolean) {
	return {
		pipeline: name,
		mode: plan.mode,
		effort: plan.effort,
		stepCount: plan.steps.length,
		agents: plan.steps.reduce(
			(acc, s) => { acc[s.agent] = (acc[s.agent] ?? 0) + 1; return acc; },
			{} as Record<string, number>,
		),
		costShape: summarizeCost(plan),
		dryRun,
	};
}

export default function (pi: ExtensionAPI) {
	// 1. Persistent status indicator + session reset.
pi.on("session_start", (_event, ctx) => {
	lastRunSteps = [];
	currentWorkspace = undefined;
	if (ctx.ui.theme) {
		ctx.ui.setStatus("pipeline", ctx.ui.theme.fg("dim", STATIC_STATUS));
	}
	ctx.ui.notify(
		"Pipeline extension loaded.\n/pipeline <recipe-name> <task> — run a specific recipe (browse with /pipelines).\n/pipeline <task> — generic pipeline, infers mode+effort.\n/pipeline dryrun <task> — show the plan with cost shape, no execution.\n/pipeline-costs — cost breakdown of the last run.\n/pipeline-audit — per-step audit (tasks/errors/tool-calls/artifacts).\nProfiles: dev (kimi-k2.7), util (minimax-m3), research (glm-5.2), high (sonnet-5).",
		"info",
	);
});

// 1b. Model fallback: inject OpenRouter's native `models` array so the
// server falls through on rate-limits/downtime (see DEFAULT_MODEL_FALLBACKS).
pi.on("before_provider_request", (event) => {
	const payload = event.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== "object") return;
	const model = payload["model"];
	if (typeof model !== "string") return;
	const chain = fallbacksFor(model);
	if (!chain || chain.length === 0) return;
	if (Array.isArray(payload["models"]) && payload["models"].length > 0) return;
	return { ...payload, models: chain };
});

// The dead `subagent`/`Agent` event hooks are removed. The pipeline tool
// now owns dispatch (see Stage D); usage comes from the dispatcher, not
// from event sniffing. Status reporting happens inline in `execute`.

// 2. The `pipeline` tool — the LLM-facing surface.
	pi.registerTool({
		name: "pipeline",
		label: "Pipeline",
		description:
			"Build an effort-scaled multi-agent plan and return it as a numbered sequence of subagent calls. Two ways to pick a pipeline: (1) pass `pipeline` with a recipe name to run a specific opinionated process (e.g. 'code-quality', 'verify-source'); (2) omit it to infer a generic pipeline from the task (mode: research/implementation, effort: surface/standard/deep). Recipes are user/project/package-defined markdown files; call with { action: 'list' } is NOT supported — use the /pipelines command to browse them. The plan shows each step's agent (dev/util/research/high) so the user can see what will run. Use dryRun: true to print the plan without dispatching any subagents.",
		parameters: Type.Object({
			pipeline: Type.Optional(
				Type.String({
					description: "Name of a pipeline recipe to run (e.g. 'code-quality', 'verify-source'). Omit to infer a generic pipeline from the task.",
				}),
			),
			task: Type.Optional(
				Type.String({
					description: "The task to perform, in plain language. For a named recipe, the recipe's {{placeholders}} are filled from `inputs`; `task` is only needed for generic (unnamed) pipelines. Defaults to the recipe name when omitted.",
				}),
			),
			inputs: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Named inputs for a recipe's {{placeholders}} (e.g. { scope: 'frontend code' }). Optional — placeholders can also be inferred from the task.",
				}),
			),
			effort: Type.Optional(
				StringEnum(["surface", "standard", "deep"] as const, {
					description:
						"Depth of the pipeline. Omit to infer from the task wording.",
				}),
			),
			mode: Type.Optional(
				StringEnum(["research", "implementation"] as const, {
					description:
						"'research' for read-only/extraction tasks (no high-tier calls in surface/standard). 'implementation' for code changes (high plans and accepts). Omit to infer from the task wording.",
				}),
			),
			hints: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional constraints or context to pass into every step (e.g. 'preserve the public API', 'no new deps').",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description:
						"If true, return the plan with cost shape but do not execute any subagent calls. Useful for the user to see the bill before dispatching.",
				}),
			),
			review: Type.Optional(
				Type.Boolean({
					description:
						"If true, show an interactive confirmation with the rendered plan before executing a named recipe. Cancelling returns the plan without dispatching.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const p = params as PipelineParams & { pipeline?: string; inputs?: Record<string, string>; review?: boolean };
			const wantsReview = p.review === true || (p.hints ?? []).some((h) => /\b(review|confirm|approve|ask)\b/i.test(h));
			const resolved = resolvePlan(p);
			const plan = resolved.plan;
			const effectiveTask = p.task ?? (resolved.name ?? "(unnamed)");
			let text = (resolved.error ? `**Note:** ${resolved.error}\n\n` : "") + renderPlan(plan, effectiveTask, p.dryRun ?? false);

			// Surface available recipes so the LLM (and user) can discover them
			// without running /pipelines separately.
			const availableRecipes = discoverAllRecipes();
			if (availableRecipes.length > 0) {
				text += "\n\n**Available recipes:** " + availableRecipes.map((r) => `\`${r.name}\``).join(", ");
				text += " (run with `pipeline=<name>` to use one)";
			}

			// Reset per-op run state
			lastRunSteps = [];

			// Dry run: return the plan only, no execution, no workspace
			if (p.dryRun || !resolved.name) {
				return {
					content: [{ type: "text" as const, text }],
					details: pipelineDetails(plan, resolved.name, p.dryRun ?? false),
				};
			}

			if (wantsReview) {
				const ok = await ctx.ui.confirm(
					`Run pipeline ${resolved.name}?`,
					`${text}\n\nConfirm to execute ${plan.steps.length} step(s). Press Esc or choose No to cancel before dispatch.`,
					{ signal },
				);
				if (!ok) {
					text += "\n\n**Cancelled:** Review was declined before dispatch; no pipeline steps were executed.";
					return {
						content: [{ type: "text" as const, text }],
						details: pipelineDetails(plan, resolved.name, true),
					};
				}
			}

			// Named, non-dryRun recipe: create workspace, dispatch each step, finalize.
			const projectDir = ctx.cwd || process.cwd();
			cleanupRuns(projectDir, currentArtifactsConfig);
			currentWorkspace = createWorkspace(projectDir, resolved.name, currentArtifactsConfig);
			writeManifestShell(currentWorkspace, resolved.name, projectDir);

			// Pre-populate manifest with pending step shells (so /pipeline-audit
			// shows structure even before the first dispatch lands).
			const manifestStepIds: string[] = [];
			for (const step of plan.steps) {
				const ms = buildManifestStep(step, currentWorkspace);
				manifestStepIds.push(ms.id);
				// Re-use the dispatcher helper for the initial write
				// (it calls updateManifestStep, which overwrites by id).
				updateManifestStep(currentWorkspace, ms);
			}

			// Set up the dispatch context. The SDK is dynamically imported to
			// keep this module importable in test contexts where the SDK is
			// not resolvable.
			let authStorage: any, modelRegistry: any;
			try {
				const sdk = await import("@earendil-works/pi-coding-agent");
				authStorage = (sdk as any).AuthStorage.create();
				modelRegistry = (sdk as any).ModelRegistry.create(authStorage);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				text += `\n\n**Error:** Failed to load pi SDK: ${msg}\n`;
				return { content: [{ type: "text" as const, text }], details: pipelineDetails(plan, resolved.name, false) };
			}

			const agentDirs = discoverAgentDirs(projectDir);

			// Helper: build a cost-tracker-compatible step entry from a result
			const stepEntry = (stepId: string, phase: string, agent: string, task: string, result: StepResult) => {
				const e: any = {
					stepIndex: lastRunSteps.length + 1,
					mode: stepId === phase ? "single" : "single",
					agent,
					task: task.slice(0, 80),
					results: [{
						agent,
						model: "(dispatcher)",
						task,
						exitCode: result.status === "completed" ? 0 : 1,
						error: result.error,
						usage: {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
							cost: result.usage.cost,
							turns: result.usage.turns,
						},
						durationMs: result.durationMs,
						toolCount: 0,
						finalOutput: result.text,
						attempts: [],
					}],
				};
				return e;
			};

			let aborted = false;
			const abortListener = () => {
				aborted = true;
				if (ctx.ui?.setStatus) ctx.ui.setStatus("pipeline", "Pipeline abort requested — waiting for current step to stop…");
			};
			signal.addEventListener("abort", abortListener, { once: true });

			// Dispatch each step in order. Iterate steps read their unit list
			// from the prior step's output; reduce steps read the collection.
			for (let i = 0; i < plan.steps.length; i++) {
				if (signal.aborted || aborted) {
					text += "\n\n**Aborted:** Pipeline execution was interrupted before the next step started.\n";
					break;
				}
				const step = plan.steps[i]!;
				const stepId = manifestStepIds[i]!;

				// Update status to running
				const runningMs = buildManifestStep(step, currentWorkspace);
				runningMs.status = "running";
				updateManifestStep(currentWorkspace, runningMs);
				if (ctx.ui?.setStatus) ctx.ui.setStatus("pipeline", `Step ${i + 1}/${plan.steps.length}: ${step.phase} (${step.agent})…`);

				// Load the agent profile for this step's tier. Search project/user/package
				// agent dirs so package recipes remain self-contained when run from a
				// target repo that has no local `agents/` directory.
				const loaded = loadAgentProfileFromDirs(step.agent, agentDirs);
				if (!loaded) {
					const err = `Agent profile not found: ${step.agent} (searched ${agentDirs.join(", ")})`;
					const failed: StepResult = {
						status: "failed",
						text: "",
						error: err,
						usage: emptyUsage(),
						durationMs: 0,
					};
					recordStepResult(currentWorkspace, stepId, failed, step.outputs?.[0]?.name);
					lastRunSteps.push({ step: runningMs, result: failed });
					text += `\n\n**Error:** ${err}\n`;
					break; // abort the run
				}

				// For iterate steps, load the unit list
				let units: IterateUnit[] | undefined;
				if (step.iterate) {
					units = loadUnits(currentWorkspace, step.iterate, projectDir);
					if (units.length === 0) {
						const expected = path.join(currentWorkspace.targetsDir, `${step.iterate}.json`);
						const err = `Iterate step "${step.phase}" references "${step.iterate}" but no unit list was found. Expected ${expected} to contain either { "items": [...] } or a bare array.`;
						const failed: StepResult = { status: "failed", text: "", error: err, usage: emptyUsage(), durationMs: 0 };
						recordStepResult(currentWorkspace, stepId, failed, step.outputs?.[0]?.name);
						lastRunSteps.push({ step: runningMs, result: failed });
						text += `\n\n**Error:** ${err}\n`;
						break;
					}
				}

				// Dispatch (single or iterate)
				let result: StepResult;
				try {
					const opts = {
						projectDir,
						agentsDir: loaded.agentsDir,
						modelRegistry,
						authStorage,
						abortSignal: signal,
						onProgress: onUpdate ? (txt: string) => onUpdate({ content: [{ type: "text" as const, text: txt }] }) : undefined,
					};
					result = units
						? await dispatchIterate(step, currentWorkspace, loaded.profile, units, opts)
						: await dispatchStep(step, currentWorkspace, loaded.profile, opts);
				if (signal.aborted) aborted = true;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					result = { status: "failed", text: "", error: msg, usage: emptyUsage(), durationMs: 0 };
				}

				// Update manifest with the real result
				recordStepResult(currentWorkspace, stepId, result, step.outputs?.[0]?.name);
				lastRunSteps.push({ step: runningMs, result });

				// Stop the run on first failure (mirrors the old "subsequent steps blocked" behavior)
				if (result.status === "failed") {
					text += `\n\n**Step ${i + 1} failed:** ${result.error ?? "unknown error"}\n`;
					break;
				}
			}

			if (aborted || signal.aborted) {
				// Mark not-yet-started steps as blocked so the manifest reflects an
				// intentional interruption rather than a completed run with pending rows.
				for (const stepId of manifestStepIds) {
					try {
						const manifest = JSON.parse(fs.readFileSync(currentWorkspace.manifestPath, "utf-8"));
						const ms = manifest.steps?.find((s: ManifestStep) => s.id === stepId) as ManifestStep | undefined;
						if (ms && (ms.status === "pending" || ms.status === "running")) {
							ms.status = "blocked";
							updateManifestStep(currentWorkspace, ms);
						}
					} catch { /* best effort */ }
				}
			}
			signal.removeEventListener("abort", abortListener);

			// Finalize the manifest (derives overall status from step statuses)
			try { finalizeManifest(currentWorkspace, aborted || signal.aborted ? "failed" : undefined); } catch { /* best effort */ }
			if (ctx.ui?.setStatus) ctx.ui.setStatus("pipeline", STATIC_STATUS);

			// Build a cost report from the dispatched steps
			const costReport = buildCostReport(plan, resolved.name, lastRunSteps, false);
			text += "\n\n### Execution summary\n";
			text += renderCostReport(costReport).lines.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				details: pipelineDetails(plan, resolved.name, false),
			};
		},
	});

	// 3. Slash command for explicit user invocation.
	pi.registerCommand("pipeline", {
		description:
			"Run a pipeline. Usage: /pipeline <recipe-name> <task>  |  /pipeline [mode] [effort] [dryrun] <task>. Browse recipes with /pipelines.",
		getArgumentCompletions: (prefix) => {
			const fixed = ["research", "implementation", "surface", "standard", "deep", "dryrun"];
			const recipes = discoverAllRecipes().map((r) => r.name);
			const candidates = [...recipes, ...fixed];
			const matches = candidates.filter((c) => c.startsWith(prefix));
			return matches.length > 0
				? matches.map((c) => ({ value: c, label: c }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(
					"Usage:\n  /pipeline <recipe-name> <task>\n  /pipeline <task>  (generic, infers mode+effort)\n  /pipeline [mode] [effort] [dryrun] <task>\nBrowse: /pipelines",
					"warn",
				);
				return;
			}
			// If the first token is a known recipe name, peel it off and tell the
			// LLM to run that specific recipe with the rest as the task.
			const recipes = discoverAllRecipes();
			const firstTok = trimmed.split(/\s+/, 1)[0]!;
			const rest = trimmed.slice(firstTok.length).trim();
			const recipe = recipes.find((r) => r.name === firstTok);
			if (recipe) {
				await pi.sendUserMessage(
					`Use the pipeline tool with pipeline="${recipe.name}" for this task, then execute the returned plan with subagent calls. Do not stop at planning — run the steps. Report the cost shape from the plan when you summarize the result.\n\nTask: ${rest || "(use the recipe defaults)"}`,
				);
				return;
			}
			// Generic path: forward the whole string as the task.
			await pi.sendUserMessage(
				`Use the pipeline tool for this task, then execute the returned plan with subagent calls. Do not stop at planning — run the steps. Report the cost shape from the plan when you summarize the result.\n\nTask: ${trimmed}`,
			);
		},
	});

	// 4. `/pipeline-costs` — breakdown of the last pipeline operation.
	// Shows per-step (agent / model / task / tokens / cost / duration) and a
	// per-model rollup, plus totals. Reads the in-memory report accumulated
	// from subagent tool_result events since the last `pipeline` tool call.
	pi.registerCommand("pipeline-costs", {
		description:
			"Show a cost breakdown of the last pipeline operation by step and model (tokens/cost per model and per pipeline step).",
		handler: async (_args, ctx) => {
			const report = lastRunReport();
			const { title, lines } = renderCostReport(report);
			if (ctx?.ui?.select) {
				await ctx.ui.select(title, lines);
			} else if (ctx?.ui?.notify) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	// 4b. `/pipeline-audit` — per-step audit of the last pipeline operation:
	// the full task each subagent received, resolved model, per-attempt outcomes
	// (with raw errors and a context-overflow flag), tool calls, final output,
	// and artifact paths. Surfaces 429→400 cascades and context-bloat failures.
	pi.registerCommand("pipeline-audit", {
		description:
			"Audit the last pipeline run: per-step task/model/errors/tool-calls/artifacts. Surfaces context-overflow failures.",
		handler: async (_args, ctx) => {
			const report = lastRunReport();
			if (report.steps.length === 0) {
				ctx.ui.notify("No pipeline operation recorded yet.", "warn");
				return;
			}

			// If select TUI isn't available, fall back to simple notification flat-dump.
			if (!ctx.ui.select) {
				const { title, lines } = renderAuditReport(report);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Interactive outer step selector loop.
			while (true) {
				const { title, lines } = renderAuditReport(report);
				const stepOptions = [
					"← Go Back",
					"View Full Flat Audit Report",
					...report.steps.map((s) => `#${s.stepIndex} [${s.agent}] — ${s.task.slice(0, 50).replace(/\r?\n/g, " ").trim()}...`),
				];

				const choice = await ctx.ui.select("Select a step to inspect or copy details:", stepOptions);
				if (!choice || choice === "← Go Back") break;

				if (choice === "View Full Flat Audit Report") {
					await ctx.ui.select(title, lines);
					continue;
				}

				// Resolve the selected step index from choice (e.g. "#2 [dev] ...")
				const match = choice.match(/^#(\d+)\s+\[/);
				if (!match) continue;
				const stepIndex = parseInt(match[1]!, 10);
				const step = report.steps.find((s) => s.stepIndex === stepIndex);
				if (!step) continue;

				// Sub-menu for the selected step: view details or copy files/fields.
				while (true) {
					const { lines: detailLines, paths } = renderStepAudit(step);
					const menuOptions = [
						"← Back to Steps List",
						"View Detailed Text Output",
						...(step.results[0]?.task ? ["Copy: Full Task Prompt"] : []),
						...(step.results[0]?.finalOutput ? ["Copy: Final Text Output"] : []),
						...(paths.input ? ["Copy Path: Input Markdown File"] : []),
						...(paths.output ? ["Copy Path: Output Markdown File"] : []),
						...(paths.session ? ["Copy Path: Session JSONL Log"] : []),
						...(paths.metadata ? ["Copy Path: Metadata JSON Summary"] : []),
					];

					const action = await ctx.ui.select(`Step #${step.stepIndex} Options:`, menuOptions);
					if (!action || action === "← Back to Steps List") break;

					if (action === "View Detailed Text Output") {
						await ctx.ui.select(`Step #${step.stepIndex} Detailed View`, detailLines);
						continue;
					}

					let toCopy: string | undefined;
					let label = "";

					if (action === "Copy: Full Task Prompt") {
						toCopy = step.results[0]?.task;
						label = "Task Prompt";
					} else if (action === "Copy: Final Text Output") {
						toCopy = step.results[0]?.finalOutput;
						label = "Final Output";
					} else if (action === "Copy Path: Input Markdown File") {
						toCopy = paths.input;
						label = "Input Path";
					} else if (action === "Copy Path: Output Markdown File") {
						toCopy = paths.output;
						label = "Output Path";
					} else if (action === "Copy Path: Session JSONL Log") {
						toCopy = paths.session;
						label = "Session Log Path";
					} else if (action === "Copy Path: Metadata JSON Summary") {
						toCopy = paths.metadata;
						label = "Metadata Path";
					}

					if (toCopy !== undefined) {
						const ok = copyToClipboard(toCopy);
						if (ok) {
							ctx.ui.notify(`Copied ${label} to clipboard!`, "info");
						} else {
							ctx.ui.notify(`Failed to write ${label} to clipboard.`, "error");
						}
					}
				}
			}
		},
	});

	// 5. `/pipelines` — list available pipelines (interim text command until
	// the list TUI ships in Phase 3). Lists recipes (user/project/package) plus
	// the built-in generic path.
	pi.registerCommand("pipelines", {
		description:
			"List available pipeline recipes and built-in pipelines.",
		handler: async (_args, ctx) => {
			const recipes = discoverAllRecipes();
			const lines: string[] = [];
			if (recipes.length > 0) {
				lines.push("── Recipes ──");
				for (const r of recipes) {
					const plan = buildPlanFromRecipe({ raw: r.raw, nameFallback: r.name });
					const shape = summarizeCost(plan);
					const src = r.source === "user" ? "~" : r.source === "project" ? "." : "pkg";
					lines.push(`${r.name} [${src}] — ${plan.steps.length} steps · ${shape}${r.description ? ` · ${r.description}` : ""}`);
				}
			} else {
				lines.push("── Recipes ──");
				lines.push("(none yet. Add one to ~/.pi/agent/pipelines/ or .pi/pipelines/)");
			}
			lines.push("");
			lines.push("── Built-in ──");
			lines.push("generic [impl/research × surface/standard/deep] — infer mode+effort from the task (the /pipeline <task> path)");
			lines.push("");
			lines.push("Run a pipeline with: /pipeline <name> <task>  or  /pipeline <task>");
			if (ctx?.ui?.select) {
				await ctx.ui.select("Pipelines", lines);
			} else if (ctx?.ui?.notify) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
