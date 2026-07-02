/**
 * Pipeline extension — pure logic (no pi imports).
 *
 * Everything here is side-effect free and depends only on node:os / node:fs
 * / node:path. The pi-facing wiring lives in ./extension.ts. This split keeps
 * the plan builders, cost rollup, model resolution, and formatters unit-
 * testable with plain `node --test` (no jiti, no stubs).
 *
 * Settings readers (loadTierModels / loadModelFallbackOverrides / fallbacksFor)
 * take an optional `filePath` so tests can feed a fixture instead of reading
 * the real ~/.pi/agent/settings.json.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/** Default location of the pi settings file. Overridable for tests. */
export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

/* ─────────────────────────── types ─────────────────────────── */

export type Effort = "surface" | "standard" | "deep";
export type Mode = "research" | "implementation";

/** The standard profile roster. Recipes and built-ins name agents from this
 *  set (or any custom agent). The user binds each to a real model via
 *  `subagents.agentOverrides` in settings.json. */
export const STANDARD_PROFILES = ["dev", "util", "research", "high"] as const;
export type Profile = (typeof STANDARD_PROFILES)[number];

export interface PipelineParams {
	task: string;
	effort?: Effort;
	mode?: Mode;
	hints?: string[];
	dryRun?: boolean;
}

export interface PlanStep {
	phase: string;
	agent: string;        // a profile (dev/util/research/high) or any custom agent name
	label: string;
	task: string;
	output?: string;
	reads?: string[];
	parallel?: number;
	maxTools?: number;    // optional tool-call budget for this step (soft enforcement via task prompt)
}

export interface Plan {
	effort: Effort;
	mode: Mode;
	summary: string;
	steps: PlanStep[];
}

/* ────────────────── mode + effort inference ────────────────── */

export const EFFORT_KEYWORDS: Record<Effort, RegExp> = {
	surface:
		/\b(quick(?:ly)?|skim|survey|brief(?:ly)?|tl;?dr|summary|summarize|outlin|what does .* do|is .* feasible|feasibility check)\b/i,
	standard:
		/\b(standard|normal|regular|default|just (?:do|make|write|refactor))\b/i,
	deep: /\b(deep(?:ly)?|thorough(?:ly)?|carefully|iterate|iterative|subproject|break (?:it )?into parts|dig deep|take (?:your )?time|make it (?:really )?good|production[- ]ready)\b/i,
};

export const MODE_KEYWORDS: Record<Mode, RegExp> = {
	// Implementation is more specific (verbs that mutate), so check it first.
	implementation: /\b(implement|build|refactor|fix|change|edit|add|create|write code|codify|port|migrate|patch)\b/i,
	research: /\b(research|extract|review|audit|learnings?|postmortem|retrospect|what (?:did|have) we (?:learn|tried)|summarize (?:the )?(?:docs?|reports?)|analy[sz]e)\b/i,
};

export function inferEffort(task: string): Effort {
	if (EFFORT_KEYWORDS.deep.test(task)) return "deep";
	if (EFFORT_KEYWORDS.surface.test(task)) return "surface";
	return "standard";
}

export function inferMode(task: string): Mode {
	if (MODE_KEYWORDS.implementation.test(task)) return "implementation";
	if (MODE_KEYWORDS.research.test(task)) return "research";
	return "implementation";
}

/* ────────────────── plan steps (agent-only, no cost class) ──────────────────
 * Profiles (dev/util/research/high) replace the old tier+costClass pair.
 * A step names an agent; the user binds agents to models via settings.json.
 * `agent()` is a tiny helper so the templates read as `agent("util", {...})`
 * instead of the old `withCostClass({ tier: "util", ... })`.
 */

/** Tag a plan-step template literal with its agent. Returns the step as-is
 *  (the `agent` field carries the profile name); exists for readability and
 *  to mirror the old `withCostClass` shape during the migration. */
function agent<A extends string>(a: A, step: Omit<PlanStep, "agent">): PlanStep {
	return { ...step, agent: a };
}

/* ═══════════════════ implementation templates ═══════════════════
 * For code changes. High tier plans and accepts. Standard = 5 steps,
 * deep = 7 steps. The "persist spec" util step writes spec.md from the
 * high agent's text output (high is read-only by design).
 */

export const IMPL_SURFACE: Plan = {
	effort: "surface",
	mode: "implementation",
	summary: "1 util + 1 high. Quick recon, then a single high-tier judgment.",
	steps: [
		agent("util", {
			phase: "Recon",
			label: "Skim the relevant context",
			task:
				"Skim the requested area. Read 3–10 files or directory listings. Return a tight 200–400 word summary of what you found: file paths, line ranges, the key types/functions, and the obvious risks or unknowns. Do not edit anything. If the task refers to specific files or symbols, prioritize those.",
			output: "context.md",
		}),
		agent("high", {
			phase: "Judgment",
			label: "High-tier verdict",
			task:
				"Read context.md and the user's task. Return a one-paragraph judgment and a one-line verdict (accept / kick back / not-feasible / needs-clarification). If you recommend a next step, name the single highest-leverage one.",
			reads: ["context.md"],
		}),
	],
};

export const IMPL_STANDARD: Plan = {
	effort: "standard",
	mode: "implementation",
	summary: "1 high + 1 util + 1 research + 1 high. Plan, do, review, accept.",
	steps: [
		agent("high", {
			phase: "Plan",
			label: "Spec the work (returns spec as text)",
			task:
				"Write a one-paragraph spec for the task, then a numbered list of 2–5 concrete steps. For each step, name the tier that should do it and the deliverable (file path or short text). If the task itself is ambiguous, say so explicitly and the orchestrator will surface the question to the user. IMPORTANT: return the spec in your final assistant message as text — do not try to write a file (your tools are read-only on purpose). The util step below will read your message and write spec.md for you.",
		}),
		agent("util", {
			phase: "Persist spec",
			label: "Write spec.md from the high agent's message",
			task:
				"Read the parent's most recent assistant message — it contains the spec the high agent produced. Write the full contents of that message to `spec.md` so the next step can read it. Do not edit the spec, do not add to it. Just persist it. After writing, confirm the file path and the first line of the spec.",
			output: "spec.md",
		}),
		agent("util", {
			phase: "Execute",
			label: "Do the work per spec",
			task:
				"Read spec.md and follow each step exactly. Don't add features, don't refactor surrounding code. Edit files, run the project's tests if spec.md calls for it, and gather any data the next step needs. Write your result to the file named in spec.md for the work product; write any context the next step needs to `context.md`.",
			reads: ["spec.md"],
			output: "context.md",
		}),
		agent("research", {
			phase: "Review",
			label: "Consolidate and review",
			task:
				"Read spec.md and context.md. Verify the work matches the spec. If something is missing or wrong, list it with `file:line` references. If the work is good, write a 1-paragraph assessment. Do not edit code unless spec.md explicitly asked for fixes-applied review.",
			reads: ["spec.md", "context.md"],
			output: "review.md",
		}),
		agent("high", {
			phase: "Accept",
			label: "Accept or kick back",
			task:
				"Read spec.md, context.md, review.md. Return a one-line verdict: `accept` or `kick back`. If kick back, name the top 1–2 specific changes that would flip it to accept. Be brief; the user wants a verdict, not an essay. IMPORTANT: return the verdict in your final assistant message as text — do not try to write a file (your tools are read-only on purpose).",
			reads: ["spec.md", "context.md", "review.md"],
		}),
	],
};

