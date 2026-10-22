import { randomBytes } from "node:crypto";
import { realpathSync, type Stats } from "node:fs";
import { open, readFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, herdrCommandFailure, startPiAgent } from "@henryqw/pi-herdr";
import { utf8Prefix } from "./ephemeral.ts";
import type { PreparedRoleLaunch, ResolvedRoleLaunch } from "./index.ts";
import { assertPrivateLease, PI_SUBAGENT_PROCESS_LEASE, scanProcessLease } from "./process-lease.ts";

const OPERATION_MS = 30_000;
const SESSION_LIMIT = 16 * 1024 * 1024;
// Leave room for boundary instructions below Linux's 128 KiB per-argument limit.
const INLINE_TASK_BYTES = 64 * 1024;
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
	/** `text` is the exact answer; `inline` is bounded for Main, linking a private full copy when truncated. */
	answer(maxBytes: number): Promise<{ text: string; inline: string; answerFile?: string }>;
	usage(): Promise<DirectUsage>;
	/** Bounded assistant text from this turn so far; failure evidence only, never completion. */
	partialText(maxChars: number): Promise<string | undefined>;
	/** Display-only activity from the last usage() sample. */
	readonly activity?: DirectToolActivity;
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
		if (entry.type === "session") continue;
		const id = field(entry.id, "session entry id");
		// Non-message entries also link the exact session branch.
		if (typeof entry.parentId === "string") parents.set(id, entry.parentId);
		if (entry.type !== "message") continue;
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

const turnSuffix = (turn: string) => `\n\nTurn identity: ${turn}`;

/** Refuse continuation unless the saved session's exact recorded turn is terminal and no later user turn exists. */
export async function assertSettledDirectSession(sessionFile: string, turn: string): Promise<void> {
	const info = await stat(sessionFile).catch((error: unknown) => {
		throw new Error(`Saved Pi session ${sessionFile} is missing or unreadable`, { cause: error });
	});
	if (info.size > SESSION_LIMIT) throw new Error(`Saved Pi session ${sessionFile} exceeds 16 MiB`);
	const jsonl = await readFile(sessionFile, "utf8");
	let prompt: string | undefined;
	for (const line of jsonl.trimEnd().split("\n")) {
		const entry = JSON.parse(line) as Json;
		const message = entry?.type === "message" ? entry.message as Json | undefined : undefined;
		const text = message?.role === "user" && Array.isArray(message.content) && message.content.length === 1
			? (message.content[0] as Json)?.text : undefined;
		if (typeof text === "string" && text.endsWith(turnSuffix(turn))) prompt = text;
	}
	if (prompt === undefined || !exactDirectTerminalTurn(jsonl, prompt)) {
		throw new Error(`Saved Pi session ${sessionFile} has no terminal final turn for the recorded prompt; the worker may still be running`);
	}
}

export function exactDirectAnswer(jsonl: string, prompt: string, requireSuccess = false): string {
	const final = exactFinalTurn(jsonl, prompt);
	if (!final || final.stopReason !== "stop" || !Array.isArray(final.content)) {
		throw new Error("Pi did not persist an exact successful final answer for this prompt.");
	}
	const text = final.content.flatMap((part) => {
		const content = object(part, "assistant content");
		return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
	}).join("\n");
	if (!text.trim()) throw new Error("Pi persisted an empty final answer.");
	if (!requireSuccess) return text;
	let completion: Json;
	try { completion = JSON.parse(text) as Json; }
	catch (error) { throw new Error("Pi write-access final answer must be a JSON completion object.", { cause: error }); }
	if (!completion || typeof completion !== "object" || Array.isArray(completion)
		|| !DIRECT_OUTCOMES.some((outcome) => outcome === completion.outcome)
		|| typeof completion.answer !== "string" || !completion.answer.trim()) {
		throw new Error("Pi write-access completion must have a valid outcome and a non-empty answer.");
	}
	if (completion.outcome !== "succeeded") throw new Error(`Direct task reported ${completion.outcome}: ${completion.answer}`);
	return completion.answer;
}

/** Measured from one session read; each field is absent when no turn record carried it. */
export interface DirectUsage {
	tokens?: number;
	/** Sum of assistant `usage.cost.total`. */
	cost?: number;
}

