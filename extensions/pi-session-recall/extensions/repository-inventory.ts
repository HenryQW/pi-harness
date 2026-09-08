import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PACKAGE_MANIFESTS = 512;
export const MAX_TOTAL_MANIFEST_BYTES = 16 * 1024 * 1024;
export const REPOSITORY_UNAVAILABLE_REASON = "not-a-git-repository";

const ROOT_STDOUT_BYTES = 4 * 1024;
const INDEX_STDOUT_BYTES = 8 * 1024 * 1024;
const GIT_STDERR_BYTES = 4 * 1024;
const SIZE_STDOUT_BYTES = 128;
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]);
const REGULAR_MODES = new Set(["100644", "100755"]);
const INDEX_MODES = new Set(["100644", "100755", "120000", "160000"]);
const PROVENANCE = {
	packageScripts: "git-index",
	executableScripts: "git-index",
	agentInstructions: "git-index",
	skills: "pi-effective-registry",
} as const;

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

interface RepositoryInventoryCollections {
	packageScripts: PackageScript[];
	executableScripts: string[];
	skills: RepositorySkill[];
	agentInstructions: string[];
	worktreeVerified: false;
}

export type RepositoryInventory = RepositoryInventoryCollections & ({
	available: true;
	gitRoot: string;
	provenance: typeof PROVENANCE;
	reason?: never;
} | {
	available: false;
	reason: typeof REPOSITORY_UNAVAILABLE_REASON;
	gitRoot?: never;
	provenance?: never;
});

type InventoryPi = Pick<ExtensionAPI, "getCommands">;
type InventoryContext = Pick<ExtensionContext, "cwd" | "signal">;

interface GitResult {
	stdout: Buffer;
	code: number;
}

interface IndexEntry {
	mode: string;
	oid: string;
	path: string;
}

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

function malformedManifest(relativePath: string): Error {
	return new Error(`Malformed repository manifest: ${boundedPath(relativePath)}`);
}

function unsupportedManifestMode(relativePath: string): Error {
	return new Error(`Unsupported repository manifest mode: ${boundedPath(relativePath)}`);
}

