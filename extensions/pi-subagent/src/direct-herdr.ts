import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, herdrCommandFailure, startPiAgent } from "@henryqw/pi-herdr";
import type { ResolvedRoleLaunch } from "./index.ts";
import { assertPrivateLease, scanProcessLease } from "./process-lease.ts";

const OPERATION_MS = 30_000;
const SESSION_LIMIT = 16 * 1024 * 1024;
const ANSWER_LIMIT = 50 * 1024;
const DIRECT_OUTCOMES = ["succeeded", "failed", "blocked"] as const;

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
	usageTokens(): Promise<number | undefined>;
	cancel(): Promise<void>;
}

function exactFinalTurn(jsonl: string, prompt: string): Json | undefined {
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
	return userId && ancestor === userId ? final : undefined;
}

export function exactDirectTerminalTurn(jsonl: string, prompt: string): boolean {
	const reason = exactFinalTurn(jsonl, prompt)?.stopReason;
	return reason === "stop" || reason === "error" || reason === "aborted";
}

export function exactDirectAnswer(jsonl: string, prompt: string, maxBytes = ANSWER_LIMIT, requireSuccess = false): string {
	const final = exactFinalTurn(jsonl, prompt);
	if (!final || final.stopReason !== "stop" || !Array.isArray(final.content)) {
		throw new Error("Pi did not persist an exact successful final answer for this prompt.");
	}
	const text = final.content.flatMap((part) => {
		const content = object(part, "assistant content");
		return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
	}).join("\n");
	if (!text.trim()) throw new Error("Pi persisted an empty final answer.");
	if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Pi final answer exceeds the ${maxBytes}-byte workflow limit; read the private session file for recovery.`);
	if (!requireSuccess) return text;
	let completion: Json;
	try { completion = JSON.parse(text) as Json; }
	catch (error) { throw new Error("Pi potential-writer final answer must be a JSON completion object.", { cause: error }); }
	if (!completion || typeof completion !== "object" || Array.isArray(completion)
		|| !DIRECT_OUTCOMES.some((outcome) => outcome === completion.outcome)
		|| typeof completion.answer !== "string" || !completion.answer.trim()) {
		throw new Error("Pi potential-writer completion must have a valid outcome and a non-empty answer.");
	}
	if (completion.outcome !== "succeeded") throw new Error(`Direct task reported ${completion.outcome}: ${completion.answer}`);
	return completion.answer;
}

// Ignore a partial trailing JSONL entry while the child is writing it.
export function directSessionTokens(jsonl: string, prompt: string): number | undefined {
	let active = false;
	let total = 0;
	let observed = false;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: Json;
		try { entry = JSON.parse(line) as Json; } catch { break; }
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Json;
		if (message.role === "user") {
			active = Array.isArray(message.content) && message.content.length === 1
				&& (message.content[0] as Json)?.text === prompt;
			if (active) { total = 0; observed = false; }
		} else if (active && message.role === "assistant" && message.usage && typeof message.usage === "object") {
			const usage = message.usage as Json;
			const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
			if (values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
				total += (values as number[]).reduce((sum, value) => sum + value, 0);
				observed = true;
			}
		}
	}
	return observed ? total : undefined;
}

export type DirectTab = Pick<DirectHandle, "name" | "tabId" | "paneId" | "sessionFile"> & { leasePath: string };

/** Allocation evidence is not ownership and must never authorize pane mutation. */
export type DirectAllocation = Omit<DirectTab, "tabId" | "paneId"> & {
	workspaceId: string; cwd: string; label: string; tabId?: string; paneId?: string;
};
export class DirectAllocationError extends Error {
	readonly allocation: DirectAllocation;
	constructor(allocation: DirectAllocation, cause: unknown) {
		super(`Direct tab allocation is unverified: ${cause instanceof Error ? cause.message : String(cause)}. No agent start was dispatched. Inspect /subagent allocation evidence: workspace ${allocation.workspaceId}, cwd ${allocation.cwd}, label ${JSON.stringify(allocation.label)}, tab ${allocation.tabId ?? "unknown"}, pane ${allocation.paneId ?? "unknown"}, agent ${allocation.name}, session ${allocation.sessionFile}, lease ${allocation.leasePath}. Manual allocation reconciliation is required; do not replay creation or unlock admission.`, { cause });
		this.allocation = allocation;
	}
}

export function createDirectHerdr(pi: Pick<ExtensionAPI, "exec">, cwd: string, idleMs: number) {
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
		/** Close only an exact owned pane, then prove it and its leased children stopped.
		 * A task result or Ctrl-C acknowledgement is not termination evidence. */
		async stop(tab: DirectTab, current: () => boolean = () => true): Promise<void> {
			const requireCurrent = () => { if (!current()) throw new Error("Direct task scope changed; reopen /subagent."); };
			requireCurrent();
			await assertPrivateLease(tab.leasePath, false);
			const listed = result(await herdr.json(["agent", "list"], options()), "agent_list");
			if (!Array.isArray(listed.agents)) throw new Error("Malformed Herdr agent list.");
			const related = listed.agents.map((value) => {
				const agent = object(value, "listed agent");
				for (const key of ["pane_id", "tab_id"]) field(agent[key], `listed agent ${key}`);
				return agent;
			}).filter((agent) => agent.name === tab.name || agent.pane_id === tab.paneId || agent.tab_id === tab.tabId);
			const panes = async () => {
				const list = result(await herdr.json(["pane", "list", "--workspace", workspaceId], options()), "pane_list");
				if (!Array.isArray(list.panes)) throw new Error("Malformed Herdr pane list.");
				return list.panes.map((value) => {
					const pane = object(value, "listed pane");
					for (const key of ["pane_id", "tab_id"]) field(pane[key], `listed pane ${key}`);
					if (pane.workspace_id !== workspaceId) throw new Error("Herdr pane list escaped the owned workspace.");
					return pane;
				});
			};
			if (related.length) {
				const agent = related[0]!;
				if (related.length !== 1 || agent.name !== tab.name || agent.pane_id !== tab.paneId
					|| agent.tab_id !== tab.tabId || agent.workspace_id !== workspaceId || agent.cwd !== workingDir
					|| tab.paneId === callerPane) throw new Error("Worker termination requires one exact owned agent, workspace, checkout, tab and pane match.");
				requireCurrent();
				result(await herdr.json(["pane", "close", tab.paneId], options()), "ok");
			}
			if ((await panes()).some((pane) => pane.pane_id === tab.paneId || pane.tab_id === tab.tabId)) {
				throw new Error(`Owned pane ${tab.paneId} is still present; termination is unproved.`);
			}
			for (let scan = 0; scan < 2; scan++) {
				const holders = await scanProcessLease(tab.leasePath, (args) => pi.exec("lsof", args, { cwd: workingDir, timeout: 3_000 }));
				if (holders.length) throw new Error(`Owned process lease ${tab.leasePath} still has holders: ${holders.join(", ")}. Stop those owned processes, then retry Close/cancel-and-release.`);
				if (scan === 0) await sleep(50);
			}
			requireCurrent();
		},
		async start(launch: ResolvedRoleLaunch, name: string, label: string, task: string, signal: AbortSignal, onTab: (tab: DirectTab) => void, requireSuccess = false): Promise<DirectHandle> {
			const caller = result(await herdr.json(["pane", "current", "--current"], options(signal)), "pane_current");
			const pane = object(caller.pane, "calling pane");
			if (pane.pane_id !== callerPane || pane.workspace_id !== workspaceId) throw new Error("Herdr caller pane no longer matches the launching workspace.");
			if (Object.keys(launch.env).length) throw new Error("Direct Herdr launch cannot transfer Role environment overrides.");
			const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-direct-"));
			const sessionFile = join(sessionDir, "session.jsonl");
			const leasePath = join(sessionDir, "process.lease");
			await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
			// Pi's native session is the exact answer channel. Herdr screen output is diagnostic only.
			const sessionArgs = launch.args.filter((arg) => arg !== "--no-session");
			if (sessionArgs.length !== launch.args.length - 1) throw new Error("Role launch must contain exactly one --no-session option.");
			signal.throwIfAborted();
			// Tab creation is bounded but not session-cancellable: Herdr may create it
			// before the CLI responds, and aborting the CLI loses the exact tab ID.
			const allocation: DirectAllocation = { name, workspaceId, cwd: workingDir, label, sessionFile, leasePath };
			let tabId: string;
			let paneId: string;
			try {
				const response = await herdr.json(["tab", "create", "--workspace", workspaceId, "--cwd", workingDir, "--label", label, "--env", `PI_SUBAGENT_PROCESS_LEASE=${leasePath}`, "--no-focus"], options());
				const created = object(response.result, "tab allocation result");
				// Capture every returned ID before validation can fail. These are evidence,
				// not owned tabs; the caller retains this intent even without either ID.
				for (const [source, key, target] of [[created.tab, "tab_id", "tabId"], [created.root_pane, "pane_id", "paneId"]] as const) {
					if (source && typeof source === "object" && typeof (source as Json)[key] === "string") allocation[target] = (source as Json)[key] as string;
				}
				result(response, "tab_created");
				const tab = object(created.tab, "created tab");
				const workerPane = object(created.root_pane, "created pane");
				tabId = field(tab.tab_id, "tab id");
				paneId = field(workerPane.pane_id, "pane id");
				if (tab.workspace_id !== workspaceId || workerPane.workspace_id !== workspaceId || workerPane.tab_id !== tabId
					|| workerPane.cwd !== workingDir || tab.focused !== false || workerPane.focused !== false || paneId === callerPane) {
					throw new Error(`Herdr tab ${tabId} has unverified identity, cwd or focus; inspect it before retrying.`);
				}
			} catch (error) { throw new DirectAllocationError(allocation, error); }
			try {
				// Record the tab before the agent start can outlive an aborted launch.
				onTab({ name, tabId, paneId, sessionFile, leasePath });
				signal.throwIfAborted();
				const started = await startPiAgent(herdr, { name, pane: paneId,
					args: [...sessionArgs, "--session", sessionFile], options: options(signal), shouldRetry: () => false });
				if (started.code !== 0 || started.killed) throw new Error(`Herdr agent start failed: ${started.stderr.slice(0, 1000)}`);
				if (inspect(JSON.parse(started.stdout), "agent_started", name, paneId, tabId) !== "idle") throw new Error("Herdr agent was not idle after start.");
				// A canceled start may have succeeded server-side; retain its tab but
				// never submit a new prompt after cancellation.
				signal.throwIfAborted();
				const completionInstruction = requireSuccess
					? `\n\nPotential-writer completion: Return exactly one JSON object without Markdown, {"outcome":"succeeded","answer":"summary"}. outcome must be ${DIRECT_OUTCOMES.join(", ")}. Use succeeded only when the entire authorized task, including requested checks and commits, completed successfully; a failed mutation, unresolved partial work, or missing authorization must be failed or blocked, even if your Pi turn ends normally. Describe changes, checks, commit identity, remaining risks, and checkout status in answer.`
					: "";
				const prompt = `${task}\n\nDirect shared-checkout boundary: use only your Role's resources for the explicitly authorized task and scope. Writes and commits affect Main's existing checkout immediately; preserve unrelated files and staged changes. Do not create or manage worktrees, change branches, push, or perform external mutations without explicit task authorization. There is no isolated integration, automatic validation, or rollback. If instructions conflict or authorization is missing, stop and report it. Report changes, commit identity if any, checks, remaining risks, and checkout status; never claim isolated guarantees.${completionInstruction}\n\nTurn identity: ${randomBytes(16).toString("hex")}`;
				// Native prompt without --wait acknowledges submission, not completion of the turn.
				const accepted = await herdr.json(["agent", "prompt", name, prompt], options(signal));
				const state = inspect(accepted, "agent_prompted", name, paneId, tabId);
				if (state === "blocked" || state === "unknown") throw new Error(`Herdr agent became ${state}; inspect it before retrying.`);
				let lastUsageSize = -1;
				let lastTokens: number | undefined;
				return {
				name, tabId, paneId, sessionFile, prompt,
				async usageTokens() {
					const info = await stat(sessionFile);
					if (info.size > SESSION_LIMIT) return undefined;
					if (info.size !== lastUsageSize) {
						lastTokens = directSessionTokens(await readFile(sessionFile, "utf8"), prompt);
						lastUsageSize = info.size;
					}
					return lastTokens;
				},
				async answer(maxBytes) {
					const readAnswer = async () => {
						const info = await stat(sessionFile);
						if (info.size > SESSION_LIMIT) throw new Error(`Pi session in tab ${tabId} exceeds 16 MiB; inspect ${sessionFile} for recovery.`);
						return exactDirectAnswer(await readFile(sessionFile, "utf8"), prompt, maxBytes, requireSuccess);
					};
					const maybeAnswer = async () => {
						try { return await readAnswer(); } catch (error) {
							if (signal.aborted || !(error instanceof Error)
								|| (!('code' in error && error.code === "ENOENT")
									&& !error.message.includes("did not persist an exact successful final answer"))) throw error;
							return undefined;
						}
					};
					let current = state;
					let deadline = Date.now() + idleMs;
					let sessionSize = 0;
					const observeProgress = async () => {
						const info = await stat(sessionFile).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return undefined;
							throw error;
						});
						if (info && info.size > SESSION_LIMIT) throw new Error(`Pi session in tab ${tabId} exceeds 16 MiB; inspect ${sessionFile} for recovery.`);
						if (info && info.size > sessionSize) {
							sessionSize = info.size;
							deadline = Date.now() + idleMs;
						}
					};
					while (current === "working" || current === "idle") {
						// A turn may finish before observation begins (or between waits).
						if (current === "idle") {
							const answer = await maybeAnswer();
							if (answer !== undefined) return answer;
						}
						await observeProgress();
						const remaining = deadline - Date.now();
						if (remaining <= 0) throw new Error(`Herdr agent in tab ${tabId} made no progress for ${idleMs}ms; inspect ${sessionFile} before retrying.`);
						const args = ["agent", "wait", name,
							...(current === "idle" ? ["--until", "working"] : ["--until", "idle"]),
							"--until", "done", "--until", "blocked", "--until", "unknown",
							"--timeout", String(Math.max(1, Math.min(current === "idle" ? 1000 : OPERATION_MS - 1000, remaining)))];
						const waited = await herdr.exec(args, options(signal));
						if (waited.code !== 0 || waited.killed) {
							if (!waited.killed && hasHerdrErrorCode(waited, "timeout")) {
								continue;
							}
							throw new Error(herdrCommandFailure(args, waited));
						}
						const next = inspect(JSON.parse(waited.stdout), "agent_info", name, paneId, tabId);
						if (next !== current) deadline = Date.now() + idleMs;
						current = next;
					}
					if (current !== "done") throw new Error(`Herdr agent in tab ${tabId} became ${current}; inspect it before retrying.`);
					return readAnswer();
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