export const IMPL_DEEP: Plan = {
	effort: "deep",
	mode: "implementation",
	summary:
		"Estimator + 1 high + 1 util + 2 util (parallel drafts) + 1 research (merge) + 1 high, with up to 3 kick-back rounds.",
	steps: [
		agent("util", {
			phase: "Estimate",
			label: "Estimate effort and confidence",
			task:
				"Read the project briefly (just enough to size the work). Return a JSON object with: `effort_recommendation` (one of `surface`, `standard`, `deep`), `confidence` (0.0–1.0), `estimated_high_tier_calls` (integer), `reasoning` (one paragraph), and `blockers` (array of strings, possibly empty). Do not edit files; this is read-only sizing.",
			output: "estimate.md",
		}),
		agent("high", {
			phase: "Plan",
			label: "Spec the work (returns spec as text)",
			task:
				"Read estimate.md. Write a one-paragraph spec for the task, then a numbered list of 2–5 concrete steps. Each step names the tier (util/research/high) and the deliverable. If the task itself is ambiguous, say so explicitly. Include any acceptance criteria you can name from the user's request. IMPORTANT: return the spec in your final assistant message as text — do not try to write a file (your tools are read-only on purpose). The util step below will read your message and write spec.md for you.",
			reads: ["estimate.md"],
		}),
		agent("util", {
			phase: "Persist spec",
			label: "Write spec.md from the high agent's message",
			task:
				"Read the parent's most recent assistant message — it contains the spec the high agent produced. Write the full contents of that message to `spec.md` so the next step can read it. Do not edit the spec, do not add to it. Just persist it. After writing, confirm the file path and the first line of the spec.",
			output: "spec.md",
		}),
		agent("util", {
			phase: "Gather",
			label: "Gather relevant context",
			task:
				"Read spec.md. Find the 5–15 most relevant files for the work. Read each. Write `context.md` with file paths, line ranges, and 1–2 line notes on what each file does that's relevant. Don't analyze — that's the research tier's job.",
			reads: ["spec.md"],
			output: "context.md",
		}),
		agent("util", {
			phase: "Draft (best-of-N)",
			label: "Draft approach A",
			task:
				"Read spec.md and context.md. Produce draft A: implement the spec in `draft-A.md` (a single markdown file containing the proposed code changes as fenced blocks with file paths). Keep it minimal; don't refactor beyond the spec. Don't apply the changes — just write the draft.",
			reads: ["spec.md", "context.md"],
			output: "draft-A.md",
			parallel: 1,
		}),
		agent("util", {
			phase: "Draft (best-of-N)",
			label: "Draft approach B (different angle)",
			task:
				"Read spec.md and context.md. Produce draft B in `draft-B.md` — a different approach from A. Aim for diversity: if A favored one pattern, try a contrasting one. Same constraints as A: minimal, no scope creep, code in fenced blocks with file paths.",
			reads: ["spec.md", "context.md"],
			output: "draft-B.md",
			parallel: 2,
		}),
		agent("research", {
			phase: "Merge",
			label: "Pick or merge drafts",
			task:
				"Read spec.md, context.md, draft-A.md, draft-B.md. Pick the better draft, or merge the strongest ideas from both. Write the final implementation as fenced code blocks with file paths to `final.md`. Justify your pick in 1–2 paragraphs at the top. Do not apply the changes to source files.",
			reads: ["spec.md", "context.md", "draft-A.md", "draft-B.md"],
			output: "final.md",
		}),
		agent("high", {
			phase: "Accept",
			label: "Accept or kick back",
			task:
				"Read spec.md, context.md, draft-A.md, draft-B.md, final.md. Return a one-line verdict: `accept` or `kick back`. If kick back, name the top 1–2 specific changes. The orchestrator may loop you back to the merge step up to 3 times total before giving up. IMPORTANT: return the verdict in your final assistant message as text — do not try to write a file (your tools are read-only on purpose).",
			reads: ["spec.md", "context.md", "draft-A.md", "draft-B.md", "final.md"],
		}),
	],
};

/* ═══════════════════ research templates ═══════════════════
 * For read-only/extraction tasks. No high-tier calls in surface or
 * standard (no plan/accept gate needed when there's no implementation).
 * Deep adds an optional high-tier accept at the end.
 *
 * The parent writes the spec itself (these templates don't have a plan
 * step); the spec is what tells each research subagent what to extract.
 * The parent uses its own knowledge of the file system to partition
 * the work into N parallel research subagent calls, named in the plan
 * below as fanout steps.
 */

export const RESEARCH_SURFACE: Plan = {
	effort: "surface",
	mode: "research",
	summary:
		"1 util skim + 1 research review. No high-tier calls. Use for quick reviews of 1–3 files.",
	steps: [
		agent("util", {
			phase: "Recon",
			label: "Skim the requested material",
			task:
				"Read the 1–3 files or directory the user named. Return a tight 200–400 word summary: file paths, line ranges, the key claims/decisions/learnings, and any follow-up the next step should chase. Do not edit anything. If the user named a specific file, prioritize that file's content.",
			output: "context.md",
		}),
		agent("research", {
			phase: "Review",
			label: "Consolidate and review",
			task:
				"Read context.md. Produce a 1-paragraph review and a one-line verdict (accept / kick back / needs-clarification). If the user wanted a structured list, return it as bullets with file:line citations. If kick back, name the single highest-leverage thing the next pass should fix.",
			reads: ["context.md"],
		}),
	],
};

export const RESEARCH_STANDARD: Plan = {
	effort: "standard",
	mode: "research",
	summary:
		"1 util partition + N research extractions (parallel) + 1 research merge. No high-tier calls. Use for multi-source extraction (devlogs + postmortems + audits, etc.).",
	steps: [
		agent("util", {
			phase: "Partition",
			label: "Inventory + partition the source set by theme",
			task:
				"Read the user's task and the project structure. Identify the 3–8 source files the parent should hand to the parallel research subagents. Group them by theme (e.g. 'bot/verb reliability', 'multi-agent cooperation', 'testing methodology', 'world/fixtures') and write `partition.md` as a short table: theme → files → 1-line scope note. If the user already partitioned in the task description, just persist their partition. After writing, list the themes and their files.",
			output: "partition.md",
		}),
		agent("research", {
			phase: "Extract (parallel)",
			label: "Extract theme-1 findings (parallel slot 1)",
			task:
				"Read partition.md. For the theme assigned to slot 1, read every file the partition names for that theme. Produce a structured bulleted findings dump: each bullet is `**topic** — `file` (date, run id). *Tried:* / *Worked:* / *Failed:* / *Decided:*`. Do NOT extract themes that belong to other slots. Write the dump to `findings-<theme>.md` (parent will pass the theme name).",
			reads: ["partition.md"],
			output: "findings-<theme-1>.md",
			parallel: 1,
		}),
		agent("research", {
			phase: "Extract (parallel)",
			label: "Extract theme-2 findings (parallel slot 2)",
			task:
				"Read partition.md. For the theme assigned to slot 2, read every file the partition names for that theme. Produce a structured bulleted findings dump: each bullet is `**topic** — `file` (date, run id). *Tried:* / *Worked:* / *Failed:* / *Decided:*`. Do NOT extract themes that belong to other slots. Write the dump to `findings-<theme>.md` (parent will pass the theme name).",
			reads: ["partition.md"],
			output: "findings-<theme-2>.md",
			parallel: 2,
		}),
		agent("research", {
			phase: "Merge",
			label: "Cross-check findings and write the synthesis",
			task:
				"Read partition.md and every `findings-*.md` produced by the parallel extractions. Cross-check for: (a) facts cited in one place but contradicted in another, (b) themes that should be merged or split, (c) numerical claims that should be preserved verbatim. Write a short `synthesis.md` with: top 5 decisions carried forward, top 3 open questions, and pointers into the per-theme files. Do not duplicate the per-theme dumps.",
			reads: ["partition.md"],
			output: "synthesis.md",
		}),
	],
};