export interface DirectToolActivity {
	pending: string[];
	latest?: { name: string; durationMs?: number };
}

class DirectSessionState {
	private active = false;
	private total = 0;
	private observed = false;
	private cost: number | undefined;
	private pending = new Map<string, string>();
	private latest: DirectToolActivity["latest"];
	private texts: string[] = [];

	private prompt: string;
	constructor(prompt: string) { this.prompt = prompt; }

	consume(line: string): boolean {
		if (!line.trim()) return true;
		let entry: Json;
		try { entry = JSON.parse(line) as Json; } catch { return false; }
		if (!entry || entry.type !== "message" || !entry.message || typeof entry.message !== "object") return true;
		const message = entry.message as Json;
		if (message.role === "user") {
			this.active = Array.isArray(message.content) && message.content.length === 1
				&& (message.content[0] as Json)?.text === this.prompt;
			if (this.active) {
				this.total = 0; this.observed = false; this.cost = undefined; this.pending.clear(); this.latest = undefined;
				this.texts = [];
			}
		} else if (this.active && message.role === "assistant") {
			if (message.usage && typeof message.usage === "object") {
				const usage = message.usage as Json;
				const values = [usage.input, usage.output];
				if (values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
					this.total += (values as number[]).reduce((sum, value) => sum + value, 0);
					this.observed = true;
				}
				const cost = (usage.cost as Json | undefined)?.total;
				if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) this.cost = (this.cost ?? 0) + cost;
			}
			if (Array.isArray(message.content)) for (const part of message.content) {
				if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
					this.pending.set(part.id, part.name);
				} else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					this.texts.push(part.text);
				}
			}
		} else if (this.active && message.role === "toolResult" && typeof message.toolCallId === "string") {
			const name = this.pending.get(message.toolCallId);
			if (name !== undefined) {
				this.pending.delete(message.toolCallId);
				this.latest = { name };
				if (typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0) {
					this.latest.durationMs = message.durationMs;
				}
			}
		}
		return true;
	}

	usage(): DirectUsage & { activity?: DirectToolActivity } {
		return { tokens: this.observed ? this.total : undefined, cost: this.cost,
			activity: this.pending.size || this.latest ? { pending: [...this.pending.values()], latest: this.latest } : undefined };
	}

	partialText(maxChars: number): string | undefined {
		const chars = Array.from(this.texts.join("\n").trim());
		if (!chars.length) return undefined;
		return chars.length <= maxChars ? chars.join("") : `…${chars.slice(-maxChars).join("")}`;
	}
}

function parseDirectSession(jsonl: string, prompt: string): DirectSessionState {
	const state = new DirectSessionState(prompt);
	for (const line of jsonl.split("\n")) if (!state.consume(line)) break;
	return state;
}

// Ignore a partial trailing JSONL entry while the child is writing it.
export function directSessionUsage(jsonl: string, prompt: string): DirectUsage & { activity?: DirectToolActivity } {
	return parseDirectSession(jsonl, prompt).usage();
}

/** The last `maxChars` of assistant text in the exact prompt's turn; ignores a partial trailing entry. */
export function directPartialText(jsonl: string, prompt: string, maxChars: number): string | undefined {
	return parseDirectSession(jsonl, prompt).partialText(maxChars);
}

/** One reader per handle; only complete, valid lines advance the byte offset. */
export function createDirectSessionReader(sessionFile: string, prompt: string): Pick<DirectHandle, "usage" | "partialText" | "activity"> {
	let offset = 0;
	let previous: Stats | undefined;
	let state = new DirectSessionState(prompt);
	let lastUsage: ReturnType<typeof directSessionUsage> = {};
	let reading: Promise<boolean> | undefined;
	const read = async () => {
		const file = await open(sessionFile, "r");
		try {
			const info = await file.stat();
			if (info.size > SESSION_LIMIT) { previous = info; return false; }
			if (previous && (info.dev !== previous.dev || info.ino !== previous.ino || info.size < previous.size
				|| (info.size === previous.size && (info.mtimeMs !== previous.mtimeMs || info.ctimeMs !== previous.ctimeMs)))) {
				offset = 0;
				state = new DirectSessionState(prompt);
			}
			previous = info;
			const buffer = Buffer.alloc(info.size - offset);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read({ buffer, offset: length, length: buffer.length - length, position: offset + length });
				if (!bytesRead) break;
				length += bytesRead;
			}
			let start = 0;
			for (let end = buffer.indexOf(10); end >= 0 && end < length; end = buffer.indexOf(10, start)) {
				if (!state.consume(buffer.toString("utf8", start, end))) break;
				offset += end + 1 - start;
				start = end + 1;
			}
			return true;
		} finally { await file.close(); }
	};
	// Timer samples and failure evidence can request the same file at the same time.
	const sample = () => reading ??= read().finally(() => { reading = undefined; });
	return {
		get activity() { return lastUsage.activity; },
		async usage() {
			lastUsage = await sample() ? state.usage() : {};
			return { tokens: lastUsage.tokens, cost: lastUsage.cost };
		},
		async partialText(maxChars) {
			return await sample() ? state.partialText(maxChars) : undefined;
		},
	};
}

