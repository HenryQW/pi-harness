import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { inspectIndexFlags } from "./worktree.ts";
import { runGit as runCapturedGit } from "./git-process.ts";
import { REVIEW_MAX_PATCH_BYTES, REVIEW_MAX_PATHS } from "./review-evidence.ts";

const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = REVIEW_MAX_PATCH_BYTES + 1;
const MANIFEST_MAX_BYTES = 512 * 1024;

export interface WorkingSnapshotIdentity {
	head: string;
	indexHash: string;
	tree: string;
	rawManifestHash: string;
}

export interface WorkingCheckoutBaseline extends WorkingSnapshotIdentity {
	worktree: string;
}

export interface PreparedWorkingChangeEvidence {
	baseline: WorkingCheckoutBaseline;
	identity: WorkingSnapshotIdentity;
	changedPaths: string[];
	patchPath: string;
	rawEvidencePath: string;
	cleanup(): Promise<void>;
}

type CommandResult = { code: number; stdout: Buffer; stderr: Buffer };

function hash(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function line(value: Buffer, field: string): string {
	const text = value.toString("utf8").replace(/\r?\n$/, "");
	if (!text || text.includes("�") || /[\r\n\0]/.test(text)) throw new Error(`Git returned malformed ${field}.`);
	return text;
}

function oid(value: Buffer, field: string): string {
	const result = line(value, field);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw new Error(`Git returned invalid ${field}.`);
	return result;
}

async function command(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
	limit = OUTPUT_LIMIT,
): Promise<CommandResult> {
	signal?.throwIfAborted();
	const child = spawn("git", args, { cwd, env, signal, timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let overflow = false;
	const collect = (chunks: Buffer[], chunk: Buffer, current: number) => {
		const available = limit - current;
		if (available <= 0) { overflow = true; return 0; }
		chunks.push(chunk.subarray(0, available));
		if (chunk.length > available) overflow = true;
		return Math.min(chunk.length, available);
	};
	child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += collect(stdout, chunk, stdoutBytes); if (overflow) child.kill(); });
	child.stderr.on("data", (chunk: Buffer) => { stderrBytes += collect(stderr, chunk, stderrBytes); if (overflow) child.kill(); });
	const code = await new Promise<number | null>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("close", resolveCode);
	});
	signal?.throwIfAborted();
	if (overflow) throw new Error(`Working-change evidence exceeds ${limit - 1} bytes.`);
	return { code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Buffer> {
	const result = await command(args, cwd, env, signal);
	if (result.code !== 0) {
		const detail = result.stderr.toString("utf8").slice(0, 200).trim();
		throw new Error(`git ${args.join(" ")} failed with exit ${result.code}${detail ? `: ${detail}` : ""}`);
	}
	return result.stdout;
}

function paths(value: Buffer): string[] {
	if (!value.length) return [];
	const text = value.toString("utf8");
	if (text.includes("�") || value.at(-1) !== 0) throw new Error("Git returned malformed working-change paths.");
	const result = text.slice(0, -1).split("\0");
	if (result.length > REVIEW_MAX_PATHS) throw new Error(`Working-change evidence exceeds ${REVIEW_MAX_PATHS} paths.`);
	for (const path of result) {
		if (!path || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
			throw new Error(`Git returned malformed or unsupported path: ${JSON.stringify(path)}`);
		}
	}
	return result;
}

async function indexPath(worktree: string, signal?: AbortSignal): Promise<string> {
	const raw = line(await git(["rev-parse", "--git-path", "index"], worktree, undefined, signal), "index path");
	const path = isAbsolute(raw) ? raw : resolve(worktree, raw);
	return await realpath(path);
}

async function repositoryObjects(worktree: string, signal?: AbortSignal): Promise<string> {
	const raw = line(await git(["rev-parse", "--git-common-dir"], worktree, undefined, signal), "common Git directory");
	const directory = isAbsolute(raw) ? raw : resolve(worktree, raw);
	return await realpath(join(directory, "objects"));
}

async function assertNoExternalFilters(worktree: string, signal?: AbortSignal): Promise<void> {
	const result = await command(["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"], worktree, process.env, signal, 64 * 1024);
	if (result.code === 1 && result.stdout.length === 0) return;
	if (result.code !== 0) throw new Error("Could not inspect effective Git content filters.");
	throw new Error("Checked direct changesets reject configured Git clean/process filters; use isolated mode or remove the filter configuration before retrying.");
}

async function assertSupportedIndex(worktree: string, signal?: AbortSignal): Promise<void> {
	const flags = await inspectIndexFlags(worktree, runCapturedGit, signal);
	if (flags.failure) throw new Error(`Working-change index inspection failed: ${flags.failure}`);
	if (flags.hidden) throw new Error("Checked direct changesets reject assume-unchanged or skip-worktree index entries.");
	const stage = (await git(["ls-files", "--stage", "-z"], worktree, undefined, signal)).toString("utf8");
	if (stage.includes("�") || /(?:^|\0)160000 /.test(stage)) throw new Error("Checked direct changesets reject Git links.");
}

async function rawManifest(worktree: string, signal?: AbortSignal): Promise<{ json: string; digest: string }> {
	const listed = paths(await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], worktree, undefined, signal));
	const entries: Array<{ path: string; kind: string; mode?: number; size?: number; hash?: string }> = [];
	for (const path of [...new Set(listed)].sort()) {
		signal?.throwIfAborted();
		const absolute = join(worktree, path);
		let info;
		try { info = await lstat(absolute); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") { entries.push({ path, kind: "absent" }); continue; }
			throw error;
		}
		if (info.isSymbolicLink()) {
			const target = await readlink(absolute, { encoding: "buffer" });
			entries.push({ path, kind: "symlink", mode: info.mode & 0o7777, size: target.length, hash: hash(target) });
		} else if (info.isFile()) {
			const contents = await readFile(absolute);
			entries.push({ path, kind: "file", mode: info.mode & 0o7777, size: contents.length, hash: hash(contents) });
		} else {
			throw new Error(`Checked direct evidence rejects unsupported working path type: ${path}`);
		}
	}
	const json = `${JSON.stringify(entries)}\n`;
	if (Buffer.byteLength(json, "utf8") > MANIFEST_MAX_BYTES) throw new Error(`Working-change raw manifest exceeds ${MANIFEST_MAX_BYTES} bytes.`);
	return { json, digest: hash(json) };
}