export const RESEARCH_DEEP: Plan = {
	effort: "deep",
	mode: "research",
	summary:
		"1 util partition + N research extractions (parallel) + 1 research merge + 1 high accept. The high accept is the only $$$ call; everything else is $ or $$.",
	steps: [
		agent("util", {
			phase: "Partition",
			label: "Inventory + partition the source set by theme",
			task:
				"Read the user's task and the project structure. Identify the 4–12 source files the parent should hand to the parallel research subagents. Group them by theme (e.g. 'bot/verb reliability', 'multi-agent cooperation', 'testing methodology', 'world/fixtures', 'architecture falsification') and write `partition.md` as a short table: theme → files → 1-line scope note. Aim for 3–5 themes total. If the user already partitioned in the task description, persist their partition. After writing, list the themes and their files.",
			output: "partition.md",
		}),
		agent("research", {
			phase: "Extract (parallel)",
			label: "Extract theme-1 findings (parallel slot 1)",
			task:
				"Read partition.md. For the theme assigned to slot 1, read every file the partition names for that theme. Produce a structured bulleted findings dump: each bullet is `**topic** — `file` (date, run id). *Tried:* / *Worked:* / *Failed:* / *Decided:*`. Do NOT extract themes that belong to other slots. Write the dump to `findings-<theme>.md` (parent will pass the theme name). Include cross-references to other themes where they touch the same incident, but only as inline references — not as full extractions.",
			reads: ["partition.md"],
			output: "findings-<theme-1>.md",
			parallel: 1,
		}),
		agent("research", {
			phase: "Extract (parallel)",
			label: "Extract theme-2 findings (parallel slot 2)",
			task:
				"Read partition.md. For the theme assigned to slot 2, read every file the partition names for that theme. Produce a structured bulleted findings dump: each bullet is `**topic** — `file` (date, run id). *Tried:* / *Worked:* / *Failed:* / *Decided:*`. Do NOT extract themes that belong to other slots. Write the dump to `findings-<theme>.md` (parent will pass the theme name). Include cross-references to other themes where they touch the same incident, but only as inline references — not as full extractions.",
			reads: ["partition.md"],
			output: "findings-<theme-2>.md",
			parallel: 2,
		}),
		agent("research", {
			phase: "Extract (parallel)",
			label: "Extract theme-3 findings (parallel slot 3)",
			task:
				"Read partition.md. For the theme assigned to slot 3, read every file the partition names for that theme. Produce a structured bulleted findings dump: each bullet is `**topic** — `file` (date, run id). *Tried:* / *Worked:* / *Failed:* / *Decided:*`. Do NOT extract themes that belong to other slots. Write the dump to `findings-<theme>.md` (parent will pass the theme name). Include cross-references to other themes where they touch the same incident, but only as inline references — not as full extractions.",
			reads: ["partition.md"],
			output: "findings-<theme-3>.md",
			parallel: 3,
		}),
		agent("research", {
			phase: "Merge",
			label: "Cross-check findings and write the synthesis",
			task:
				"Read partition.md and every `findings-*.md` produced by the parallel extractions. Cross-check for: (a) facts cited in one place but contradicted in another, (b) themes that should be merged or split, (c) numerical claims that should be preserved verbatim. Write a comprehensive `synthesis.md` with: top 10 decisions carried forward, top 5 open questions, conflicts between sources, and pointers into the per-theme files. Do not duplicate the per-theme dumps.",
			reads: ["partition.md"],
			output: "synthesis.md",
		}),
		agent("high", {
			phase: "Accept",
			label: "Accept or kick back",
			task:
				"Read partition.md, every `findings-*.md`, and synthesis.md. Return a one-line verdict: `accept` or `kick back`. The bar is: every theme has a populated findings file, every entry has the four quadruple fields and a citation, and the synthesis top-10 is consistent with the per-theme dumps. If kick back, name the single highest-leverage fix. IMPORTANT: return the verdict in your final assistant message as text — do not try to write a file (your tools are read-only on purpose).",
			reads: ["partition.md", "synthesis.md"],
		}),
	],
};

export const IMPL_TEMPLATES: Record<Effort, Plan> = {
	surface: IMPL_SURFACE,
	standard: IMPL_STANDARD,
	deep: IMPL_DEEP,
};

export const RESEARCH_TEMPLATES: Record<Effort, Plan> = {
	surface: RESEARCH_SURFACE,
	standard: RESEARCH_STANDARD,
	deep: RESEARCH_DEEP,
};

/* ─────────────────── model fallback (OpenRouter) ───────────────────
 *
 * OpenRouter does server-side failover: if you send a `models` array
 * alongside `model`, it tries the primary first and falls through to the
 * rest on rate-limits, downtime, moderation, or context-length errors
 * (https://openrouter.ai/docs/guides/routing/model-fallbacks). This
 * composes with pi's own same-model retry and needs no client logic.
 *
 * pi fires `before_provider_request` before every provider call (parent
 * AND subagents); returning a payload replaces it. We use that to inject
 * `payload.models` based on which class the current `payload.model`
 * belongs to. The three pipeline tiers map to three fallback classes:
 *
 *   util ($)   → utility : minimax/minimax-m3      → moonshotai/kimi-k2.7-code
 *   research($$)→ coding  : z-ai/glm-5.2            → google/gemini-3.5-flash → qwen/qwen3.7-max
 *   high  ($$$) → stronger: anthropic/claude-sonnet-5 → ~openai/gpt-mini-latest
 *
 * Tunable without editing the package: set `pipeline.modelFallbacks` in
 * ~/.pi/agent/settings.json as `{ "<class>": ["id", ...] }` to override
 * the defaults below. Missing classes fall back to the defaults.
 *
 * Note: OpenRouter model ids are bare `vendor/model` (no `openrouter/`
 * prefix). The `~` prefix is OpenRouter's "latest" alias. Some ids
 * (e.g. qwen/qwen3.7-max) exist on OpenRouter's live catalog but not in
 * pi's bundled model snapshot — that's fine, the `models` array is
 * opaque to pi and resolved server-side.
 */

export const DEFAULT_MODEL_FALLBACKS: Record<ModelClass, string[]> = {
	utility: ["minimax/minimax-m3", "moonshotai/kimi-k2.7-code"],
	coding: ["z-ai/glm-5.2", "google/gemini-3.5-flash", "qwen/qwen3.7-max"],
	stronger: ["anthropic/claude-sonnet-5", "~openai/gpt-mini-latest"],
};

export type ModelClass = "utility" | "coding" | "stronger";

/** Map each known primary model id → its fallback class. */
export const PRIMARY_TO_CLASS: Record<string, ModelClass> = {
	"minimax/minimax-m3": "utility",
	"moonshotai/kimi-k2.7-code": "utility",   // default dev model
	"z-ai/glm-5.2": "coding",
	"anthropic/claude-sonnet-5": "stronger",
};

/** Read ~/.pi/agent/settings.json -> pipeline.modelFallbacks, best-effort.
 * Memoized at module scope; refreshes on `/reload` (module re-evaluation). */
const _fallbackOverridesCache = new Map<string, Record<string, string[]>>();
export function loadModelFallbackOverrides(filePath: string = DEFAULT_SETTINGS_PATH): Record<string, string[]> {
	const cached = _fallbackOverridesCache.get(filePath);
	if (cached !== undefined) return cached;
	const out: Record<string, string[]> = {};
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		const f = parsed?.pipeline?.modelFallbacks;
		if (f && typeof f === "object") {
			for (const [k, v] of Object.entries(f)) {
				if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
			}
		}
	} catch {
		/* missing/unreadable/unparsable settings → use defaults */
	}
	_fallbackOverridesCache.set(filePath, out);
	return out;
}

