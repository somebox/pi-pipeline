/**
 * Guards against the "structured_output silently unavailable" regression.
 *
 * pi-subagents' `--tools` flag is a strict *allowlist* over built-in,
 * extension, AND custom tools (see docs/usage.md in @earendil-works/pi-coding-agent).
 * Because `structured_output` is a dynamically-registered extension tool
 * (only present when a chain step declares `outputSchema`), any agent that
 * declares an explicit `tools:` frontmatter list must include
 * `structured_output` in it, or every `outputSchema` step routed to that
 * agent fails with "Missing structured_output call" even though the model
 * did everything else right.
 *
 * This test reads the shipped agents/*.md files directly (no fs mocking —
 * these are the actual files shipped in the package) and asserts the
 * invariant holds for all of them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const AGENTS_DIR = path.join(import.meta.dirname, "..", "agents");

function parseToolsLine(raw: string): string[] | undefined {
	const match = raw.match(/^tools:\s*(.+)$/m);
	if (!match) return undefined;
	return match[1]!.split(",").map((t) => t.trim()).filter(Boolean);
}

function shippedAgentFiles(): string[] {
	return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
}

test("every shipped agent with an explicit tools: allowlist includes structured_output", () => {
	const files = shippedAgentFiles();
	assert.ok(files.length > 0, "expected at least one agent file under agents/");
	for (const file of files) {
		const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
		const tools = parseToolsLine(raw);
		if (tools === undefined) continue; // no explicit allowlist — inherits everything, fine
		assert.ok(
			tools.includes("structured_output"),
			`${file}: tools: allowlist is missing "structured_output" — any outputSchema step ` +
				`routed to this agent will fail with "Missing structured_output call" even when the ` +
				`model behaves correctly. Add structured_output to the tools: line.`,
		);
	}
});
