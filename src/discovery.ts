/**
 * Recipe discovery — find all pipeline recipes on disk and dedupe by name.
 *
 * Sources, in precedence order (later wins on name collision, matching
 * skills/agents/prompts):
 *   1. Built-in TS pipelines (NOT discovered here — these are the templates
 *      in lib.ts; the tool falls back to them when no recipe name is given)
 *   2. ~/.pi/agent/pipelines/             (user-global)
 *   3. .pi/pipelines/                     (project, walking up from cwd)
 *   4. <package>/pipelines/               (from installed pi packages)
 *
 * Project (3) and package (4) discovery require a cwd and a packages root;
 * user-global (2) only needs the pi config dir. The discovery functions take
 * their roots as params so they're testable without touching the real
 * filesystem layout.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type DiscoveredRecipe } from "./recipes.ts";

/** Find `pipelines/` dirs walking up from `cwd` (project-local). Returns
 *  existing dirs in nearest-first order. */
export function findProjectPipelineDirs(cwd: string, stopAt?: string): string[] {
	const dirs: string[] = [];
	let dir = path.resolve(cwd);
	const root = stopAt ? path.resolve(stopAt) : path.parse(dir).root;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const candidate = path.join(dir, ".pi", "pipelines");
		if (fs.existsSync(candidate)) dirs.push(candidate);
		if (dir === root || path.dirname(dir) === dir) break;
		if (dir === stopAt) break;
		dir = path.dirname(dir);
	}
	return dirs;
}

/** Scan a single pipelines/ dir for `*.md` recipe files. Returns raw
 *  discovered entries (no dedup). */
export function scanPipelinesDir(dir: string, source: DiscoveredRecipe["source"]): DiscoveredRecipe[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: DiscoveredRecipe[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(dir, entry);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		const raw = fs.readFileSync(filePath, "utf8");
		const { frontmatter } = parseFrontmatter(raw);
		const name = frontmatter.name ?? entry.replace(/\.md$/, "");
		out.push({
			name,
			description: frontmatter.description ?? "",
			filePath,
			source,
			frontmatter,
			raw,
		});
	}
	return out;
}

/** Discover all recipes from the three on-disk sources, deduped by name with
 *  later sources winning. Built-in TS pipelines are not included (the tool
 *  handles them as a fallback). */
export function discoverRecipes(opts: {
	userDir?: string;        // ~/.pi/agent/pipelines
	projectDirs?: string[];  // from findProjectPipelineDirs
	packageDirs?: string[];  // <pkg>/pipelines for installed packages
}): DiscoveredRecipe[] {
	const byName = new Map<string, DiscoveredRecipe>();
	const add = (d: DiscoveredRecipe) => byName.set(d.name, d); // last wins
	if (opts.userDir) {
		for (const d of scanPipelinesDir(opts.userDir, "user")) add(d);
	}
	if (opts.packageDirs) {
		for (const dir of opts.packageDirs) {
			for (const d of scanPipelinesDir(dir, "package")) add(d);
		}
	}
	if (opts.projectDirs) {
		// Project dirs are nearest-first; walk far-to-near so nearest wins.
		for (let i = opts.projectDirs.length - 1; i >= 0; i--) {
			for (const d of scanPipelinesDir(opts.projectDirs[i]!, "project")) add(d);
		}
	}
	// Stable sort by name for display.
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ──────────────────────── package-dir resolution ────────────────────────
 *
 * pi doesn't expose an installed-packages accessor to extensions, so we read
 * the `packages` field from settings.json and resolve each source to its
 * on-disk package root, then check for a `pipelines/` subdir. Sources:
 *   - local path ("/abs/path" or "./rel") -> that path
 *   - "npm:<name>"           -> <npmRoot>/<name>            (npmRoot = ~/.pi/agent/npm/node_modules)
 *   - "git:<host>/<owner>/<repo>[@ref]" -> <gitRoot>/<host>/<owner>/<repo>
 *                                                              (gitRoot = ~/.pi/agent/git)
 * Unknown/missing dirs are silently skipped.
 */
export function resolvePackagePipelineDirs(
	packages: string[],
	npmRoot: string,
	gitRoot: string,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (pkgDir: string) => {
		const pipelinesDir = path.join(pkgDir, "pipelines");
		if (seen.has(pipelinesDir)) return;
		if (fs.existsSync(pipelinesDir)) {
			seen.add(pipelinesDir);
			out.push(pipelinesDir);
		}
	};
	for (const src of packages) {
		const s = src.trim();
		if (!s) continue;
		if (s.startsWith("npm:")) {
			const name = s.slice(4).trim();
			if (name) add(path.join(npmRoot, name));
		} else if (s.startsWith("git:")) {
			// git:github.com/owner/repo[@ref]  or  git:git@github.com:owner/repo
			const rest = s.slice(4);
			const atIdx = rest.indexOf("@");
			const loc = atIdx >= 0 ? rest.slice(0, atIdx) : rest;
			if (loc) add(path.join(gitRoot, loc));
		} else {
			// local path (absolute or relative)
			add(path.resolve(s));
		}
	}
	return out;
}
