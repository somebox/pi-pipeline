/**
 * Unit tests for src/checkpoint.ts (checkpoint pause/resume helpers) and the
 * paused-run workspace semantics. No pi imports, no SDK.
 *
 *   node --test --experimental-strip-types test/checkpoint.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	pendingCheckpoint,
	validateResumeDecision,
	applyCheckpointFeedback,
	renderPausedResult,
	renderRejectionResult,
	renderRevisionResult,
	isCheckpointDecision,
} from "../src/checkpoint.ts";
import {
	createWorkspace,
	writeManifestShell,
	updateManifestStep,
	patchManifest,
	readManifest,
	latestIncomplete,
	listRuns,
} from "../src/workspace.ts";
import type { Manifest } from "../src/workspace.ts";
import type { Plan } from "../src/lib.ts";

const plan: Plan = {
	effort: "standard",
	mode: "research",
	summary: "",
	steps: [
		{ phase: "Discover", agent: "util", label: "d", task: "d" },
		{ phase: "Present candidates", agent: "high", label: "p", task: "p", checkpoint: "candidate-sprint" },
		{ phase: "Normalize", agent: "high", label: "n", task: "n" },
	],
};

function pausedManifest(overrides: Partial<Manifest> = {}): Manifest {
	const base: Manifest = {
		run_id: "2026-08-30-000000-sprint-planning",
		recipe: "sprint-planning",
		started_at: "2026-08-30T00:00:00Z",
		project_dir: "/x",
		workspace_dir: ".pi/pipeline/x",
		steps: [
			{ id: "discover", phase: "Discover", agent: "util", status: "completed" },
			{ id: "present_candidates", phase: "Present candidates", agent: "high", status: "completed", checkpoint: "candidate-sprint" },
			{ id: "normalize", phase: "Normalize", agent: "high", status: "pending" },
		],
		deliverables: [],
		status: "paused",
	};
	return { ...base, ...overrides };
}

/* ─────────── pendingCheckpoint ─────────── */

test("pendingCheckpoint: only paused runs with an undetermined completed checkpoint", () => {
	assert.equal(pendingCheckpoint(pausedManifest({ status: "running" })), undefined);
	assert.deepEqual(pendingCheckpoint(pausedManifest()), { token: "candidate-sprint", stepId: "present_candidates" });
	// an already-decided checkpoint is not pending
	assert.equal(
		pendingCheckpoint(pausedManifest({ checkpoints: { "candidate-sprint": { step_id: "present_candidates", decision: "approve", decided_at: "2026-08-30T00:01:00Z" } } })),
		undefined,
	);
	// the last undetermined completed checkpoint wins
	const man = pausedManifest();
	man.steps.push({ id: "plan", phase: "Plan", agent: "high", status: "completed", checkpoint: "plan-approved" });
	assert.deepEqual(pendingCheckpoint(man), { token: "plan-approved", stepId: "plan" });
});

/* ─────────── validateResumeDecision ─────────── */

test("validateResumeDecision: non-paused run — no params is fine, params are refused", () => {
	const man = pausedManifest({ status: "aborted" });
	assert.deepEqual(validateResumeDecision({ manifest: man, plan }), { kind: "none" });
	const err = validateResumeDecision({ manifest: man, plan, checkpoint: "candidate-sprint", decision: "approve" });
	assert.equal(err.kind, "error");
	if (err.kind === "error") assert.ok(err.error.includes("only valid when resuming a paused run"));
});

test("validateResumeDecision: paused run without a decision fails safely", () => {
	const man = pausedManifest();
	const noTok = validateResumeDecision({ manifest: man, plan });
	assert.equal(noTok.kind, "error");
	if (noTok.kind === "error") {
		assert.ok(noTok.error.includes("candidate-sprint"));
		assert.ok(noTok.error.includes("checkpointDecision"));
	}
	const noDec = validateResumeDecision({ manifest: man, plan, checkpoint: "candidate-sprint" });
	assert.equal(noDec.kind, "error");
	const badDec = validateResumeDecision({ manifest: man, plan, checkpoint: "candidate-sprint", decision: "maybe" });
	assert.equal(badDec.kind, "error");
});

test("validateResumeDecision: mismatched token is refused", () => {
	const badTok = validateResumeDecision({ manifest: pausedManifest(), plan, checkpoint: "other-token", decision: "approve" });
	assert.equal(badTok.kind, "error");
	if (badTok.kind === "error") {
		assert.ok(badTok.error.includes("mismatch"));
		assert.ok(badTok.error.includes("candidate-sprint"));
		assert.ok(badTok.error.includes("other-token"));
	}
});

test("validateResumeDecision: valid approve/reject/revise with note", () => {
	for (const decision of ["approve", "reject", "revise"] as const) {
		const v = validateResumeDecision({ manifest: pausedManifest(), plan, checkpoint: "candidate-sprint", decision, note: "  drop item X " });
		assert.equal(v.kind, "decision");
		if (v.kind === "decision") {
			assert.equal(v.token, "candidate-sprint");
			assert.equal(v.stepIndex, 1);
			assert.equal(v.decision, decision);
			assert.equal(v.note, "drop item X");
		}
	}
});

