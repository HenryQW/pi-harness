import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	PROTOCOL_VERSION,
	parseCompletionNotices,
	parseTerminalResult,
	resultExcerpt,
} from "../internal/protocol.ts";

const DEFAULT_LIMIT = 10;
const CONFIG_PATH = () => join(getAgentDir(), "config", "pi-herdr-subagents.json");
const WORKER_EXTENSION = fileURLToPath(new URL("../internal/worker.ts", import.meta.url));
const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFINITIVE_PROMPT_ERRORS = new Set([
	"agent_not_found", "agent_not_running", "agent_not_ready", "agent_not_idle",
	"empty_agent_prompt", "invalid_agent_name", "agent_prompt_failed",
]);

type OwnedWorker = {
	taskId: string;
	task: string;
	workerName: string;
	resultPath: string;
	tempDir: string;
	tabId?: string;
};

type HerdrLocation = { workspace: string; pane: string };
type HerdrTab = { id: string; label?: string };

const object = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
	return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value) throw new Error(`${label} is missing.`);
	return value;
};

const herdrName = (value: unknown, label: string): string => {
	const name = text(value, label);
	if (!HERDR_NAME.test(name)) throw new Error(`${label} is invalid.`);
	return name;
};

const parseJson = (value: string, label: string): Record<string, unknown> => {
	try {
		return object(JSON.parse(value), label);
	} catch {
		throw new Error(`${label} is not JSON.`);
	}
};

const configLimit = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

async function readLimit(): Promise<{ value: number; invalid: boolean }> {
	try {
		const value = JSON.parse(await readFile(CONFIG_PATH(), "utf8")) as unknown;
		const limit = value && typeof value === "object" && !Array.isArray(value)
			? configLimit((value as { maxConcurrentWorkers?: unknown }).maxConcurrentWorkers)
			: undefined;
		return limit ? { value: limit, invalid: false } : { value: DEFAULT_LIMIT, invalid: true };
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { value: DEFAULT_LIMIT, invalid: false };
		}
		return { value: DEFAULT_LIMIT, invalid: true };
	}
}