/** Resolve the fallback list for a primary model id, or undefined if unknown. */
export function fallbacksFor(modelId: string | undefined, filePath: string = DEFAULT_SETTINGS_PATH): string[] | undefined {
	if (!modelId) return undefined;
	// Normalize: strip a leading "openrouter/" provider prefix if present
	// (payload.model is usually bare, but be lenient).
	const id = modelId.replace(/^openrouter\//, "");
	const cls = PRIMARY_TO_CLASS[id];
	if (!cls) return undefined;
	const overrides = loadModelFallbackOverrides(filePath);
	return overrides[cls] ?? DEFAULT_MODEL_FALLBACKS[cls];
}

/* ──────────────────────── tier model pinning ────────────────────────
 *
 * WHY utility subagents sometimes run on glm-5.2 instead of minimax-m3:
 * pi-subagents resolves a child's model as
 *   resolveSubagentModelOverride(params.model ?? agent.model, ctx.model, ...).
 * When the parent calls `subagent({agent:"util", task:...})` WITHOUT a
 * `model` field and the agent's `model` override is *not loaded in the
 * running parent process* (session started before the override was added to
 * settings.json, or settings edited without `/reload`), `agent.model` is
 * unset, so the child **inherits the parent session's in-memory model**
 * (here glm-5.2). The agent's `thinking` level still applies (it comes
 * from the agent frontmatter, independently of overrides) — which is why
 * you see `glm-5.2:low` for util steps and the thinking level still varies
 * (low/medium/high) while the model does not.
 *
 * Robust fix: this extension reads the tier→model mapping from the *live*
 * settings.json and injects `model` into the subagent tool args at
 * `tool_call` time (below), so the correct tier model is used regardless
 * of whether the parent process has reloaded agentOverrides. A `/reload` or
 * restart is still recommended so pi-subagents' own mapping is consistent.
 */

export const DEFAULT_TIER_MODELS: Record<Profile, string> = {
	dev: "openrouter/moonshotai/kimi-k2.7-code",
	util: "openrouter/minimax/minimax-m3",
	research: "openrouter/z-ai/glm-5.2",
	high: "openrouter/anthropic/claude-sonnet-5",
};

/** Read the tier→model map from the live ~/.pi/agent/settings.json
 *  `subagents.agentOverrides.<tier>.model`. Falls back to the defaults.
 *  Not memoized: re-read each dispatch so edits to settings.json take
 *  effect on the next subagent call even in a stale parent process. */
export function loadTierModels(filePath: string = DEFAULT_SETTINGS_PATH): Record<Profile, string> {
	const out: Record<Profile, string> = { ...DEFAULT_TIER_MODELS };
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		const ao = parsed?.subagents?.agentOverrides;
		if (ao && typeof ao === "object") {
			for (const k of STANDARD_PROFILES) {
				const m = ao[k]?.model;
				if (typeof m === "string" && m.trim()) out[k] = m.trim();
			}
		}
	} catch {
		/* missing/unreadable/unparsable settings → use defaults */
	}
	return out;
}

/** Is `agentName` one of the standard pipeline profiles? */
export function isTierAgent(agentName: unknown): agentName is Profile {
	return typeof agentName === "string" && (STANDARD_PROFILES as readonly string[]).includes(agentName);
}

/* ──────────────────────── error classification ────────────────────────
 *
 * Provider errors come back as raw strings in attempts[].error and result.error.
 * Classifying them lets the audit view say *why* a step failed — context
 * overflow vs. rate-limit vs. auth — which is the diagnostic signal for the
 * "subagents get too much context" problem.
 */

export type FailureKind =
	| "context-overflow"   // 400: maximum context length / context length is
	| "rate-limit"         // 429 / rate limit / too many requests / overloaded
	| "auth"               // 401/403 / api key / unauthorized
	| "timeout"            // timed out
	| "model-unavailable"  // model not found / disabled / unavailable
	| "unknown";

const CONTEXT_OVERFLOW_RE = /maximum context length|context length is|context length/i;
const RATE_LIMIT_RE = /\b429\b|rate[\s-]?limit|too many requests|overloaded|temporarily rate-limited/i;
const AUTH_RE = /\b40[13]\b|unauthori[sz]ed|api[\s-]?key|token expired|forbidden/i;
const TIMEOUT_RE = /timed?\s*out|deadline exceeded/i;
const MODEL_UNAVAILABLE_RE = /model.*(not found|disabled|unavailable)|unknown model|provider.*unavailable/i;

/** Classify a raw error string into a failure kind. */
export function classifyFailure(error: string | undefined | null): FailureKind {
	if (!error) return "unknown";
	if (CONTEXT_OVERFLOW_RE.test(error)) return "context-overflow";
	if (RATE_LIMIT_RE.test(error)) return "rate-limit";
	if (AUTH_RE.test(error)) return "auth";
	if (TIMEOUT_RE.test(error)) return "timeout";
	if (MODEL_UNAVAILABLE_RE.test(error)) return "model-unavailable";
	return "unknown";
}

/** True if the error indicates the prompt exceeded the model's context window. */
export function isContextOverflow(error: string | undefined | null): boolean {
	return classifyFailure(error) === "context-overflow";
}

/** Human-readable label for a failure kind. */
export function failureLabel(error: string | undefined | null): string {
	const kind = classifyFailure(error);
	return kind === "unknown" ? "failed" : kind;
}

/* ──────────────────────── cost tracking ────────────────────────
 *
 * Accumulate per-dispatch subagent cost from `tool_result` events so the
 * `/pipeline-costs` command can render a breakdown by pipeline step and by
 * model. Reset whenever the `pipeline` tool is invoked (a new pipeline
 * operation). Also drives the live progress status line.
 */

export interface ModelUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number; // input + output + cacheRead (cacheWrite counted once)
	cost: number;
	turns: number;
	calls: number;
}

export interface AttemptEntry {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;            // raw per-attempt error (e.g. the 429 or 400 message)
	usage?: ModelUsageTotals;
}

export interface ArtifactPaths {
	inputPath?: string;       // the exact task/prompt given to the subagent
	outputPath?: string;      // the subagent's final output
	jsonlPath?: string;       // full child session — every message/tool call/response
	metadataPath?: string;    // run summary (agent/task/usage/model)
}

export interface ToolCallSummary {
	text: string;             // one-line summary of the call
	expandedText?: string;    // longer form, if available
}

export interface CostResultEntry {
	agent: string;
	model: string; // normalized display model
	task: string;  // FULL task text (not snippet) — audit needs it
	exitCode: number | null;
	error?: string;           // top-level result error (the final failure)
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	durationMs?: number;
	toolCount?: number;
	finalOutput?: string;     // the subagent's final text response
	toolCalls?: ToolCallSummary[]; // per-call summary
	sessionFile?: string;    // child session JSONL (full conversation)
	artifactPaths?: ArtifactPaths;
	attempts: AttemptEntry[];
}

export interface CostStep {
	stepIndex: number; // dispatch order within the current pipeline op
	mode: "single" | "parallel" | string;
	agent: string; // single agent, or comma-joined for parallel
	task: string; // snippet (single) or "N tasks: ..." (parallel)
	results: CostResultEntry[];
}

export interface PipelineCostReport {
	planName?: string;       // recipe name, or undefined for the generic path
	planMode?: string;
	planEffort?: string;
	planStepCount?: number;
	planCostShape?: string;
	dryRun?: boolean;
	steps: CostStep[];
}

/* ──────────────────────── RunMetrics (single source of truth) ────────────────────────
 *
 * The canonical record of one pipeline run's cost/time/tokens, captured for
 * EVERY run (not just when a cost command is invoked). All future consumers —
 * overview TUI cost estimate, live dashboard, footer widget, reports — read
 * from this shape so they answer "per-step cost", "per-model cost", "total
 * run cost", "session cumulative", and "time per step/model" without
 * re-deriving. `PipelineCostReport` (above) is the live accumulator; a
 * finalized run snapshots into a `RunMetrics` record.
 */

