/**
 * Pipeline workspace — run-scoped build directory, manifest, and artifact
 * retention. This module is pure: it depends only on node builtins (no pi
 * imports), so it is unit-testable with `node --test`.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ─────────────────────────── types ─────────────────────────── */

export interface ArtifactsConfig {
  root: string;                     // where run workspaces live (relative to project_dir)
  retain_runs: "never" | "failed" | "always";
  retain_logs: "never" | "failed" | "always";
  temp_root: string | null;       // null → <run_dir>/temp
  max_retained_runs: number;
}

const ARTIFACTS_DEFAULTS: ArtifactsConfig = {
  root: ".pi/run",
  retain_runs: "failed",
  retain_logs: "always",
  temp_root: null,
  max_retained_runs: 20,
};

export interface WorkspaceInfo {
  runId: string;                    // <recipe>-<yyyymmdd>-<hex6>
  dir: string;                      // absolute
  targetsDir: string;               // dir/targets
  collectionsDir: string;           // dir/collections
  logsDir: string;                  // dir/logs
  tempRoot: string;                 // dir/temp or external temp
  manifestPath: string;             // dir/manifest.json
}

export interface ManifestUnitEntry {
  key: string;                     // unit identifier (e.g. src/auth.ts)
  status: "completed" | "failed";
  error?: string;
}

export interface ManifestOutputEntry {
  name: string;
  kind: "singleton" | "collection";
  path: string;                    // relative to workspace root
  units?: ManifestUnitEntry[];
}

export interface ManifestStep {
  id: string;
  phase: string;
  agent: string;
  reads?: string[];
  outputs?: ManifestOutputEntry[];
  status: "pending" | "running" | "completed" | "failed" | "partial" | "blocked";
  attempts?: number;
  usage?: {
    input: number;
    output: number;
    cost: number;
  };
}

export interface Manifest {
  run_id: string;
  recipe: string;
  started_at: string;
  project_dir: string;
  workspace_dir: string;
  steps: ManifestStep[];
  deliverables: unknown[];
  finalized_at?: string;
  status?: "completed" | "failed" | "partial";
}

/* ──────────────────────── run id ──────────────────────── */

export function mintRunId(recipe: string, now?: Date): string {
  const d = now ?? new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, "");
  const hex = crypto.randomBytes(3).toString("hex"); // hex6
  return `${recipe}-${date}-${hex}`;
}

/* ──────────────────────── workspace creation ──────────────────────── */

export function createWorkspace(projectDir: string, recipe: string, cfg: ArtifactsConfig, now?: Date): WorkspaceInfo {
  const runId = mintRunId(recipe, now);
  const dir = path.resolve(projectDir, cfg.root, runId);
  const targetsDir = path.join(dir, "targets");
  const collectionsDir = path.join(dir, "collections");
  const logsDir = path.join(dir, "logs");
  const tempRoot = cfg.temp_root
    ? path.resolve(projectDir, cfg.temp_root, runId)
    : path.join(dir, "temp");

  // mkdirSync with recursive:true is idempotent; safe to call on re-runs.
  fs.mkdirSync(targetsDir, { recursive: true });
  fs.mkdirSync(collectionsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  return {
    runId,
    dir,
    targetsDir,
    collectionsDir,
    logsDir,
    tempRoot,
    manifestPath: path.join(dir, "manifest.json"),
  };
}

/* ──────────────────────── manifest I/O ──────────────────────── */

export function writeManifestShell(ws: WorkspaceInfo, recipe: string, projectDir: string): void {
  const manifest: Manifest = {
    run_id: ws.runId,
    recipe,
    started_at: new Date().toISOString(),
    project_dir: projectDir,
    workspace_dir: path.relative(projectDir, ws.dir),
    steps: [],
    deliverables: [],
  };
  fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
}

export function readManifest(manifestPath: string): Manifest {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw);
}

export function updateManifestStep(ws: WorkspaceInfo, step: ManifestStep): void {
  const manifest = readManifest(ws.manifestPath);
  const idx = manifest.steps.findIndex((s) => s.id === step.id);
  if (idx >= 0) manifest.steps[idx] = step;
  else manifest.steps.push(step);
  fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
}

