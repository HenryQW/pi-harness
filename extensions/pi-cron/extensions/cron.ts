import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTextFileBounded } from "@henryqw/pi-config-store";
import {
	createEphemeralSubagentExecutor,
	finalizeRoleLaunch,
	loadRoles,
	prepareRoleLaunch,
	type EphemeralSubagentExecutor,
	type ResolvedRoleLaunch,
	type Role,
} from "@henryqw/pi-subagent";
import { modelReference, registerModelTask, resolveTaskModelRoute, type ModelTask } from "@henryqw/pi-task-models";
import {
	cronConfigStore,
	cronHome,
	effectiveLimits,
	jobEnabled,
	jobNotify,
	jobSchedule,
	type CronConfig,
	type Job,
	type Limits,
} from "../internal/config.ts";
import { sessionFilePath, sessionLaunchArgs, summarize } from "../internal/launch.ts";
import { formatInstant, nextRunAt } from "../internal/schedule.ts";
import { StateStore, type Claim, type Outcome } from "../internal/state.ts";

export const CRON_JOB_TASK = {
	id: "pi-cron/job",
	label: "Scheduled job",
	purpose: "Run one scheduled job prompt in a new Pi session.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
export const CRON_RESULT_TYPE = "pi-cron-result";

const DEFAULT_TICK_MS = 60_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const SUMMARY_BYTES = 2 * 1024;
const FOLLOW_UP_BYTES = 16 * 1024;
const STALE_MARGIN_MS = 5 * 60_000;

export interface CronExtensionOptions {
	agentDir?: string;
	/** Test seam; production uses pi-subagent's bounded ephemeral executor. */
	executor?: (limits: Required<Limits>) => EphemeralSubagentExecutor;
	now?: () => number;
	tickMs?: number;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export default function cronExtension(pi: ExtensionAPI, options: CronExtensionOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? Date.now;
	const configStore = cronConfigStore(agentDir);
	const home = cronHome(agentDir);
	const state = new StateStore(join(home, "state.json"));
	const owner = `${process.pid}-${randomUUID()}`;
	let latestCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ticking = false;
	let running = false;
	let lastConfigError: string | undefined;
	let executor: { key: string; value: EphemeralSubagentExecutor } | undefined;
	// Renewed on session start so a session switch in the same Pi process revives scheduling.
	let shutdown = new AbortController();

	registerModelTask(pi, CRON_JOB_TASK);

	const executorFor = (limits: Required<Limits>): EphemeralSubagentExecutor => {
		const key = JSON.stringify(limits);
		if (executor?.key !== key) {
			const value = options.executor?.(limits) ?? createEphemeralSubagentExecutor({
				maxConcurrency: 1,
				maxTurns: limits.maxTurns,
				timeout: { idleMs: limits.idleMinutes * 60_000, maxMs: limits.maxMinutes * 60_000 },
			});
			executor = { key, value };
		}
		return executor.value;
	};

	const loadConfig = (ctx: ExtensionContext): CronConfig | undefined => {
		try {
			const loaded = configStore.loadSync().value;
			lastConfigError = undefined;
			return loaded;
		} catch (error) {
			const message = `pi-cron config at ${configStore.path} is invalid; jobs are paused until it is fixed: ${errorText(error)}`;
			if (message !== lastConfigError && ctx.hasUI) ctx.ui.notify(message, "error");
			lastConfigError = message;
			return undefined;
		}
	};

	const prepareLaunch = (ctx: ExtensionContext, job: Job, role: Role): ResolvedRoleLaunch => {
		if (job.model !== undefined) {
			const route = resolveTaskModelRoute(ctx, { model: job.model, thinkingLevel: job.thinking! });
			if (!route) throw new Error(`model ${job.model} with thinking ${job.thinking} is not available in this session.`);
			return finalizeRoleLaunch(prepareRoleLaunch(pi, ctx, { role, route }));
		}
		return finalizeRoleLaunch(prepareRoleLaunch(pi, ctx, {
			role, task: CRON_JOB_TASK, agentDir, ...(job.modelClass === undefined ? {} : { modelClass: job.modelClass }),
		}));
	};

	const deliver = (ctx: ExtensionContext, job: Job, outcome: Outcome, output: string, sessionFile?: string): void => {
		if (shutdown.signal.aborted) return;
		const mode = jobNotify(job);
		const headline = `Scheduled job ${job.id} ${outcome === "success" ? "finished" : "failed"} · ${sessionFile ?? "no session created"}`;
		if (mode === "followUp") {
			try {
				pi.sendMessage({
					customType: CRON_RESULT_TYPE,
					content: `${headline}\n\n${summarize(output, FOLLOW_UP_BYTES)}`,
					display: true,
					details: { jobId: job.id, outcome, sessionFile },
				}, { triggerTurn: true, deliverAs: "followUp" });
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`${headline}\nFollow-up delivery failed: ${errorText(error)}\nResult saved; use /cron → Show last run.`, "warning");
			}
			return;
		}
		// In an active UI, `none` silences only successes.
		if ((mode === "notify" || outcome === "failure") && ctx.hasUI) {
			ctx.ui.notify(outcome === "success" ? headline : `${headline}\n${summarize(output, SUMMARY_BYTES)}`, outcome === "success" ? "info" : "error");
		}
	};

	/** Admit locally before claiming so no shared claim ages in an executor queue. */
	const runJob = async (ctx: ExtensionContext, config: CronConfig, job: Job, force: boolean): Promise<
		{ claimed: true; done: Promise<void> } | { claimed: false; done: Promise<void>; reason: string }
	> => {
		const signal = shutdown.signal;
		if (running || signal.aborted) return { claimed: false, done: Promise.resolve(), reason: "A job is already running in this Pi session, or the session is shutting down." };
		running = true;
		try {
			const limits = effectiveLimits(config);
			const claim = await state.claim(job.id, jobSchedule(job), now(), {
				owner, force, staleMs: limits.maxMinutes * 60_000 + STALE_MARGIN_MS,
			});
			if (!claim) {
				running = false;
				return { claimed: false, done: Promise.resolve(), reason: `${job.id} is not due or is already running in another Pi session.` };
			}
			return { claimed: true, done: execute(ctx, limits, job, claim, signal).finally(() => { running = false; }) };
		} catch (error) {
			running = false;
			throw error;
		}
	};

	const execute = async (ctx: ExtensionContext, limits: Required<Limits>, job: Job, claim: Claim, signal: AbortSignal): Promise<void> => {
		const sessionFile = sessionFilePath(home, job.id, claim.startedAt);
		let outcome: Outcome = "failure";
		let output = "";
		try {
			signal.throwIfAborted();
			const prompt = job.prompt ?? await readTextFileBounded(job.promptFile!, MAX_PROMPT_BYTES, { signal });
			if (!prompt.trim()) throw new Error(`prompt file ${job.promptFile} is empty.`);
			const role = loadRoles(agentDir).find((candidate) => candidate.name === job.role);
			if (!role) throw new Error(`Role ${job.role} is not configured.`);
			const launch = prepareLaunch(ctx, job, role);
			await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
			const result = await executorFor(limits).run({
				signal,
				prepare: async () => ({
					launch: { args: sessionLaunchArgs(launch.args, sessionFile), env: { ...launch.env, ...job.env } },
					task: prompt,
					cwd: job.cwd,
				}),
			});
			outcome = result.outcome;
			output = result.outcome === "success"
				? result.output
				: `${result.errorMessage ?? result.stopReason ?? `exit ${result.exitCode}`}\n${result.output}\n${result.stderr}`;
			if (result.outcome === "success") output = `${modelReference(launch.model)} (${launch.thinkingLevel})\n${result.output}`;
		} catch (error) {
			output = errorText(error);
		}
		let session: string | undefined;
		try {
			if ((await stat(sessionFile)).isFile()) session = sessionFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const finished = await state.finish(job.id, claim, { finishedAt: now(), outcome, summary: summarize(output, SUMMARY_BYTES), session });
		if (finished) deliver(latestCtx ?? ctx, job, outcome, output, session);
	};

	const tick = async (): Promise<void> => {
		const signal = shutdown.signal;
		if (ticking || !latestCtx || signal.aborted) return;
		ticking = true;
		try {
			const initial = loadConfig(latestCtx);
			if (!initial) return;
			for (const id of initial.jobs.map((job) => job.id)) {
				if (signal.aborted) return;
				const config = loadConfig(latestCtx);
				if (!config) return;
				const job = config.jobs.find((candidate) => candidate.id === id);
				if (!job || !jobEnabled(job)) continue;
				try {
					await (await runJob(latestCtx, config, job, false)).done;
				} catch (error) {
					if (!signal.aborted && latestCtx.hasUI) latestCtx.ui.notify(`pi-cron could not schedule ${job.id}: ${errorText(error)}`, "error");
				}
			}
		} finally {
			ticking = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		if (shutdown.signal.aborted) shutdown = new AbortController();
		timer ??= setInterval(() => void tick(), options.tickMs ?? DEFAULT_TICK_MS);
		timer.unref?.();
		void tick();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		shutdown.abort(new Error("Pi session shut down."));
	});

	pi.registerCommand("cron", {
		description: "list scheduled jobs, run one now, or enable/disable it",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const config = loadConfig(ctx);
			if (!config) return;
			const [verb, target] = args.trim().split(/\s+/);
			if (verb === "run") {
				const job = config.jobs.find((candidate) => candidate.id === target);
				if (!job) {
					ctx.ui.notify(target ? `No job ${target} in ${configStore.path}.` : "Usage: /cron run <job-id>", "error");
					return;
				}
				await startNow(ctx, config, job);
				return;
			}
			if (!config.jobs.length) {
				ctx.ui.notify(`No jobs configured. Add jobs to ${configStore.path}.`, "info");
				return;
			}
			const current = now();
			const jobs = state.loadSync().jobs;
			const labels = config.jobs.map((job) => {
				const record = jobs[job.id];
				const anchor = Math.max(record?.firstSeenAt ?? current, record?.lastStartedAt ?? 0);
				const schedule = jobSchedule(job);
				const next = jobEnabled(job) ? `next ${formatInstant(nextRunAt(schedule, current, anchor), schedule.kind === "at" ? schedule.timeZone : undefined)}` : "disabled";
				const last = record?.running ? "running" : record?.lastOutcome ?? "never ran";
				return `${job.id} · ${next} · last ${last}`;
			});
			if (!ctx.hasUI) {
				ctx.ui.notify(labels.join("\n"), "info");
				return;
			}
			const selected = await ctx.ui.select("Scheduled jobs", labels);
			const job = config.jobs[labels.indexOf(selected ?? "")];
			if (!job) return;
			const toggle = jobEnabled(job) ? "Disable" : "Enable";
			const action = await ctx.ui.select(job.id, ["Run now", toggle, "Show last run"]);
			if (action === "Run now") await startNow(ctx, config, job);
			else if (action === toggle) {
				const enabled = !jobEnabled(job);
				await configStore.update((value) => {
					const entry = value.jobs.find((candidate) => candidate.id === job.id);
					if (!entry) throw new Error(`Job ${job.id} disappeared from config.`);
					if (enabled) delete entry.enabled;
					else entry.enabled = false;
					return value;
				});
				ctx.ui.notify(`${job.id} ${enabled ? "enabled" : "disabled"}.`, "info");
			} else if (action === "Show last run") {
				const record = jobs[job.id];
				ctx.ui.notify(record?.lastOutcome
					? `${job.id} ${record.lastOutcome} at ${formatInstant(record.lastFinishedAt!)}\nSession: ${record.lastSession ?? "none created"}\n${record.lastSummary}`
					: `${job.id} has not run yet.`, "info");
			}
		},
	});

	async function startNow(ctx: ExtensionCommandContext, config: CronConfig, job: Job): Promise<void> {
		const run = await runJob(ctx, config, job, true);
		if (!run.claimed) {
			ctx.ui.notify(run.reason, "warning");
			return;
		}
		run.done.catch((error) => {
			if (!shutdown.signal.aborted && latestCtx?.hasUI) latestCtx.ui.notify(`pi-cron could not run ${job.id}: ${errorText(error)}`, "error");
		});
		ctx.ui.notify(`Started ${job.id}; the result arrives as ${jobNotify(job) === "followUp" ? "a follow-up message" : "a notification"}.`, "info");
	}
}