/** `turn` is the prompt's random turn identity; it proves which session turn a record owns.
 * `workspaceId` and `cwd` bind the record to its launching Herdr workspace and checkout. */
export type DirectTab = Pick<DirectHandle, "name" | "tabId" | "paneId" | "sessionFile"> & { leasePath: string; turn: string; workspaceId: string; cwd: string };

/** Allocation evidence is not ownership and must never authorize pane mutation. */
export type DirectAllocation = Omit<DirectTab, "tabId" | "paneId"> & { label: string; tabId?: string; paneId?: string };
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
		workspaceId,
		cwd: workingDir,
		/** Close only an exact owned pane, then prove it and its leased children stopped.
		 * A task result or Ctrl-C acknowledgement is not termination evidence.
		 * `settledOnly` refuses to close a listed agent that is not idle or done. */
		async stop(tab: Pick<DirectTab, "name" | "tabId" | "paneId" | "leasePath">, current: () => boolean = () => true, settledOnly = false): Promise<void> {
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
				if (settledOnly && agent.agent_status !== "idle" && agent.agent_status !== "done") {
					throw new Error(`Herdr agent ${tab.name} is ${String(agent.agent_status)}, not idle or done; it was not closed`);
				}
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
		/** `resume` reuses a stopped worker's saved session and private lease instead of a new temp directory. */
		async start(launch: ResolvedRoleLaunch & Pick<PreparedRoleLaunch, "tools">, name: string, label: string, task: string, signal: AbortSignal, onTab: (tab: DirectTab) => void, requireSuccess = false, resume?: Pick<DirectTab, "sessionFile" | "leasePath">): Promise<DirectHandle> {
			const fileTask = Buffer.byteLength(task, "utf8") > INLINE_TASK_BYTES;
			const reader = launch.tools.includes("read") ? "read" : launch.tools.includes("bash") ? "bash" : undefined;
			if (fileTask && !reader) throw new Error("Large direct task packets require read or bash in the Role; no worker was launched.");
			const caller = result(await herdr.json(["pane", "current", "--current"], options(signal)), "pane_current");
			const pane = object(caller.pane, "calling pane");
			if (pane.pane_id !== callerPane || pane.workspace_id !== workspaceId) throw new Error("Herdr caller pane no longer matches the launching workspace.");
			if (Object.keys(launch.env).length) throw new Error("Direct Herdr launch cannot transfer Role environment overrides.");
			let sessionFile: string;
			let leasePath: string;
			if (resume) {
				({ sessionFile, leasePath } = resume);
				await assertPrivateLease(leasePath, false);
			} else {
				const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-direct-"));
				sessionFile = join(sessionDir, "session.jsonl");
				leasePath = join(sessionDir, "process.lease");
				await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
			}
			const turn = randomBytes(16).toString("hex");
			if (fileTask) {
				const taskFile = join(dirname(sessionFile), `task-${turn}.md`);
				await writeFile(taskFile, task, { flag: "wx", mode: 0o600 });
				task = `Use ${reader} to read the complete task packet at ${JSON.stringify(taskFile)}. Read all parts before you act; do not use a truncated preview. The file contains the full task and chain context. If you cannot read it in full, stop and report blocked work.`;
			}
			// Pi's native session is the exact answer channel. Herdr screen output is diagnostic only.
			const sessionArgs = launch.args.filter((arg) => arg !== "--no-session");
			if (sessionArgs.length !== launch.args.length - 1) throw new Error("Role launch must contain exactly one --no-session option.");
			signal.throwIfAborted();
			// Tab creation is bounded but not session-cancellable: Herdr may create it
			// before the CLI responds, and aborting the CLI loses the exact tab ID.
			const allocation: DirectAllocation = { name, workspaceId, cwd: workingDir, label, sessionFile, leasePath, turn };
			let tabId: string;
			let paneId: string;
			try {
				const response = await herdr.json(["tab", "create", "--workspace", workspaceId, "--cwd", workingDir, "--label", label, "--env", `${PI_SUBAGENT_PROCESS_LEASE}=${leasePath}`, "--no-focus"], options());
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
				onTab({ name, tabId, paneId, sessionFile, leasePath, turn, workspaceId, cwd: workingDir });
				signal.throwIfAborted();
				const started = await startPiAgent(herdr, { name, pane: paneId,
					args: [...sessionArgs, "--session", sessionFile], options: options(signal), shouldRetry: () => false });
				if (started.code !== 0 || started.killed) throw new Error(`Herdr agent start failed: ${started.stderr.slice(0, 1000)}`);
				if (inspect(JSON.parse(started.stdout), "agent_started", name, paneId, tabId) !== "idle") throw new Error("Herdr agent was not idle after start.");
				// A canceled start may have succeeded server-side; retain its tab but
				// never submit a new prompt after cancellation.
				signal.throwIfAborted();
				const completionInstruction = requireSuccess
					? `\n\nWrite-access completion: Return exactly one JSON object without Markdown, {"outcome":"succeeded","answer":"summary"}. outcome must be ${DIRECT_OUTCOMES.join(", ")}. Use succeeded only when the entire authorized task, including requested checks and commits, completed successfully; a failed mutation, unresolved partial work, or missing authorization must be failed or blocked, even if your Pi turn ends normally. Describe changes, checks, commit identity, remaining risks, and checkout status in answer.`
					: "";
				const prompt = `${task}\n\nDirect shared-checkout boundary: use only your Role's resources for the explicitly authorized task and scope. Writes and commits affect Main's existing checkout immediately; preserve unrelated files and staged changes. Do not create or manage worktrees, change branches, push, or perform external mutations without explicit task authorization. There is no isolated integration, automatic validation, or rollback. If instructions conflict or authorization is missing, stop and report it. Report changes, commit identity if any, checks, remaining risks, and checkout status; never claim isolated guarantees.${completionInstruction}${turnSuffix(turn)}`;
				// Native prompt without --wait acknowledges submission, not completion of the turn.
				const accepted = await herdr.json(["agent", "prompt", name, prompt], options(signal));
				const state = inspect(accepted, "agent_prompted", name, paneId, tabId);
				if (state === "blocked" || state === "unknown") throw new Error(`Herdr agent became ${state}; inspect it before retrying.`);
				const session = createDirectSessionReader(sessionFile, prompt);
				return {
				name, tabId, paneId, sessionFile, prompt,
				get activity() { return session.activity; },
				usage: session.usage,
				partialText: session.partialText,
				async answer(maxBytes) {
					const readAnswer = async () => {
						const info = await stat(sessionFile);
						if (info.size > SESSION_LIMIT) throw new Error(`Pi session in tab ${tabId} exceeds 16 MiB; inspect ${sessionFile} for recovery.`);
						const text = exactDirectAnswer(await readFile(sessionFile, "utf8"), prompt, requireSuccess);
						const bytes = Buffer.byteLength(text, "utf8");
						if (bytes <= maxBytes) return { text, inline: text };
						// An oversized exact answer still succeeds: Main gets a bounded prefix and a private full copy.
						// Exclusive creation refuses a worker-planted file, symlink, or FIFO at this predictable path.
						const file = join(dirname(sessionFile), `answer-${turn}.md`);
						await writeFile(file, text, { flag: "wx", mode: 0o600 });
						return { text, answerFile: file, inline: `${utf8Prefix(text, maxBytes)}\n\n[Answer truncated to ${maxBytes} of ${bytes} bytes; read the full answer at ${file}]` };
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
