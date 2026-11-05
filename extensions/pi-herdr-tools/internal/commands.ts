import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extensionConfigDir, registerConfigReporting } from "@henryqw/pi-config-store";
import { createHerdrToolsConfigStore } from "./config.ts";
import { showCommandOutput } from "./command-output.ts";
import { checkoutAdmission, checkoutKey, HerdrRequestError, requestHerdr, withWorktreeLock, type CheckoutAdmission } from "@henryqw/pi-herdr";
import { cancelJob, inventoryJobs, jobId, listJobs, outputTail, privateDirectory, pruneJob, readJob, readPrivate, readPublishedSpec, recordNonDispatch, recoveryDiagnostic, releaseJob, terminal, userReleased, validateSpec, withCommandRemovalGuard, withCommandStoreLock, writePrivate, type Job, type JobSpec } from "./command-state.ts";

const runner = fileURLToPath(new URL("../dist/command-runner.js", import.meta.url));
const completionType = "background-command-completion";
export const commandParameters = Type.Object({
	action: Type.String({ enum: ["launch", "list", "status", "cancel"] }),
	command: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	access: Type.Optional(Type.String({ enum: ["read", "write"] })),
	id: Type.Optional(Type.String()),
}, { additionalProperties: false });
type Request = { action: string; command?: string; access?: string; id?: string };
export function validateRequest(input: Request): void {
	if (input.action === "launch") {
		if (!input.command?.trim() || input.command.includes("\0") || input.command.length > 16_384 || !["read", "write"].includes(input.access ?? "") || input.id !== undefined) throw new Error("launch requires command and access (read or write), without id.");
	} else if (input.action === "list") {
		if (input.command !== undefined || input.access !== undefined || input.id !== undefined) throw new Error("list takes no command, access, or id.");
	} else if (input.action === "status" || input.action === "cancel") {
		jobId(input.id);
		if (input.command !== undefined || input.access !== undefined) throw new Error("status and cancel take only id.");
	} else throw new Error("Unknown background command action.");
}
export interface CommandPolicy { runtimeMs: number; outputBytes: number; concurrency: number; retainedJobs: number }

function assertMainLaunch(): void {
	// Pi Subagent sets the Role tool flag for all workers and the lease for Herdr workers.
	if (process.env.PI_SUBAGENT_PROCESS_LEASE !== undefined || process.argv.some((arg) => arg === "--pi-subagent-role-tools" || arg.startsWith("--pi-subagent-role-tools="))) {
		throw new Error("Managed background command launches are Main-only. Delegated workers must use commands within their assigned runtime.");
	}
}

