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
import path from "node:path";
import {
	type PipelineParams,
	type PipelineCostReport,
	type Plan,
	buildPlan,
	summarizeCost,
	renderPlan,
	loadTierModels,
	injectTierModels,
	fallbacksFor,
	newReport,
	buildCostStep,
	renderProgressStatus,
	renderCostReport,
	STATIC_STATUS,
} from "./lib.ts";
import { buildPlanFromRecipe } from "./recipes.ts";
import { discoverRecipes, findProjectPipelineDirs } from "./discovery.ts";

/* ──────────────────────── cost state (session-scoped) ────────────────────────
 *
 * Per-dispatch subagent cost accumulated from `tool_result` events so
 * `/pipeline-costs` can render a breakdown. Reset on `pipeline` tool call
 * (new op) and on `session_start` (no leak across sessions in one process).
 * Lives here in the wiring module, not the pure lib, because it is mutable. */

let currentReport: PipelineCostReport = { steps: [] };
let dispatchCounter = 0;
let lastReport: PipelineCostReport = { steps: [] };
let currentPlanName: string | undefined;   // recipe name for the active run (undefined = generic path)

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
		const recipes = discoverRecipes({
			userDir: path.join(os.homedir(), ".pi", "agent", "pipelines"),
			projectDirs: findProjectPipelineDirs(process.cwd()),
		});
		const recipe = recipes.find((r) => r.name === input.pipeline);
		if (!recipe) {
			return {
				plan: buildPlan(input), // fall back to generic so the tool still returns something
				error: `No pipeline recipe named "${input.pipeline}" was found. Available: ${recipes.map((r) => r.name).join(", ") || "(none)"}. Falling back to the generic pipeline.`,
			};
		}
		return {
				plan: buildPlanFromRecipe({
					raw: recipe.raw,
					nameFallback: recipe.name,
					inputs: input.inputs,
					hints: input.hints,
				}),
				name: recipe.name,
			};
	}
	return { plan: buildPlan(input) }; // generic inference path
}


/* ──────────────────────── tool & command ──────────────────────── */

