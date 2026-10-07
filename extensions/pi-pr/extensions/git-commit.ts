import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnBounded, type Exec, type ExecOptions } from "@henryqw/pi-process";
import { inspectWorktreeState, parseNulPaths, parseStatusSnapshot, readHead, requiredOid, requiredText, runChecked, validatePaths, withWorktreeLock } from "./pr-execution.ts";

export type PendingCommit = { head: string; status: string; integrity: string };

export function commitPaths(input: string[]): string[] {
	const paths = validatePaths(input, "Commit paths");
	if (!paths.length) throw new Error("Commit paths must not be empty");
	for (const path of paths) {
		const parts = path.split("/");
		if (parts.some((part) => !part || part === "." || part === ".git" || part === ".context") || path.includes("\0")) {
			throw new Error("Commit paths must be canonical and must exclude .git/ and .context/");
		}
		if (parts.some((part) => /^(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part))) {
			throw new Error("Commit paths include a possible secret; remove it from the commit scope");
		}
	}
	return paths;
}

/** Integrity includes file bytes, symlink targets, modes, and the index, not only status letters. */
export async function inspectPendingCommit(exec: Exec, options: ExecOptions): Promise<PendingCommit> {
	if (await inspectWorktreeState(exec, options) === "operation") throw new Error("Git operation in progress");
	const head = await readHead(exec, options);
	const status = (await runChecked(exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], options)).stdout;
	const hash = createHash("sha256").update(status);
	hash.update((await runChecked(exec, "git", ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"], options)).stdout);
	for (const path of validatePaths([...parseStatusSnapshot(status).keys()], "Pending paths")) {
		const absolute = join(options.cwd, path);
		let stat;
		try { stat = await lstat(absolute); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") { hash.update("deleted\0"); continue; }
			throw error;
		}
		hash.update(`${path}\0${stat.mode}\0`);
		if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
		else if (stat.isFile()) for await (const chunk of createReadStream(absolute)) {
			options.signal?.throwIfAborted();
			hash.update(chunk);
		}
		else throw new Error("Pending directories or submodules need a separate ownership decision");
		hash.update("\0");
	}
	return { head, status, integrity: hash.digest("hex") };
}

export async function requirePendingCommit(exec: Exec, options: ExecOptions, pending: PendingCommit): Promise<void> {
	const current = await inspectPendingCommit(exec, options);
	if (current.head !== pending.head || current.status !== pending.status || current.integrity !== pending.integrity) {
		throw new Error("Pending work changed after inspection; review it again");
	}
}

/** Call under the worktree lock. Never replace unrelated or partially staged work. */
export async function stageCommitPaths(exec: Exec, options: ExecOptions, input: string[]): Promise<void> {
	const paths = commitPaths(input);
	const staged = parseNulPaths((await runChecked(exec, "git", ["diff", "--cached", "--no-renames", "--name-only", "-z"], options)).stdout, "Staged paths");
	if (staged.some((path) => !paths.includes(path))) throw new Error("Unrelated staged changes require an ownership decision");
	const unstaged = parseNulPaths((await runChecked(exec, "git", ["diff", "--no-renames", "--name-only", "-z"], options)).stdout, "Unstaged paths");
	if (staged.some((path) => unstaged.includes(path))) throw new Error("Partially staged changes require an ownership decision; staging was preserved");
	await runChecked(exec, "git", ["--literal-pathspecs", "add", "-A", "--", ...paths], options);
}

export function validateCommitMessage(message: string): void {
	if (typeof message !== "string" || !/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n()]+\))?!?: [^\r\n]+(?:\n[\s\S]*)?$/.test(message) || message.split("\n")[0]!.length > 72 || message.length > 16_384 || message.includes("\0")) {
		throw new Error("Use a Conventional Commit message with a subject of at most 72 characters");
	}
}

export async function commitStagedPaths(exec: Exec, options: ExecOptions, message: string): Promise<void> {
	validateCommitMessage(message);
	const parent = await readHead(exec, options);
	const tree = requiredOid((await runChecked(exec, "git", ["write-tree"], options)).stdout.trim(), "commit tree");
	await runChecked(exec, "git", ["commit", "-m", message], options);
	const actual = (await runChecked(exec, "git", ["show", "-s", "--format=%P %T", "HEAD"], options)).stdout.trim();
	if (actual !== `${parent} ${tree}`) throw new Error("Commit parent or tree changed, possibly by a hook; inspect the actual commit and do not replay it");
}

type Options = { cwd: string; agentDir?: string; exec?: Exec };

/** A single session/worktree owns this object. Unknown mutations consume it until manual review. */
export class GitCommitter {
	private pending?: PendingCommit & { inspectionId: string; branch: string };
	private uncertain = false;
	private readonly exec: Exec;
	private readonly options: Options;
	constructor(options: Options) { this.options = options; this.exec = options.exec ?? spawnBounded; }

	async inspect(target: string, signal?: AbortSignal) {
		if (this.uncertain) throw new Error("Commit outcome needs manual review; do not replay it. Reload only after review");
		requiredText(target, "target");
		return withWorktreeLock(this.options.cwd, async () => {
			const options = { cwd: this.options.cwd, signal };
			const branch = requiredText((await runChecked(this.exec, "git", ["branch", "--show-current"], options)).stdout.trim(), "attached branch");
			const targetOid = requiredOid((await runChecked(this.exec, "git", ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`], options)).stdout.trim(), "target OID");
			const pending = await inspectPendingCommit(this.exec, options);
			const mergeBase = requiredOid((await runChecked(this.exec, "git", ["merge-base", pending.head, targetOid], options)).stdout.trim(), "merge base");
			const inspectionId = randomUUID();
			this.pending = { ...pending, inspectionId, branch };
			return { inspectionId, head: pending.head, targetOid, mergeBase, paths: [...parseStatusSnapshot(pending.status).keys()] };
		}, { agentDir: this.options.agentDir, signal });
	}

	async commit(inspectionId: string, pathsInput: string[], message: string, signal?: AbortSignal) {
		const pending = this.pending;
		if (!pending || pending.inspectionId !== inspectionId || this.uncertain) throw new Error("Commit inspection is absent, stale, or consumed");
		const paths = commitPaths(pathsInput);
		if (paths.some((path) => !parseStatusSnapshot(pending.status).has(path))) throw new Error("Commit paths must be reviewed pending paths");
		validateCommitMessage(message);
		return withWorktreeLock(this.options.cwd, async () => {
			const options = { cwd: this.options.cwd, signal };
			if ((await runChecked(this.exec, "git", ["branch", "--show-current"], options)).stdout.trim() !== pending.branch) throw new Error("Commit branch changed");
			await requirePendingCommit(this.exec, options, pending);
			// Stage validation can fail without consuming an attempt. No commit has run yet.
			await stageCommitPaths(this.exec, options, paths);
			this.pending = undefined;
			this.uncertain = true;
			await commitStagedPaths(this.exec, options, message);
			const head = await readHead(this.exec, options);
			this.uncertain = false;
			return { head };
		}, { agentDir: this.options.agentDir, signal });
	}
}