async function actualIdentity(worktree: string, signal?: AbortSignal): Promise<{ head: string; indexHash: string }> {
	const [head, index] = await Promise.all([
		git(["rev-parse", "--verify", "HEAD"], worktree, undefined, signal),
		readFile(await indexPath(worktree, signal)),
	]);
	return { head: oid(head, "HEAD"), indexHash: hash(index) };
}

async function privateSnapshot(worktree: string, directory: string, signal?: AbortSignal): Promise<{ tree: string; manifest: { json: string; digest: string } }> {
	const privateIndex = join(directory, "index");
	const objectDirectory = join(directory, "objects");
	await mkdir(objectDirectory, { mode: 0o700 });
	await copyFile(await indexPath(worktree, signal), privateIndex, constants.COPYFILE_EXCL);
	await chmod(privateIndex, 0o600);
	const env = {
		...process.env,
		GIT_INDEX_FILE: privateIndex,
		GIT_OBJECT_DIRECTORY: objectDirectory,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: await repositoryObjects(worktree, signal),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	await git(["add", "-A", "--", "."], worktree, env, signal);
	const tree = oid(await git(["write-tree"], worktree, env, signal), "private working tree");
	const manifest = await rawManifest(worktree, signal);
	return { tree, manifest };
}

async function makeDirectory(): Promise<{ directory: string; cleanup(): Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-working-review-"));
	await chmod(directory, 0o700);
	let cleaning: Promise<void> | undefined;
	return { directory, cleanup: () => cleaning ??= rm(directory, { recursive: true, force: true }) };
}

async function capture(worktree: string, directory: string, signal?: AbortSignal): Promise<{ identity: WorkingSnapshotIdentity; manifest: string }> {
	await assertNoExternalFilters(worktree, signal);
	await assertSupportedIndex(worktree, signal);
	const before = await actualIdentity(worktree, signal);
	const snapshot = await privateSnapshot(worktree, directory, signal);
	const afterManifest = await rawManifest(worktree, signal);
	const after = await actualIdentity(worktree, signal);
	if (before.head !== after.head || before.indexHash !== after.indexHash || snapshot.manifest.digest !== afterManifest.digest) {
		throw new Error("Working checkout changed while direct evidence was being captured.");
	}
	return {
		identity: { ...before, tree: snapshot.tree, rawManifestHash: snapshot.manifest.digest },
		manifest: snapshot.manifest.json,
	};
}

export async function captureWorkingCheckoutBaseline(worktree: string, signal?: AbortSignal): Promise<WorkingCheckoutBaseline> {
	const canonical = await realpath(worktree);
	const root = await realpath(line(await git(["rev-parse", "--show-toplevel"], canonical, undefined, signal), "checkout root"));
	if (root !== canonical) throw new Error("Checked direct changesets require the attached Git worktree root as cwd.");
	const branch = await command(["symbolic-ref", "-q", "HEAD"], canonical, process.env, signal, 64 * 1024);
	if (branch.code !== 0) throw new Error("Checked direct changesets require an attached branch.");
	if ((await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], canonical, undefined, signal)).length) {
		throw new Error("Checked direct changesets require a clean initial checkout; settle existing work or choose authorized isolated mode. No files were stashed, reset, or deleted.");
	}
	const owned = await makeDirectory();
	try {
		const captured = await capture(canonical, owned.directory, signal);
		return { worktree: canonical, ...captured.identity };
	} finally {
		await owned.cleanup();
	}
}

