import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { readTextFileBoundedSync, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { lock } from "proper-lockfile";
import { dueAt, type Schedule } from "./schedule.ts";

const MAX_STATE_BYTES = 1024 * 1024;
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 50 } } as const;

export type Outcome = "success" | "failure";

export interface JobState {
	firstSeenAt: number;
	lastStartedAt?: number;
	lastFinishedAt?: number;
	lastOutcome?: Outcome;
	lastSummary?: string;
	lastSession?: string;
	running?: { startedAt: number; owner: string };
}

export interface CronState {
	version: 1;
	jobs: Record<string, JobState>;
}

export interface Claim {
	dueAt: number;
	startedAt: number;
	owner: string;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const timestamp = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
const text = (value: unknown): value is string => typeof value === "string" && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);

function parseState(value: unknown, path: string): CronState {
	const invalid = (field: string): never => { throw new Error(`pi-cron state at ${path} has invalid ${field}; fix it or move it aside to reset.`); };
	const object = (value: unknown, keys: readonly string[], field: string): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) return invalid(field);
		return value as Record<string, unknown>;
	};
	const state = object(value, ["version", "jobs"], "root");
	if (state.version !== 1 || !state.jobs || typeof state.jobs !== "object" || Array.isArray(state.jobs)) invalid("version or jobs");
	for (const [id, value] of Object.entries(state.jobs as Record<string, unknown>)) {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) invalid(`job id ${id}`);
		const job = object(value, ["firstSeenAt", "lastStartedAt", "lastFinishedAt", "lastOutcome", "lastSummary", "lastSession", "running"], `job ${id}`);
		if (!timestamp(job.firstSeenAt)) invalid(`${id}.firstSeenAt`);
		for (const key of ["lastStartedAt", "lastFinishedAt"] as const) {
			if (job[key] !== undefined && !timestamp(job[key])) invalid(`${id}.${key}`);
		}
		if (job.lastOutcome !== undefined && job.lastOutcome !== "success" && job.lastOutcome !== "failure") invalid(`${id}.lastOutcome`);
		if (job.lastSummary !== undefined && !text(job.lastSummary)) invalid(`${id}.lastSummary`);
		if (job.lastSession !== undefined && (!text(job.lastSession) || !isAbsolute(job.lastSession))) invalid(`${id}.lastSession`);
		if (job.lastOutcome !== undefined && (job.lastFinishedAt === undefined || job.lastSummary === undefined)) invalid(`${id} result`);
		if (job.running !== undefined) {
			const run = object(job.running, ["startedAt", "owner"], `${id}.running`);
			if (!timestamp(run.startedAt) || !text(run.owner) || !run.owner.trim()) invalid(`${id}.running identity`);
		}
	}
	return { version: 1, jobs: Object.assign(Object.create(null), state.jobs) as Record<string, JobState> };
}

export class StateStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	loadSync(): CronState {
		let contents: string;
		try {
			contents = readTextFileBoundedSync(this.path, MAX_STATE_BYTES);
		} catch (error) {
			if (isMissing(error)) return { version: 1, jobs: Object.create(null) as Record<string, JobState> };
			throw error;
		}
		return parseState(JSON.parse(contents), this.path);
	}

	/** Mutate the latest state under the lock; no-op operations never replace the file. */
	private async update<T>(mutate: (state: CronState) => { value: T; changed: boolean }): Promise<T> {
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const release = await lock(directory, { ...LOCK_OPTIONS, lockfilePath: `${this.path}.lock` });
		try {
			const state = this.loadSync();
			const result = mutate(state);
			if (result.changed) {
				const contents = `${JSON.stringify(state, null, "\t")}\n`;
				if (Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES) {
					throw new Error(`pi-cron state exceeds ${MAX_STATE_BYTES} bytes; remove inactive job records from ${this.path}. Existing state was preserved.`);
				}
				await writePrivateTextFileAtomically(this.path, contents);
			}
			return result.value;
		} finally {
			await release();
		}
	}

	/** Claim a due run, or just record the baseline on first sighting. */
	claim(id: string, schedule: Schedule, now: number, options: { owner: string; staleMs: number; force?: boolean }): Promise<Claim | undefined> {
		return this.update((state) => {
			const newJob = state.jobs[id] === undefined;
			const job = state.jobs[id] ??= { firstSeenAt: now };
			if (job.running && now - job.running.startedAt < options.staleMs) return { value: undefined, changed: false };
			const anchor = Math.max(job.firstSeenAt, job.lastStartedAt ?? 0);
			const due = options.force ? now : dueAt(schedule, now, anchor);
			if (due === undefined) return { value: undefined, changed: newJob };
			job.running = { startedAt: now, owner: options.owner };
			job.lastStartedAt = now;
			return { value: { dueAt: due, ...job.running }, changed: true };
		});
	}

	finish(id: string, claim: Claim, result: { finishedAt: number; outcome: Outcome; summary: string; session?: string }): Promise<boolean> {
		return this.update((state) => {
			const job = state.jobs[id];
			if (!job?.running || job.running.owner !== claim.owner || job.running.startedAt !== claim.startedAt) return { value: false, changed: false };
			delete job.running;
			job.lastFinishedAt = result.finishedAt;
			job.lastOutcome = result.outcome;
			job.lastSummary = result.summary;
			if (result.session === undefined) delete job.lastSession;
			else job.lastSession = result.session;
			return { value: true, changed: true };
		});
	}
}
