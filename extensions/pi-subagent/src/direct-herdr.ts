import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, herdrCommandFailure, startPiAgent } from "@henryqw/pi-herdr";
import type { ResolvedRoleLaunch } from "./index.ts";

const OPERATION_MS = 30_000;
const SESSION_LIMIT = 16 * 1024 * 1024;
const ANSWER_LIMIT = 50 * 1024;

type Json = Record<string, unknown>;
const object = (value: unknown, label: string): Json => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed Herdr ${label}.`);
	return value as Json;
};
const field = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Malformed Herdr ${label}.`);
	return value;
};
const result = (value: unknown, type: string): Json => {
	const response = object(object(value, "response").result, "result");
	if (response.type !== type) throw new Error(`Herdr returned an unexpected ${type} response.`);
	return response;
};

/** A prompt is accepted only with the exact pane, agent, cwd and turn identity. */
export interface DirectHandle {
	name: string;
	tabId: string;
	paneId: string;
	sessionFile: string;
	prompt: string;
	answer(maxBytes: number): Promise<string>;
	cancel(): Promise<void>;
}

export function exactDirectAnswer(jsonl: string, prompt: string, maxBytes = ANSWER_LIMIT): string {
	const lines = jsonl.trimEnd().split("\n");
	let userId: string | undefined;
	let final: Json | undefined;
	let finalId: string | undefined;
	const parents = new Map<string, string>();
	for (const line of lines) {
		const entry = object(JSON.parse(line) as unknown, "session entry");
		if (entry.type !== "message") continue;
		const id = field(entry.id, "message id");
		if (typeof entry.parentId === "string") parents.set(id, entry.parentId);
		const message = object(entry.message, "session message");
		if (message.role === "user" && Array.isArray(message.content)
			&& message.content.length === 1 && object(message.content[0], "user content").text === prompt) {
			userId = id;
			final = undefined;
			finalId = undefined;
		} else if (userId && message.role === "user") {
			throw new Error("Pi session contains an unexpected user turn after direct delegation.");
		} else if (userId && message.role === "assistant") {
			final = message;
			finalId = id;
		}
	}
	let ancestor = finalId;
	const seen = new Set<string>();
	while (ancestor && ancestor !== userId && !seen.has(ancestor)) {
		seen.add(ancestor);
		ancestor = parents.get(ancestor);
	}
	if (!userId || ancestor !== userId || !final || final.stopReason !== "stop" || !Array.isArray(final.content)) {
		throw new Error("Pi did not persist an exact successful final answer for this prompt.");
	}
	const text = final.content.flatMap((part) => {
		const content = object(part, "assistant content");
		return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
	}).join("\n");
	if (!text.trim()) throw new Error("Pi persisted an empty final answer.");
	if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Pi final answer exceeds the ${maxBytes}-byte workflow limit; read the private session file for recovery.`);
	return text;
}

export function createDirectHerdr(pi: Pick<ExtensionAPI, "exec">, cwd: string) {
	if (process.env.HERDR_ENV !== "1") throw new Error("Direct delegation requires a Herdr-managed Pi pane (HERDR_ENV=1).");
	const workspaceId = field(process.env.HERDR_WORKSPACE_ID, "HERDR_WORKSPACE_ID");
	const callerPane = field(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
	const workingDir = realpathSync(cwd);
	const herdr = createHerdrClient(pi.exec.bind(pi));
	const options = (signal?: AbortSignal) => ({ cwd: workingDir, timeout: OPERATION_MS, ...(signal ? { signal } : {}) });
	const inspect = (value: unknown, type: string, name: string, paneId: string, tabId: string) => {
		const agent = object(result(value, type).agent, "agent");
		if (agent.name !== name || agent.pane_id !== paneId || agent.tab_id !== tabId || agent.workspace_id !== workspaceId
			|| agent.cwd !== workingDir || agent.interactive_ready !== true) {
			throw new Error("Herdr agent identity or readiness did not match its verified launch.");
		}
		return field(agent.agent_status, "agent state");
	};
	return {
		async start(launch: ResolvedRoleLaunch, name: string, label: string, task: string, signal: AbortSignal): Promise<DirectHandle> {
			const caller = result(await herdr.json(["pane", "current", "--current"], options(signal)), "pane_current");
			const pane = object(caller.pane, "calling pane");
			if (pane.pane_id !== callerPane || pane.workspace_id !== workspaceId) throw new Error("Herdr caller pane no longer matches the launching workspace.");
			if (Object.keys(launch.env).length) throw new Error("Direct Herdr launch cannot transfer Role environment overrides.");
			const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-direct-"));
			const sessionFile = join(sessionDir, "session.jsonl");
			// Pi's native session is the exact answer channel. Herdr screen output is diagnostic only.
			const sessionArgs = launch.args.filter((arg) => arg !== "--no-session");
			if (sessionArgs.length !== launch.args.length - 1) throw new Error("Role launch must contain exactly one --no-session option.");
			const created = result(await herdr.json(["tab", "create", "--workspace", workspaceId, "--cwd", workingDir, "--label", label, "--no-focus"], options(signal)), "tab_created");
			const tab = object(created.tab, "created tab");
			const workerPane = object(created.root_pane, "created pane");
			const tabId = field(tab.tab_id, "tab id");
			const paneId = field(workerPane.pane_id, "pane id");
			if (tab.workspace_id !== workspaceId || workerPane.workspace_id !== workspaceId || workerPane.tab_id !== tabId
				|| workerPane.cwd !== workingDir || tab.focused !== false || workerPane.focused !== false || paneId === callerPane) {
				throw new Error(`Herdr tab ${tabId} has unverified identity, cwd or focus; inspect it before retrying.`);
			}
			try {
				const started = await startPiAgent(herdr, { name, pane: paneId,
					args: [...sessionArgs, "--session", sessionFile], options: options(signal), shouldRetry: () => false });
				if (started.code !== 0 || started.killed) throw new Error(`Herdr agent start failed: ${started.stderr.slice(0, 1000)}`);
				if (inspect(JSON.parse(started.stdout), "agent_started", name, paneId, tabId) !== "idle") throw new Error("Herdr agent was not idle after start.");
				const prompt = `${task}\n\nDirect text boundary: inspect only. Do not modify files, the Git index, HEAD, branches, or worktrees.\n\nTurn identity: ${randomBytes(16).toString("hex")}`;
				const accepted = await herdr.json(["agent", "prompt", name, prompt, "--wait", "--until", "working", "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", String(OPERATION_MS - 1000)], options(signal));
				const state = inspect(accepted, "agent_prompted", name, paneId, tabId);
				if (state === "blocked" || state === "unknown") throw new Error(`Herdr agent became ${state}; inspect it before retrying.`);
				return {
				name, tabId, paneId, sessionFile, prompt,
				async answer(maxBytes) {
					let current = state;
					while (current === "working") {
						const args = ["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", String(OPERATION_MS - 1000)];
						const waited = await herdr.exec(args, options(signal));
						if (waited.code !== 0 || waited.killed) {
							if (!waited.killed && hasHerdrErrorCode(waited, "timeout")) continue;
							throw new Error(herdrCommandFailure(args, waited));
						}
						current = inspect(JSON.parse(waited.stdout), "agent_info", name, paneId, tabId);
					}
					if (current !== "done" && current !== "idle") throw new Error(`Herdr agent in tab ${tabId} became ${current}; inspect it before retrying.`);
					const info = await stat(sessionFile);
					if (info.size > SESSION_LIMIT) throw new Error(`Pi session in tab ${tabId} exceeds 16 MiB; inspect ${sessionFile} for recovery.`);
					return exactDirectAnswer(await readFile(sessionFile, "utf8"), prompt, maxBytes);
				},
				async cancel() {
					await herdr.json(["agent", "send-keys", name, "ctrl+c"], options());
				},
				};
			} catch (error) {
				if (signal.aborted) await herdr.exec(["agent", "send-keys", name, "ctrl+c"], options()).catch(() => undefined);
				throw new Error(`Direct launch in Herdr tab ${tabId} is not verified; inspect the agent and ${sessionFile} before retrying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		},
	};
}
