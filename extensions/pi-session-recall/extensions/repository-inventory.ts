import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const REPOSITORY_UNAVAILABLE_REASON = "not-a-git-repository";

const INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]);
const SAFE_READ_FLAGS = fs.constants.O_RDONLY |
	(fs.constants.O_NOFOLLOW ?? 0) |
	(fs.constants.O_NONBLOCK ?? 0);

export type RepositoryInventoryMode = "required" | "optional";

export interface PackageScript {
	path: string;
	name: string;
	command: string;
}

export interface RepositorySkill {
	name: string;
	description: string;
	sourcePath: string;
}

export interface RepositoryInventory {
	available: boolean;
	reason?: typeof REPOSITORY_UNAVAILABLE_REASON;
	gitRoot?: string;
	packageScripts: PackageScript[];
	executableScripts: string[];
	skills: RepositorySkill[];
	agentInstructions: string[];
}

type InventoryPi = Pick<ExtensionAPI, "exec" | "getCommands">;
type InventoryContext = Pick<ExtensionContext, "cwd" | "signal">;

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function isWithin(root: string, target: string, allowRoot = true): boolean {
	const relative = path.relative(root, target);
	return (allowRoot && relative === "") ||
		(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function boundedPath(value: string): string {
	const bounded = value.length <= 240 ? value : `${value.slice(0, 239)}…`;
	return JSON.stringify(bounded);
}

function unsafeManifest(relativePath: string): Error {
	return new Error(`Unsafe repository manifest: ${boundedPath(relativePath)}`);
}

function malformedManifest(relativePath: string): Error {
	return new Error(`Malformed repository manifest: ${boundedPath(relativePath)}`);
}

function oversizedManifest(relativePath: string): Error {
	return new Error(`Oversized repository manifest (1 MiB limit): ${boundedPath(relativePath)}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Repository inventory cancelled.");
}

async function runGit(
	pi: InventoryPi,
	ctx: InventoryContext,
	cwd: string,
	args: string[],
): Promise<{ stdout: string; code: number; killed: boolean }> {
	throwIfAborted(ctx.signal);
	let result: Awaited<ReturnType<InventoryPi["exec"]>>;
	try {
		result = await pi.exec("git", args, { cwd, signal: ctx.signal });
	} catch {
		throwIfAborted(ctx.signal);
		throw new Error("Repository inventory could not run Git.");
	}
	if (result.killed || ctx.signal?.aborted) throw new Error("Repository inventory cancelled.");
	return result;
}

function gitRootFromOutput(stdout: string): string {
	const root = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (!root || root.includes("\r") || root.includes("\n") || (!path.isAbsolute(root) && !path.win32.isAbsolute(root))) {
		throw new Error("Repository inventory could not resolve the Git root.");
	}
	try {
		const canonicalRoot = fs.realpathSync(root);
		if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("not a directory");
		return canonicalRoot;
	} catch {
		throw new Error("Repository inventory could not resolve the Git root.");
	}
}

async function resolveGitRoot(
	pi: InventoryPi,
	ctx: InventoryContext,
): Promise<string | undefined> {
	const result = await runGit(pi, ctx, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	return result.code === 0 ? gitRootFromOutput(result.stdout) : undefined;
}

function looksLikePackageJson(value: string): boolean {
	const normalized = value.replaceAll("\\", "/");
	return normalized === "package.json" || normalized.endsWith("/package.json");
}

function normalizeRepositoryPath(value: string): string {
	const segments = value.split("/");
	if (
		!value ||
		value.includes("\0") ||
		value.includes("\\") ||
		path.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		if (looksLikePackageJson(value)) throw unsafeManifest(value);
		throw new Error("Repository inventory received an invalid repository path.");
	}
	return value;
}

function nulRecords(stdout: string): string[] {
	if (!stdout) return [];
	const records = stdout.split("\0");
	if (records.pop() !== "") throw new Error("Repository inventory received an invalid Git file listing.");
	return records;
}

function trackedFiles(stdout: string): Map<string, boolean> {
	const files = new Map<string, boolean>();
	for (const record of nulRecords(stdout)) {
		const tab = record.indexOf("\t");
		if (tab < 0) throw new Error("Repository inventory received an invalid Git file listing.");
		const [mode] = record.slice(0, tab).split(" ");
		if (!mode || !/^\d{6}$/.test(mode)) throw new Error("Repository inventory received an invalid Git file listing.");
		const relativePath = normalizeRepositoryPath(record.slice(tab + 1));
		files.set(relativePath, files.get(relativePath) === true || mode === "100755");
	}
	return files;
}

function untrackedFiles(stdout: string): Set<string> {
	return new Set(nulRecords(stdout).map(normalizeRepositoryPath));
}

function repositoryFile(root: string, relativePath: string, error: () => Error): string {
	const candidate = path.resolve(root, ...relativePath.split("/"));
	if (!isWithin(root, candidate)) throw error();
	let parent: string;
	try {
		parent = fs.realpathSync(path.dirname(candidate));
	} catch {
		throw error();
	}
	if (!isWithin(root, parent)) throw error();
	const filePath = path.join(parent, path.basename(candidate));
	if (!isWithin(root, filePath)) throw error();
	return filePath;
}

function readManifestSnapshot(root: string, relativePath: string): string {
	const filePath = repositoryFile(root, relativePath, () => unsafeManifest(relativePath));
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, SAFE_READ_FLAGS);
	} catch {
		throw unsafeManifest(relativePath);
	}
	try {
		let stat: fs.Stats;
		try {
			stat = fs.fstatSync(fd);
		} catch {
			throw unsafeManifest(relativePath);
		}
		if (!stat.isFile()) throw unsafeManifest(relativePath);
		if (stat.size > MAX_MANIFEST_BYTES) throw oversizedManifest(relativePath);
		const snapshot = Buffer.allocUnsafe(stat.size);
		let read = 0;
		while (read < snapshot.length) {
			let bytesRead: number;
			try {
				bytesRead = fs.readSync(fd, snapshot, read, snapshot.length - read, read);
			} catch {
				throw unsafeManifest(relativePath);
			}
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return snapshot.toString("utf8", 0, read);
	} finally {
		fs.closeSync(fd);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scriptsFromManifest(root: string, relativePath: string): PackageScript[] {
	let manifest: unknown;
	try {
		manifest = JSON.parse(readManifestSnapshot(root, relativePath));
	} catch (error) {
		if (error instanceof SyntaxError) throw malformedManifest(relativePath);
		throw error;
	}
	if (!isRecord(manifest)) throw malformedManifest(relativePath);
	const scripts = manifest.scripts;
	if (scripts === undefined) return [];
	if (!isRecord(scripts)) throw malformedManifest(relativePath);
	const result: PackageScript[] = [];
	for (const [name, command] of Object.entries(scripts)) {
		if (typeof command !== "string") throw malformedManifest(relativePath);
		result.push({ path: relativePath, name, command });
	}
	return result.sort((left, right) => compare(left.name, right.name));
}

function isUntrackedExecutable(root: string, relativePath: string): boolean {
	const filePath = repositoryFile(root, relativePath, () => new Error("Repository inventory received an invalid repository path."));
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, SAFE_READ_FLAGS);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP" || code === "ENXIO") return false;
		throw new Error("Repository inventory could not inspect untracked files.");
	}
	try {
		let stat: fs.Stats;
		try {
			stat = fs.fstatSync(fd);
		} catch {
			throw new Error("Repository inventory could not inspect untracked files.");
		}
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} finally {
		fs.closeSync(fd);
	}
}

function effectiveSkills(pi: InventoryPi, root: string): RepositorySkill[] {
	let commands: ReturnType<InventoryPi["getCommands"]>;
	try {
		commands = pi.getCommands();
	} catch {
		throw new Error("Repository inventory could not read effective skills.");
	}
	const skills: RepositorySkill[] = [];
	for (const command of commands) {
		if (command.source !== "skill" || typeof command.name !== "string" || typeof command.sourceInfo?.path !== "string") continue;
		let sourcePath: string;
		try {
			sourcePath = fs.realpathSync(command.sourceInfo.path);
		} catch {
			continue;
		}
		if (!isWithin(root, sourcePath, false)) continue;
		skills.push({
			name: command.name,
			description: typeof command.description === "string" ? command.description : "",
			sourcePath: toPosixPath(path.relative(root, sourcePath)),
		});
	}
	return skills.sort((left, right) =>
		compare(left.name, right.name) ||
		compare(left.sourcePath, right.sourcePath) ||
		compare(left.description, right.description),
	);
}

/** Inventory Git-visible automation surfaces without traversing the working tree. */
export async function inventoryRepository(
	pi: InventoryPi,
	ctx: InventoryContext,
	mode: RepositoryInventoryMode = "required",
): Promise<RepositoryInventory> {
	if (mode !== "required" && mode !== "optional") throw new Error("Invalid repository inventory mode.");
	const gitRoot = await resolveGitRoot(pi, ctx);
	if (!gitRoot) {
		if (mode === "optional") {
			return {
				available: false,
				reason: REPOSITORY_UNAVAILABLE_REASON,
				packageScripts: [],
				executableScripts: [],
				skills: [],
				agentInstructions: [],
			};
		}
		throw new Error("Repository inventory requires a Git repository.");
	}

	const tracked = trackedFiles((await runGit(pi, ctx, gitRoot, ["ls-files", "--stage", "-z"])).stdout);
	const untracked = untrackedFiles((await runGit(pi, ctx, gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
	const files = [...new Set([...tracked.keys(), ...untracked])].sort(compare);

	const packageScripts = files
		.filter(looksLikePackageJson)
		.flatMap((relativePath) => scriptsFromManifest(gitRoot, relativePath));
	const executableScripts = new Set<string>();
	for (const [relativePath, executable] of tracked) {
		if (executable) executableScripts.add(relativePath);
	}
	for (const relativePath of [...untracked].sort(compare)) {
		if (isUntrackedExecutable(gitRoot, relativePath)) executableScripts.add(relativePath);
	}

	return {
		available: true,
		gitRoot,
		packageScripts,
		executableScripts: [...executableScripts].sort(compare),
		skills: effectiveSkills(pi, gitRoot),
		agentInstructions: files.filter((relativePath) => INSTRUCTION_NAMES.has(path.posix.basename(relativePath))),
	};
}
