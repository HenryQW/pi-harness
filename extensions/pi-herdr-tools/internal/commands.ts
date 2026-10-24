import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore, extensionConfigDir, field, parsers, registerConfigReporting } from "@henryqw/pi-config-store";
import { checkoutAdmission, checkoutKey, requestHerdr, withWorktreeLock, type CheckoutAdmission } from "@henryqw/pi-herdr";
import { cancelJob, jobId, listJobs, outputTail, privateDirectory, readJob, readPrivate, terminal, writePrivate, type Job, type JobSpec } from "./command-state.ts";

const runner = fileURLToPath(new URL("./command-runner.ts", import.meta.url));
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
export function createCommandConfig(agentDir?: string) {
	return createConfigStore({ extensionId: "pi-herdr-tools", agentDir, fields: {
		runtimeMs: field(parsers.integer({ min: 100, max: 86_400_000 }), 600_000),
		outputBytes: field(parsers.integer({ min: 1024, max: 104_857_600 }), 10_485_760),
		concurrency: field(parsers.integer({ min: 1, max: 16 }), 4),
		retainedJobs: field(parsers.integer({ min: 1, max: 10_000 }), 1000),
	} });
}

export class CommandManager {
	readonly root: string;
	readonly admission: CheckoutAdmission;
	readonly request: typeof requestHerdr;
	constructor(root: string, admission: CheckoutAdmission, request = requestHerdr) {
		this.root = root; this.admission = admission; this.request = request;
		admission.guard("background-commands", async () => { await this.refresh(); });
	}
	async refresh(): Promise<Job[]> {
		const jobs = await listJobs(this.root);
		for (const job of jobs) {
			const owner = `command:${job.spec.id}`;
			if (job.spec.access === "write" && !terminal(job.state)) {
				this.admission.restore(owner, job.spec.checkout);
			} else { this.admission.release(owner); }
		}
		// Removed records are not proof of termination. Keep their restored ownership.
		return jobs;
	}
	async launch(input: { command: string; access: "read" | "write"; callId: string; sessionId: string; sessionFile: string | null; cwd: string; checkout: string }, policy: CommandPolicy, signal?: AbortSignal): Promise<Job> {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (process.env.HERDR_ENV !== "1" || !workspaceId || !socketPath?.startsWith("/")) throw new Error("Background commands require a local Herdr pane and HERDR_SOCKET_PATH.");
		if (signal?.aborted) throw new Error("Command launch aborted before dispatch.");
		await privateDirectory(this.root, true);
		const prepared = await withWorktreeLock(this.root, async () => {
			const jobs = await this.refresh();
			const duplicate = jobs.find((job) => job.spec.sessionId === input.sessionId && job.spec.callId === input.callId);
			if (duplicate) return { job: duplicate, fresh: false };
			if (jobs.length >= policy.retainedJobs) throw new Error("Command record limit reached; archive verified terminal records before launch.");
			if (jobs.filter((job) => !terminal(job.state)).length >= policy.concurrency) throw new Error("Command concurrency limit reached; wait for owned commands to stop.");
			const id = randomUUID();
			const spec: JobSpec = { ...input, runtimeMs: policy.runtimeMs, outputBytes: policy.outputBytes, version: 1, id, token: randomUUID(), workspaceId, socketPath, createdAt: Date.now() };
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
			const response = await this.request("layout.apply", {
				workspace_id: workspaceId, focus: false,
				root: { type: "pane", cwd: input.cwd, command: [process.execPath, runner, job.dir], env: {} },
			}, { signal });
			const layout = response.layout as { workspace_id?: unknown; tab_id?: unknown; root?: { type?: unknown; pane_id?: unknown } } | undefined;
			if (response.type !== "layout_apply" || layout?.workspace_id !== workspaceId || typeof layout.tab_id !== "string" || layout.root?.type !== "pane" || typeof layout.root.pane_id !== "string") throw new Error("Herdr did not return the exact command terminal identity.");
			await writePrivate(join(job.dir, "dispatch.json"), { id: job.spec.id, token: job.spec.token, workspaceId, tabId: layout.tab_id, paneId: layout.root.pane_id });
		} catch {
			await writePrivate(join(job.dir, "uncertain.json"), { id: job.spec.id, token: job.spec.token });
		}
		await this.refresh();
		return await readJob(job.dir);
	}
	async get(id: string): Promise<Job> { return await readJob(join(this.root, jobId(id))); }
	async guardRemoval(checkout: string): Promise<() => void> {
		const key = await realpath(checkout);
		await privateDirectory(this.root, true);
		return await withWorktreeLock(this.root, async () => {
			const jobs = await this.refresh();
			if (jobs.some((job) => job.spec.checkout === key && !terminal(job.state))) throw new Error("Active or unknown background commands block worktree removal, including forced completion. Inspect /commands.");
			return await this.admission.reserve(`done:${randomUUID()}`, key);
		});
	}
}

function summary(job: Job) {
	return { id: job.spec.id, state: job.state, access: job.spec.access, checkout: job.spec.checkout,
		sessionId: job.spec.sessionId, runnerId: job.claim?.runnerId ?? null, workspaceId: job.spec.workspaceId,
		tabId: job.claim?.tabId ?? null, paneId: job.claim?.paneId ?? null, outputPath: job.outputPath,
		exitCode: job.result?.exitCode ?? null, signal: job.result?.signal ?? null, failure: job.result?.failure ?? null };
}
const summarySchema = Type.Object({
	id: Type.String(), state: Type.String(), access: Type.String(), checkout: Type.String(), sessionId: Type.String(),
	runnerId: Type.Union([Type.String(), Type.Null()]), workspaceId: Type.String(), tabId: Type.Union([Type.String(), Type.Null()]),
	paneId: Type.Union([Type.String(), Type.Null()]), outputPath: Type.String(), exitCode: Type.Union([Type.Number(), Type.Null()]), failure: Type.Union([Type.String(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
});

export function registerCommands(pi: ExtensionAPI): CommandManager {
	const admission = checkoutAdmission(pi);
	admission.install(pi);
	const manager = new CommandManager(join(extensionConfigDir("pi-herdr-tools"), "commands"), admission);
	const store = createCommandConfig();
	const reporter = registerConfigReporting(pi, [store]);
	pi.registerTool({
		name: "background_command", label: "Background command", parameters: commandParameters,
		description: "Launch an already authorized, bounded noninteractive local shell command in its own Herdr terminal; list, inspect output, or cancel it. Declare write access if it can change files, Git state, or external resources. Read access is not enforced; no sandbox. Do not detach processes or use remote or interactive jobs. Unknown launch or ownership is not permission to retry. Status and cancel remain available while checkout writes are blocked.",
		outputSchema: Type.Object({ jobs: Type.Array(summarySchema), totalJobs: Type.Number(), output: Type.Optional(Type.String()) }),
		async execute(callId, input, signal, _update, ctx) {
			validateRequest(input);
			let jobs: Job[];
			let output: string | undefined;
			if (input.action === "launch") {
				const loaded = store.loadSync(); reporter.report(ctx, store, loaded);
				if (loaded.status !== "ok") throw new Error("Background command config is disabled; repair it before launch.");
				jobs = [await manager.launch({ command: input.command!, access: input.access as "read" | "write", callId,
					sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null,
					cwd: await realpath(ctx.cwd), checkout: await checkoutKey(pi, ctx) }, loaded.value, signal)];
			} else if (input.action === "list") jobs = await manager.refresh();
			else {
				let job = await manager.get(input.id!);
				if (input.action === "cancel") { await cancelJob(job); job = await manager.get(input.id!); }
				jobs = [job]; output = await outputTail(job);
			}
			const structuredContent = { jobs: jobs.sort((a, b) => Number(terminal(a.state)) - Number(terminal(b.state)) || b.spec.createdAt - a.spec.createdAt).slice(0, 20).map(summary), totalJobs: jobs.length, ...(output === undefined ? {} : { output }) };
			const isError = jobs.some((job) => ["failed", "cancelled", "timeout", "output_limit", "unknown"].includes(job.state));
			return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], details: undefined, structuredContent, isError };
		},
	});
	pi.registerCommand("commands", {
		description: "Inspect or cancel managed background commands",
		async handler(args, ctx) {
			if (args.trim()) throw new Error("Usage: /commands");
			const jobs = await manager.refresh();
			if (!ctx.hasUI) { process.stdout.write(JSON.stringify(jobs.map(summary)) + "\n"); return; }
			const selected = await ctx.ui.select("Background commands", jobs.map((job) => `${job.spec.id} ${job.state}`));
			if (!selected) return;
			const job = await manager.get(selected.split(" ")[0]!);
			const action = await ctx.ui.select(`${job.spec.id}: ${job.state}`, ["Show output", ...(!terminal(job.state) ? ["Cancel"] : [])]);
			if (action === "Cancel") { await cancelJob(job); ctx.ui.notify("Cancellation requested. Ownership stays held until the runner proves completion.", "info"); }
			else if (action === "Show output") ctx.ui.notify(`${JSON.stringify(summary(job))}\n${await outputTail(job)}`, "info");
		},
	});
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let scanning = false;
	let warned = false;
	const scan = async () => {
		const ctx = context;
		if (!ctx || scanning) return;
		scanning = true;
		try {
			for (const job of await manager.refresh()) {
				if (!terminal(job.state) || job.spec.sessionId !== ctx.sessionManager.getSessionId()) continue;
				await withWorktreeLock(join(job.dir, "spec.json"), async () => {
					if (context !== ctx || !ctx.isIdle()) return;
					const delivered = await readPrivate(join(job.dir, "delivered.json"));
					if (delivered !== undefined) {
						const value = delivered as { id?: string; runnerId?: string } | null;
						if (value?.id !== job.spec.id || value.runnerId !== job.claim?.runnerId) throw new Error("Foreign completion delivery record.");
						return;
					}
					const recorded = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === completionType &&
						(entry.details as { id?: string; runnerId?: string } | undefined)?.id === job.spec.id &&
						(entry.details as { runnerId?: string }).runnerId === job.claim?.runnerId);
					if (context !== ctx || !ctx.isIdle()) return;
					if (!recorded) pi.sendMessage({ customType: completionType, content: `Background command ${job.spec.id}: ${job.state}. Output: ${job.outputPath}`, display: true, details: summary(job) }, { triggerTurn: false });
					await writePrivate(join(job.dir, "delivered.json"), { id: job.spec.id, runnerId: job.claim!.runnerId });
				});
			}
		} catch {
			if (!warned && context === ctx) {
				warned = true;
				const message = "Background command recovery or delivery failed. Inspect /commands and its private state directory; do not retry unknown jobs.";
				if (ctx.hasUI) ctx.ui.notify(message, "error"); else process.stderr.write(message + "\n");
			}
		}
		finally { scanning = false; }
	};
	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		await manager.refresh();
		if (timer) clearInterval(timer);
		timer = setInterval(() => { void scan(); }, 1000); timer.unref();
	});
	pi.on("session_shutdown", () => { context = undefined; if (timer) clearInterval(timer); timer = undefined; });
	return manager;
}
