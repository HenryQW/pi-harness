import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withWorktreeLock } from "@henryqw/pi-herdr";

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
export interface Dispatch { id: string; token: string; workspaceId: string; tabId: string; paneId: string }
export interface Job {
	spec: JobSpec; dir: string; claim?: RunnerIdentity; result?: RunnerState;
	state: CommandState; outputPath: string;
}
export const terminal = (state: CommandState) => ["succeeded", "failed", "cancelled", "timeout", "output_limit"].includes(state);
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
async function withPrivateLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
	// The job directory exists before publication; the state file need not exist yet.
	for (let attempt = 0; ; attempt++) {
		let entered = false;
		try {
			return await withWorktreeLock(dir, () => { entered = true; return operation(); });
		} catch (error) {
			// Retry only lock acquisition, never a read, write, or lock-release failure.
			if (entered || (error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 400) throw error;
		}
		await delay(25);
	}
}
export async function readPrivate(file: string, max = 65_536): Promise<unknown | undefined> {
	return await withPrivateLock(dirname(file), () => readPrivateUnlocked(file, max));
}
async function readPrivateUnlocked(file: string, max = 65_536): Promise<unknown | undefined> {
	let handle;
	try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > max) throw new Error(`Unsafe command state file: ${file}`);
		const buffer = Buffer.alloc(max + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > max) throw new Error(`Command state exceeds its limit: ${file}`);
		return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
	} finally { await handle.close(); }
}
export async function writePrivate(file: string, value: unknown): Promise<void> {
	await withPrivateLock(dirname(file), async () => {
		const handle = await open(file, "wx", 0o600);
		try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
		finally { await handle.close(); }
		await syncDirectory(dirname(file));
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
export async function readJob(dir: string): Promise<Job> {
	await privateDirectory(dir);
	return await withPrivateLock(dir, async () => {
		const spec = parseSpec(await readPrivateUnlocked(join(dir, "spec.json")));
		if (dir.split("/").at(-1) !== spec.id) throw new Error("Command directory identity does not match its specification.");
		const rawClaim = await readPrivateUnlocked(join(dir, "claim.json"));
		const claim = rawClaim === undefined ? undefined : parseIdentity(rawClaim, spec);
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
		const state = result && (terminal(result.state) || Date.now() - result.updatedAt < 10_000) ? result.state
			: !claim && uncertain === undefined && Date.now() - spec.createdAt < 10_000 ? "starting" : "unknown";
		return { spec, dir, claim, result, state, outputPath: join(dir, "output.log") };
	});
}
export async function listJobs(root: string): Promise<Job[]> {
	await privateDirectory(root, true);
	const entries = await readdir(root);
	const jobs: Job[] = [];
	for (const id of entries) {
		// The job-directory lock is a sibling, not a command record.
		if (id.endsWith(".lock") && uuid.test(id.slice(0, -5))) continue;
		jobs.push(await readJob(join(root, jobId(id))));
	}
	return jobs;
}
export async function cancelJob(job: Job): Promise<void> {
	if (terminal(job.state)) return;
	const control = { id: job.spec.id, token: job.spec.token };
	const file = join(job.dir, "cancel.json");
	const raw = await readPrivate(file);
	if (raw !== undefined) {
		const existing = record(raw);
		if (existing.id !== control.id || existing.token !== control.token) throw new Error("Foreign cancellation control; ownership remains unknown.");
		return;
	}
	// Concurrent requests publish the same immutable control. The runner never sees a partial file.
	const temp = join(job.dir, `cancel-${randomUUID()}.tmp`);
	await writePrivate(temp, control);
	await rename(temp, file);
	await syncDirectory(job.dir);
}
export async function outputTail(job: Job): Promise<string> {
	let handle;
	try { handle = await open(job.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("Unsafe command output file.");
		const buffer = Buffer.alloc(Math.min(info.size, 8192));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally { await handle.close(); }
}