export default function (pi: ExtensionAPI) {
	// 1. Persistent status indicator (visible at the top of every turn).
	pi.on("session_start", (_event, ctx) => {
		// No leak across sessions in a long-lived process: reset cost state.
		currentReport = { steps: [] };
		dispatchCounter = 0;
		lastReport = { steps: [] };
		if (ctx.ui.theme) {
			ctx.ui.setStatus("pipeline", ctx.ui.theme.fg("dim", STATIC_STATUS));
		}
		ctx.ui.notify(
			"Pipeline extension loaded.\n/pipeline <recipe-name> <task> — run a specific recipe (browse with /pipelines).\n/pipeline <task> — generic pipeline, infers mode+effort.\n/pipeline dryrun <task> — show the plan with cost shape, no execution.\n/pipeline-costs — breakdown of the last pipeline op by step and model.\nProfiles: dev (kimi-k2.7), util (minimax-m3), research (glm-5.2), high (sonnet-5).",
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
		// Only inject when a fallback chain is known for this primary. If the
		// caller already set `models` (e.g. a manual override), leave it alone.
		const chain = fallbacksFor(model);
		if (!chain || chain.length === 0) return;
		if (Array.isArray(payload["models"]) && payload["models"].length > 0) return;
		return { ...payload, models: chain };
	});

	// 1c. Pin tier models + reset cost tracking + live progress status.
	//
	// On every `pipeline` tool call we reset the cost report (a new pipeline
	// operation is starting) and remember the plan metadata. On every
	// `subagent` tool call we inject the configured tier model for the
	// util/research/high agents (so the right model is used even if the
	// parent process hasn't reloaded agentOverrides — see loadTierModels),
	// bump the dispatch counter, and seed the status line.
	pi.on("tool_call", (event: any, _ctx: any) => {
		if (event.toolName === "pipeline") {
			const input = event.input ?? {};
			const resolved = resolvePlan(input as PipelineParams & { pipeline?: string });
			currentReport = newReport(resolved.plan, input.dryRun === true, resolved.name);
			currentPlanName = resolved.name;
			dispatchCounter = 0;
			return;
		}
		if (event.toolName !== "subagent") return;
		const input = (event.input ?? {}) as Record<string, any>;
		// Inject the configured tier model for util/research/high when the caller
		// didn't set one (defends against stale agentOverrides — see lib.ts).
		injectTierModels(input, loadTierModels());
	});

	// 1d. Live progress: reflect the subagent's current task/tool/path/tokens
	// in the status line as it works. `tool_execution_update` carries the
	// partial result the subagent tool emits via onUpdate.
	pi.on("tool_execution_update", (event: any, ctx: any) => {
		if (event.toolName !== "subagent") return;
		const pr = event.partialResult as { details?: any } | undefined;
		const progress = pr?.details?.progress;
		if (!Array.isArray(progress)) return;
		const line = renderProgressStatus(progress);
		if (ctx?.ui?.setStatus) ctx.ui.setStatus("pipeline", line);
	});

	// 1e. Restore the static status line when a subagent dispatch finishes.
	pi.on("tool_execution_end", (event: any, ctx: any) => {
		if (event.toolName !== "subagent") return;
		if (ctx?.ui?.setStatus) ctx.ui.setStatus("pipeline", STATIC_STATUS);
	});

	// 1f. Accumulate per-step + per-model cost from subagent tool results.
	pi.on("tool_result", (event: any, _ctx: any) => {
		if (event.toolName !== "subagent") return;
		const details = event.details as { mode?: string; results?: any[] } | undefined;
		if (!details || details.mode === "management") return;
		const input = (event.input ?? {}) as Record<string, any>;
		const step = buildCostStep(input, details, ++dispatchCounter);
		if (!step) return;
		currentReport.steps.push(step);
		// Snapshot so the command can read a stable copy even mid-run.
		lastReport = currentReport;
	});

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
			task: Type.String({
				description: "The task to perform, in plain language. For a named recipe, this provides the specifics the recipe's {{placeholders}} fill.",
			}),
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
		}),

		async execute(_toolCallId, params) {
			const p = params as PipelineParams & { pipeline?: string; inputs?: Record<string, string> };
			const resolved = resolvePlan(p);
			const plan = resolved.plan;
			const text = (resolved.error ? `**Note:** ${resolved.error}\n\n` : "") + renderPlan(plan, p.task, p.dryRun ?? false);
			return {
				content: [
					{
						type: "text" as const,
						text,
					},
				],
				details: {
					pipeline: resolved.name,
					mode: plan.mode,
					effort: plan.effort,
					stepCount: plan.steps.length,
					agents: plan.steps.reduce(
						(acc, s) => {
							acc[s.agent] = (acc[s.agent] ?? 0) + 1;
							return acc;
						},
						{} as Record<string, number>,
					),
					costShape: summarizeCost(plan),
					dryRun: p.dryRun ?? false,
				},
			};
		},
	});

	// 3. Slash command for explicit user invocation.
	pi.registerCommand("pipeline", {
		description:
			"Run a pipeline. Usage: /pipeline <recipe-name> <task>  |  /pipeline [mode] [effort] [dryrun] <task>. Browse recipes with /pipelines.",
		getArgumentCompletions: (prefix) => {
			const fixed = ["research", "implementation", "surface", "standard", "deep", "dryrun"];
			const recipes = discoverRecipes({
				userDir: path.join(os.homedir(), ".pi", "agent", "pipelines"),
				projectDirs: findProjectPipelineDirs(process.cwd()),
			}).map((r) => r.name);
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
			const recipes = discoverRecipes({
				userDir: path.join(os.homedir(), ".pi", "agent", "pipelines"),
				projectDirs: findProjectPipelineDirs(process.cwd()),
			});
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
			const report = lastReport.steps.length > 0 ? lastReport : currentReport;
			const { title, lines } = renderCostReport(report);
			if (ctx?.ui?.select) {
				await ctx.ui.select(title, lines);
			} else if (ctx?.ui?.notify) {
				ctx.ui.notify(lines.join("\n"), "info");
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
			const recipes = discoverRecipes({
				userDir: path.join(os.homedir(), ".pi", "agent", "pipelines"),
				projectDirs: findProjectPipelineDirs(process.cwd()),
			});
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