export class CommandManager {
	readonly root: string;
	readonly admission: CheckoutAdmission;
	readonly request: typeof requestHerdr;
	constructor(root: string, admission: CheckoutAdmission, request = requestHerdr) {
		for (const method of ["install", "guard", "restore", "release", "complete", "reserve"] as const) {
			if (typeof admission[method] !== "function") throw new Error("The active checkout coordinator cannot protect managed commands. Reload with the current Pi Herdr package before command actions.");
		}
		this.root = root; this.admission = admission; this.request = request;
		admission.guard("background-commands", async (checkouts) => { await this.refresh(checkouts); });
	}
	async refresh(checkouts?: readonly string[]): Promise<Job[]> {
		const jobs = await listJobs(this.root, checkouts);
		for (const job of jobs) {
			const owner = `command:${job.spec.id}`;
			if (job.released) { this.admission.complete(owner); }
			else if (job.spec.access === "write" && !terminal(job.state)) {
				this.admission.restore(owner, job.spec.checkout);
			} else if (terminal(job.state)) { this.admission.complete(owner); }
			else { this.admission.release(owner); }
		}
		// Removed records are not proof of termination. Keep their restored ownership.
		return jobs;
	}
	async launch(input: { command: string; access: "read" | "write"; callId: string; callEntryId: string; sessionId: string; sessionFile: string | null; cwd: string; checkout: string }, policy: CommandPolicy, signal?: AbortSignal): Promise<Job> {
		assertMainLaunch();
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (process.env.HERDR_ENV !== "1" || !workspaceId || !socketPath?.startsWith("/")) throw new Error("Background commands require a local Herdr pane and HERDR_SOCKET_PATH.");
		if (signal?.aborted) throw new Error("Command launch aborted before dispatch.");
		const id = randomUUID();
		const spec: JobSpec = { ...input, runtimeMs: policy.runtimeMs, outputBytes: policy.outputBytes, version: 1, id, token: randomUUID(), workspaceId, socketPath, createdAt: Date.now() };
		validateSpec(spec);
		await privateDirectory(this.root, true);
		const prepared = await withCommandStoreLock(this.root, async () => {
			const jobs = await this.refresh();
			const duplicate = jobs.find((job) => job.spec.sessionId === input.sessionId && job.spec.callId === input.callId);
			if (duplicate) return { job: duplicate, fresh: false };
			if (jobs.filter(job => !job.pruned).length >= policy.retainedJobs) throw new Error("Command record limit reached; use /commands to inspect finished output and explicitly confirm pruning.");
			if (jobs.filter((job) => !terminal(job.state) && !job.released).length >= policy.concurrency) throw new Error("Command concurrency limit reached; wait for owned commands to stop.");
			const dir = join(this.root, id);
			const release = await this.admission.reserve(`command:${id}`, input.checkout);
			try {
				await mkdir(dir, { mode: 0o700 });
				await writePrivate(join(dir, "spec.json"), spec);
				if (input.access === "read") release();
			} catch (error) { release(); throw error; }
			return { job: await readJob(dir), fresh: true };
		});
		if (!prepared.fresh) return prepared.job;
		const { job } = prepared;
		// Once the specification exists, no transport or process outcome can cause another launch.
		try {
			if (await userReleased(job.dir, job.spec)) return await this.get(job.spec.id);
			if (signal?.aborted) throw new HerdrRequestError("aborted", "Command launch aborted before dispatch.", false);
			const response = await this.request("layout.apply", {
				workspace_id: workspaceId, focus: false,
				root: { type: "pane", cwd: input.cwd, command: [process.execPath, runner, job.dir], env: {} },
			}, { signal });
			const layout = response.layout as { workspace_id?: unknown; tab_id?: unknown; root?: { type?: unknown; pane_id?: unknown } } | undefined;
			if (response.type !== "layout_apply" || layout?.workspace_id !== workspaceId || typeof layout.tab_id !== "string" || layout.root?.type !== "pane" || typeof layout.root.pane_id !== "string") throw new Error("Herdr did not return the exact command terminal identity.");
			await writePrivate(join(job.dir, "dispatch.json"), { id: job.spec.id, token: job.spec.token, workspaceId, tabId: layout.tab_id, paneId: layout.root.pane_id });
		} catch (error) {
			if (!await recordNonDispatch(job, error)) await writePrivate(join(job.dir, "uncertain.json"), { id: job.spec.id, token: job.spec.token });
		}
		await this.refresh([input.checkout]);
		return await readJob(job.dir);
	}
	async get(id: string): Promise<Job> { return await readJob(join(this.root, jobId(id))); }
	async cancel(id: string, expected?: JobSpec, check: () => void = () => {}): Promise<void> {
		const dir = join(this.root, jobId(id));
		await privateDirectory(dir);
		const spec = await readPublishedSpec(this.root, dir);
		if (expected && JSON.stringify(spec) !== JSON.stringify(expected)) throw new Error("Command identity or scope changed; cancellation was not sent.");
		check();
		await cancelJob({ dir, spec }, check);
	}
	async release(spec: JobSpec, typedId: string, check: () => void): Promise<void> {
		await releaseJob(join(this.root, jobId(spec.id)), spec, typedId, check);
		// This seals admission against a recovery scan that read the old state.
		this.admission.complete(`command:${spec.id}`);
	}
	async guardRemoval<T>(checkout: string, operation: (descriptor: number) => Promise<T>): Promise<T> {
		const key = await realpath(checkout);
		return await withCommandRemovalGuard(this.root, key, async (descriptor) => {
			const release = await this.admission.reserve(`done:${randomUUID()}`, key);
			try { return await operation(descriptor); }
			finally { release(); }
		});
	}

	async recoverRemoval(checkout: string, ctx: ExtensionContext, check: () => void): Promise<boolean> {
		if (!ctx.hasUI) throw new Error("Command recovery requires a user interface; worktree removal is blocked.");
		const key = await realpath(checkout);
		const candidates = (await inventoryJobs(this.root)).filter(item => item.spec?.checkout === key && (!item.job || (!terminal(item.job.state) && !item.job.released)));
		check();
		if (!candidates.length) throw new Error("No command with verified checkout identity can be recovered here. Inspect /commands; worktree removal stays blocked.");
		for (const item of candidates) if (!await recoverCommand(this, item.spec!, ctx, check)) return false;
		return true;
	}
}

