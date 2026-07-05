/**
 * Unit tests for src/discovery.ts. Uses temp fixture dirs, no real fs paths.
 *
 *   node --test --experimental-strip-types test/discovery.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanPipelinesDir, findProjectPipelineDirs, discoverRecipes, resolvePackagePipelineDirs } from "../src/discovery.ts";

function mkdir(d: string): string {
	fs.mkdirSync(d, { recursive: true });
	return d;
}
function write(d: string, content: string): void {
	fs.mkdirSync(path.dirname(d), { recursive: true });
	fs.writeFileSync(d, content, "utf8");
}

test("scanPipelinesDir: picks up *.md, ignores non-md, uses filename stem as name", () => {
	const dir = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "pipelines"));
	write(path.join(dir, "alpha.md"), "---\nname: alpha\ndescription: a\n---\n# alpha\n");
	write(path.join(dir, "beta.md"), "---\ndescription: b\n---\n# beta\n"); // no name -> stem
	write(path.join(dir, "readme.txt"), "not a recipe");
	const out = scanPipelinesDir(dir, "user");
	assert.equal(out.length, 2);
	const alpha = out.find((r) => r.name === "alpha")!;
	const beta = out.find((r) => r.name === "beta")!;
	assert.equal(alpha.description, "a");
	assert.equal(alpha.source, "user");
	assert.equal(beta.name, "beta"); // fell back to filename stem
});

test("scanPipelinesDir: missing dir -> empty, no throw", () => {
	assert.deepEqual(scanPipelinesDir("/nonexistent-" + Date.now(), "user"), []);
});

test("discoverRecipes: project wins over user on name collision", () => {
	const user = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "pipelines"));
	const proj = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "pipelines"));
	write(path.join(user, "shared.md"), "---\nname: shared\ndescription: USER\n---\n# shared\n");
	write(path.join(proj, "shared.md"), "---\nname: shared\ndescription: PROJECT\n---\n# shared\n");
	const out = discoverRecipes({ userDir: user, projectDirs: [proj] });
	assert.equal(out.length, 1);
	assert.equal(out[0]!.description, "PROJECT");
	assert.equal(out[0]!.source, "project");
});

test("discoverRecipes: package source between user and project", () => {
	const user = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "p"));
	const pkg = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "p"));
	const proj = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "p"));
	write(path.join(user, "x.md"), "---\nname: x\ndescription: USER\n---\n# x\n");
	write(path.join(pkg, "x.md"), "---\nname: x\ndescription: PACKAGE\n---\n# x\n");
	write(path.join(proj, "x.md"), "---\nname: x\ndescription: PROJECT\n---\n# x\n");
	const out = discoverRecipes({ userDir: user, projectDirs: [proj], packageDirs: [pkg] });
	assert.equal(out[0]!.description, "PROJECT");
});

test("discoverRecipes: distinct names coexist, sorted by name", () => {
	const user = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "p"));
	const pkg = mkdir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "p"));
	write(path.join(user, "zebra.md"), "---\nname: zebra\n---\n# zebra\n");
	write(path.join(pkg, "apple.md"), "---\nname: apple\n---\n# apple\n");
	const out = discoverRecipes({ userDir: user, packageDirs: [pkg] });
	assert.deepEqual(out.map((r) => r.name), ["apple", "zebra"]);
	assert.equal(out[0]!.source, "package");
	assert.equal(out[1]!.source, "user");
});

test("findProjectPipelineDirs: walks up and collects .pi/pipelines", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
	const deep = mkdir(path.join(root, "a", "b", "c"));
	// .pi/pipelines at root and at a/b
	write(path.join(root, ".pi", "pipelines", "root.md"), "---\nname: root\n---\n# root\n");
	write(path.join(root, "a", "b", ".pi", "pipelines", "mid.md"), "---\nname: mid\n---\n# mid\n");
	const dirs = findProjectPipelineDirs(deep, root);
	assert.ok(dirs.length >= 2, `expected >=2 dirs, got ${dirs.length}`);
	// nearest-first
	assert.equal(dirs[0], path.join(root, "a", "b", ".pi", "pipelines"));
	assert.equal(dirs[1], path.join(root, ".pi", "pipelines"));
	// discoverRecipes with nearest-wins: mid should win if names collided, but here
	// they're distinct so both appear.
	const out = discoverRecipes({ projectDirs: dirs });
	assert.deepEqual(out.map((r) => r.name), ["mid", "root"]);
});

test("resolvePackagePipelineDirs: npm, git, and local-path sources", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
	const npmRoot = mkdir(path.join(root, "npm"));
	const gitRoot = mkdir(path.join(root, "git"));
	const localPkg = mkdir(path.join(root, "local-pkg"));
	// npm package with pipelines
	write(path.join(npmRoot, "some-pkg", "pipelines", "a.md"), "---\nname: a\n---\n# a\n");
	// git package with pipelines
	write(path.join(gitRoot, "github.com", "owner", "repo", "pipelines", "b.md"), "---\nname: b\n---\n# b\n");
	// local package with pipelines
	write(path.join(localPkg, "pipelines", "c.md"), "---\nname: c\n---\n# c\n");
	// npm package WITHOUT pipelines (should be skipped)
	write(path.join(npmRoot, "no-pipelines", "package.json"), "{}");
	const dirs = resolvePackagePipelineDirs(
		["npm:some-pkg", "npm:no-pipelines", "git:github.com/owner/repo", localPkg],
		npmRoot,
		gitRoot,
	);
	assert.equal(dirs.length, 3);
	assert.ok(dirs.some((d) => d.endsWith("some-pkg/pipelines")));
	assert.ok(dirs.some((d) => d.endsWith("repo/pipelines")));
	assert.ok(dirs.some((d) => d.endsWith("local-pkg/pipelines")));
});

test("resolvePackagePipelineDirs: relative path resolves against settingsDir, not cwd", () => {
	// Reproduce the real-world bug: a relative path in settings.json
	// (e.g. `../../src/pi-pipeline` next to `~/.pi/agent/`) must resolve
	// against the settings file's directory, not against process.cwd().
	// The TUI's cwd is often unrelated to the directory the user edited
	// settings.json from.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pipeline-disc-"));
	// Layout: root/agent/settings.json  +  root/src/pi-pipeline/pipelines/x.md
	// Relative path: "../src/pi-pipeline" (from agent/ to src/)
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const pkg = path.join(root, "src", "pi-pipeline");
	fs.mkdirSync(path.join(pkg, "pipelines"), { recursive: true });
	write(path.join(pkg, "pipelines", "x.md"), "---\nname: x\n---\n# x\n");

	const resolved = resolvePackagePipelineDirs(
		["../src/pi-pipeline"],
		path.join(agentDir, "npm", "node_modules"),
		path.join(agentDir, "git"),
		agentDir,
	);
	assert.equal(resolved.length, 1, `expected 1 dir, got ${resolved.length}: ${JSON.stringify(resolved)}`);
	assert.equal(resolved[0], path.join(pkg, "pipelines"));

	// Demonstrate the fix is needed: with a different cwd, the same call
	// without settingsDir would resolve to the wrong place.
	const previousCwd = process.cwd();
	try {
		process.chdir("/");
		const buggy = resolvePackagePipelineDirs(
			["../src/pi-pipeline"],
			path.join(agentDir, "npm", "node_modules"),
			path.join(agentDir, "git"),
		);
		// From cwd="/", "../src/pi-pipeline" resolves to "/src/pi-pipeline"
		// — not our test fixture — so the package isn't found.
		assert.equal(buggy.length, 0, "without settingsDir, the relative path resolves against cwd and misses the package");
	} finally {
		process.chdir(previousCwd);
	}
	fs.rmSync(root, { recursive: true, force: true });
});