export async function prepareWorkingChangeEvidence(
	baseline: WorkingCheckoutBaseline,
	signal?: AbortSignal,
): Promise<PreparedWorkingChangeEvidence> {
	const owned = await makeDirectory();
	try {
		const captured = await capture(baseline.worktree, owned.directory, signal);
		if (captured.identity.head !== baseline.head) throw new Error("Checked direct changesets cannot move HEAD or create commits.");
		const env = {
			...process.env,
			GIT_OBJECT_DIRECTORY: join(owned.directory, "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: await repositoryObjects(baseline.worktree, signal),
			GIT_CONFIG_NOSYSTEM: "1",
		};
		const raw = await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--raw", "-z", baseline.tree, captured.identity.tree], baseline.worktree, env, signal);
		if (raw.toString("utf8").includes("160000")) throw new Error("Checked direct changesets reject changed Git links.");
		const changedPaths = paths(await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", baseline.tree, captured.identity.tree], baseline.worktree, env, signal));
		const patch = await git(["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", baseline.tree, captured.identity.tree], baseline.worktree, env, signal);
		if (patch.length > REVIEW_MAX_PATCH_BYTES) throw new Error(`Working-change evidence exceeds ${REVIEW_MAX_PATCH_BYTES} bytes.`);
		const patchPath = join(owned.directory, "review.patch");
		const rawEvidencePath = join(owned.directory, "raw-manifest.json");
		const patchFile = await open(patchPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		await patchFile.writeFile(patch);
		await patchFile.close();
		await writeFile(rawEvidencePath, captured.manifest, { mode: 0o600, flag: "wx" });
		return { baseline, identity: captured.identity, changedPaths, patchPath, rawEvidencePath, cleanup: owned.cleanup };
	} catch (error) {
		await owned.cleanup();
		throw error;
	}
}

export function sameWorkingSnapshot(left: WorkingSnapshotIdentity, right: WorkingSnapshotIdentity): boolean {
	return left.head === right.head && left.indexHash === right.indexHash && left.tree === right.tree && left.rawManifestHash === right.rawManifestHash;
}