/** Derive the run's overall status from its step statuses.
 *  Any failed step -> "failed"; any step with a partial collection -> "partial";
 *  all steps completed -> "completed". Pending/running/blocked steps leave
 *  the run uncompleted (the caller should not call finalizeManifest until
 *  every step has a terminal status). */
export function deriveRunStatus(steps: ManifestStep[]): Manifest["status"] {
  let anyFailed = false;
  let anyPartial = false;
  let allCompleted = true;
  for (const step of steps) {
    if (step.status === "failed") anyFailed = true;
    if (step.status === "partial") anyPartial = true;
    if (step.status !== "completed") allCompleted = false;
  }
  if (anyFailed || anyPartial) return anyFailed ? "failed" : "partial";
  if (allCompleted && steps.length > 0) return "completed";
  return undefined;
}

export function finalizeManifest(ws: WorkspaceInfo, status?: Manifest["status"]): void {
  const manifest = readManifest(ws.manifestPath);
  manifest.finalized_at = new Date().toISOString();
  manifest.status = status ?? deriveRunStatus(manifest.steps);
  fs.writeFileSync(ws.manifestPath, JSON.stringify(manifest, null, 2));
}

/* ──────────────────────── config ──────────────────────── */

export function loadArtifactsConfig(settingsPath?: string): ArtifactsConfig {
  const out = { ...ARTIFACTS_DEFAULTS };
  try {
    const raw = fs.readFileSync(
      settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    const cfg = parsed?.pipeline?.artifacts;
    if (cfg && typeof cfg === "object") {
      if (typeof cfg.root === "string") out.root = cfg.root;
      if (cfg.retain_runs === "never" || cfg.retain_runs === "failed" || cfg.retain_runs === "always") {
        out.retain_runs = cfg.retain_runs;
      }
      if (cfg.retain_logs === "never" || cfg.retain_logs === "failed" || cfg.retain_logs === "always") {
        out.retain_logs = cfg.retain_logs;
      }
      if (cfg.temp_root === null || typeof cfg.temp_root === "string") out.temp_root = cfg.temp_root;
      if (typeof cfg.max_retained_runs === "number") out.max_retained_runs = cfg.max_retained_runs;
    }
  } catch {
    /* missing/unreadable/unparsable settings → use defaults */
  }
  return out;
}

/* ──────────────────────── retention / cleanup ──────────────────────── */

interface RunDir {
  dir: string;
  manifestPath: string;
  mtime: number;                        // ms since epoch
  status?: Manifest["status"];
}

function collectRunDirs(root: string): RunDir[] {
  const entries: RunDir[] = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const manifestPath = path.join(dir, "manifest.json");
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) continue;
        let status: Manifest["status"] | undefined;
        try {
          status = readManifest(manifestPath).status;
        } catch {
          /* no manifest → treat as unknown status */
        }
        entries.push({ dir, manifestPath, mtime: stat.mtime.getTime(), status });
      } catch {
        continue;
      }
    }
  } catch {
    /* root may not exist yet → no runs to delete */
  }
  return entries;
}

function shouldDelete(manifestStatus: Manifest["status"] | undefined, retainPolicy: string): boolean {
  if (retainPolicy === "always") return false;
  if (retainPolicy === "never") return true;
  // "failed": keep failed and partial, delete completed
  if (retainPolicy === "failed") {
    return manifestStatus !== "failed" && manifestStatus !== "partial";
  }
  return false;
}

export function cleanupRuns(projectDir: string, cfg: ArtifactsConfig): void {
  const root = path.resolve(projectDir, cfg.root);
  const runs = collectRunDirs(root);
  // First pass: delete expired by policy
  for (const r of runs) {
    if (shouldDelete(r.status, cfg.retain_runs)) {
      try {
        fs.rmSync(r.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  // Second pass: enforce max_retained_runs cap on survivors
  const survivors = collectRunDirs(root); // re-read after deletions
  if (survivors.length <= cfg.max_retained_runs) return;
  // delete oldest first
  survivors.sort((a, b) => a.mtime - b.mtime);
  const toDelete = survivors.slice(0, survivors.length - cfg.max_retained_runs);
  for (const r of toDelete) {
    try {
      fs.rmSync(r.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