test("validateResumeDecision: paused run whose checkpoint is missing from the plan is refused", () => {
	const man = pausedManifest();
	const planWithout = { ...plan, steps: plan.steps.map((s, i) => (i === 1 ? { ...s, checkpoint: undefined } : s)) };
	const v = validateResumeDecision({ manifest: man, plan: planWithout, checkpoint: "candidate-sprint", decision: "approve" });
	assert.equal(v.kind, "error");
});

test("isCheckpointDecision: accepts the three decisions only", () => {
	assert.equal(isCheckpointDecision("approve"), true);
	assert.equal(isCheckpointDecision("reject"), true);
	assert.equal(isCheckpointDecision("revise"), true);
	assert.equal(isCheckpointDecision("merge"), false);
	assert.equal(isCheckpointDecision(undefined), false);
});

/* ─────────── applyCheckpointFeedback ─────────── */

test("applyCheckpointFeedback: banner only on steps after the checkpoint step", () => {
	const out = applyCheckpointFeedback(plan, 1, "drop item X");
	assert.equal(out.steps[0]!.task, "d");
	assert.equal(out.steps[1]!.task, "p");
	assert.ok(out.steps[2]!.task.startsWith("USER CHECKPOINT FEEDBACK"));
	assert.ok(out.steps[2]!.task.includes("drop item X"));
	assert.ok(out.steps[2]!.task.endsWith("n"));
	// empty note is a no-op returning the same plan; input is not mutated
	assert.equal(applyCheckpointFeedback(plan, 1, "   "), plan);
	assert.equal(plan.steps[2]!.task, "n");
});

/* ─────────── result renderers ─────────── */

test("renderPausedResult: run id, token, output paths, exact resume syntax", () => {
	const text = renderPausedResult({
		runId: "r1",
		token: "candidate-sprint",
		runDir: "/p/.pi/pipeline/r1",
		outputPaths: ["/p/.pi/pipeline/r1/targets/candidate_sprint.md"],
		readmePath: "/p/.pi/pipeline/r1/README.md",
	});
	assert.ok(text.includes("`r1`"));
	assert.ok(text.includes("`candidate-sprint`"));
	assert.ok(text.includes("/p/.pi/pipeline/r1/targets/candidate_sprint.md"));
	assert.ok(text.includes("/p/.pi/pipeline/r1/README.md"));
	assert.ok(text.includes('"resume": "r1"'));
	assert.ok(text.includes('"checkpoint": "candidate-sprint"'));
	assert.ok(text.includes("checkpointDecision"));
	assert.ok(text.includes("checkpointNote"));
});

test("renderRejectionResult: records the rejection and the note", () => {
	const text = renderRejectionResult("r1", "candidate-sprint", "not now");
	assert.ok(text.includes("`r1`"));
	assert.ok(text.includes("rejected"));
	assert.ok(text.includes("not now"));
	assert.ok(text.includes("No later steps were executed"));
});

test("renderRevisionResult: instructs a fresh run with the steering", () => {
	const text = renderRevisionResult("r1", "candidate-sprint", "sprint-planning", "focus on auth");
	assert.ok(text.includes("`r1`"));
	assert.ok(text.includes("rejected"));
	assert.ok(text.includes("fresh"));
	assert.ok(text.includes('"pipeline": "sprint-planning"'));
	assert.ok(text.includes("focus on auth"));
});

/* ─────────── paused-run workspace semantics ─────────── */

test("workspace: paused runs are discoverable by latestIncomplete; rejected runs are not", () => {
	const tmp = path.join(os.tmpdir(), `pi-pipeline-checkpoint-ws-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const ws = createWorkspace(tmp, "sprint-planning");
	writeManifestShell(ws, "sprint-planning", tmp);
	updateManifestStep(ws, { id: "present_candidates", phase: "Present candidates", agent: "high", status: "completed", checkpoint: "candidate-sprint" });
	patchManifest(ws, { status: "paused" });

	const found = latestIncomplete(tmp);
	assert.ok(found, "paused run should be the latest incomplete");
	assert.equal(found!.runId, ws.runId);
	assert.equal(readManifest(ws.manifestPath).status, "paused");

	// a newer finalized/rejected run must NOT shadow the paused one
	const ws2 = createWorkspace(tmp, "sprint-planning");
	writeManifestShell(ws2, "sprint-planning", tmp);
	patchManifest(ws2, { status: "rejected" });
	assert.equal(latestIncomplete(tmp)!.runId, ws.runId);
	assert.ok(listRuns(tmp).some((r) => r.status === "rejected"));
	fs.rmSync(tmp, { recursive: true, force: true });
});
