/**
 * Checkpoint decision helpers — pure logic (no fs, no pi imports).
 *
 * A recipe step can declare `checkpoint=<token>`. When that step COMPLETES,
 * the pipeline tool pauses the run (manifest status "paused") and returns a
 * tool result with the run id, checkpoint token, relevant output paths, and
 * the exact resume syntax. No blocking UI is called at the checkpoint.
 *
 * Resuming a paused run requires the matching checkpoint token plus a
 * decision:
 *   - approve: keep the completed checkpoint step (planDelta skips it),
 *     record the decision/note, resume the later steps, and inject a
 *     non-empty note into the remaining steps as USER CHECKPOINT FEEDBACK.
 *   - reject: record the rejection and finalize the run (status "rejected")
 *     without executing later steps.
 *   - revise: record major-revision feedback, stop the run (status
 *     "rejected"), and return instructions to start a fresh run of the same
 *     recipe with that steering.
 *
 * Resume without a decision, or with a mismatched token, fails safely.
 * Recipe hash drift is refused before any checkpoint logic runs.
 */

import type { Plan } from "./lib.ts";
import type { Manifest } from "./workspace.ts";

export type CheckpointDecision = "approve" | "reject" | "revise";

export const CHECKPOINT_DECISIONS: readonly CheckpointDecision[] = ["approve", "reject", "revise"];

/** True when v is one of the valid checkpoint decisions. */
export function isCheckpointDecision(v: unknown): v is CheckpointDecision {
	return typeof v === "string" && (CHECKPOINT_DECISIONS as readonly string[]).includes(v);
}

/** The run's pending checkpoint: the last completed step carrying a
 *  checkpoint token that has no recorded decision yet. Returns undefined when
 *  the run is not paused or no undetermined checkpoint exists. */
export function pendingCheckpoint(manifest: Manifest): { token: string; stepId: string } | undefined {
	if (manifest.status !== "paused") return undefined;
	let found: { token: string; stepId: string } | undefined;
	for (const s of manifest.steps) {
		if (s.checkpoint && s.status === "completed" && !manifest.checkpoints?.[s.checkpoint]) {
			found = { token: s.checkpoint, stepId: s.id };
		}
	}
	return found;
}

export type ResumeDecisionVerdict =
	| { kind: "error"; error: string }
	| { kind: "none" }
	| { kind: "decision"; token: string; stepIndex: number; decision: CheckpointDecision; note?: string };

/** Validate the checkpoint params of a resume against the run manifest.
 *  - Non-paused run + any checkpoint param  → error (params only valid on a
 *    paused resume).
 *  - Non-paused run, no params               → "none" (ordinary resume).
 *  - Paused run, no params / bad token / bad
 *    decision                                → error (fails safely).
 *  - Paused run, matching token + decision   → "decision". */
export function validateResumeDecision(params: {
	manifest: Manifest;
	plan: Plan;
	checkpoint?: string;
	decision?: string;
	note?: string;
}): ResumeDecisionVerdict {
	const { manifest, plan } = params;
	const hasCheckpointParams =
		params.checkpoint !== undefined ||
		params.decision !== undefined ||
		(typeof params.note === "string" && params.note.trim() !== "");
	if (manifest.status !== "paused") {
		if (hasCheckpointParams) {
			return {
				kind: "error",
				error: `checkpoint / checkpointDecision / checkpointNote are only valid when resuming a paused run (run ${manifest.run_id} has status "${manifest.status ?? "running"}").`,
			};
		}
		return { kind: "none" };
	}
	const pending = pendingCheckpoint(manifest);
	if (!pending) {
		return {
			kind: "error",
			error: `Run ${manifest.run_id} is paused but has no pending checkpoint in its manifest; there is nothing to decide.`,
		};
	}
	if (params.checkpoint === undefined) {
		return {
			kind: "error",
			error: `Run ${manifest.run_id} is paused at checkpoint "${pending.token}" and requires a decision. Resume with the pipeline tool: resume="${manifest.run_id}", checkpoint="${pending.token}", checkpointDecision="approve" | "reject" | "revise" (plus an optional checkpointNote).`,
		};
	}
	if (params.checkpoint !== pending.token) {
		return {
			kind: "error",
			error: `Checkpoint token mismatch for run ${manifest.run_id}: expected "${pending.token}" but got "${params.checkpoint}".`,
		};
	}
	if (params.decision === undefined || params.decision === "") {
		return {
			kind: "error",
			error: `Run ${manifest.run_id} is paused at checkpoint "${pending.token}" and requires checkpointDecision (${CHECKPOINT_DECISIONS.join(" | ")}).`,
		};
	}
	if (!isCheckpointDecision(params.decision)) {
		return {
			kind: "error",
			error: `Invalid checkpointDecision "${params.decision}". Valid decisions: ${CHECKPOINT_DECISIONS.join(", ")}.`,
		};
	}
	const stepIndex = plan.steps.findIndex((s) => s.checkpoint === pending.token);
	if (stepIndex < 0) {
		return {
			kind: "error",
			error: `Checkpoint "${pending.token}" is not present in the current plan for run ${manifest.run_id}; refusing to resume.`,
		};
	}
	return {
		kind: "decision",
		token: pending.token,
		stepIndex,
		decision: params.decision,
		note: params.note && params.note.trim() ? params.note.trim() : undefined,
	};
}

