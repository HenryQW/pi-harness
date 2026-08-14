import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface AddedDir {
	absolutePath: string;
	label: string;
	addedAt: number;
}

export interface DirContext {
	dir: string;
	agentsMd: string | null;
	claudeMd: string | null;
	skillPaths: Map<string, string>;
	skills: Map<string, string>;
}

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_DIRS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;
const SKIPPED_SEARCH_DIRS = new Set([".git", "node_modules"]);

export function expandUserPath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

export function resolveDir(input: string, cwd: string): string {
	const expanded = expandUserPath(input);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	try {
		return realpathSync(resolved);
	} catch {
		return path.resolve(resolved);
	}
}

export function dirExists(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

export function readFileSafe(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function readContextFile(dir: string, name: (typeof CONTEXT_FILES)[number]): string | null {
	const contents = [readFileSafe(path.join(dir, name)), readFileSafe(path.join(dir, ".pi", name))].filter(
		(content): content is string => content !== null,
	);
	return contents.length > 0 ? contents.join("\n\n") : null;
}

function skillFiles(dir: string): Array<{ name: string; path: string }> {
	const files: Array<{ name: string; path: string }> = [];

	for (const skillDir of SKILL_DIRS) {
		const fullSkillDir = path.join(dir, skillDir);
		if (!dirExists(fullSkillDir)) continue;
		try {
			for (const entry of readdirSync(fullSkillDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const skillPath = path.join(fullSkillDir, entry.name, "SKILL.md");
				try {
					if (statSync(skillPath).isFile()) files.push({ name: entry.name, path: skillPath });
				} catch {
					// Skill may disappear while resources are being discovered.
				}
			}
		} catch {
			// Skip unreadable skill directories.
		}
	}

	return files;
}

export function scanDirContext(dir: string): DirContext {
	const ctx: DirContext = {
		dir,
		agentsMd: readContextFile(dir, "AGENTS.md"),
		claudeMd: readContextFile(dir, "CLAUDE.md"),
		skillPaths: new Map(),
		skills: new Map(),
	};

	for (const skill of skillFiles(dir)) {
		const content = readFileSafe(skill.path);
		if (content === null) continue;
		ctx.skillPaths.set(skill.name, skill.path);
		ctx.skills.set(skill.name, content);
	}

	return ctx;
}

export function collectSkillPaths(dirs: AddedDir[]): string[] {
	const paths: string[] = [];
	for (const dir of dirs) {
		if (!dirExists(dir.absolutePath)) continue;
		paths.push(...skillFiles(dir.absolutePath).map((skill) => skill.path));
	}
	return paths;
}

function skillDescription(content: string): string {
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	const value = frontmatter?.match(/^description:\s*(.*?)\s*$/m)?.[1];
	if (!value || value === ">" || value === "|") return "No description";
	return value.replace(/^("|')|("|')$/g, "").trim() || "No description";
}

export function buildContextInjection(dirs: AddedDir[]): string {
	if (dirs.length === 0) return "";

	const sections = [
		"\n\n## External Directories (added via pi-add-dir)",
		`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
	];

	for (const dir of dirs) {
		const ctx = scanDirContext(dir.absolutePath);
		sections.push(`### ${dir.label} - \`${dir.absolutePath}\``);

		if (ctx.agentsMd) sections.push(`\n#### AGENTS.md (from ${dir.label})\n${ctx.agentsMd}`);
		if (ctx.claudeMd) sections.push(`\n#### CLAUDE.md (from ${dir.label})\n${ctx.claudeMd}`);

		if (ctx.skills.size > 0) {
			sections.push(`\n#### Skills from ${dir.label} (registered as /skill:name commands):`);
			for (const [name, content] of ctx.skills) {
				sections.push(
					`- **${name}**: ${skillDescription(content)} - use \`/skill:${name}\` or read \`${ctx.skillPaths.get(name)}\``,
				);
			}
		}
	}

	return sections.join("\n");
}

function normalizePattern(pattern: string): string {
	let normalized = pattern.trim();
	if (path.sep === "\\") normalized = normalized.replaceAll("/", "\\");
	const prefix = `.${path.sep}`;
	if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
	return normalized;
}

export async function findFiles(
	root: string,
	pattern: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const normalizedPattern = normalizePattern(pattern);
	if (!normalizedPattern) throw new Error("File pattern must not be blank.");

	const matchPath = normalizedPattern.includes(path.sep);
	const results: string[] = [];
	const pending = [root];

	while (pending.length > 0 && !signal?.aborted) {
		const current = pending.pop()!;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (signal?.aborted) break;
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_SEARCH_DIRS.has(entry.name)) pending.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;

			const candidate = matchPath ? path.relative(root, fullPath) : entry.name;
			if (!path.matchesGlob(candidate, normalizedPattern)) continue;
			results.push(fullPath);
			if (results.length >= maxResults) return results;
		}
	}

	return results;
}
