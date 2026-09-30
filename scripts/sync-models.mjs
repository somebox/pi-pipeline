#!/usr/bin/env node

/**
 * Generate explicit pi-subagents agentOverrides from the canonical model map.
 *
 * Usage:
 *   npm run sync-models
 *   node scripts/sync-models.mjs --check
 *   node scripts/sync-models.mjs --settings /tmp/settings.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(packageRoot, "config", "models.json");
const defaultSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

function argValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Does an `enabledModels` pattern cover a `provider/id` model? Exact ids and
 *  `*`/`?` globs (optionally with a `:thinking` suffix), matched against the
 *  full id or the id without its provider, case-insensitively — the common
 *  subset of pi's scope matching. */
function scopePatternMatches(pattern, model) {
	if (typeof pattern !== "string") return false;
	const glob = pattern.replace(/:(off|minimal|low|medium|high|xhigh)$/, "");
	const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
	return re.test(model) || re.test(model.replace(/^[^/]+\//, ""));
}

const check = process.argv.includes("--check");
const settingsPath = path.resolve(argValue("--settings") ?? defaultSettingsPath);
const config = JSON.parse(fs.readFileSync(argValue("--config") ?? configPath, "utf8"));
const models = config.models;
const agents = config.agents;

if (!models || typeof models !== "object" || !agents || typeof agents !== "object") {
	throw new Error("Model config must contain object-valued models and agents fields.");
}

const expected = {};
for (const [agent, alias] of Object.entries(agents)) {
	if (typeof alias !== "string" || typeof models[alias] !== "string" || !models[alias].trim()) {
		throw new Error(`Agent ${JSON.stringify(agent)} references unknown model alias ${JSON.stringify(alias)}.`);
	}
	expected[agent] = models[alias].trim();
}

let settings;
try {
	settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (error) {
	throw new Error(`Could not read settings file ${settingsPath}: ${error.message}`);
}

if (!settings.subagents || typeof settings.subagents !== "object") settings.subagents = {};
if (!settings.subagents.agentOverrides || typeof settings.subagents.agentOverrides !== "object") {
	settings.subagents.agentOverrides = {};
}

const changes = [];
for (const [agent, model] of Object.entries(expected)) {
	const override = settings.subagents.agentOverrides[agent];
	if (!override || typeof override !== "object") {
		settings.subagents.agentOverrides[agent] = { model };
		changes.push(`${agent}: (unset) → ${model}`);
		continue;
	}
	if (override.model !== model) {
		changes.push(`${agent}: ${override.model ?? "(unset)"} → ${model}`);
		settings.subagents.agentOverrides[agent] = { ...override, model };
	}
}

// When settings scope models (`enabledModels`, the /scoped-models list), the
// pipeline refuses to run a model outside that scope, so add any newly
// mapped model. Existing entries are never removed.
if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
	const inScope = (model) => settings.enabledModels.some((pattern) => scopePatternMatches(pattern, model));
	for (const model of new Set(Object.values(expected))) {
		if (inScope(model)) continue;
		settings.enabledModels.push(model);
		changes.push(`enabledModels: + ${model}`);
	}
}

if (check) {
	if (changes.length > 0) {
		console.error(`Model settings are out of sync in ${settingsPath}:`);
		for (const change of changes) console.error(`  ${change}`);
		process.exitCode = 1;
	} else {
		console.log(`Model settings are in sync with ${path.relative(process.cwd(), configPath) || configPath}.`);
	}
} else if (changes.length > 0) {
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
	console.log(`Updated ${settingsPath}:`);
	for (const change of changes) console.log(`  ${change}`);
} else {
	console.log(`No model changes needed in ${settingsPath}.`);
}
