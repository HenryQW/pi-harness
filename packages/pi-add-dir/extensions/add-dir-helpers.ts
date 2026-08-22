import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
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
	if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) return path.join(homedir(), input.slice(2));
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
	const names = new Set<string>();

	for (const skillDir of SKILL_DIRS) {
		const fullSkillDir = path.join(dir, skillDir);
		if (!dirExists(fullSkillDir)) continue;
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
	const names = new Set<string>();
	for (const dir of dirs) {
		if (!dirExists(dir.absolutePath)) continue;
		for (const skill of skillFiles(dir.absolutePath)) {
			if (names.has(skill.name)) continue;
			names.add(skill.name);
			paths.push(skill.path);
		}
	}
	return paths;
}

function skillDescription(content: string): string {
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	const value = frontmatter?.match(/^description:\s*(.*?)\s*$/m)?.[1];
	if (!value || value === ">" || value === "|") return "No description";
	return value.replace(/^("|')|("|')$/g, "").trim() || "No description";
}

// ponytail: 8KB head is enough for SKILL.md frontmatter descriptions; full-body reads stay in scanDirContext
function readHead(filePath: string, bytes = 8192): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(bytes);
		const bytesRead = readSync(fd, buffer, 0, bytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

// ponytail: 8KB head covers typical frontmatter; falls back to full read only when opener present but closer missing (rare)
function readSkillFrontmatter(filePath: string): string | null {
	const head = readHead(filePath, 8192);
	if (head === null || !/^---\r?\n/.test(head)) return head;
	if (/^---\r?\n[\s\S]*\r?\n---(?:\r?\n|$)/.test(head)) return head;
	return readFileSafe(filePath);
}

export function buildContextInjection(dirs: AddedDir[]): string {
	if (dirs.length === 0) return "";

	const sections = [
		"\n\n## External Directories (added via pi-add-dir)",
		`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
	];

	const registeredSkills = new Set<string>();
	for (const dir of dirs) {
		sections.push(`### ${dir.label} - \`${dir.absolutePath}\``);

		const agentsMd = readContextFile(dir.absolutePath, "AGENTS.md");
		if (agentsMd) sections.push(`\n#### AGENTS.md (from ${dir.label})\n${agentsMd}`);
		const claudeMd = readContextFile(dir.absolutePath, "CLAUDE.md");
		if (claudeMd) sections.push(`\n#### CLAUDE.md (from ${dir.label})\n${claudeMd}`);

		const skills = skillFiles(dir.absolutePath).filter((skill) => !registeredSkills.has(skill.name));
		if (skills.length > 0) {
			sections.push(`\n#### Skills from ${dir.label} (registered as /skill:name commands):`);
			for (const skill of skills) {
				registeredSkills.add(skill.name);
				const description = skillDescription(readSkillFrontmatter(skill.path) ?? "");
				sections.push(`- **${skill.name}**: ${description} - use \`/skill:${skill.name}\` or read \`${skill.path}\``);
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

	signal?.throwIfAborted();
	while (pending.length > 0) {
		signal?.throwIfAborted();
		const current = pending.pop()!;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			signal?.throwIfAborted();
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
