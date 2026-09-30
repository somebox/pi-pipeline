/**
 * Tests for scripts/sync-models.mjs, run as a child process against temp
 * settings/config files (never the real ~/.pi/agent/settings.json).
 *
 *   node --test --experimental-strip-types test/sync-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.join(import.meta.dirname, "..", "scripts", "sync-models.mjs");

function run(settings: unknown, config: unknown, ...args: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-models-"));
	const settingsPath = path.join(dir, "settings.json");
	const configPath = path.join(dir, "models.json");
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	fs.writeFileSync(configPath, JSON.stringify(config));
	const r = spawnSync(process.execPath, [script, "--settings", settingsPath, "--config", configPath, ...args], { encoding: "utf8" });
	return { status: r.status, out: r.stdout + r.stderr, settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

const config = { models: { low: "openrouter/~z-ai/glm-flash-latest", high: "openrouter/~openai/gpt-sol-latest" }, agents: { util: "low", high: "high" } };

test("sync-models: adds newly mapped models to a non-empty enabledModels, keeps existing entries", () => {
	const r = run({ enabledModels: ["openrouter/minimax/minimax-m3", "openrouter/~openai/gpt-sol-latest"] }, config);
	assert.equal(r.status, 0);
	assert.deepEqual(r.settings.enabledModels, ["openrouter/minimax/minimax-m3", "openrouter/~openai/gpt-sol-latest", "openrouter/~z-ai/glm-flash-latest"]);
	assert.equal(r.settings.subagents.agentOverrides.util.model, "openrouter/~z-ai/glm-flash-latest");
});

test("sync-models: glob and thinking-suffixed patterns count as in scope", () => {
	const r = run({ enabledModels: ["openrouter/~z-ai/*", "~openai/gpt-sol-latest:high"] }, config);
	assert.deepEqual(r.settings.enabledModels, ["openrouter/~z-ai/*", "~openai/gpt-sol-latest:high"]);
});

test("sync-models: no enabledModels means no scope to extend", () => {
	const r = run({}, config);
	assert.equal(r.settings.enabledModels, undefined);
});

test("sync-models --check: reports a missing scope entry and does not write", () => {
	const settings = { enabledModels: ["openrouter/minimax/minimax-m3"], subagents: { agentOverrides: { util: { model: "openrouter/~z-ai/glm-flash-latest" }, high: { model: "openrouter/~openai/gpt-sol-latest" } } } };
	const r = run(settings, config, "--check");
	assert.equal(r.status, 1);
	assert.match(r.out, /enabledModels: \+ openrouter\/~z-ai\/glm-flash-latest/);
	assert.deepEqual(r.settings, settings);
});