export interface RunMetricsEntry {
	stepIndex: number;       // dispatch order
	mode: string;            // "single" | "parallel" | ...
	agent: string;           // single agent, or comma-joined for parallel
	task: string;            // snippet
	results: CostResultEntry[];
	durationMs: number;      // sum across results (0 if unknown)
}

export interface RunMetrics {
	planName?: string;       // recipe name, or undefined for the generic path
	planMode?: string;
	planEffort?: string;
	planCostShape?: string;
	dryRun: boolean;
	startedAt: number;       // epoch ms
	endedAt?: number;        // epoch ms; set when the run finalizes
	steps: RunMetricsEntry[];
}

/** Snapshot a cost report into an immutable RunMetrics record. `startedAt`
 *  is the caller's responsibility (set when the pipeline op began). */
export function toRunMetrics(
	report: PipelineCostReport,
	startedAt: number,
	endedAt?: number,
	planName?: string,
): RunMetrics {
	return {
		planName: planName ?? report.planName,
		planMode: report.planMode,
		planEffort: report.planEffort,
		planCostShape: report.planCostShape,
		dryRun: report.dryRun ?? false,
		startedAt,
		endedAt,
		steps: report.steps.map((s) => ({
			stepIndex: s.stepIndex,
			mode: s.mode,
			agent: s.agent,
			task: s.task,
			results: s.results,
			durationMs: s.results.reduce((a, r) => a + (r.durationMs ?? 0), 0),
		})),
	};
}

/** Per-model rollup from a RunMetrics record. Reuses rollupByModel on the
 *  report shape; provided here as the canonical accessor. */
export function metricsByModel(metrics: RunMetrics): Map<string, ModelUsageTotals> {
	return rollupByModel({ steps: metrics.steps } as PipelineCostReport);
}

/** Total cost across a run. */
export function metricsTotalCost(metrics: RunMetrics): number {
	return [...metricsByModel(metrics).values()].reduce((a, t) => a + t.cost, 0);
}

/** Total wall-clock duration across all steps (sum; not end-to-end — parallel
 *  steps overlap). 0 if no step has a duration. */
export function metricsTotalDurationMs(metrics: RunMetrics): number {
	return metrics.steps.reduce((a, s) => a + s.durationMs, 0);
}


/** Strip thinking suffix (`:low`) and provider prefix for rollup keys. */
export function normalizeModel(model: string | undefined): string {
	if (!model) return "(unknown)";
	let m = model;
	// strip trailing :thinking level
	const colon = m.lastIndexOf(":");
	if (colon !== -1 && /^(low|medium|high|minimal|off|xhigh)$/.test(m.substring(colon + 1))) {
		m = m.substring(0, colon);
	}
	// strip a leading openrouter/ provider prefix for display
	m = m.replace(/^openrouter\//, "");
	return m || "(unknown)";
}

export function snippet(s: string | undefined, n = 80): string {
	if (!s) return "";
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

export function fmtCost(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(6)}`;
}

export function emptyTotals(): ModelUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, turns: 0, calls: 0 };
}

export function addUsageInto(totals: ModelUsageTotals, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number } | undefined): void {
	if (!u) return;
	totals.input += u.input ?? 0;
	totals.output += u.output ?? 0;
	totals.cacheRead += u.cacheRead ?? 0;
	totals.cacheWrite += u.cacheWrite ?? 0;
	totals.tokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0);
	totals.cost += u.cost ?? 0;
	totals.turns += u.turns ?? 0;
}

/** Map a subagent SingleResult (from tool_result details) into a cost entry.
 *  Captures per-attempt usage so model fallbacks (e.g. minimax-m3 → glm-5.2)
 *  are charged to the model that actually served them. */
export function mapResultEntry(r: any): CostResultEntry {
	const entry: CostResultEntry = {
		agent: r?.agent ?? "?",
		model: normalizeModel(r?.model),
		task: typeof r?.task === "string" ? r.task : "",  // FULL task, not snippet — audit needs it
		exitCode: r?.exitCode ?? null,
		error: typeof r?.error === "string" ? r.error : undefined,
		usage: r?.usage && typeof r.usage === "object"
			? {
				input: r.usage.input ?? 0,
				output: r.usage.output ?? 0,
				cacheRead: r.usage.cacheRead ?? 0,
				cacheWrite: r.usage.cacheWrite ?? 0,
				cost: r.usage.cost ?? 0,
				turns: r.usage.turns ?? 0,
			}
			: undefined,
		durationMs: r?.progressSummary?.durationMs,
		toolCount: r?.progressSummary?.toolCount,
		finalOutput: typeof r?.finalOutput === "string" ? r.finalOutput : undefined,
		toolCalls: Array.isArray(r?.toolCalls) ? r.toolCalls.map((tc: any) => ({
			text: typeof tc?.text === "string" ? tc.text : "",
			expandedText: typeof tc?.expandedText === "string" ? tc.expandedText : undefined,
		})) : undefined,
		sessionFile: typeof r?.sessionFile === "string" ? r.sessionFile : undefined,
		artifactPaths: r?.artifactPaths && typeof r.artifactPaths === "object" ? {
			inputPath: typeof r.artifactPaths.inputPath === "string" ? r.artifactPaths.inputPath : undefined,
			outputPath: typeof r.artifactPaths.outputPath === "string" ? r.artifactPaths.outputPath : undefined,
			jsonlPath: typeof r.artifactPaths.jsonlPath === "string" ? r.artifactPaths.jsonlPath : undefined,
			metadataPath: typeof r.artifactPaths.metadataPath === "string" ? r.artifactPaths.metadataPath : undefined,
		} : undefined,
		attempts: [],
	};
	const ma = Array.isArray(r?.modelAttempts) ? r.modelAttempts : [];
	for (const a of ma) {
		entry.attempts.push({
			model: normalizeModel(a?.model),
			success: !!a?.success,
			exitCode: a?.exitCode ?? null,
			error: typeof a?.error === "string" ? a.error : undefined,
			usage: a?.usage
				? {
						...emptyTotals(),
						input: a.usage.input ?? 0,
						output: a.usage.output ?? 0,
						cacheRead: a.usage.cacheRead ?? 0,
						cacheWrite: a.usage.cacheWrite ?? 0,
						tokens: (a.usage.input ?? 0) + (a.usage.output ?? 0) + (a.usage.cacheRead ?? 0),
						cost: a.usage.cost ?? 0,
						turns: a.usage.turns ?? 0,
						calls: 1,
				  }
				: undefined,
		});
	}
	return entry;
}

/* ──────────────────────── progress status line ──────────────────────── */

export const STATIC_STATUS = "pipeline extension loaded · /pipeline [research|impl] [effort] <task> · /pipeline-costs";

export function renderProgressStatus(progressList: Array<any>): string {
	if (!progressList || progressList.length === 0) return STATIC_STATUS;
	const parts: string[] = [];
	for (const p of progressList) {
		if (!p) continue;
		const agent = p.agent ?? "?";
		const tool = p.currentTool ? ` ${p.currentTool}` : "";
		const pth = p.currentPath ? ` ${String(p.currentPath).split("/").pop()}` : "";
		const tools = p.toolCount ? ` · ${p.toolCount} tools` : "";
		const turns = p.turnCount ? ` · ${p.turnCount} turns` : "";
		const tok = p.tokens ? ` · ${fmtTokens(p.tokens)} tok` : "";
		parts.push(`${agent}${tool}${pth}${tools}${turns}${tok}`);
	}
	return `pipeline ▸ ${parts.join(" | ")}`;
}

/* ──────────────────────── cost report rendering ──────────────────────── */

/** Aggregate per-model totals across a report. Prefers modelAttempts when
 *  present (so fallback costs land on the right model), else the result's
 *  own usage. */
export function rollupByModel(report: PipelineCostReport): Map<string, ModelUsageTotals> {
	const byModel = new Map<string, ModelUsageTotals>();
	const bump = (model: string, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number } | undefined) => {
		const key = model || "(unknown)";
		let t = byModel.get(key);
		if (!t) { t = emptyTotals(); byModel.set(key, t); }
		addUsageInto(t, usage);
		t.calls += 1;
	};
	for (const step of report.steps) {
		for (const r of step.results) {
			if (r.attempts.length > 0) {
				for (const a of r.attempts) bump(a.model, a.usage);
			} else {
				bump(r.model, r.usage);
			}
		}
	}
	return byModel;
}

/** Render the last pipeline op's cost report as a scrollable list of lines
 *  (per-step + per-model rollup + totals). Designed for `ctx.ui.select`. */
export function renderCostReport(report: PipelineCostReport): { title: string; lines: string[] } {
	const lines: string[] = [];
	if (report.steps.length === 0) {
		return { title: "Pipeline costs — no pipeline op recorded yet", lines: ["Run /pipeline <task> first, then /pipeline-costs."] };
	}
	const head: string[] = [];
	head.push(`Pipeline costs · mode=${report.planMode ?? "?"} effort=${report.planEffort ?? "?"} · ${report.steps.length} dispatch(es)${report.dryRun ? " · DRY RUN" : ""}`);
	if (report.planCostShape) head.push(`Plan cost shape: ${report.planCostShape}`);
	lines.push(...head);
	lines.push("", "── Per step ──");
	for (const step of report.steps) {
		lines.push(`#${step.stepIndex} [${step.mode}] ${step.agent} — ${step.task}`);
		for (const r of step.results) {
			const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
			const tc = r.toolCount != null ? ` · ${r.toolCount} tools` : "";
			// When a step fell back across models, sum every attempt's usage so the
			// per-step total reconciles with the per-model rollup (which also sums
			// attempts). Otherwise use the result's own usage.
			const summed = r.attempts.length > 0 ? r.attempts.reduce(
				(acc, a) => { if (a.usage) { acc.cost += a.usage.cost; acc.tokens += a.usage.tokens; } return acc; },
				{ cost: 0, tokens: 0 },
			) : null;
			const hasUsage = summed !== null || r.usage;
			const cost = summed ? summed.cost : (r.usage ? r.usage.cost : 0);
			const tok = summed ? summed.tokens : (r.usage ? r.usage.input + r.usage.output + r.usage.cacheRead : 0);
			lines.push(`    ${r.model}${hasUsage ? ` · ${fmtCost(cost)}` : ""}${hasUsage ? ` · ${fmtTokens(tok)} tok` : ""}${dur}${tc}${r.exitCode ? ` · exit ${r.exitCode}` : ""}`);
			if (r.attempts.length > 1) {
				for (const a of r.attempts) {
					const ac = a.usage ? ` ${fmtCost(a.usage.cost)}` : "";
					lines.push(`      ${a.success ? "✓" : "✗"} ${a.model}${ac}`);
				}
			}
		}
	}

	const byModel = rollupByModel(report);
	lines.push("", "── Per model ──");
	const grand = emptyTotals();
	const modelRows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
	for (const [model, t] of modelRows) {
		lines.push(`${model} — ${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} tok · ${t.calls} call(s)`);
		addUsageInto(grand, t);
		grand.calls += t.calls;
	}
	lines.push("", `── Total ──`);
	lines.push(`${fmtCost(grand.cost)} · ${fmtTokens(grand.tokens)} tok · ${report.steps.length} step(s) · ${grand.calls} call(s)`);
	return { title: `Pipeline costs — ${report.steps.length} dispatch(es) · ${fmtCost(grand.cost)}`, lines };
}

