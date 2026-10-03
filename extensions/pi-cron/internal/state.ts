import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function parseState(value: unknown, path: string): CronState {
	const state = value as CronState;
	if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 1
		|| !state.jobs || typeof state.jobs !== "object" || Array.isArray(state.jobs)) {
		throw new Error(`pi-cron state at ${path} is not a version 1 state object; move it aside to reset.`);
	}
	return state;
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
			if (isMissing(error)) return { version: 1, jobs: {} };
			throw error;
		}
		return parseState(JSON.parse(contents), this.path);
	}

	/** Mutate the latest state under the cross-process lock and persist it. */
	async update<T>(mutate: (state: CronState) => T): Promise<T> {
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const release = await lock(directory, { ...LOCK_OPTIONS, lockfilePath: `${this.path}.lock` });
		try {
			const state = this.loadSync();
			const result = mutate(state);
			await writePrivateTextFileAtomically(this.path, `${JSON.stringify(state, null, "\t")}\n`);
			return result;
		} finally {
			await release();
		}
	}

	/**
	 * Record a run start when the job is due (or forced) and no other process
	 * holds a fresh run claim. A job seen for the first time only gets its baseline.
	 */
	claim(id: string, schedule: Schedule, now: number, options: { owner: string; staleMs: number; force?: boolean }): Promise<Claim | undefined> {
		return this.update((state) => {
			const job = state.jobs[id] ??= { firstSeenAt: now };
			if (job.running && now - job.running.startedAt < options.staleMs) return undefined;
			const anchor = Math.max(job.firstSeenAt, job.lastStartedAt ?? 0);
			const due = options.force ? now : dueAt(schedule, now, anchor);
			if (due === undefined) return undefined;
			job.running = { startedAt: now, owner: options.owner };
			job.lastStartedAt = now;
			return { dueAt: due, startedAt: now };
		});
	}

	finish(id: string, result: { finishedAt: number; outcome: Outcome; summary: string; session: string }): Promise<void> {
		return this.update((state) => {
			const job = state.jobs[id] ??= { firstSeenAt: result.finishedAt };
			delete job.running;
			job.lastFinishedAt = result.finishedAt;
			job.lastOutcome = result.outcome;
			job.lastSummary = result.summary;
			job.lastSession = result.session;
		});
	}
}
