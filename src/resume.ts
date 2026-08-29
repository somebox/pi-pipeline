/**
 * Resume helpers: match a prior run, refuse recipe drift, skip completed steps.
 */

import fs from "node:fs";
import path from "node:path";
import type { Plan, PlanStep } from "./lib.ts";
import type { Manifest, ManifestStep, WorkspaceInfo } from "./workspace.ts";
import { hashRecipe } from "./workspace.ts";

export type ResumeAction = "skip" | "run" | "retry-units";

export interface StepDelta {
	step: PlanStep;
	action: ResumeAction;
	unitKeys?: string[];
}

export function stepId(step: PlanStep): string {
	return step.phase.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

export function recipeHashMismatch(manifest: Manifest, recipeRaw: string): string | undefined {
	if (!manifest.recipe_hash) return undefined;
	const current = hashRecipe(recipeRaw);
	if (current === manifest.recipe_hash) return undefined;
	return `Recipe "${manifest.recipe}" has changed since run ${manifest.run_id} (hash ${manifest.recipe_hash} → ${current}). Refusing to resume. Re-run the pipeline from scratch, or restore the original recipe.`;
}

function outputExists(ws: WorkspaceInfo, step: ManifestStep): boolean {
	const outputs = step.outputs ?? [];
	if (outputs.length === 0) return true;
	return outputs.every((o) => {
		const abs = path.isAbsolute(o.path) ? o.path : path.join(ws.dir, o.path);
		try {
			return fs.existsSync(abs);
		} catch {
			return false;
		}
	});
}

export function planDelta(plan: Plan, manifest: Manifest, ws: WorkspaceInfo): StepDelta[] {
	const byId = new Map<string, ManifestStep>();
	for (const s of manifest.steps) byId.set(s.id, s);
	return plan.steps.map((step) => {
		const id = stepId(step);
		const ms = byId.get(id);
		if (!ms) return { step, action: "run" as const };
		if (ms.status === "partial" && step.iterate) {
			const units = ms.outputs?.[0]?.units ?? [];
			const failed = units.filter((u) => u.status === "failed").map((u) => u.key);
			if (failed.length > 0) return { step, action: "retry-units" as const, unitKeys: failed };
		}
		if (ms.status === "completed" && outputExists(ws, ms)) {
			return { step, action: "skip" as const };
		}
		return { step, action: "run" as const };
	});
}

export function filterUnits<T extends Record<string, unknown>>(
	units: T[],
	unitKeys: string[],
): T[] {
	const want = new Set(unitKeys);
	return units.filter((u, i) => {
		const key = String((u as any).path ?? (u as any).id ?? `unit-${i}`);
		return want.has(key);
	});
}
