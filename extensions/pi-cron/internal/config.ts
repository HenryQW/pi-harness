import { isAbsolute } from "node:path";
import { createConfigStore, extensionConfigDir, field, parsers, type FieldParser } from "@henryqw/pi-config-store";
import {
	canonicalModelReference,
	PROFILE_NAMES,
	THINKING_LEVELS,
	type ProfileName,
	type ThinkingLevel,
} from "@henryqw/pi-task-models";
import { parseEvery, type Schedule } from "./schedule.ts";

const EXTENSION_ID = "pi-cron";
const NOTIFY_MODES = ["notify", "followUp", "none"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/** One validated job exactly as written in config.json; derived values come from the helpers below. */
export interface Job {
	id: string;
	every?: string;
	at?: string;
	timezone?: string;
	role: string;
	modelClass?: ProfileName;
	model?: string;
	thinking?: ThinkingLevel;
	cwd: string;
	env?: Record<string, string>;
	prompt?: string;
	promptFile?: string;
	enabled?: boolean;
	notify?: NotifyMode;
}

export interface Limits {
	maxTurns?: number;
	idleMinutes?: number;
	maxMinutes?: number;
}

export interface CronConfig {
	jobs: Job[];
	limits?: Limits;
}

const DEFAULT_LIMITS = { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 } as const;
const JOB_KEYS = ["id", "every", "at", "timezone", "role", "modelClass", "model", "thinking", "cwd", "env", "prompt", "promptFile", "enabled", "notify"] as const;
export const JOB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const record = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
		throw new Error(`${label} must be non-empty text`);
	}
	return value;
};
const optional = <T>(value: unknown, parse: (value: unknown) => T): T | undefined => value === undefined ? undefined : parse(value);
const rejectUnknownKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
};

function validTimeZone(value: unknown, label: string): string {
	const zone = text(value, label);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch {
		throw new Error(`${label} must be an IANA time zone such as Asia/Hong_Kong`);
	}
	return zone;
}