/** Prepend the approved checkpoint's feedback banner to every step AFTER the
 *  checkpoint step (the remaining steps of a resumed run). Steps at or before
 *  the checkpoint index are untouched; an empty note is a no-op. Returns a new
 *  Plan; the input is not mutated. */
export function applyCheckpointFeedback(plan: Plan, checkpointStepIndex: number, note: string): Plan {
	const trimmed = (note ?? "").trim();
	if (!trimmed || checkpointStepIndex < 0) return plan;
	const banner =
		`USER CHECKPOINT FEEDBACK — the user approved the checkpoint with the following steering. ` +
		`Incorporate it into your work:\n${trimmed}`;
	return {
		...plan,
		steps: plan.steps.map((s, i) => (i > checkpointStepIndex ? { ...s, task: `${banner}\n\n${s.task}` } : s)),
	};
}

export interface PausedRunInfo {
	runId: string;
	token: string;
	runDir: string;
	outputPaths: string[];
	readmePath: string;
}

/** The tool result body for a run that just paused at a checkpoint: run id,
 *  checkpoint token, relevant output paths, and the exact resume syntax. */
export function renderPausedResult(info: PausedRunInfo): string {
	const lines: string[] = [];
	lines.push(`## Paused at checkpoint \`${info.token}\``);
	lines.push("");
	lines.push(`The checkpoint step completed and the run is now **paused** — no further steps will run until a decision is recorded.`);
	lines.push("");
	lines.push(`- **Run id:** \`${info.runId}\``);
	lines.push(`- **Checkpoint:** \`${info.token}\``);
	lines.push(`- **Run dir:** \`${info.runDir}\``);
	if (info.outputPaths.length > 0) {
		lines.push(`- **Outputs:**`);
		for (const p of info.outputPaths) lines.push(`  - \`${p}\``);
	}
	lines.push(`- **Run log:** \`${info.readmePath}\``);
	lines.push("");
	lines.push(`**Resume with the pipeline tool:**`);
	lines.push("");
	lines.push("```json");
	lines.push(
		JSON.stringify(
			{
				resume: info.runId,
				checkpoint: info.token,
				checkpointDecision: "approve | reject | revise",
				checkpointNote: "optional feedback / steering",
			},
			null,
			2,
		),
	);
	lines.push("```");
	lines.push("");
	lines.push(`- **approve** — keep the completed checkpoint step and continue with the remaining steps. Pass feedback via \`checkpointNote\`; a non-empty note is injected into every remaining step as USER CHECKPOINT FEEDBACK.`);
	lines.push(`- **reject** — finalize this run now; no later steps are executed.`);
	lines.push(`- **revise** — stop this run and start a fresh run of the same recipe, using your note as steering for the new run.`);
	return lines.join("\n");
}

/** The tool result body for a run finalized by a `reject` decision. */
export function renderRejectionResult(runId: string, token: string, note?: string): string {
	const lines: string[] = [];
	lines.push(`## Checkpoint \`${token}\` — rejected`);
	lines.push("");
	lines.push(`Run \`${runId}\` has been finalized with status **rejected**. No later steps were executed.`);
	if (note) {
		lines.push("");
		lines.push(`Recorded note:`);
		lines.push("");
		lines.push(note);
	}
	lines.push("");
	lines.push(`If the work should still happen, start a fresh run of the same recipe.`);
	return lines.join("\n");
}

/** The tool result body for a run stopped by a `revise` decision: explicit
 *  instructions to start a fresh run of the recipe with the recorded steering. */
export function renderRevisionResult(runId: string, token: string, recipeName: string, note?: string): string {
	const lines: string[] = [];
	lines.push(`## Checkpoint \`${token}\` — major revision recorded`);
	lines.push("");
	lines.push(`Run \`${runId}\` has been stopped and finalized with status **rejected**. Do not resume it and do not continue its later steps.`);
	lines.push("");
	lines.push(`Start a **fresh** run of the \`${recipeName}\` recipe with this steering:`);
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify({ pipeline: recipeName, inputs: { focus: note ?? "" } }, null, 2));
	lines.push("```");
	lines.push("");
	lines.push(`Steering to carry into the new run:`);
	lines.push("");
	lines.push(note ? note : "(no note was provided; ask the user for the desired revision before starting the fresh run)");
	return lines.join("\n");
}
