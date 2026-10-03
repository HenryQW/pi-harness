import { isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createConfigStore, extensionConfigDir } from "@henryqw/pi-config-store";
import {
	canonicalModelReference,
	PROFILE_NAMES,
	THINKING_LEVELS,
	type ProfileName,
	type ThinkingLevel,
} from "@henryqw/pi-task-models";
import { parseEvery, type Schedule } from "./schedule.ts";

export const EXTENSION_ID = "pi-cron";
export const NOTIFY_MODES = ["notify", "followUp", "none"] as const;
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

export const DEFAULT_LIMITS = { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 } as const;
const JOB_KEYS = ["id", "every", "at", "timezone", "role", "modelClass", "model", "thinking", "cwd", "env", "prompt", "promptFile", "enabled", "notify"] as const;
const LIMIT_KEYS = ["maxTurns", "idleMinutes", "maxMinutes"] as const;
const JOB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const record = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
	return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
		throw new Error(`${label} must be non-empty text.`);
	}
	return value;
};
const optional = <T>(value: unknown, parse: (value: unknown) => T): T | undefined => value === undefined ? undefined : parse(value);
const rejectUnknownKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}.`);
};

function validTimeZone(value: unknown, label: string): string {
	const zone = text(value, label);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch {
		throw new Error(`${label} must be an IANA time zone such as Asia/Hong_Kong.`);
	}
	return zone;
}

function parseJob(value: unknown, index: number): Job {
	const raw = record(value, `jobs[${index}]`);
	const id = text(raw.id, `jobs[${index}].id`);
	if (!JOB_ID.test(id)) throw new Error(`jobs[${index}].id must match ${JOB_ID}.`);
	const label = `Job ${id}`;
	rejectUnknownKeys(raw, JOB_KEYS, label);
	if ((raw.every === undefined) === (raw.at === undefined)) throw new Error(`${label} needs exactly one of every or at.`);
	const every = optional(raw.every, (candidate) => {
		const spec = text(candidate, `${label} every`);
		if (parseEvery(spec) === undefined) throw new Error(`${label} every must be like 15m, 6h, or 1d, between 1m and 7d.`);
		return spec;
	});
	const at = optional(raw.at, (candidate) => {
		const clock = text(candidate, `${label} at`);
		if (!CLOCK.test(clock)) throw new Error(`${label} at must be HH:MM in 24-hour time.`);
		return clock;
	});
	if (raw.timezone !== undefined && at === undefined) throw new Error(`${label} timezone requires at.`);
	const timezone = optional(raw.timezone, (candidate) => validTimeZone(candidate, `${label} timezone`));
	const modelClass = optional(raw.modelClass, (candidate) => {
		if (typeof candidate !== "string" || !(PROFILE_NAMES as readonly string[]).includes(candidate)) {
			throw new Error(`${label} modelClass must be one of ${PROFILE_NAMES.join(", ")}.`);
		}
		return candidate as ProfileName;
	});
	if ((raw.model === undefined) !== (raw.thinking === undefined)) throw new Error(`${label} model and thinking must be set together.`);
	if (modelClass !== undefined && raw.model !== undefined) throw new Error(`${label} cannot set both modelClass and model.`);
	const model = optional(raw.model, (candidate) => {
		try {
			return canonicalModelReference(text(candidate, `${label} model`));
		} catch {
			throw new Error(`${label} model must be provider/model.`);
		}
	});
	const thinking = optional(raw.thinking, (candidate) => {
		if (typeof candidate !== "string" || !(THINKING_LEVELS as readonly string[]).includes(candidate)) {
			throw new Error(`${label} thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
		}
		return candidate as ThinkingLevel;
	});
	const cwd = text(raw.cwd, `${label} cwd`);
	if (!isAbsolute(cwd)) throw new Error(`${label} cwd must be an absolute path.`);
	const env = optional(raw.env, (candidate) => {
		const entries = Object.entries(record(candidate, `${label} env`));
		for (const [name, entry] of entries) {
			if (!ENV_NAME.test(name)) throw new Error(`${label} env has an invalid variable name: ${name}.`);
			if (typeof entry !== "string" || entry.includes("\0")) throw new Error(`${label} env.${name} must be a string.`);
		}
		return Object.fromEntries(entries) as Record<string, string>;
	});
	if ((raw.prompt === undefined) === (raw.promptFile === undefined)) throw new Error(`${label} needs exactly one of prompt or promptFile.`);
	const prompt = optional(raw.prompt, (candidate) => text(candidate, `${label} prompt`));
	const promptFile = optional(raw.promptFile, (candidate) => {
		const file = text(candidate, `${label} promptFile`);
		if (!isAbsolute(file)) throw new Error(`${label} promptFile must be an absolute path.`);
		return file;
	});
	const enabled = optional(raw.enabled, (candidate) => {
		if (typeof candidate !== "boolean") throw new Error(`${label} enabled must be true or false.`);
		return candidate;
	});
	const notify = optional(raw.notify, (candidate) => {
		if (typeof candidate !== "string" || !(NOTIFY_MODES as readonly string[]).includes(candidate)) {
			throw new Error(`${label} notify must be one of ${NOTIFY_MODES.join(", ")}.`);
		}
		return candidate as NotifyMode;
	});
	const job: Job = { id, role: text(raw.role, `${label} role`), cwd };
	if (every !== undefined) job.every = every;
	if (at !== undefined) job.at = at;
	if (timezone !== undefined) job.timezone = timezone;
	if (modelClass !== undefined) job.modelClass = modelClass;
	if (model !== undefined) job.model = model;
	if (thinking !== undefined) job.thinking = thinking;
	if (env !== undefined) job.env = env;
	if (prompt !== undefined) job.prompt = prompt;
	if (promptFile !== undefined) job.promptFile = promptFile;
	if (enabled !== undefined) job.enabled = enabled;
	if (notify !== undefined) job.notify = notify;
	return job;
}