/** Any problem rejects the whole job, so the store drops it; a misspelled key never runs a job with a default. */
function parseJob(value: unknown): Job {
	const raw = record(value, "Job");
	const id = text(raw.id, "Job id");
	if (!JOB_ID.test(id)) throw new Error(`Job id must match ${JOB_ID}`);
	const label = `Job ${id}`;
	rejectUnknownKeys(raw, JOB_KEYS, label);
	if ((raw.every === undefined) === (raw.at === undefined)) throw new Error(`${label} needs exactly one of every or at`);
	optional(raw.every, (candidate) => {
		const spec = text(candidate, `${label} every`);
		if (parseEvery(spec) === undefined) throw new Error(`${label} every must be like 15m, 6h, or 1d, between 1m and 7d`);
		return spec;
	});
	const at = optional(raw.at, (candidate) => {
		const clock = text(candidate, `${label} at`);
		if (!CLOCK.test(clock)) throw new Error(`${label} at must be HH:MM in 24-hour time`);
		return clock;
	});
	if (raw.timezone !== undefined && at === undefined) throw new Error(`${label} timezone requires at`);
	optional(raw.timezone, (candidate) => validTimeZone(candidate, `${label} timezone`));
	const modelClass = optional(raw.modelClass, (candidate) => {
		if (typeof candidate !== "string" || !(PROFILE_NAMES as readonly string[]).includes(candidate)) {
			throw new Error(`${label} modelClass must be one of ${PROFILE_NAMES.join(", ")}`);
		}
		return candidate as ProfileName;
	});
	if ((raw.model === undefined) !== (raw.thinking === undefined)) throw new Error(`${label} model and thinking must be set together`);
	if (modelClass !== undefined && raw.model !== undefined) throw new Error(`${label} cannot set both modelClass and model`);
	const model = optional(raw.model, (candidate) => {
		try {
			return canonicalModelReference(text(candidate, `${label} model`));
		} catch {
			throw new Error(`${label} model must be provider/model`);
		}
	});
	optional(raw.thinking, (candidate) => {
		if (typeof candidate !== "string" || !(THINKING_LEVELS as readonly string[]).includes(candidate)) {
			throw new Error(`${label} thinking must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		return candidate as ThinkingLevel;
	});
	const cwd = text(raw.cwd, `${label} cwd`);
	if (!isAbsolute(cwd)) throw new Error(`${label} cwd must be an absolute path`);
	optional(raw.env, (candidate) => {
		const entries = Object.entries(record(candidate, `${label} env`));
		for (const [name, entry] of entries) {
			if (!ENV_NAME.test(name)) throw new Error(`${label} env has an invalid variable name: ${name}`);
			if (typeof entry !== "string" || entry.includes("\0")) throw new Error(`${label} env.${name} must be a string`);
		}
		return Object.fromEntries(entries) as Record<string, string>;
	});
	if ((raw.prompt === undefined) === (raw.promptFile === undefined)) throw new Error(`${label} needs exactly one of prompt or promptFile`);
	optional(raw.prompt, (candidate) => text(candidate, `${label} prompt`));
	optional(raw.promptFile, (candidate) => {
		const file = text(candidate, `${label} promptFile`);
		if (!isAbsolute(file)) throw new Error(`${label} promptFile must be an absolute path`);
		return file;
	});
	optional(raw.enabled, (candidate) => {
		if (typeof candidate !== "boolean") throw new Error(`${label} enabled must be true or false`);
		return candidate;
	});
	optional(raw.notify, (candidate) => {
		if (typeof candidate !== "string" || !(NOTIFY_MODES as readonly string[]).includes(candidate)) {
			throw new Error(`${label} notify must be one of ${NOTIFY_MODES.join(", ")}`);
		}
		return candidate as NotifyMode;
	});
	text(raw.role, `${label} role`);
	return { ...raw, ...(model === undefined ? {} : { model }) } as Job;
}

const minutes: FieldParser<number> = (raw) => {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw * 60_000 > 2_147_483_647) {
		throw new Error("must be positive minutes within the 2147483647 ms timer limit");
	}
	return raw;
};
// An absent limit keeps its default, so the store never writes defaults into the file.
const limitFields = parsers.object({
	maxTurns: field<number | undefined>(parsers.integer({ min: 1 }), undefined),
	idleMinutes: field<number | undefined>(minutes, undefined),
	maxMinutes: field<number | undefined>(minutes, undefined),
});

/** A bad limit uses its default; a broken idle/max pair rejects all limits, so every limit uses its default. */
const parseLimits: FieldParser<Limits> = (raw, report) => {
	const limits: Limits = Object.fromEntries(Object.entries(limitFields(raw, report)).filter(([, value]) => value !== undefined));
	const effective = effectiveLimits({ jobs: [], limits });
	if (effective.maxMinutes <= effective.idleMinutes) throw new Error("maxMinutes must be greater than idleMinutes");
	return limits;
};

export function effectiveLimits(config: CronConfig): Required<Limits> {
	return { ...DEFAULT_LIMITS, ...config.limits };
}

export function jobSchedule(job: Job): Schedule {
	if (job.every !== undefined) return { kind: "every", everyMs: parseEvery(job.every)! };
	const [, hour, minute] = CLOCK.exec(job.at!)!;
	return { kind: "at", hour: Number(hour), minute: Number(minute), timeZone: job.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export const jobEnabled = (job: Job): boolean => job.enabled ?? true;
export const jobNotify = (job: Job): NotifyMode => job.notify ?? "notify";

/** A bad job is dropped and reported, so the other jobs still run. */
export function cronConfigStore(agentDir: string) {
	return createConfigStore({
		extensionId: EXTENSION_ID,
		agentDir,
		fields: {
			jobs: field(parsers.array(parseJob, { unique: (job) => job.id }), []),
			limits: field<Limits | undefined>(parseLimits, undefined),
		},
	});
}

export const cronHome = (agentDir: string): string => extensionConfigDir(EXTENSION_ID, agentDir);
