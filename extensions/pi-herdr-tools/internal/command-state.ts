import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrRequestError, withWorktreeLock } from "@henryqw/pi-herdr";

export const COMMAND_STATES = ["starting", "running", "cancelling", "succeeded", "failed", "cancelled", "timeout", "output_limit", "unknown"] as const;
export type CommandState = typeof COMMAND_STATES[number];
export interface JobSpec {
	version: 1; id: string; token: string; callId: string; callEntryId: string; sessionId: string; sessionFile: string | null;
	createdAt: number; cwd: string; checkout: string; workspaceId: string; socketPath: string;
	command: string; access: "read" | "write"; runtimeMs: number; outputBytes: number;
}
export interface RunnerIdentity { id: string; token: string; runnerId: string; workspaceId: string; tabId: string; paneId: string }
export interface RunnerState extends RunnerIdentity {
	state: CommandState; updatedAt: number; exitCode: number | null; signal: string | null; failure?: string;
}
export interface NonDispatchProof {
	version: 1; id: string; token: string; workspaceId: string; updatedAt: number;
	state: "failed" | "cancelled"; reason: "not_dispatched";
}
export interface Job {
	spec: JobSpec; dir: string; claim?: RunnerIdentity; result?: RunnerState; nonDispatch?: NonDispatchProof;
	state: CommandState; outputPath: string; released?: boolean; pruned?: boolean;
}
export interface CommandInventory {
	id: string | null; category: "verified" | "released" | "locked" | "unverified"; diagnostic?: string; spec?: JobSpec; job?: Job;
}
export const terminal = (state: CommandState) => ["succeeded", "failed", "cancelled", "timeout", "output_limit"].includes(state);
export class CommandRemovalBlocked extends Error {}
export function assertCommandRemovalAllowed(jobs: readonly Job[]): void {
	if (jobs.some((job) => !terminal(job.state) && !job.released)) throw new CommandRemovalBlocked("Active or unknown background commands block worktree removal, including forced completion. Inspect /commands.");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function jobId(value: unknown): string {
	if (typeof value !== "string" || !uuid.test(value)) throw new Error("Invalid command identity.");
	return value;
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed command state; preserved for inspection.");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"); }
function integer(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function path(value: unknown): value is string { return text(value) && isAbsolute(value); }
export function parseSpec(value: unknown): JobSpec {
	const s = record(value);
	jobId(s.id); jobId(s.token);
	if (s.version !== 1 || !text(s.callId) || !text(s.callEntryId) || !text(s.sessionId) || !(s.sessionFile === null || path(s.sessionFile)) ||
		!integer(s.createdAt, 1, Number.MAX_SAFE_INTEGER) || !path(s.cwd) || !path(s.checkout) || !path(s.socketPath) ||
		!text(s.workspaceId) || !text(s.command, 16_384) || !["read", "write"].includes(String(s.access)) ||
		!integer(s.runtimeMs, 100, 86_400_000) || !integer(s.outputBytes, 1024, 104_857_600)) throw new Error("Invalid command specification; preserved for inspection.");
	return s as unknown as JobSpec;
}
export function validateSpec(spec: JobSpec): void {
	parseSpec(spec);
	if (Buffer.byteLength(JSON.stringify(spec)) > 65_536) throw new Error("Command specification exceeds 65536 serialized bytes; nothing was reserved or launched.");
}
function parseNonDispatch(value: unknown, spec: JobSpec): NonDispatchProof {
	const p = record(value);
	if (p.version !== 1 || p.id !== spec.id || p.token !== spec.token || p.workspaceId !== spec.workspaceId ||
		!integer(p.updatedAt, spec.createdAt, Number.MAX_SAFE_INTEGER) || (p.state !== "failed" && p.state !== "cancelled") || p.reason !== "not_dispatched") {
		throw new Error("Invalid non-dispatch proof; ownership remains unknown.");
	}
	return p as unknown as NonDispatchProof;
}
function parseIdentity(value: unknown, spec: JobSpec): RunnerIdentity {
	const r = record(value);
	jobId(r.runnerId);
	if (r.id !== spec.id || r.token !== spec.token || r.workspaceId !== spec.workspaceId || !text(r.tabId) || !text(r.paneId)) throw new Error("Foreign command runner identity; ownership remains unknown.");
	return r as unknown as RunnerIdentity;
}
export function sameIdentity(a: RunnerIdentity, b: RunnerIdentity): boolean {
	return ["id", "token", "runnerId", "workspaceId", "tabId", "paneId"].every((key) => a[key as keyof RunnerIdentity] === b[key as keyof RunnerIdentity]);
}
export async function privateDirectory(dir: string, create = false): Promise<void> {
	if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error(`Command directory is not private: ${dir}`);
}
const recoveryDetails = new WeakMap<object, string>();
function recoveryFailure(error: unknown, dir: string, stage: string): unknown {
	if (error && typeof error === "object" && !recoveryDetails.has(error) && uuid.test(basename(dir))) {
		const code = (error as NodeJS.ErrnoException).code;
		const category = error instanceof SyntaxError ? "invalid_json" : code === "ELOCKED" ? "lock_busy"
			: code === "ECOMPROMISED" ? "lock_lost" : code === "EACCES" || code === "EPERM" ? "permission" : "unverified_state";
		recoveryDetails.set(error, `Command ${basename(dir)}: ${stage} (${category}).`);
	}
	return error;
}
export function recoveryDiagnostic(error: unknown): string | undefined {
	return error && typeof error === "object" ? recoveryDetails.get(error) : undefined;
}
async function withPrivateLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
	// The job directory exists before publication; the state file need not exist yet.
	for (let attempt = 0; ; attempt++) {
		let entered = false;
		try {
			return await withWorktreeLock(dir, () => { entered = true; return operation(); });
		} catch (error) {
			// Retry only lock acquisition, never a read, write, or lock-release failure.
			if (entered || publicationLock.getStore() !== undefined || (error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 400) throw recoveryFailure(error, dir, entered ? "record" : "lock");
		}
		await delay(25);
	}
}
const publicationLock = new AsyncLocalStorage<string>();
export async function withCommandStoreLock<T>(root: string, operation: (descriptor: number) => Promise<T>): Promise<T> {
	return await withWorktreeLock(root, (descriptor) => publicationLock.run(root, () => operation(descriptor)));
}
// Call under the checkout lock. Keep command publication excluded through actual removal.
export async function withCommandRemovalGuard<T>(root: string, checkout: string, operation: (descriptor: number) => Promise<T>): Promise<T> {
	await privateDirectory(root, true);
	return await withCommandStoreLock(root, async (descriptor) => {
		let jobs: Job[];
		try { jobs = await listJobs(root, [checkout]); }
		catch (error) { throw Object.assign(new CommandRemovalBlocked(error instanceof Error ? error.message : "Background command records cannot be verified; inspect /commands before removal.", { cause: error }), { code: (error as NodeJS.ErrnoException)?.code }); }
		assertCommandRemovalAllowed(jobs);
		return await operation(descriptor);
	});
}
export async function readPublishedSpec(root: string, dir: string): Promise<JobSpec> {
	try { return await readSpec(dir); }
	catch (error) {
		// Launch and removal guards can already hold this lock through admission callbacks.
		if (publicationLock.getStore() === root) throw error;
		// Wait without a job lock. Publication takes the root lock before the job lock.
		return await withPrivateLock(root, () => readSpec(dir));
	}
}
export async function readPrivate(file: string, max = 65_536): Promise<unknown | undefined> {
	return await withPrivateLock(dirname(file), () => readPrivateUnlocked(file, max));
}
async function readPrivateUnlocked(file: string, max = 65_536): Promise<unknown | undefined> {
	try { return await readPrivateFile(file, max); }
	catch (error) {
		const name = basename(file);
		const stage = ["spec.json", "claim.json", "state.json", "dispatch.json", "uncertain.json", "cancel.json", "delivered.json"].includes(name) ? name : "record";
		throw recoveryFailure(error, dirname(file), stage);
	}
}
async function readPrivateFile(file: string, max: number): Promise<unknown | undefined> {
	let handle;
	// A pipe must not block open before the file-type check while we hold the job lock.
	try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > max) throw new Error(`Unsafe command state file: ${file}`);
		const buffer = Buffer.alloc(max + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > max) throw new Error(`Command state exceeds its limit: ${file}`);
		try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
		catch { throw new SyntaxError("Invalid command state; preserved for inspection."); }
	} finally { await handle.close(); }
}
export async function writePrivate(file: string, value: unknown): Promise<void> {
	await withPrivateLock(dirname(file), () => writePrivateUnlocked(file, value));
}
async function writePrivateUnlocked(file: string, value: unknown): Promise<void> {
	const handle = await open(file, "wx", 0o600);
	try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
	finally { await handle.close(); }
	await syncDirectory(dirname(file));
}
export async function claimRunner(dir: string, identity: RunnerIdentity): Promise<void> {
	await withPrivateLock(dir, async () => {
		const spec = await readSpec(dir);
		parseIdentity(identity, spec);
		if (await userReleased(dir, spec)) throw new Error("Command released by user; a runner cannot claim it.");
		await writePrivateUnlocked(join(dir, "claim.json"), identity);
	});
}
export async function recordNonDispatch(job: Job, error: unknown): Promise<boolean> {
	if (!(error instanceof HerdrRequestError) || error.dispatched !== false) return false;
	return await withPrivateLock(job.dir, async () => {
		const spec = await readSpec(job.dir);
		if (spec.id !== job.spec.id || spec.token !== job.spec.token) throw new Error("Foreign non-dispatch identity.");
		for (const file of ["claim.json", "state.json", "dispatch.json", "uncertain.json"]) {
			if (await readPrivateUnlocked(join(job.dir, file)) !== undefined) return false;
		}
		const proof: NonDispatchProof = { version: 1, id: spec.id, token: spec.token, workspaceId: spec.workspaceId,
			updatedAt: Date.now(), state: error.code === "aborted" ? "cancelled" : "failed", reason: "not_dispatched" };
		// One exclusive creation slot seals either runner ownership or proved non-dispatch.
		await writePrivateUnlocked(join(job.dir, "claim.json"), proof);
		return true;
	});
}
async function syncDirectory(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicState(dir: string, state: RunnerState): Promise<void> {
	const temp = join(dir, `state-${randomUUID()}.tmp`);
	await writePrivate(temp, state);
	await withPrivateLock(dir, async () => {
		await rename(temp, join(dir, "state.json"));
		await syncDirectory(dir);
	});
}
async function readSpec(dir: string): Promise<JobSpec> {
	try {
		const spec = parseSpec(await readPrivateUnlocked(join(dir, "spec.json")));
		if (basename(dir) !== spec.id) throw new Error("Command directory identity does not match its specification.");
		return spec;
	} catch (error) { throw recoveryFailure(error, dir, "spec.json"); }
}
export async function readJob(dir: string, wait = true): Promise<Job> {
	await privateDirectory(dir);
	const spec = await readSpec(dir);
	// Release is not completion proof. Read later runner evidence when the lock is available.
	const released = await userReleased(dir, spec);
	try {
		const job = await (wait && !released ? withPrivateLock : withWorktreeLock)(dir, () => readJobUnlocked(dir));
		return released ? { ...job, state: terminal(job.state) ? job.state : "unknown", released: true } : job;
	} catch (error) {
		// A released record remains inspectable even if its mutable evidence is locked or damaged.
		if (released) return { spec, dir, state: "unknown", released: true, outputPath: join(dir, "output.log") };
		throw recoveryFailure(error, dir, "lock");
	}
}
async function readJobUnlocked(dir: string): Promise<Job> {
		const spec = await readSpec(dir);
		const rawClaim = await readPrivateUnlocked(join(dir, "claim.json"));
		const nonDispatch = rawClaim !== undefined && record(rawClaim).reason === "not_dispatched" ? parseNonDispatch(rawClaim, spec) : undefined;
		const claim = rawClaim === undefined || nonDispatch ? undefined : parseIdentity(rawClaim, spec);
		const rawResult = await readPrivateUnlocked(join(dir, "state.json"));
		let result: RunnerState | undefined;
		if (rawResult !== undefined) {
			const r = record(rawResult);
			const identity = parseIdentity(r, spec);
			if (!claim || !sameIdentity(claim, identity) || !COMMAND_STATES.includes(r.state as CommandState) ||
				!integer(r.updatedAt, spec.createdAt, Number.MAX_SAFE_INTEGER) || !(r.exitCode === null || integer(r.exitCode, 0, 255)) ||
				!(r.signal === null || text(r.signal, 32)) || (r.failure !== undefined && (!text(r.failure, 64) || !/^[a-zA-Z0-9_]+$/.test(r.failure)))) throw new Error("Invalid runner completion; ownership remains unknown.");
			if (r.state === "succeeded" && (r.exitCode !== 0 || r.signal !== null)) throw new Error("Invalid successful command completion.");
			result = r as unknown as RunnerState;
		}
		const dispatch = await readPrivateUnlocked(join(dir, "dispatch.json"));
		if (dispatch !== undefined) {
			const d = record(dispatch);
			if (d.id !== spec.id || d.token !== spec.token || d.workspaceId !== spec.workspaceId || !text(d.tabId) || !text(d.paneId) ||
				(claim && (d.tabId !== claim.tabId || d.paneId !== claim.paneId))) throw new Error("Herdr terminal identity does not match the command runner.");
		}
		const uncertain = await readPrivateUnlocked(join(dir, "uncertain.json"));
		if (uncertain !== undefined) {
			const u = record(uncertain);
			if (u.id !== spec.id || u.token !== spec.token) throw new Error("Foreign dispatch record.");
		}
		if (nonDispatch && (claim || result || dispatch !== undefined || uncertain !== undefined)) throw new Error("Conflicting command dispatch proof; ownership remains unknown.");
		const state = nonDispatch ? nonDispatch.state : result && (terminal(result.state) || Date.now() - result.updatedAt < 10_000) ? result.state
			: !claim && uncertain === undefined && Date.now() - spec.createdAt < 10_000 ? "starting" : "unknown";
		const pruneAuthorized = await controlRecord(dir, spec, "pruned");
		if (pruneAuthorized && !terminal(state)) throw new Error("Pruned command has no verified completion.");
		let pruned = false;
		if (pruneAuthorized) {
			try { await lstat(join(dir, "output.log")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; pruned = true; }
		}
		return { spec, dir, claim, result, nonDispatch, state, outputPath: join(dir, "output.log"), ...(pruned ? { pruned: true } : {}) };
}
export async function listJobs(root: string, checkouts?: readonly string[]): Promise<Job[]> {
	await privateDirectory(root, true);
	const entries = await readdir(root);
	const jobs: Job[] = [];
	for (const id of entries) {
		// The job-directory lock is a sibling, not a command record.
		if (id.endsWith(".lock") && uuid.test(id.slice(0, -5))) continue;
		const dir = join(root, jobId(id));
		await privateDirectory(dir);
		// All readers wait for incomplete publication before taking the job lock.
		const spec = await readPublishedSpec(root, dir);
		if (checkouts && !checkouts.includes(spec.checkout)) continue;
		jobs.push(await readJob(dir));
	}
	return jobs;
}
// These controls use the specification lock, not the potentially stuck record lock.
// Never replace or unlink a kernel lock sidecar.
async function controlRecord(dir: string, spec: JobSpec, kind: "released" | "pruned"): Promise<boolean> {
	const raw = await readPrivateUnlocked(join(dir, `${kind}.json`));
	if (raw === undefined) return false;
	const value = record(raw);
	if (value.version !== 1 || value.id !== spec.id || value.token !== spec.token || value.checkout !== spec.checkout ||
		value.sessionId !== spec.sessionId || value.callId !== spec.callId || value.kind !== kind ||
		!integer(value.updatedAt, spec.createdAt, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid user command control; protection stays held.");
	return true;
}
export const userReleased = (dir: string, spec: JobSpec) => controlRecord(dir, spec, "released");
async function publishControl(dir: string, spec: JobSpec, kind: "released" | "pruned", check: () => void): Promise<void> {
	check();
	const temp = join(dir, `${kind}-${randomUUID()}.tmp`);
	await writePrivateUnlocked(temp, { version: 1, id: spec.id, token: spec.token, checkout: spec.checkout,
		sessionId: spec.sessionId, callId: spec.callId, kind, updatedAt: Date.now() });
	check();
	await rename(temp, join(dir, `${kind}.json`));
	await syncDirectory(dir);
}
async function checkSpec(dir: string, expected: JobSpec): Promise<JobSpec> {
	await privateDirectory(dir);
	const spec = await readSpec(dir);
	if (JSON.stringify(spec) !== JSON.stringify(expected)) throw new Error("Command identity or scope changed; no action was taken.");
	return spec;
}
export async function releaseJob(dir: string, expected: JobSpec, typedId: string, check: () => void): Promise<void> {
	if (typedId !== expected.id) throw new Error("Type the exact command ID to release protection.");
	await checkSpec(dir, expected);
	await withWorktreeLock(join(dir, "spec.json"), async () => {
		const spec = await checkSpec(dir, expected);
		check();
		if (await userReleased(dir, spec)) return;
		// Release also asks the live runner to stop; malformed cancellation evidence is preserved.
		await publishControl(dir, spec, "released", check);
	});
}
// The callback must start the shell synchronously. Release and spawn cannot cross.
export async function startUnreleased<T>(dir: string, spec: JobSpec, start: () => T): Promise<T> {
	await checkSpec(dir, spec);
	return await withWorktreeLock(join(dir, "spec.json"), async () => {
		await checkSpec(dir, spec);
		if (await userReleased(dir, spec) || await cancellationRequested(dir, spec)) throw new Error("Command start is sealed by user control.");
		return start();
	});
}
// Only the human command handler calls this after explicit warned confirmation.
export async function pruneJob(dir: string, expected: JobSpec, check: () => void): Promise<void> {
	await checkSpec(dir, expected);
	await withWorktreeLock(join(dir, "spec.json"), () => withWorktreeLock(dir, async () => {
		const verify = async () => {
			await checkSpec(dir, expected);
			await userReleased(dir, expected);
			const job = await readJobUnlocked(dir);
			if (!terminal(job.state)) throw new Error("Only verified finished commands can be pruned; output is preserved.");
			// This proves recorded delivery only, not exclusive consumption across Pi processes.
			const raw = await readPrivateUnlocked(join(dir, "delivered.json"));
			if (raw === undefined) throw new Error("Completion delivery is pending; output is preserved.");
			const delivered = record(raw);
			if (delivered.id !== expected.id || delivered.runnerId !== (job.claim?.runnerId ?? null)) throw new Error("Foreign completion delivery record; output is preserved.");
			await outputTail(job);
			check();
			return job;
		};
		await verify();
		// Persist permission before deletion. A receipt alone never reports output as absent.
		if (!await controlRecord(dir, expected, "pruned")) await publishControl(dir, expected, "pruned", check);
		const job = await verify();
		check();
		try { await unlink(job.outputPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		await syncDirectory(dir);
	}));
}
export async function inventoryJobs(root: string): Promise<CommandInventory[]> {
	await privateDirectory(root, true);
	const inventory: CommandInventory[] = [];
	for (const name of await readdir(root)) {
		if (name.endsWith(".lock") && uuid.test(name.slice(0, -5))) continue;
		const id = uuid.test(name) ? name : null;
		let spec: JobSpec | undefined;
		try {
			if (!id) throw new Error("Unrecognized command record.");
			const dir = join(root, id);
			await privateDirectory(dir);
			// Immutable identity is safe to inspect without the mutable-state lock.
			spec = await readSpec(dir);
			const job = await readJob(dir, false);
			inventory.push({ id, spec, job, category: job.released ? "released" : "verified" });
		} catch (error) {
			inventory.push({ id, spec, category: (error as NodeJS.ErrnoException).code === "ELOCKED" ? "locked" : "unverified",
				diagnostic: recoveryDiagnostic(error) ?? `Command ${id ?? "record"}: identity or state could not be verified.` });
		}
	}
	return inventory;
}
export async function cancelJob(job: Pick<Job, "spec" | "dir"> & { state?: CommandState }, check: () => void = () => {}): Promise<void> {
	check();
	if (job.state && terminal(job.state)) return;
	const control = { id: job.spec.id, token: job.spec.token };
	const file = join(job.dir, "cancel.json");
	await privateDirectory(job.dir);
	const raw = await readPrivateUnlocked(file);
	if (raw !== undefined) {
		const existing = record(raw);
		if (existing.id !== control.id || existing.token !== control.token) throw new Error("Foreign cancellation control; ownership remains unknown.");
		return;
	}
	// Concurrent requests publish the same immutable control. The runner never sees a partial file.
	check();
	const temp = join(job.dir, `cancel-${randomUUID()}.tmp`);
	await writePrivateUnlocked(temp, control);
	check();
	await rename(temp, file);
	await syncDirectory(job.dir);
}
// Cancellation is published by atomic rename, so the runner needs no record lock.
export async function cancellationRequested(dir: string, spec: JobSpec): Promise<boolean> {
	if (await userReleased(dir, spec)) return true;
	const raw = await readPrivateUnlocked(join(dir, "cancel.json"));
	if (raw === undefined) return false;
	const value = record(raw);
	if (value.id !== spec.id || value.token !== spec.token) throw new Error("Foreign cancellation control; ownership remains unknown.");
	return true;
}
export async function outputTail(job: Job): Promise<string> {
	let handle;
	try { handle = await open(job.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return await controlRecord(job.dir, job.spec, "pruned") ? "(Output has been pruned by the user.)" : "";
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("Unsafe command output file.");
		const buffer = Buffer.alloc(Math.min(info.size, 8192));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally { await handle.close(); }
}