/* ──────────────────────── audit rendering ────────────────────────
 *
 * A per-step browser of one pipeline run's audit data: the full task each
 * subagent received, its resolved model, per-attempt outcomes (with raw
 * errors and a context-overflow flag), tool calls, final output, and paths to
 * the on-disk artifacts (input.md / output.md / session.jsonl / meta.json)
 * for deep drill-down. Failed steps are emphasized so a 429→400 cascade is
 * immediately visible. Designed for `ctx.ui.select`.
 */

/** Truncate a long string for inline display, keeping head + tail. */
function truncateMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = Math.ceil((max - 1) / 2);
	const tail = Math.floor((max - 1) / 2);
	return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/** Truncate to the head only (no tail). Used for task text, where the tail is
 *  often appended boilerplate (e.g. pi-subagents' output-path instructions)
 *  that makes middle-truncation misleading. */
function truncateHead(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

import { spawnSync } from "node:child_process";

/** Copy plain text to the local system clipboard, platform-independent. */
export function copyToClipboard(text: string): boolean {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			const proc = spawnSync("pbcopy", { input: text, encoding: "utf-8" });
			return proc.status === 0;
		} else if (platform === "win32") {
			const proc = spawnSync("clip", { input: text, encoding: "utf-8" });
			return proc.status === 0;
		} else if (platform === "linux") {
			// Check for Wayland wl-copy, fallback to xclip, then xsel
			const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
			if (wayland) {
				const proc = spawnSync("wl-copy", { input: text, encoding: "utf-8" });
				if (proc.status === 0) return true;
			}
			const procXclip = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf-8" });
			if (procXclip.status === 0) return true;

			const procXsel = spawnSync("xsel", ["--clipboard", "--input"], { input: text, encoding: "utf-8" });
			return procXsel.status === 0;
		}
	} catch {
		// Ignore shell execution failures
	}
	return false;
}

/** Render a single step's ultra-detailed audit lines (no truncation on tasks or outputs). */
export function renderStepAudit(step: CostStep): { title: string; lines: string[]; paths: Record<string, string> } {
	const lines: string[] = [];
	const paths: Record<string, string> = {};
	const failedResults = step.results.filter((r) => r.exitCode !== 0 || r.error);
	const marker = failedResults.length > 0 ? "✗" : "✓";

	lines.push(`Step #${step.stepIndex} [${step.mode}] ${step.agent}`);
	lines.push(`Summary: ${step.task}`);
	lines.push("");

	for (let rIndex = 0; rIndex < step.results.length; rIndex++) {
		const r = step.results[rIndex]!;
		const failed = r.exitCode !== 0 || !!r.error;
		const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
		const tc = r.toolCount != null ? ` · ${r.toolCount} tools` : "";
		const tok = r.usage ? ` · ${fmtTokens(r.usage.input + r.usage.output + r.usage.cacheRead)} tok` : "";
		const exitLbl = r.exitCode ? ` · exit ${r.exitCode}` : "";

		lines.push(`${failed ? "✗" : "•"} ${r.model}${tok}${dur}${tc}${exitLbl}`);

		// Per-attempt breakdown
		if (r.attempts.length > 1 || (r.attempts.length === 1 && !r.attempts[0]!.success)) {
			for (let i = 0; i < r.attempts.length; i++) {
				const a = r.attempts[i]!;
				const kind = a.success ? "ok" : failureLabel(a.error);
				const overflow = !a.success && isContextOverflow(a.error) ? " ⚠ context overflow" : "";
				const errSnip = a.error ? `: ${a.error.replace(/\s+/g, " ").trim()}` : "";
				const fellBack = i < r.attempts.length - 1 && !a.success ? `  ↳ fell back to ${r.attempts[i + 1]!.model}` : "";
				lines.push(`    attempt ${i + 1}: ${a.model} — ${kind}${overflow}${errSnip}${fellBack}`);
			}
		}

		// Top-level error
		if (r.error && r.attempts.length <= 1) {
			const overflow = isContextOverflow(r.error) ? " ⚠ context overflow" : "";
			lines.push(`    error: ${r.error.replace(/\s+/g, " ").trim()}${overflow}`);
		}

		// Full tool calls
		if (r.toolCalls && r.toolCalls.length > 0) {
			lines.push(`    tools: ${r.toolCalls.length} call(s)`);
			for (const tc2 of r.toolCalls) {
				lines.push(`      · ${tc2.text}`);
			}
		}

		// Full task
		if (r.task) {
			lines.push("    task:");
			for (const line of r.task.split("\n")) {
				lines.push(`      ${line}`);
			}
		}

		// Final output
		if (r.finalOutput) {
			lines.push("    output:");
			for (const line of r.finalOutput.split("\n")) {
				lines.push(`      ${line}`);
			}
		}

		// Artifact paths
		if (r.artifactPaths) {
			const ap = r.artifactPaths;
			lines.push("    artifacts on disk:");
			if (ap.inputPath) {
				lines.push(`      - input:      ${ap.inputPath}`);
				paths.input = ap.inputPath;
			}
			if (ap.outputPath) {
				lines.push(`      - output:     ${ap.outputPath}`);
				paths.output = ap.outputPath;
			}
			if (ap.jsonlPath) {
				lines.push(`      - session:    ${ap.jsonlPath}`);
				paths.session = ap.jsonlPath;
			}
			if (ap.metadataPath) {
				lines.push(`      - metadata:   ${ap.metadataPath}`);
				paths.metadata = ap.metadataPath;
			}
		}
	}

	return { title: `Step #${step.stepIndex} Detailed Audit`, lines, paths };
}