function oversizedManifest(relativePath: string): Error {
	return new Error(`Oversized repository manifest (1 MiB limit): ${boundedPath(relativePath)}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Repository inventory cancelled.");
}

/** Spawn one bounded process and never expose child output through failures. */
function runGit(
	cwd: string,
	args: string[],
	signal: AbortSignal | undefined,
	stdoutCap: number,
	options: { allowNonzero?: boolean; allowStderrOnNonzero?: boolean } = {},
): Promise<GitResult> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			reject(new Error("Repository inventory could not start Git."));
			return;
		}

		const childStdout = child.stdout;
		const childStderr = child.stderr;
		if (!childStdout || !childStderr) {
			child.kill("SIGKILL");
			reject(new Error("Repository inventory could not start Git."));
			return;
		}
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: Error | undefined;
		let settled = false;

		const fail = (error: Error) => {
			if (failure) return;
			failure = error;
			child.kill("SIGKILL");
		};
		const finish = (error?: Error, result?: GitResult) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(result!);
		};
		const onAbort = () => fail(new Error("Repository inventory cancelled."));

		childStdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > stdoutCap) {
				fail(new Error("Repository inventory Git stdout exceeded its limit."));
				return;
			}
			stdout.push(chunk);
		});
		childStderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > GIT_STDERR_BYTES) {
				fail(new Error("Repository inventory Git stderr exceeded its limit."));
			} else if (!options.allowStderrOnNonzero) {
				fail(new Error("Repository inventory Git wrote unexpected stderr."));
			}
		});
		child.once("error", () => finish(new Error("Repository inventory could not start Git.")));
		child.once("close", (code) => {
			if (failure) {
				finish(failure);
				return;
			}
			if (signal?.aborted) {
				finish(new Error("Repository inventory cancelled."));
				return;
			}
			if (code === null || (code !== 0 && !options.allowNonzero)) {
				finish(new Error("Repository inventory Git command failed."));
				return;
			}
			if (stderrBytes > 0 && !(code !== 0 && options.allowStderrOnNonzero)) {
				finish(new Error("Repository inventory Git wrote unexpected stderr."));
				return;
			}
			finish(undefined, { stdout: Buffer.concat(stdout, stdoutBytes), code });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function decodeUtf8(value: Buffer, error: () => Error): string {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		throw error();
	}
	if (decoded.includes("�")) throw error();
	return decoded;
}

function decodeAscii(value: Buffer, error: () => Error): string {
	if (value.some((byte) => byte > 0x7f)) throw error();
	return value.toString("ascii");
}

function canonicalDirectory(value: string): string {
	try {
		const canonical = fs.realpathSync(value);
		if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
		return canonical;
	} catch {
		throw new Error("Repository inventory could not resolve the Git root.");
	}
}

function gitRootFromOutput(stdout: Buffer): string {
	const invalid = () => new Error("Repository inventory could not resolve the Git root.");
	const decoded = decodeUtf8(stdout, invalid);
	const root = decoded.endsWith("\r\n") ? decoded.slice(0, -2) : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
	if (!root || root.includes("\r") || root.includes("\n") || (!path.isAbsolute(root) && !path.win32.isAbsolute(root))) {
		throw invalid();
	}
	return canonicalDirectory(root);
}

async function resolveGitRoot(ctx: InventoryContext): Promise<string | undefined> {
	const cwd = canonicalDirectory(ctx.cwd);
	const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], ctx.signal, ROOT_STDOUT_BYTES, {
		allowNonzero: true,
		allowStderrOnNonzero: true,
	});
	return result.code === 0 ? gitRootFromOutput(result.stdout) : undefined;
}

function looksLikePackageJson(value: string): boolean {
	return value === "package.json" || value.endsWith("/package.json");
}

function normalizeRepositoryPath(value: string): string {
	const segments = value.split("/");
	if (
		!value ||
		value.includes("�") ||
		value.includes("\\") ||
		path.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error("Repository inventory received an invalid repository path.");
	}
	return value;
}

function parseIndex(stdout: Buffer): IndexEntry[] {
	if (stdout.length === 0) return [];
	if (stdout.at(-1) !== 0) throw new Error("Repository inventory received an invalid Git index listing.");
	const entries: IndexEntry[] = [];
	const paths = new Set<string>();
	let start = 0;
	while (start < stdout.length) {
		const end = stdout.indexOf(0, start);
		if (end < 0) throw new Error("Repository inventory received an invalid Git index listing.");
		const record = stdout.subarray(start, end);
		start = end + 1;
		const tab = record.indexOf(0x09);
		if (tab < 0) throw new Error("Repository inventory received an invalid Git index listing.");
		const invalid = () => new Error("Repository inventory received an invalid Git index listing.");
		const metadata = decodeAscii(record.subarray(0, tab), invalid);
		const match = /^([0-7]{6}) ([0-9a-fA-F]{40}|[0-9a-fA-F]{64}) ([0-3])$/.exec(metadata);
		if (!match) throw invalid();
		const relativePath = normalizeRepositoryPath(decodeUtf8(record.subarray(tab + 1), invalid));
		const [, mode, oid, stage] = match;
		if (stage !== "0") throw new Error("Repository inventory does not accept conflicted Git index entries.");
		if (paths.has(relativePath)) throw new Error("Repository inventory received duplicate Git index entries.");
		paths.add(relativePath);
		if (looksLikePackageJson(relativePath) && !REGULAR_MODES.has(mode)) throw unsupportedManifestMode(relativePath);
		if (!INDEX_MODES.has(mode)) throw invalid();
		entries.push({ mode, oid, path: relativePath });
	}
	return entries.sort((left, right) => compare(left.path, right.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scriptsFromManifest(source: string, relativePath: string): PackageScript[] {
	let manifest: unknown;
	try {
		manifest = JSON.parse(source);
	} catch {
		throw malformedManifest(relativePath);
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

function parseObjectSize(stdout: Buffer): number {
	const invalid = () => new Error("Repository inventory received an invalid Git object size.");
	const value = decodeAscii(stdout, invalid);
	if (!/^(0|[1-9][0-9]*)\n$/.test(value)) throw invalid();
	const size = BigInt(value.slice(0, -1));
	if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
	return Number(size);
}

async function packageScriptsFromIndex(
	root: string,
	entries: IndexEntry[],
	signal: AbortSignal | undefined,
): Promise<PackageScript[]> {
	const packages = entries.filter((entry) => looksLikePackageJson(entry.path));
	if (packages.length > MAX_PACKAGE_MANIFESTS) {
		throw new Error("Repository inventory exceeds the 512 package manifest limit.");
	}

	const sized: (IndexEntry & { size: number })[] = [];
	let totalBytes = 0;
	for (const entry of packages) {
		const result = await runGit(root, ["--no-replace-objects", "cat-file", "-s", "--", entry.oid], signal, SIZE_STDOUT_BYTES);
		const size = parseObjectSize(result.stdout);
		if (size > MAX_MANIFEST_BYTES) throw oversizedManifest(entry.path);
		if (totalBytes > MAX_TOTAL_MANIFEST_BYTES - size) {
			throw new Error("Repository inventory exceeds the 16 MiB total manifest limit.");
		}
		totalBytes += size;
		sized.push({ ...entry, size });
	}

	const scripts: PackageScript[] = [];
	for (const entry of sized) {
		const result = await runGit(root, ["--no-replace-objects", "cat-file", "blob", "--", entry.oid], signal, entry.size);
		if (result.stdout.length !== entry.size) {
			throw new Error("Repository inventory received an incorrect Git blob size.");
		}
		const invalid = () => malformedManifest(entry.path);
		scripts.push(...scriptsFromManifest(decodeUtf8(result.stdout, invalid), entry.path));
	}
	return scripts;
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

/** Return bounded discovery hints from the Git index and Pi's effective skill registry. */
export async function inventoryRepository(
	pi: InventoryPi,
	ctx: InventoryContext,
	mode: RepositoryInventoryMode = "required",
): Promise<RepositoryInventory> {
	if (mode !== "required" && mode !== "optional") throw new Error("Invalid repository inventory mode.");
	const gitRoot = await resolveGitRoot(ctx);
	if (!gitRoot) {
		if (mode === "optional") {
			return {
				available: false,
				reason: REPOSITORY_UNAVAILABLE_REASON,
				packageScripts: [],
				executableScripts: [],
				skills: [],
				agentInstructions: [],
				worktreeVerified: false,
			};
		}
		throw new Error("Repository inventory requires a Git repository.");
	}

	const index = parseIndex((await runGit(gitRoot, ["--no-replace-objects", "ls-files", "--stage", "-z"], ctx.signal, INDEX_STDOUT_BYTES)).stdout);
	return {
		available: true,
		gitRoot,
		packageScripts: await packageScriptsFromIndex(gitRoot, index, ctx.signal),
		executableScripts: index.filter((entry) => entry.mode === "100755").map((entry) => entry.path),
		skills: effectiveSkills(pi, gitRoot),
		agentInstructions: index
			.filter((entry) => REGULAR_MODES.has(entry.mode) && INSTRUCTION_NAMES.has(path.posix.basename(entry.path)))
			.map((entry) => entry.path),
		provenance: PROVENANCE,
		worktreeVerified: false,
	};
}