async function writeLimit(limit: number): Promise<void> {
	const path = CONFIG_PATH();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ maxConcurrentWorkers: limit }, null, 2)}\n`, "utf8");
}

const workerName = (taskId: string) => `worker_${taskId.replaceAll("-", "").slice(0, 8)}`;
const mainName = () => `main_${randomBytes(4).toString("hex")}`;

function workerLabel(task: string, taskId: string): string {
	const suffix = ` · ${taskId.replaceAll("-", "").slice(0, 8)}`;
	const words = task.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().split(/\s+/).slice(0, 4).join(" ");
	return `${words.slice(0, 40 - suffix.length).trim() || "worker"}${suffix}`;
}

function location(): HerdrLocation {
	if (process.env.HERDR_ENV !== "1") throw new Error("delegate_task requires Herdr (HERDR_ENV=1).");
	const workspace = process.env.HERDR_WORKSPACE_ID;
	const pane = process.env.HERDR_PANE_ID;
	if (!workspace || !pane) throw new Error("delegate_task requires Herdr workspace and pane identity.");
	return { workspace, pane };
}

function commandError(args: string[], stderr: string, code: number): Error {
	return new Error(`Herdr ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || `exit code ${code}`}`);
}

function rollbackCleanupError(worker: OwnedWorker, tabId: string, launchError: unknown, cleanupError: unknown): Error {
	const launch = launchError instanceof Error ? launchError.message : String(launchError);
	const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
	return new Error(`Delegated Task ${worker.taskId} launch failed and Worker tab cleanup also failed; Worker remains owned.\nWorker: ${worker.workerName}\nTab: ${tabId}\nResult: ${worker.resultPath}\nStop: herdr tab close ${tabId}\nLaunch error: ${launch}\nCleanup error: ${cleanup}`);
}

function herdrErrorCode(stderr: string): string | undefined {
	try {
		const code = (JSON.parse(stderr) as { error?: { code?: unknown } }).error?.code;
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

const hasHerdrError = (stderr: string, code: string): boolean => herdrErrorCode(stderr) === code;

async function runHerdr(pi: ExtensionAPI, args: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const result = await pi.exec("herdr", args, { cwd: ctx.cwd, signal });
	if (result.code !== 0 || result.killed) throw commandError(args, result.stderr, result.code);
	return result.stdout;
}

function resultOf(stdout: string, label: string): Record<string, unknown> {
	return object(parseJson(stdout, label).result, `${label} result`);
}

function agentInfo(stdout: string, label: string): Record<string, unknown> {
	const result = resultOf(stdout, label);
	if (result.type !== "agent_info") throw new Error(`${label} did not return agent_info.`);
	return object(result.agent, `${label} agent`);
}

function assertAgent(agent: Record<string, unknown>, expected: { name?: string; pane: string; workspace: string; tab?: string }): void {
	if (agent.pane_id !== expected.pane || agent.workspace_id !== expected.workspace) {
		throw new Error("Herdr agent identity does not match Main location.");
	}
	if (expected.name && agent.name !== expected.name) throw new Error("Herdr agent name does not match request.");
	if (expected.tab && agent.tab_id !== expected.tab) throw new Error("Herdr agent tab does not match request.");
}

async function closeTab(pi: ExtensionAPI, tabId: string, ctx: ExtensionContext): Promise<void> {
	const result = await pi.exec("herdr", ["tab", "close", tabId], { cwd: ctx.cwd });
	if (result.code !== 0 && !hasHerdrError(result.stderr, "tab_not_found")) {
		throw commandError(["tab", "close"], result.stderr, result.code);
	}
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	const workers = new Map<string, OwnedWorker>();
	let limit = DEFAULT_LIMIT;
	let cachedMainName: string | undefined;

	const listTabs = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<HerdrTab[]> => {
		const result = resultOf(await runHerdr(pi, ["tab", "list", "--workspace", where.workspace], ctx, signal), "Herdr tab list");
		if (result.type !== "tab_list" || !Array.isArray(result.tabs)) throw new Error("Herdr tab list is invalid.");
		return result.tabs.flatMap((candidate) => {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
			const tab = candidate as { tab_id?: unknown; workspace_id?: unknown; label?: unknown };
			if (typeof tab.tab_id !== "string" || tab.workspace_id !== where.workspace) return [];
			return [{ id: tab.tab_id, label: typeof tab.label === "string" ? tab.label : undefined }];
		});
	};

	const reconcile = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<Set<string>> => {
		const present = new Set((await listTabs(where, ctx, signal)).map((tab) => tab.id));
		for (const [taskId, worker] of workers) {
			if (worker.tabId && !present.has(worker.tabId)) workers.delete(taskId);
		}
		return present;
	};

	const ensureMainName = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		if (cachedMainName) return cachedMainName;
		const current = agentInfo(await runHerdr(pi, ["agent", "get", where.pane], ctx, signal), "Herdr Main lookup");
		assertAgent(current, { pane: where.pane, workspace: where.workspace });
		if (typeof current.name === "string") {
			cachedMainName = herdrName(current.name, "Herdr Main name");
			return cachedMainName;
		}
		if (current.name !== null && current.name !== undefined) throw new Error("Herdr Main name is invalid.");
		const name = mainName();
		const renamed = agentInfo(await runHerdr(pi, ["agent", "rename", where.pane, name], ctx, signal), "Herdr Main rename");
		assertAgent(renamed, { name, pane: where.pane, workspace: where.workspace });
		cachedMainName = name;
		return name;
	};

	const startWorker = async (name: string, tabId: string, paneId: string, where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (!ctx.model) throw new Error("delegate_task requires an active Pi model.");
		const args = [
			"agent", "start", name, "--kind", "pi", "--pane", paneId, "--",
			"--no-session", "--no-extensions", "--extension", WORKER_EXTENSION,
			"--tools", "read,bash,edit,write,finish_task",
			"--model", `${ctx.model.provider}/${ctx.model.id}`,
			...(ctx.thinkingLevel ? ["--thinking", ctx.thinkingLevel] : []),
			ctx.isProjectTrusted() ? "--approve" : "--no-approve",
		];
		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await pi.exec("herdr", args, { cwd: ctx.cwd, signal });
			if (result.code === 0 && !result.killed) {
				const started = resultOf(result.stdout, "Herdr Worker start");
				if (started.type !== "agent_started") throw new Error("Herdr Worker start did not return agent_started.");
				const agent = object(started.agent, "Herdr Worker agent");
				assertAgent(agent, { name, pane: paneId, workspace: where.workspace, tab: tabId });
				if (agent.interactive_ready !== true) throw new Error("Herdr Worker is not interactive.");
				return;
			}
			if (!hasHerdrError(result.stderr, "agent_pane_busy") || attempt === 4) {
				throw commandError(args, result.stderr, result.code);
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const config = await readLimit();
		limit = config.value;
		if (config.invalid) ctx.ui.notify(`Invalid pi-herdr-subagents config; using Worker Limit ${DEFAULT_LIMIT}.`, "warning");
	});

	pi.registerCommand("subagent-limit", {
		description: "set maximum live Herdr Workers for this Main session",
		handler: async (_args, ctx) => {
			const selected = await ctx.ui.input("Worker Limit", String(limit));
			if (selected === undefined) return;
			const parsed = /^[1-9]\d*$/.test(selected.trim()) ? Number(selected.trim()) : NaN;
			if (!Number.isSafeInteger(parsed)) {
				ctx.ui.notify("Worker Limit must be a positive integer.", "warning");
				return;
			}
			try {
				await writeLimit(parsed);
				limit = parsed;
				ctx.ui.notify(`Worker Limit set to ${limit}.`, "info");
			} catch {
				ctx.ui.notify("Couldn't save Worker Limit config.", "warning");
			}
		},
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Delegate one bounded task to one interactive Herdr Pi Worker.",
		parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const task = params.task;
			if (!task.trim()) throw new Error("delegate_task task must not be blank.");
			if (task.includes("\0")) throw new Error("delegate_task task must not contain NUL bytes.");
			if (!ctx.model) throw new Error("delegate_task requires an active Pi model.");
			const where = location();
			const existingTabs = await reconcile(where, ctx, signal);
			if (workers.size >= limit) throw new Error(`Worker Limit reached (${limit}); no task was queued.`);

			const taskId = randomUUID();
			const tempDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-"));
			await chmod(tempDir, 0o700);
			const resultPath = join(tempDir, "result.json");
			const worker: OwnedWorker = { taskId, task, workerName: workerName(taskId), resultPath, tempDir };
			const label = workerLabel(task, taskId);
			let tabCreationAttempted = false;
			let promptOutcomeUnknown = false;
			workers.set(taskId, worker);
			try {
				const createdAt = new Date().toISOString();
				await writeFile(resultPath, `${JSON.stringify({ version: PROTOCOL_VERSION, taskId, state: "pending", task, createdAt })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await chmod(resultPath, 0o600);
				const main = await ensureMainName(where, ctx, signal);
				tabCreationAttempted = true;
				const created = resultOf(await runHerdr(pi, [
					"tab", "create", "--workspace", where.workspace, "--cwd", ctx.cwd,
					"--label", label, "--no-focus",
					"--env", `PI_HERDR_SUBAGENT_PROTOCOL=${PROTOCOL_VERSION}`,
					"--env", `PI_HERDR_SUBAGENT_TASK_ID=${taskId}`,
					"--env", `PI_HERDR_SUBAGENT_RESULT_PATH=${resultPath}`,
					"--env", `PI_HERDR_SUBAGENT_MAIN=${main}`,
				], ctx, signal), "Herdr tab create");
				if (created.type !== "tab_created") throw new Error("Herdr tab create did not return tab_created.");
				const tab = object(created.tab, "Herdr Worker tab");
				const pane = object(created.root_pane, "Herdr Worker root pane");
				const tabId = text(tab.tab_id, "Herdr Worker tab ID");
				worker.tabId = tabId;
				const paneId = text(pane.pane_id, "Herdr Worker pane ID");
				if (
					tab.workspace_id !== where.workspace || pane.workspace_id !== where.workspace || pane.tab_id !== tabId
					|| tab.focused !== false || pane.focused !== false || tab.pane_count !== 1 || pane.cwd !== ctx.cwd
				) throw new Error("Herdr Worker tab identity is invalid.");
				await startWorker(worker.workerName, tabId, paneId, where, ctx, signal);
				if (signal?.aborted) throw new Error("delegate_task was aborted before task submission.");
				const promptArgs = ["agent", "prompt", worker.workerName, task];
				promptOutcomeUnknown = true;
				const response = await pi.exec("herdr", promptArgs, { cwd: ctx.cwd, signal });
				if (response.code !== 0 || response.killed) {
					if (!response.killed && DEFINITIVE_PROMPT_ERRORS.has(herdrErrorCode(response.stderr) ?? "")) {
						promptOutcomeUnknown = false;
					}
					throw commandError(promptArgs, response.stderr, response.code);
				}
				const prompted = resultOf(response.stdout, "Herdr Worker prompt");
				if (prompted.type !== "agent_prompted") throw new Error("Herdr Worker prompt was not accepted.");
				const agent = object(prompted.agent, "Herdr prompted Worker");
				assertAgent(agent, { name: worker.workerName, pane: paneId, workspace: where.workspace, tab: tabId });
				promptOutcomeUnknown = false;
				return {
					content: [{ type: "text", text: `Delegated Task ${taskId}\nWorker: ${worker.workerName}\nTab: ${tabId}\nResult: ${resultPath}\nStop: herdr tab close ${tabId}` }],
					details: {},
				};
			} catch (error) {
				if (promptOutcomeUnknown) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Delegated Task ${taskId} prompt outcome is unknown; Worker may be running and remains owned.\nWorker: ${worker.workerName}\nTab: ${worker.tabId}\nResult: ${worker.resultPath}\nStop: herdr tab close ${worker.tabId}\n${message}`);
				}
				if (worker.tabId) {
					try {
						await closeTab(pi, worker.tabId, ctx);
					} catch (cleanupError) {
						throw rollbackCleanupError(worker, worker.tabId, error, cleanupError);
					}
				} else if (tabCreationAttempted) {
					const tabs = await listTabs(where, ctx).catch(() => []);
					for (const tab of tabs.filter((candidate) => !existingTabs.has(candidate.id) && candidate.label === label)) {
						try {
							await closeTab(pi, tab.id, ctx);
						} catch (cleanupError) {
							worker.tabId = tab.id;
							throw rollbackCleanupError(worker, tab.id, error, cleanupError);
						}
					}
				}
				workers.delete(taskId);
				await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" } as const;
		const notices = parseCompletionNotices(event.text);
		if (!notices) return { action: "continue" } as const;
		const seen = new Set<string>();
		const owned = [];
		for (const notice of notices) {
			if (seen.has(notice.taskId)) return { action: "continue" } as const;
			seen.add(notice.taskId);
			const worker = workers.get(notice.taskId);
			if (!worker || worker.resultPath !== notice.resultPath || !isAbsolute(notice.resultPath)) return { action: "continue" } as const;
			owned.push({ notice, worker });
		}
		let validated;
		try {
			validated = await Promise.all(owned.map(async ({ notice, worker }) => {
				const terminal = parseTerminalResult(JSON.parse(await readFile(worker.resultPath, "utf8")) as unknown);
				if (!terminal || terminal.taskId !== worker.taskId || terminal.task !== worker.task || notice.excerpt !== resultExcerpt(terminal)) return;
				return { notice, worker, terminal };
			}));
		} catch {
			return { action: "continue" } as const;
		}
		const completed = validated.flatMap((entry) => entry ? [entry] : []);
		if (completed.length !== notices.length || completed.some(({ notice, worker }) => workers.get(notice.taskId) !== worker)) {
			return { action: "continue" } as const;
		}
		for (const { worker } of completed) workers.delete(worker.taskId);
		for (const { worker } of completed) if (worker.tabId) void closeTab(pi, worker.tabId, ctx).catch(() => undefined);
		return {
			action: "transform",
			text: completed.map(({ notice, worker, terminal }) => `Worker ${worker.workerName} completed Delegated Task ${worker.taskId} (${terminal.state}). Result: ${worker.resultPath}\n\n${notice.excerpt}`).join("\n\n"),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const owned = [...workers.values()];
		workers.clear();
		await Promise.all(owned.flatMap((worker) => worker.tabId ? [closeTab(pi, worker.tabId, ctx).catch(() => undefined)] : []));
	});
}
