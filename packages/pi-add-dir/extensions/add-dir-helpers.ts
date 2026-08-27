import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface AddedDir {
	absolutePath: string;
	label: string;
}

export interface DirContext {
	agentsMd: string | null;
	claudeMd: string | null;
	skills: Set<string>;
}

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_DIRS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;
const SKIPPED_SEARCH_DIRS = new Set([".git", "node_modules"]);

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

export function expandUserPath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) return path.join(homedir(), input.slice(2));
	return input;
}

export function resolveDir(input: string, cwd: string): string {
	const expanded = expandUserPath(input);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isMissingPathError(error)) return path.resolve(resolved);
		throw error;
	}
}

export function dirExists(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
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
	const names = new Set<string>();

	for (const skillDir of SKILL_DIRS) {
		const fullSkillDir = path.join(dir, skillDir);
		try {
			for (const entry of readdirSync(fullSkillDir, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const skillPath = path.join(fullSkillDir, entry.name, "SKILL.md");
				try {
					if (statSync(skillPath).isFile() && !names.has(entry.name)) {
						names.add(entry.name);
						files.push({ name: entry.name, path: skillPath });
					}
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
	return {
		agentsMd: readContextFile(dir, "AGENTS.md"),
		claudeMd: readContextFile(dir, "CLAUDE.md"),
		skills: new Set(skillFiles(dir).map(({ name }) => name)),
	};
}

export function collectSkillPaths(dirs: AddedDir[]): string[] {
	const paths: string[] = [];
	const names = new Set<string>();
	for (const dir of dirs) {
		for (const skill of skillFiles(dir.absolutePath)) {
			if (names.has(skill.name)) continue;
			names.add(skill.name);
			paths.push(skill.path);
		}
	}
	return paths;
}

export function buildContextInjection(dirs: AddedDir[]): string {
	if (dirs.length === 0) return "";

	const sections = [
		"\n\n## External Directories (added via pi-add-dir)",
		`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
	];

	for (const dir of dirs) {
		sections.push(`### ${dir.label} - \`${dir.absolutePath}\``);

		const agentsMd = readContextFile(dir.absolutePath, "AGENTS.md");
		if (agentsMd) sections.push(`\n#### AGENTS.md (from ${dir.label})\n${agentsMd}`);
		const claudeMd = readContextFile(dir.absolutePath, "CLAUDE.md");
		if (claudeMd) sections.push(`\n#### CLAUDE.md (from ${dir.label})\n${claudeMd}`);
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

	signal?.throwIfAborted();
	for await (const entry of glob("**/@(*|.*)", {
		cwd: root,
		withFileTypes: true,
		exclude: (entry) => entry.isSymbolicLink() || (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)),
	})) {
		signal?.throwIfAborted();
		if (!entry.isFile()) continue;

		const fullPath = path.join(entry.parentPath, entry.name);
		const candidate = matchPath ? path.relative(root, fullPath) : entry.name;
		if (!path.matchesGlob(candidate, normalizedPattern)) continue;
		results.push(fullPath);
		if (results.length >= maxResults) return results;
	}

	return results;
}