export function renderAuditReport(report: PipelineCostReport): { title: string; lines: string[] } {
	const lines: string[] = [];
	if (report.steps.length === 0) {
		return { title: "Pipeline audit — no pipeline op recorded yet", lines: ["Run /pipeline <task> first, then /pipeline-audit."] };
	}
	lines.push(`Pipeline audit · ${report.planName ?? "generic"}${report.planMode ? ` · ${report.planMode}/${report.planEffort ?? ""}` : ""} · ${report.steps.length} dispatch(es)${report.dryRun ? " · DRY RUN" : ""}`);
	lines.push("");
	for (const step of report.steps) {
		const failedResults = step.results.filter((r) => r.exitCode !== 0 || r.error);
		const marker = failedResults.length > 0 ? "✗" : "✓";
		lines.push(`${marker} #${step.stepIndex} [${step.mode}] ${step.agent} — ${snippet(step.task, 90)}`);
		for (const r of step.results) {
			const failed = r.exitCode !== 0 || !!r.error;
			const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
			const tc = r.toolCount != null ? ` · ${r.toolCount} tools` : "";
			const tok = r.usage ? ` · ${fmtTokens(r.usage.input + r.usage.output + r.usage.cacheRead)} tok` : "";
			const exitLbl = r.exitCode ? ` · exit ${r.exitCode}` : "";
			lines.push(`    ${failed ? "✗" : "•"} ${r.model}${tok}${dur}${tc}${exitLbl}`);
			// Per-attempt breakdown — the 429→400 cascade lives here.
			if (r.attempts.length > 1 || (r.attempts.length === 1 && !r.attempts[0]!.success)) {
				for (let i = 0; i < r.attempts.length; i++) {
					const a = r.attempts[i]!;
					const kind = a.success ? "ok" : failureLabel(a.error);
					const overflow = !a.success && isContextOverflow(a.error) ? " ⚠ context overflow" : "";
					const errSnip = a.error ? `: ${snippet(a.error.replace(/\s+/g, " "), 100)}` : "";
					const fellBack = i < r.attempts.length - 1 && !a.success ? `  ↳ fell back to ${r.attempts[i + 1]!.model}` : "";
					lines.push(`        attempt ${i + 1}: ${a.model} — ${kind}${overflow}${errSnip}${fellBack}`);
				}
			}
			// Top-level error (the final failure).
			if (r.error && r.attempts.length <= 1) {
				const overflow = isContextOverflow(r.error) ? " ⚠ context overflow" : "";
				lines.push(`        error: ${snippet(r.error.replace(/\s+/g, " "), 120)}${overflow}`);
			}
			// Tool calls — one line each.
			if (r.toolCalls && r.toolCalls.length > 0) {
				lines.push(`        tools: ${r.toolCalls.length} call(s)`);
				for (const tc2 of r.toolCalls.slice(0, 8)) {
					lines.push(`          · ${snippet(tc2.text.replace(/\s+/g, " "), 100)}`);
				}
				if (r.toolCalls.length > 8) lines.push(`          · … ${r.toolCalls.length - 8} more`);
			}
			// Full task (audit needs it; truncated for the inline view).
			if (r.task) lines.push(`        task: ${truncateHead(r.task.replace(/\s+/g, " "), 160)}`);
			// Final output (truncated).
			if (r.finalOutput) lines.push(`        output: ${truncateMiddle(r.finalOutput.replace(/\s+/g, " "), 160)}`);
			// Artifact paths for deep drill-down.
			if (r.artifactPaths) {
				const ap = r.artifactPaths;
				const paths: string[] = [];
				if (ap.inputPath) paths.push(`input`);
				if (ap.outputPath) paths.push(`output`);
				if (ap.jsonlPath) paths.push(`session.jsonl`);
				if (ap.metadataPath) paths.push(`meta`);
				if (paths.length) lines.push(`        artifacts: ${paths.join(", ")} (under subagent-artifacts/)`);
			}
		}
		lines.push("");
	}
	// Summary: count failed steps and context overflows. An overflow is counted
	// once per failed result (the top-level error and the last attempt's error
	// are the same failure — don't sum both).
	const failedSteps = report.steps.filter((s) => s.results.some((r) => r.exitCode !== 0 || r.error)).length;
	const overflows = report.steps.reduce((a, s) => a + s.results.reduce((b, r) => {
		if (isContextOverflow(r.error)) return b + 1;
		if (r.attempts.some((x) => !x.success && isContextOverflow(x.error))) return b + 1;
		return b;
	}, 0), 0);
	lines.push(`── Summary ──`);
	lines.push(`${failedSteps} of ${report.steps.length} step(s) failed · ${overflows} context overflow(s)`);
	return { title: `Pipeline audit — ${report.steps.length} dispatch(es) · ${failedSteps} failed`, lines };
}

/* ──────────────────────── plan building ──────────────────────── */

/* ──────────────────────── tool-call budget ────────────────────────
 *
 * Soft enforcement of smaller batch sizes. When a step has maxTools, prepend
 * a hard, countable instruction to its task. The audit captures toolCount per
 * step, so compliance is directly measurable. If the model self-limits, this
 * is a cheap per-step lever; if not, escalate to a bounded agent variant
 * (tools: read, grep, write — no ls/find/bash).
 */

/** The budget instruction text (no TASK prefix). Empty string when no budget. */
export function toolBudgetInstruction(maxTools: number | undefined): string {
	if (maxTools == null) return "";
	return `TOOL BUDGET: You may make at most ${maxTools} tool calls total for this step. ` +
		`Count every read, ls, grep, find, and bash call. Plan your calls: prefer grep to locate, then read only what you need. ` +
		`When you have made ${maxTools} calls, STOP exploring immediately and write your output with what you have. ` +
		`Do not exceed ${maxTools} calls. Fewer is better if the output is ready.`;
}

/** Compose a step's final task text from its base task, optional hints, and an
 *  optional tool budget. When either hints or a budget is present, they prefix
 *  the task and a `TASK:` marker separates them from the base task. When
 *  neither is present, the base task is returned unchanged. */
