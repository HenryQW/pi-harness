import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	PROTOCOL_VERSION,
	completionNotice,
	isTaskId,
	parsePendingResult,
	type TerminalResult,
} from "./protocol.ts";

const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

type WorkerProtocol = {
	taskId: string;
	resultPath: string;
	mainName: string;
	task: string;
	createdAt: string;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function protocolFromEnvironment(): Omit<WorkerProtocol, "task" | "createdAt"> {
	if (process.env.PI_HERDR_SUBAGENT_PROTOCOL !== String(PROTOCOL_VERSION)) {
		throw new Error("Missing PI_HERDR_SUBAGENT_PROTOCOL=1.");
	}
	const taskId = process.env.PI_HERDR_SUBAGENT_TASK_ID;
	const resultPath = process.env.PI_HERDR_SUBAGENT_RESULT_PATH;
	const mainName = process.env.PI_HERDR_SUBAGENT_MAIN;
	if (!isTaskId(taskId)) throw new Error("Invalid PI_HERDR_SUBAGENT_TASK_ID.");
	if (!resultPath || !isAbsolute(resultPath)) throw new Error("Invalid PI_HERDR_SUBAGENT_RESULT_PATH.");
	if (!mainName || !HERDR_NAME.test(mainName)) throw new Error("Invalid PI_HERDR_SUBAGENT_MAIN.");
	return { taskId, resultPath, mainName };
}

async function loadProtocol(): Promise<WorkerProtocol> {
	const base = protocolFromEnvironment();
	let pending;
	try {
		pending = parsePendingResult(JSON.parse(await readFile(base.resultPath, "utf8")) as unknown);
	} catch {
		throw new Error("Worker Result file is unreadable.");
	}
	if (!pending || pending.taskId !== base.taskId) throw new Error("Worker Result file is not this pending task.");
	return { ...base, task: pending.task, createdAt: pending.createdAt };
}

function latestAssistant(ctx: ExtensionContext, toolCallId?: string): Record<string, unknown> | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = object(entry.message);
		if (!message) continue;
		if (!toolCallId) return message;
		const content = Array.isArray(message.content) ? message.content : [];
		const calls = content.filter((part) => {
			const call = object(part);
			return call?.type === "toolCall";
		});
		if (calls.some((part) => object(part)?.id === toolCallId)) return message;
	}
}

function soleFinishCall(ctx: ExtensionContext, toolCallId: string): boolean {
	const message = latestAssistant(ctx, toolCallId);
	if (!message || !Array.isArray(message.content)) return false;
	const calls = message.content.filter((part) => object(part)?.type === "toolCall");
	return calls.length === 1 && object(calls[0])?.id === toolCallId && object(calls[0])?.name === "finish_task";
}

async function atomicResult(protocol: WorkerProtocol, terminal: TerminalResult): Promise<void> {
	let pending;
	try {
		pending = parsePendingResult(JSON.parse(await readFile(protocol.resultPath, "utf8")) as unknown);
	} catch {
		throw new Error("Worker Result file is unreadable.");
	}
	if (!pending || pending.taskId !== protocol.taskId || pending.task !== protocol.task || pending.createdAt !== protocol.createdAt) {
		throw new Error("Worker Result file is no longer pending for this Worker.");
	}
	const temporary = join(dirname(protocol.resultPath), `.result-${randomUUID()}.json`);
	try {
		await writeFile(temporary, `${JSON.stringify(terminal)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(temporary, 0o600);
		await rename(temporary, protocol.resultPath);
		await chmod(protocol.resultPath, 0o600);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function herdr(pi: ExtensionAPI, args: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await pi.exec("herdr", args, { cwd: ctx.cwd, signal });
	if (response.code !== 0 || response.killed) {
		throw new Error(`Herdr ${args.slice(0, 2).join(" ")} failed: ${response.stderr.trim() || `exit code ${response.code}`}`);
	}
	try {
		const parsed = object(JSON.parse(response.stdout));
		if (!parsed) throw new Error();
		return parsed;
	} catch {
		throw new Error(`Herdr ${args.slice(0, 2).join(" ")} returned invalid JSON.`);
	}
}

async function waitAndNotify(pi: ExtensionAPI, protocol: WorkerProtocol, terminal: TerminalResult, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	const waited = object((await herdr(pi, ["agent", "wait", protocol.mainName, "--until", "idle", "--until", "done"], ctx, signal)).result);
	if (!waited || waited.type !== "agent_info") throw new Error("Herdr Main wait did not return agent_info.");
	const status = object(waited.agent)?.agent_status;
	if (status !== "idle" && status !== "done") throw new Error("Herdr Main did not settle idle or done.");
	const prompted = object((await herdr(pi, ["agent", "prompt", protocol.mainName, completionNotice(protocol.resultPath, terminal)], ctx, signal)).result);
	if (!prompted || prompted.type !== "agent_prompted") throw new Error("Herdr Completion Notice was not accepted.");
}

export default async function workerExtension(pi: ExtensionAPI): Promise<void> {
	const protocol = await loadProtocol();
	let completionStarted = false;

	const complete = async (terminal: TerminalResult, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> => {
		if (completionStarted) throw new Error("Worker Result is already terminal.");
		completionStarted = true;
		try {
			await atomicResult(protocol, terminal);
		} catch (error) {
			completionStarted = false;
			throw error;
		}
		await waitAndNotify(pi, protocol, terminal, ctx, signal);
	};

	pi.registerTool({
		name: "finish_task",
		label: "Finish Task",
		description: "Store final Result and notify Main. Call alone after task is complete.",
		parameters: Type.Object({ result: Type.String({ minLength: 1 }) }),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			if (!params.result.trim()) throw new Error("finish_task result must not be blank.");
			if (!soleFinishCall(ctx, toolCallId)) throw new Error("finish_task must be sole tool call in this assistant message.");
			const terminal: TerminalResult = {
				version: PROTOCOL_VERSION,
				taskId: protocol.taskId,
				state: "finished",
				task: protocol.task,
				result: params.result,
				error: null,
				createdAt: protocol.createdAt,
				finishedAt: new Date().toISOString(),
			};
			await complete(terminal, ctx, signal);
			return { content: [{ type: "text", text: "Result stored and Main notified." }], details: {}, terminate: true };
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (completionStarted) return;
		const latest = latestAssistant(ctx);
		if (!latest || (latest.stopReason !== "error" && latest.stopReason !== "aborted")) return;
		const stopReason = latest.stopReason;
		const message = typeof latest.errorMessage === "string" && latest.errorMessage.trim() ? latest.errorMessage : stopReason;
		const terminal: TerminalResult = {
			version: PROTOCOL_VERSION,
			taskId: protocol.taskId,
			state: "failed",
			task: protocol.task,
			result: null,
			error: { stopReason, message },
			createdAt: protocol.createdAt,
			finishedAt: new Date().toISOString(),
		};
		await complete(terminal, ctx).catch(() => undefined);
	});
}