async function recoverCommand(manager: CommandManager, spec: JobSpec, ctx: ExtensionContext, check: () => void, cancelFirst = false): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("Command recovery requires a user interface; protection stays held.");
	if (cancelFirst) { await manager.cancel(spec.id, spec, check); ctx.ui.notify("Cancellation requested. This is not proof of termination.", "info"); }
	while (true) {
		const current = (await inventoryJobs(manager.root)).find(entry => entry.id === spec.id);
		check();
		if (!current?.spec || JSON.stringify(current.spec) !== JSON.stringify(spec)) throw new Error("Command identity or scope cannot be verified; protection stays held.");
		if (current.job && terminal(current.job.state)) { await manager.refresh([spec.checkout]); check(); ctx.ui.notify(`Verified completion: ${current.job.state}.`, "info"); return true; }
		if (current.job?.released) { ctx.ui.notify("released by user, termination unproved", "warning"); return true; }
		const answer = await ctx.ui.select(`Termination is unproved for ${spec.id}. A live command could still write. Release can permit both Pi writes and checkout removal at ${JSON.stringify(spec.checkout)}. All records and output stay saved.`, ["Keep protection", "Cancel and recheck", "Recheck proof", "Release protection despite this risk"]);
		check();
		if (answer === "Cancel and recheck") { await manager.cancel(spec.id, spec, check); continue; }
		if (answer === "Recheck proof") continue;
		if (answer !== "Release protection despite this risk") return false;
		const typed = await ctx.ui.input("Type the exact command ID to release protection. Termination remains unproved.", spec.id);
		check();
		if (typed === undefined) return false;
		await manager.release(spec, typed, check);
		ctx.ui.notify("released by user, termination unproved. A live command could still write; Pi writes and checkout removal can now proceed if no other owner blocks them.", "warning");
		return true;
	}
}