export function composeStepTask(task: string, hints?: string[], maxTools?: number): string {
	const parts: string[] = [];
	const hintBlock = (hints ?? []).map((h) => h.trim()).filter(Boolean);
	if (hintBlock.length > 0) parts.push(`HINTS:\n${hintBlock.map((h) => `- ${h}`).join("\n")}`);
	const budget = toolBudgetInstruction(maxTools);
	if (budget) parts.push(budget);
	if (parts.length === 0) return task;
	return `${parts.join("\n\n")}\n\nTASK: ${task}`;
}

/** Back-compat alias: inject a budget into a task (no hints). */
export function withToolBudget(task: string, maxTools: number | undefined): string {
	return composeStepTask(task, undefined, maxTools);
}

export function buildPlan(params: PipelineParams): Plan {
	const effort: Effort = params.effort ?? inferEffort(params.task);
	const mode: Mode = params.mode ?? inferMode(params.task);
	const template =
		mode === "research" ? RESEARCH_TEMPLATES[effort] : IMPL_TEMPLATES[effort];
	const hints = (params.hints ?? []).map((h) => h.trim()).filter(Boolean);

	// Compose each step's task: hints + per-step tool budget (maxTools) + base
	// task. composeStepTask handles the prefix/TASK: marker consistently.
	return {
		...template,
		steps: template.steps.map((step) => ({
			...step,
			task: composeStepTask(step.task, hints, step.maxTools),
		})),
	};
}

export function summarizeCost(plan: Plan): string {
	// Aggregate per agent so the user sees the bill shape at a glance.
	// Agents are named profiles (dev/util/research/high) or custom agents;
	// real per-model cost is shown in the overview/dashboard from RunMetrics.
	const counts = new Map<string, number>();
	for (const s of plan.steps) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
	// Stable order: standard profiles first (in roster order), then any custom.
	const order = [...STANDARD_PROFILES];
	const seen = new Set(order);
	for (const a of counts.keys()) if (!seen.has(a)) order.push(a);
	return order
		.filter((a) => (counts.get(a) ?? 0) > 0)
		.map((a) => `${counts.get(a)} ${a}`)
		.join(" + ");
}

export function renderPlan(plan: Plan, task: string, dryRun: boolean): string {
	const stepCount = plan.steps.length;
	const agentCount = plan.steps.reduce(
		(acc, s) => {
			acc[s.agent] = (acc[s.agent] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);
	const breakdown = summarizeCost(plan);
	const costShape = breakdown;

	const lines: string[] = [
		`## Pipeline plan: mode=${plan.mode} effort=${plan.effort} (${breakdown}, ${stepCount} steps)`,
		`**Cost shape:** ${costShape}`,
		`**Dry run:** ${dryRun ? "yes (no subagent calls will be dispatched)" : "no"}`,
		"",
		`**Task:** ${task}`,
		"",
		`${plan.summary}`,
		"",
	];

	if (plan.mode === "research") {
		lines.push(
			"> **Research mode:** the parent (you) writes the spec from your context. " +
				"Pass the user's task into the partition step as its task text. " +
				"For parallel extraction slots, replace `<theme-N>` with the actual theme name from partition.md and pass the partition's per-theme file list as the task's `reads`. " +
				"After the merge step, summarize the result in the user's language.",
		);
		lines.push("");
	}

	for (let i = 0; i < plan.steps.length; i++) {
		const s = plan.steps[i];
		const parallelTag = s.parallel ? ` [parallel #${s.parallel}]` : "";
		const budgetTag = s.maxTools != null ? ` [budget: ${s.maxTools} tools]` : "";
		lines.push(
			`### Step ${i + 1} — ${s.phase}: ${s.label}${parallelTag}${budgetTag}  (${s.agent})`,
		);
		lines.push(`- **Agent:** \`${s.agent}\``);
		if (s.maxTools != null) lines.push(`- **Tool budget:** ${s.maxTools} calls (soft)`);
		if (s.output) lines.push(`- **Writes:** ${s.output}`);
		if (s.reads?.length) lines.push(`- **Reads:** ${s.reads.join(", ")}`);
		lines.push("");
		lines.push(s.task);
		lines.push("");
	}

	lines.push("---");
	lines.push("");
	lines.push(
		"**Execute each step with a `subagent` call. Pass the user's hints verbatim into each step's `task` if you added any. After the last step, summarize the result for the user in their language, with a one-line cost summary like `cost: " +
			costShape +
			"`.**",
	);
	lines.push("");
	if (plan.effort === "deep" && plan.mode === "implementation") {
		lines.push(
			"> **Deep kick-back loop:** If the final high-tier step returns `kick back`, the orchestrator may re-run the merge step (with feedback) up to 3 times total. If still rejected after 3 rounds, return the verdict to the user with the strongest unaddressed concerns.",
		);
	}

	// Dry-run footer.
	if (dryRun) {
		lines.push("");
		lines.push(
			"> **DRY RUN.** No subagent calls were made. To execute this plan, call the pipeline tool again with the same parameters (or omit `dryRun`).",
		);
	}

	return lines.join("\n");
}

/* ──────────────────────── wiring helpers (pure) ────────────────────────
 * Extracted from the event handlers so the model-injection and cost-step
 * logic is unit-testable without pi. The wiring in ./extension.ts calls
 * these; they have no side effects beyond mutating their `input` argument.
 */

/** Inject the configured tier model into subagent tool-call args for the
 *  util/research/high agents when the caller didn't set one. Mutates
 *  entries in place; returns the same input. Covers single, `tasks[]`
 *  (parallel), and `chain` (incl. `parallel` fanout groups) shapes. */
export function injectTierModels(
	input: Record<string, any>,
	tierModels: Record<Profile, string>,
): Record<string, any> {
	const inject = (entry: Record<string, any>) => {
		const a = entry["agent"];
		if (isTierAgent(a) && !entry["model"]) entry["model"] = tierModels[a];
	};
	if (Array.isArray(input["tasks"])) {
		for (const t of input["tasks"]) if (t && typeof t === "object") inject(t as Record<string, any>);
	} else if (Array.isArray(input["chain"])) {
		for (const step of input["chain"]) {
			if (step && typeof step === "object") inject(step as Record<string, any>);
			if (step && Array.isArray((step as any)["parallel"])) {
				for (const t of (step as any)["parallel"]) if (t && typeof t === "object") inject(t as Record<string, any>);
			}
		}
	} else {
		inject(input);
	}
	return input;
}

/** Build a CostStep from a subagent tool_result, or null if there are no
 *  results. `stepIndex` is the dispatch order (caller maintains counter). */
export function buildCostStep(
	input: Record<string, any>,
	details: { mode?: string; results?: any[] },
	stepIndex: number,
): CostStep | null {
	const results = Array.isArray(details?.results) ? details.results! : [];
	if (results.length === 0) return null;
	let agents: string;
	let taskSnip: string;
	if (Array.isArray(input["tasks"])) {
		agents = results.map((r: any) => r?.agent ?? "?").filter(Boolean).join(",") || "parallel";
		const first = (input["tasks"] as any[])[0]?.task ?? results[0]?.task ?? "";
		taskSnip = `${results.length} tasks · ${snippet(first, 64)}`;
	} else {
		agents = (input["agent"] as string) ?? results[0]?.agent ?? "?";
		taskSnip = snippet((input["task"] as string) ?? results[0]?.task, 80);
	}
	return { stepIndex, mode: details?.mode ?? "single", agent: agents, task: taskSnip, results: results.map((r: any) => mapResultEntry(r)) };
}

/** Fresh cost report for a new pipeline operation, seeded with plan metadata. */
export function newReport(plan: Plan, dryRun: boolean, planName?: string): PipelineCostReport {
	return {
		planName,
		planMode: plan.mode,
		planEffort: plan.effort,
		planStepCount: plan.steps.length,
		planCostShape: summarizeCost(plan),
		dryRun,
		steps: [],
	};
}