function parseLimits(value: unknown): Limits {
	const raw = record(value, "limits");
	rejectUnknownKeys(raw, LIMIT_KEYS, "limits");
	const limits: Limits = {};
	if (raw.maxTurns !== undefined) {
		if (!Number.isSafeInteger(raw.maxTurns) || (raw.maxTurns as number) < 1) throw new Error("limits.maxTurns must be a safe integer >= 1.");
		limits.maxTurns = raw.maxTurns as number;
	}
	for (const key of ["idleMinutes", "maxMinutes"] as const) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] <= 0) throw new Error(`limits.${key} must be a positive number of minutes.`);
		limits[key] = raw[key];
	}
	const effective = effectiveLimits({ jobs: [], limits });
	if (effective.maxMinutes <= effective.idleMinutes) throw new Error("limits.maxMinutes must be greater than limits.idleMinutes.");
	return limits;
}

export function parseCronConfig(value: unknown): CronConfig {
	const raw = record(value, "Config");
	rejectUnknownKeys(raw, ["jobs", "limits"], "Config");
	if (!Array.isArray(raw.jobs)) throw new Error("Config jobs must be an array.");
	const jobs = raw.jobs.map(parseJob);
	const ids = new Set<string>();
	for (const job of jobs) {
		if (ids.has(job.id)) throw new Error(`Duplicate job id: ${job.id}.`);
		ids.add(job.id);
	}
	const config: CronConfig = { jobs };
	if (raw.limits !== undefined) config.limits = parseLimits(raw.limits);
	return config;
}

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

export function cronConfigStore(agentDir = getAgentDir()) {
	return createConfigStore<CronConfig>({ extensionId: EXTENSION_ID, agentDir, defaults: () => ({ jobs: [] }), parse: parseCronConfig });
}

export const cronHome = (agentDir = getAgentDir()): string => extensionConfigDir(EXTENSION_ID, agentDir);