function recovery(job: Job): string | null {
	return job.released ? terminal(job.state) ? "released by user; completion later verified" : "released by user, termination unproved" : null;
}
function summary(job: Job) {
	return { id: job.spec.id, state: job.state, recovery: recovery(job), outputPruned: job.pruned === true, access: job.spec.access, checkout: job.spec.checkout,
		sessionId: job.spec.sessionId, runnerId: job.claim?.runnerId ?? null, workspaceId: job.spec.workspaceId,
		tabId: job.claim?.tabId ?? null, paneId: job.claim?.paneId ?? null, outputPath: job.outputPath,
		exitCode: job.result?.exitCode ?? null, signal: job.result?.signal ?? null, failure: job.nonDispatch?.reason ?? job.result?.failure ?? null };
}
const summarySchema = Type.Object({
	id: Type.String(), state: Type.String(), recovery: Type.Union([Type.String(), Type.Null()]), outputPruned: Type.Boolean(), access: Type.String(), checkout: Type.String(), sessionId: Type.String(),
	runnerId: Type.Union([Type.String(), Type.Null()]), workspaceId: Type.String(), tabId: Type.Union([Type.String(), Type.Null()]),
	paneId: Type.Union([Type.String(), Type.Null()]), outputPath: Type.String(), exitCode: Type.Union([Type.Number(), Type.Null()]), failure: Type.Union([Type.String(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
});

export function registerCommands(pi: ExtensionAPI): CommandManager {
	const admission = checkoutAdmission(pi);
	const manager = new CommandManager(join(extensionConfigDir("pi-herdr-tools"), "commands"), admission);
	admission.install(pi);
	const store = createHerdrToolsConfigStore();
	const reporter = registerConfigReporting(pi, [store]);
	pi.registerTool({
		name: "background_command", label: "Background command", parameters: commandParameters,
		description: "Main-only launch of an already authorized, bounded noninteractive local shell command in its own Herdr terminal; list, inspect output, or cancel it. Declare write access if it can change files, Git state, or external resources. Read access is not enforced; no sandbox. Do not detach processes or use remote or interactive jobs. Unknown launch or ownership is not permission to retry. Status and cancel remain available while checkout writes are blocked.",
		outputSchema: Type.Object({ jobs: Type.Array(summarySchema), totalJobs: Type.Number(), output: Type.Optional(Type.String()) }),
		async execute(callId, input, signal, _update, ctx) {
			validateRequest(input);
			let jobs: Job[];
			let output: string | undefined;
			if (input.action === "launch") {
				assertMainLaunch();
				const loaded = store.loadSync(); reporter.report(ctx, store, loaded);
				if (loaded.status !== "ok") throw new Error("Background command config is disabled; repair it before launch.");
				const sessionId = ctx.sessionManager.getSessionId();
				const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
				// The latest assistant call entry owns direct and nested calls, even after sibling results move the leaf.
				const callEntry = ctx.sessionManager.getBranch().reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.content.some((part) => part.type === "toolCall"));
				if (!callEntry) throw new Error("Background command launch requires its assistant tool-call entry on the current branch.");
				const cwd = await realpath(ctx.cwd);
				const checkout = await checkoutKey(pi, ctx);
				if (sessionId !== ctx.sessionManager.getSessionId() || !ctx.sessionManager.getBranch().some((entry) => entry.id === callEntry.id)) throw new Error("Command launch session or branch changed before dispatch.");
				jobs = [await manager.launch({ command: input.command!, access: input.access as "read" | "write", callId, callEntryId: callEntry.id,
					sessionId, sessionFile, cwd, checkout }, loaded.value, signal)];
			} else if (input.action === "list") jobs = await manager.refresh();
			else {
				if (input.action === "cancel") await manager.cancel(input.id!);
				const job = await manager.get(input.id!);
				jobs = [job]; output = await outputTail(job);
			}
			const structuredContent = { jobs: jobs.sort((a, b) => Number(terminal(a.state)) - Number(terminal(b.state)) || b.spec.createdAt - a.spec.createdAt).slice(0, 20).map(summary), totalJobs: jobs.length, ...(output === undefined ? {} : { output }) };
			const isError = jobs.some((job) => ["failed", "cancelled", "timeout", "output_limit", "unknown"].includes(job.state));
			return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], details: undefined, structuredContent, isError };
		},
	});
	let lifecycle = 0;
	const pending = new Set<string>();
	pi.registerCommand("commands", {
		description: "Inspect commands, cancel, release protection, or confirm output pruning; use pruned to inspect receipts",
		async handler(args, ctx) {
			const showPruned = args.trim() === "pruned";
			if (args.trim() && !showPruned) throw new Error("Usage: /commands [pruned]");
			const generation = lifecycle, sessionId = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
			const check = () => {
				if (generation !== lifecycle || sessionId !== ctx.sessionManager.getSessionId() || leaf !== ctx.sessionManager.getLeafId()) {
					throw new Error("Session, branch, or command lifecycle changed; reopen /commands.");
				}
			};
			const inventory = (await inventoryJobs(manager.root)).filter(item => showPruned ? item.job?.pruned : !item.job?.pruned);
			check();
			if (!ctx.hasUI) {
				process.stdout.write(JSON.stringify(inventory.map(item => item.job ? summary(item.job) : { id: item.id, category: item.category, diagnostic: item.diagnostic })) + "\n");
				return;
			}
			if (!inventory.length) { ctx.ui.notify(showPruned ? "No pruned command receipts." : "No unpruned commands. Use /commands pruned to inspect receipts.", "info"); return; }
			const selected = await ctx.ui.select(showPruned ? "Pruned command receipts" : "Background commands", inventory.map((item, index) => `${index + 1}. ${item.id ?? "Unverified record"} ${item.job ? [item.job.state, recovery(item.job)].filter(Boolean).join("; ") : item.category}${item.job?.pruned ? " (output pruned)" : ""}`));
			check();
			if (!selected) return;
			const item = inventory[Number(selected.split(".")[0]) - 1];
			if (!item?.spec) { ctx.ui.notify("Command identity and checkout scope cannot be verified. No cancellation, release, or pruning is permitted. Records and locks are preserved.", "error"); return; }
			const spec = item.spec, dir = join(manager.root, spec.id);
			const action = await ctx.ui.select(`${spec.id}: ${item.job?.state ?? item.category}`, ["Show output",
				...(!terminal(item.job?.state ?? "unknown") ? [...(item.job?.released ? [] : ["Cancel and recheck"]), "Recheck proof"] : []),
				...(item.job && terminal(item.job.state) && !item.job.pruned ? ["Prune finished output"] : [])]);
			check();
			if (action === "Show output") {
				const job = item.job ?? { spec, dir, state: "unknown" as const, outputPath: join(dir, "output.log") };
				const output = await outputTail(job);
				check();
				const metadata = JSON.stringify({ ...summary(job), diagnostic: item.diagnostic }, null, 2);
				if (ctx.mode === "tui") await showCommandOutput(ctx, metadata, output);
				else ctx.ui.notify(`${metadata}\n${output}`, "info");
				check();
			} else if (action === "Prune finished output") {
				const checkPrune = () => {
					check();
					if (spec.sessionId !== sessionId || !ctx.isIdle() || ctx.hasPendingMessages() || pending.has(spec.id) ||
						!ctx.sessionManager.getBranch().some(entry => entry.id === spec.callEntryId)) {
						throw new Error("Pruning requires the idle launching session and branch, with no local pending delivery or active follow-up.");
					}
				};
				checkPrune();
				const answer = await ctx.ui.select(`Delete saved output for ${spec.id}? Another Pi session may still need it. Pi cannot prove that all readers have finished. Deletion cannot be undone. Only output.log is deleted; identity, completion, delivery, and audit records remain.`, ["Keep output", "Delete output despite this risk"]);
				checkPrune();
				if (answer !== "Delete output despite this risk") return;
				await pruneJob(dir, spec, checkPrune);
				ctx.ui.notify("Output has been pruned. The command is hidden from the default list. Use /commands pruned to inspect its retained records.", "info");
			} else if (action === "Cancel and recheck" || action === "Recheck proof") {
				await recoverCommand(manager, spec, ctx, check, action === "Cancel and recheck");
			}
		},
	});
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let scanning: Promise<void> | undefined;
	const warnings = new Set<string>();
	const report = (ctx: ExtensionContext, error: unknown, job?: Job) => {
		if (context !== ctx) return;
		const detail = recoveryDiagnostic(error) ?? (job ? `Command ${job.spec.id}: delivery (unverified_state).` : undefined);
		const key = detail && warnings.size < 3 ? detail : "generic";
		if (warnings.has(key)) return;
		warnings.add(key);
		const message = `${key === "generic" ? "Background command recovery or delivery failed." : detail} Inspect /commands and its private state directory; do not retry unknown jobs.`;
		if (ctx.hasUI) ctx.ui.notify(message, "error"); else process.stderr.write(message + "\n");
	};
	const scan = async () => {
		const ctx = context;
		if (!ctx) return;
		try {
			for (let job of await manager.refresh([await checkoutKey(pi, ctx)])) {
				if (context !== ctx) return;
				if (!terminal(job.state) || job.spec.sessionId !== ctx.sessionManager.getSessionId()) continue;
				try { await withWorktreeLock(join(job.dir, "spec.json"), async () => {
					job = await manager.get(job.spec.id);
					if (job.pruned || !terminal(job.state)) return;
					if (context !== ctx || job.spec.sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
					const delivered = await readPrivate(join(job.dir, "delivered.json"));
					if (delivered !== undefined) {
						const value = delivered as { id?: string; runnerId?: string } | null;
						if (value?.id !== job.spec.id || value.runnerId !== (job.claim?.runnerId ?? null)) throw new Error("Foreign completion delivery record.");
					}
					const recorded = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === completionType &&
						(entry.details as { id?: string; runnerId?: string } | undefined)?.id === job.spec.id &&
						(entry.details as { runnerId?: string | null }).runnerId === (job.claim?.runnerId ?? null));
					if (context !== ctx || job.spec.sessionId !== ctx.sessionManager.getSessionId() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
					if (recorded) {
						if (delivered === undefined) await writePrivate(join(job.dir, "delivered.json"), { id: job.spec.id, runnerId: job.claim?.runnerId ?? null });
						pending.delete(job.spec.id);
						return;
					}
					if (delivered !== undefined) return;
					if (pending.has(job.spec.id) || !ctx.sessionManager.getBranch().some((entry) => entry.id === job.spec.callEntryId)) return;
					// Pi dispatches asynchronously and does not expose its completion or failure here.
					pending.add(job.spec.id);
					pi.sendMessage({ customType: completionType, content: `Background command ${job.spec.id}: ${job.state}. Output: ${job.outputPath}. Inspect the result and continue the existing request when appropriate.`, display: true, details: summary(job) }, { triggerTurn: true, deliverAs: "followUp" });
				}); } catch (error) { report(ctx, error, job); }
			}
		} catch (error) { report(ctx, error); }
	};
	pi.on("session_start", async (_event, ctx) => {
		lifecycle++; context = ctx;
		if (timer) clearInterval(timer);
		timer = setInterval(() => { if (!scanning) scanning = scan().finally(() => { scanning = undefined; }); }, 1000); timer.unref();
		await manager.refresh([await checkoutKey(pi, ctx)]);
	});
	pi.on("session_tree", () => { lifecycle++; });
	pi.on("session_before_switch", () => { lifecycle++; });
	pi.on("session_shutdown", async () => { lifecycle++; context = undefined; if (timer) clearInterval(timer); timer = undefined; await scanning; });
	return manager;
}
