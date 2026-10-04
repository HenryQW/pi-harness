import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import test from "node:test";
import { Compile } from "typebox/compile";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_SUBAGENT_PROCESS_LEASE, ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";
import { registerCheckoutAdmission, roleCanWrite, roleIsReadOnlyScout } from "../extensions/admission.ts";
import roleTools from "../extensions/role-tools.ts";
import subagentExtension from "../extensions/subagent.ts";

type Tool = {
	name: string;
	description: string;
	parameters: unknown;
	exposure?: string;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => any;
	renderShell?: "default" | "self";
	renderCall?: (...args: any[]) => { render: (width: number) => string[] };
	renderResult?: (...args: any[]) => { render: (width: number) => string[] };
	execute: (...args: any[]) => Promise<any>;
};

type ToolCallHandler = (event: any) => unknown;

test("checkout admission treats unknown tools, extensions and MCP servers as potential writers", () => {
	const role = {
		name: "reader", description: "Read sources", systemPrompt: "Read only.",
		tools: ["read", "grep"], extensions: ["npm:@example/reader"], skills: [], mcps: ["docs"],
	};
	assert.equal(roleCanWrite(role), true);
	assert.equal(roleCanWrite({ ...role, extensions: [], mcps: [] }), false);
	assert.equal(roleCanWrite({ ...role, tools: ["read", "bash"] }), true);
	// Codemode itself adds no capability, but its trusted extension is not sandboxed.
	assert.equal(roleCanWrite({ ...role, tools: ["read", "codemode"], extensions: ["builtin:codemode"] }), true);
	assert.equal(roleCanWrite({ ...role, tools: ["codemode", "edit"], extensions: ["builtin:codemode"] }), true);
	assert.equal(roleIsReadOnlyScout({ ...role, tools: ["read", "codemode"], extensions: ["builtin:codemode"], mcps: [] }), false);
	assert.equal(roleIsReadOnlyScout({ ...role, extensions: [], mcps: [] }), true);
	assert.equal(roleIsReadOnlyScout({ ...role, extensions: [], mcps: ["docs"] }), false);
	assert.equal(roleIsReadOnlyScout({ ...role, mcps: [] }), false);
	assert.equal(roleIsReadOnlyScout({ ...role, extensions: [], mcps: [], tools: ["bash"] }), false);
});

test("checkout admission attributes nested calls to their model-issued root and keeps independent writers out", async (t) => {
	const checkout = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-admission-")));
	t.after(() => rm(checkout, { recursive: true, force: true }));
	const handlers = new Map<string, (...args: any[]) => any>();
	let lookup = async () => {};
	const hold = registerCheckoutAdmission({
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		exec: async () => {
			await lookup();
			return { stdout: `${checkout}\n`, stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI, () => true);
	const ctx = { cwd: checkout } as ExtensionContext;
	const call = (toolCallId: string, toolName: string, parentToolCallId?: string) =>
		handlers.get("tool_call")!({ type: "tool_call", toolCallId, toolName, input: {}, ...(parentToolCallId === undefined ? {} : { parentToolCallId }) }, ctx);
	const blockedBy = (owner: string) => ({ block: true, reason: `Checkout ${checkout} already has an admitted Pi writer (${owner}); retry after it settles.` });
	// A script that only reads holds nothing, so an independent writer is admitted beside it.
	assert.equal(await call("script-1", "codemode"), undefined);
	assert.equal(await call("script-1/1", "grep", "script-1"), undefined);
	assert.equal(await call("edit-1", "edit"), undefined);
	assert.deepEqual(await call("script-1/2", "bash", "script-1"), blockedBy("edit-1"));
	handlers.get("tool_result")!({ type: "tool_result", toolCallId: "edit-1", toolName: "edit" });
	// The first nested write makes the script's root the writer; deeper and later nested calls pass.
	assert.equal(await call("script-1/3", "bash", "script-1"), undefined);
	assert.equal(await call("script-1/3/1", "write", "script-1/3"), undefined);
	assert.equal(await call("script-1/4", "edit", "script-1"), undefined);
	assert.equal(await call("script-1/5", "read", "script-1"), undefined);
	// Independent roots, including another script's nested writes, wait; their reads do not.
	assert.deepEqual(await call("edit-2", "edit"), blockedBy("script-1"));
	assert.deepEqual(await call("delegate-1", "delegate_task"), blockedBy("script-1"));
	assert.equal(await call("script-2", "codemode"), undefined);
	assert.deepEqual(await call("script-2/1", "bash", "script-2"), blockedBy("script-1"));
	assert.equal(await call("script-2/2", "read", "script-2"), undefined);
	// Root completion must not release still-running writes, including deeper descendants.
	handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "script-1/3", toolName: "bash", parentToolCallId: "script-1", isError: true });
	assert.deepEqual(await call("edit-3", "edit"), blockedBy("script-1"));
	handlers.get("tool_result")!({ toolCallId: "script-1" });
	handlers.get("tool_execution_end")!({ toolCallId: "script-1" });
	assert.deepEqual(await call("edit-3", "edit"), blockedBy("script-1"));
	// Duplicate completion hooks must not consume another descendant's admission.
	handlers.get("tool_result")!({ toolCallId: "script-1/3" });
	handlers.get("tool_result")!({ toolCallId: "script-1/4" });
	handlers.get("tool_execution_end")!({ toolCallId: "script-1/4" });
	assert.deepEqual(await call("edit-3", "edit"), blockedBy("script-1"));
	handlers.get("tool_execution_end")!({ toolCallId: "script-1/3/1" });
	assert.equal(await call("edit-3", "edit"), undefined);
	assert.deepEqual(await call("script-2/3", "bash", "script-2"), blockedBy("edit-3"));
	handlers.get("tool_result")!({ toolCallId: "edit-3" });
	// A script can finish before an unawaited nested write completes its admission lookup.
	let entered!: () => void;
	let resume!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const paused = new Promise<void>((resolve) => { resume = resolve; });
	lookup = async () => { entered(); await paused; };
	await call("script-3", "codemode");
	const lateWrite = call("script-3/1", "write", "script-3");
	await started;
	handlers.get("tool_result")!({ toolCallId: "script-3" });
	resume();
	assert.deepEqual(await lateWrite, {
		block: true,
		reason: "Parent call script-3 already settled; script-3/1 is not admitted.",
	});
	handlers.get("tool_execution_end")!({ toolCallId: "script-3/1", parentToolCallId: "script-3" });
	lookup = async () => {};
	assert.equal(await call("edit-4", "edit"), undefined);
	handlers.get("tool_result")!({ toolCallId: "edit-4" });
	assert.throws(() => hold("unadmitted"), /not admitted as a checkout writer/);
	assert.equal(await call("direct-writer", "delegate_task"), undefined);
	const releaseDirect = hold("direct-writer");
	handlers.get("tool_result")!({ toolCallId: "direct-writer" });
	handlers.get("tool_execution_end")!({ toolCallId: "direct-writer" });
	assert.deepEqual(await call("edit-5", "edit"), blockedBy("direct-writer"));
	releaseDirect();
	assert.equal(await call("edit-5", "edit"), undefined);
});

function loadRoleTools(processLease: string | undefined): { events: string[]; toolCall?: ToolCallHandler; childUmask: number } {
	const previousLease = process.env[PI_SUBAGENT_PROCESS_LEASE];
	const previousUmask = process.umask();
	if (processLease === undefined) delete process.env[PI_SUBAGENT_PROCESS_LEASE];
	else process.env[PI_SUBAGENT_PROCESS_LEASE] = processLease;
	const events: string[] = [];
	let toolCall: ToolCallHandler | undefined;
	try {
		roleTools({
			registerFlag() {},
			getFlag() {},
			on(event: string, handler: (...args: any[]) => unknown) {
				events.push(event);
				if (event === "tool_call") toolCall = handler;
			},
		} as unknown as ExtensionAPI);
		return { events, toolCall, childUmask: process.umask() };
	} finally {
		process.umask(previousUmask);
		if (previousLease === undefined) delete process.env[PI_SUBAGENT_PROCESS_LEASE];
		else process.env[PI_SUBAGENT_PROCESS_LEASE] = previousLease;
	}
}

test("process lease survives caller fd 9 reuse in descendants", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-lease-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const lease = join(dir, "lease");
	const callerLock = join(dir, "caller.lock");
	const probe = join(dir, "probe.mjs");
	await writeFile(lease, "");
	await chmod(lease, 0o600);
	await writeFile(probe, `import { fstatSync, readdirSync, statSync } from "node:fs";
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const lease = statSync(process.env.${PI_SUBAGENT_PROCESS_LEASE});
const callerLock = statSync(process.env.PI_SUBAGENT_CALLER_LOCK);
if (!sameFile(fstatSync(9), callerLock)) throw new Error("caller fd 9 was not preserved");
for (const entry of readdirSync("/dev/fd")) {
	const fd = Number(entry);
	if (!Number.isInteger(fd) || fd < 10) continue;
	try {
		if (sameFile(fstatSync(fd), lease)) process.exit(0);
	} catch (error) {
		if (error.code !== "EBADF") throw error;
	}
}
throw new Error("process lease descriptor was not inherited");
`);
	const parentUmask = process.umask(0o022);
	let extension: ReturnType<typeof loadRoleTools>;
	try {
		extension = loadRoleTools(lease);
		assert.equal(extension.childUmask, 0o022, "worker tools must preserve ordinary file creation permissions");
	} finally { process.umask(parentUmask); }
	assert.equal(extension.events.filter((event) => event === "tool_call").length, 1);
	assert.ok(extension.toolCall);
	const bash = {
		type: "tool_call",
		toolCallId: "bash",
		toolName: "bash",
		input: { command: 'exec 9>"$PI_SUBAGENT_CALLER_LOCK"\n"$PI_SUBAGENT_NODE" "$PI_SUBAGENT_LEASE_PROBE"' },
	};
	extension.toolCall(bash);
	execFileSync("/bin/bash", ["-c", bash.input.command], {
		env: {
			...process.env,
			[PI_SUBAGENT_PROCESS_LEASE]: lease,
			PI_SUBAGENT_CALLER_LOCK: callerLock,
			PI_SUBAGENT_LEASE_PROBE: probe,
			PI_SUBAGENT_NODE: process.execPath,
		},
	});
	const read = { type: "tool_call", toolCallId: "read", toolName: "read", input: { path: "file.txt" } };
	extension.toolCall(read);
	assert.deepEqual(read.input, { path: "file.txt" });
});

test("process lease absence leaves ordinary role-tools calls unchanged", () => {
	const extension = loadRoleTools(undefined);
	assert.equal(extension.events.includes("tool_call"), false);
});

test("process lease rejects invalid paths, file types, owners, and modes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-lease-invalid-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const regular = join(dir, "regular");
	await writeFile(regular, "");
	await chmod(regular, 0o600);
	const badMode = join(dir, "bad-mode");
	await writeFile(badMode, "");
	await chmod(badMode, 0o640);
	const link = join(dir, "link");
	await symlink(regular, link);
	for (const path of ["", "relative", `${dir}/newline\npath`, `${dir}/nul\0path`, join(dir, "missing"), dir, link, badMode]) {
		assert.throws(() => loadRoleTools(path), /PI_SUBAGENT_PROCESS_LEASE/);
	}
	const getuid = process.getuid;
	if (!getuid) return;
	const currentUid = getuid();
	process.getuid = () => currentUid === 0 ? 1 : 0;
	try {
		assert.throws(() => loadRoleTools(regular), /PI_SUBAGENT_PROCESS_LEASE/);
	} finally {
		process.getuid = getuid;
	}
});

async function environment(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousActivePi = process.env.PI_CODING_AGENT;
	const previousScript = process.argv[1];
	const previousTitle = process.title;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT = "true";
	process.title = "pi";
	try {
		await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
		await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				fast: { primary: { model: "test/text-model", thinkingLevel: "low" } },
				balanced: { primary: { model: "test/text-model", thinkingLevel: "low" } },
			},
		}));
		const defaultRunner = join(agentDir, "fake-pi-default.mjs");
		await writeFile(defaultRunner, "");
		process.argv[1] = defaultRunner;
		await run(agentDir);
	} finally {
		process.argv[1] = previousScript;
		process.title = previousTitle;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousActivePi === undefined) delete process.env.PI_CODING_AGENT;
		else process.env.PI_CODING_AGENT = previousActivePi;
		await rm(agentDir, { recursive: true, force: true });
	}
}

const model = {
	provider: "test",
	id: "text-model",
	name: "Text Model",
	api: "openai-responses",
	baseUrl: "https://example.test",
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 10_000,
	reasoning: true,
	thinkingLevelMap: { off: "none", low: "low", high: "high" },
} as const;

function harness(options: {
	ui?: boolean;
	skills?: Array<{ name: string; path: string }>;
	trusted?: boolean;
	availableModels?: any[];
	currentModel?: any;
	scopedModels?: any[];
	cwd?: string;
	sendMessageError?: Error;
	herdr?: (args: string[], options?: { signal?: AbortSignal; timeout?: number }) => Promise<any>;
} = {}) {
	let tool: Tool | undefined;
	const tools = new Map<string, Tool>();
	let widget: { render: (width: number) => string[] } | undefined;
	let messageRenderer: ((...args: any[]) => { render: (width: number) => string[] }) | undefined;
	let renders = 0;
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	let sessionEntries: any[] = [];
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const tui = { requestRender: () => { renders++; } };
	const theme = { fg: (_color: string, value: string) => value };
	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(event);
			handlers.set(event, (...args) => {
				const result = previous?.(...args);
				return result instanceof Promise ? result.then(() => handler(...args)) : handler(...args);
			});
		},
		exec(command: string, args: string[], execOptions?: { cwd?: string; signal?: AbortSignal; timeout?: number }) {
			if (command === "herdr" && options.herdr) return options.herdr(args, execOptions);
			return new Promise((resolve) => {
				execFile(command, args, execOptions, (error, stdout, stderr) => resolve({
					stdout: String(stdout),
					stderr: String(stderr),
					code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
					killed: Boolean(error && "killed" in error && error.killed),
				}));
			});
		},
		registerTool(candidate: Tool) {
			if (candidate.name !== "delegate_task") {
				tools.set(candidate.name, candidate);
				return;
			}
			const directInput = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) && !("mode" in value)
				? { mode: "direct", ...value }
				: value;
			const wrapped: Tool = {
				...candidate,
				prepareArguments: candidate.prepareArguments
					? (value) => candidate.prepareArguments!(directInput(value))
					: undefined,
				execute: (toolCallId, params, ...rest) => candidate.execute(toolCallId, directInput(params), ...rest),
			};
			tools.set(candidate.name, wrapped);
			tool = wrapped;
		},
		registerMessageRenderer(customType: string, renderer: typeof messageRenderer) {
			if (customType === "subagent-direct-result") messageRenderer = renderer;
		},
		appendEntry(customType: string, data: unknown) { sessionEntries.push({ type: "custom", customType, data }); },
		sendMessage(message: any, deliveryOptions: any) {
			if (options.sendMessageError) throw options.sendMessageError;
			sentMessages.push({ message, options: deliveryOptions });
		},
		registerCommand(name: string, candidate: { handler: (...args: any[]) => any }) { commands.set(name, candidate); },
		getCommands() {
			return (options.skills ?? []).map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.name,
				source: "skill" as const,
				sourceInfo: { path: skill.path, source: "test", scope: "user" as const, origin: "top-level" as const },
			}));
		},
	} as unknown as ExtensionAPI;
	subagentExtension(api);
	const ctx = {
		cwd: options.cwd ?? "/tmp",
		model: options.currentModel ?? model,
		thinkingLevel: "low",
		hasUI: options.ui ?? false,
		isProjectTrusted: () => options.trusted ?? true,
		modelRegistry: { getAvailable: () => options.availableModels ?? [model] },
		scopedModels: options.scopedModels ?? [],
		sessionManager: { getBranch: () => sessionEntries, getEntries: () => sessionEntries, getSessionId: () => "test-session", getSessionFile: () => "test.jsonl" },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			setWidget: (_key: string, content: any) => {
				widget = typeof content === "function" ? content(tui, theme) : undefined;
			},
		},
	} as unknown as ExtensionContext;
	return {
		get tool() { return tool!; },
		tools,
		get widget() { return widget; },
		get renders() { return renders; },
		renderMessage(message: any, expanded = false) {
			assert.ok(messageRenderer, "direct result renderer was not registered");
			return messageRenderer(message, { expanded, outputPad: 0 }, theme).render(120).join("\n");
		},
		notifications,
		sentMessages,
		get sessionEntries() { return sessionEntries; },
		switchBranch() { sessionEntries = []; },
		ctx,
		handlers,
		commands,
	};
}

test("registered tools have object roots and preserve closed union validation", async () => {
	await environment(async () => {
		const app = harness();
		for (const tool of app.tools.values()) {
			const schema = tool.parameters as { type?: string; properties?: unknown; anyOf?: unknown; oneOf?: unknown };
			assert.equal(schema.type, "object", tool.name);
			assert.ok(schema.properties, tool.name);
			assert.equal(schema.anyOf, undefined, tool.name);
			assert.equal(schema.oneOf, undefined, tool.name);
		}
		const tip = { branch: "refs/heads/main", head: "a".repeat(40), index: "a".repeat(40), tree: "a".repeat(40) };
		const inputs = [
			["delegate_task", { mode: "direct", role: "worker", name: "Inspect", task: "Inspect the patch." }, "mode"],
			["subagent_resume", { id: "request-one", action: "retry", taskId: "task-one" }, "action"],
			["subagent_integrate", { id: "request-one", action: "validate", generation: 1, expectedTip: tip }, "action"],
		] as const;
		for (const [name, input, discriminant] of inputs) {
			const validator = Compile(JSON.parse(JSON.stringify(app.tools.get(name)!.parameters)));
			assert.ok(validator.Check(input), name);
			assert.equal(validator.Check({ ...input, extra: true }), false, name);
			assert.equal(validator.Check({ ...input, [discriminant]: "unknown" }), false, name);
			const missingDiscriminant: Record<string, unknown> = { ...input };
			delete missingDiscriminant[discriminant];
			assert.equal(validator.Check(missingDiscriminant), false, name);
		}
		const isolated = { mode: "isolated", id: "request-one", goal: "Inspect the change", tasks: [{
			id: "task-one", kind: "text", role: "scout", modelClass: "fast", requirements: "Inspect",
			deliverable: "Report", dependsOn: [], contextFrom: [],
		}] };
		assert.ok(Compile(JSON.parse(JSON.stringify(app.tools.get("delegate_task")!.parameters))).Check(isolated));
		assert.equal(app.tools.get("delegate_task")!.exposure, "model-only");
		assert.throws(() => app.tools.get("subagent_resume")!.prepareArguments!({ id: "request-one", action: "retry" }), /one strict action/);
		assert.throws(() => app.tools.get("subagent_integrate")!.prepareArguments!({ id: "request-one", action: "refresh", generation: 1, expectedTip: tip }), /exact generation and tip/);
		assert.throws(() => app.tools.get("delegate_task")!.prepareArguments!({ mode: "isolated", id: "request-one" }), /strict task schema/);
	});
});

async function recoverDirect(app: ReturnType<typeof harness>): Promise<void> {
	let shown = false;
	app.ctx.hasUI = true;
	app.ctx.ui.select = async (_title: string, choices: string[]) => {
		if (shown) return undefined;
		shown = true;
		return choices.find((choice) => choice.startsWith("Direct ·"));
	};
	await app.commands.get("subagent")!.handler("", app.ctx);
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function writeWorkerRole(agentDir: string): Promise<void> {
	await mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---
name: worker
description: Does bounded work
tools: [read]
extensions: []
skills: []
---
Do bounded work.
`);
}

function fakeHerdr(cwd: string, answer: (prompt: string) => string | undefined | Promise<string | undefined> = (prompt) => prompt.includes("Potential-writer completion:") ? JSON.stringify({ outcome: "succeeded", answer: "exact answer" }) : "exact answer", waitGate?: Promise<void>, promptStatus = "working", waitTimeout = false) {
	const calls: string[][] = [];
	const sessions = new Map<string, { path: string; prompt?: string; pane: string; tab: string }>();
	let next = 1;
	const response = (result: any) => ({ code: 0, stdout: JSON.stringify({ id: "mock", result }), stderr: "" });
	const agent = (name: string, status: string) => {
		const identity = sessions.get(name)!;
		return { name, agent: "pi", agent_status: status, cwd, interactive_ready: true,
			pane_id: identity.pane, tab_id: identity.tab, workspace_id: "w-test" };
	};
	const persist = async (name: string) => {
		const identity = sessions.get(name)!;
		const text = await answer(identity.prompt!);
		if (text === undefined) return; // Native Pi owns this session in launch integration tests.
		await writeFile(identity.path, [
			{ type: "session", id: "session" },
			{ type: "message", id: "user", parentId: "session", message: { role: "user", content: [{ type: "text", text: identity.prompt }] } },
			{ type: "message", id: "final", parentId: "user", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1_200, output: 40, cacheRead: 300, cacheWrite: 0 } } },
		].map((line) => JSON.stringify(line)).join("\n") + "\n");
	};
	return {
		calls,
		async exec(args: string[]) {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return response({ type: "pane_current", pane: { pane_id: "w-test:p1", workspace_id: "w-test" } });
			if (args[0] === "tab" && args[1] === "create") {
				const tab = `w-test:t${++next}`;
				return response({ type: "tab_created", tab: { tab_id: tab, workspace_id: "w-test", focused: false },
					root_pane: { pane_id: `w-test:p${next}`, tab_id: tab, workspace_id: "w-test", cwd, focused: false } });
			}
			if (args[0] === "agent" && args[1] === "start") {
				if (args.some((arg) => /[\r\n]/.test(arg))) return { code: 1, stdout: JSON.stringify({ error: { code: "invalid_agent_argument" } }), stderr: "Herdr cannot encode multiline arguments" };
				const name = args[2]!;
				const pane = args[args.indexOf("--pane") + 1]!;
				const path = args[args.indexOf("--session") + 1]!;
				sessions.set(name, { path, pane, tab: `w-test:t${next}` });
				return response({ type: "agent_started", agent: agent(name, "idle") });
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				sessions.get(args[2]!)!.prompt = args[3]!;
				if (promptStatus === "done" || promptStatus === "idle") await persist(args[2]!);
				return response({ type: "agent_prompted", agent: agent(args[2]!, promptStatus) });
			}
			if (args[0] === "agent" && args[1] === "wait") {
				if (waitTimeout) return { code: 1, stdout: JSON.stringify({ error: { code: "timeout" } }), stderr: "" };
				await waitGate;
				await persist(args[2]!);
				return response({ type: "agent_info", agent: agent(args[2]!, "done") });
			}
			if (args[0] === "agent" && args[1] === "send-keys") return response({ type: "ok" });
			throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
		},
	};
}

async function herdrEnvironment(run: (cwd: string) => Promise<void>) {
	const previous = [process.env.HERDR_ENV, process.env.HERDR_WORKSPACE_ID, process.env.HERDR_PANE_ID];
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w-test";
	process.env.HERDR_PANE_ID = "w-test:p1";
	try { await run(await realpath("/tmp")); }
	finally {
		for (const [index, key] of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID"].entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
	}
}

test("direct returns verified nonfocused tab and sends exact result once as follow-up", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd, () => "exact answer");
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			const result = await app.tool.execute("call", { role: "worker", name: "Check", task: "inspect" }, undefined, undefined, app.ctx);
			assert.match(result.content[0].text, /Herdr tab: w-test:t2/);
			await waitFor(() => app.sentMessages.length === 1);
			const message = app.sentMessages[0]!.message;
			assert.ok(message.content.startsWith("Delegation completed · 1 completed\n✓ [1/1] Check · worker — exact answer\nResults:\n- [1/1] Check · worker · result:\nexact answer\nRecovery (also available via /subagent):\n"));
			assert.match(message.content, /tab w-test:t2 · pane w-test:p2/);
			assert.deepEqual(message.details.entries.map(({ id, index, name, role, status, summary }: any) => ({ id, index, name, role, status, summary })), [
				{ id: "call:single:0", index: 0, name: "Check", role: "worker", status: "succeeded", summary: "exact answer" },
			]);
			assert.deepEqual(app.sentMessages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
			assert.equal(fake.calls.filter(([kind, command]) => kind === "agent" && command === "prompt").length, 1);
			const startArgs = fake.calls.find(([kind, command]) => kind === "agent" && command === "start")!;
			assert.ok(startArgs.includes("--append-system-prompt"));
			assert.ok(startArgs.every((arg) => !/[\r\n]/.test(arg)), "Herdr launch arguments must be shell-safe");
			await assert.rejects(stat(startArgs[startArgs.indexOf("--append-system-prompt") + 1]!), { code: "ENOENT" });
			assert.ok(fake.calls.some((args) => args.includes("--no-focus") && args.includes(cwd)));
		});
	});
});

test("authorized direct write and commit use native Pi tools/session and preserve unrelated changes", { timeout: 30_000 }, async (t) => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---\nname: worker\ndescription: Git operator\ntools: [bash]\nextensions: []\nskills: []\n---\nExecute only the authorized command; preserve unrelated work.\n`);
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-direct-write-")));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		git("init", "-q");
		git("config", "user.name", "Direct test");
		git("config", "user.email", "direct@example.test");
		for (const path of ["owned.txt", "staged.txt", "unstaged.txt"]) await writeFile(join(cwd, path), "base\n");
		git("add", "."); git("commit", "-qm", "base");
		await writeFile(join(cwd, "staged.txt"), "unrelated staged\n"); git("add", "staged.txt");
		await writeFile(join(cwd, "unstaged.txt"), "unrelated unstaged\n");
		await writeFile(join(cwd, "untracked.txt"), "unrelated untracked\n");
		const before = git("diff", "--cached");
		const command = "printf 'authorized write\\n' > owned.txt && git add -- owned.txt && git -c commit.gpgsign=false commit --only -m 'authorized direct commit' -- owned.txt";
		const requests: any[] = [];
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			const input = JSON.parse(body); requests.push(input);
			const used = input.messages.some((message: any) => message.role === "tool");
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: used ? { content: JSON.stringify({ outcome: "succeeded", answer: "Commit completed; unrelated changes preserved." }) } : { tool_calls: [{ index: 0, id: "authorized", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: used ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const address = server.address() as { port: number };
		const nativeModel = { ...model, api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1` };
		await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { api: nativeModel.api, baseUrl: nativeModel.baseUrl, apiKey: "test", models: [{ id: model.id }] } } }));
		await herdrEnvironment(async () => {
			let systemPrompt = "";
			const fake = fakeHerdr(cwd, async (prompt) => {
				const start = fake.calls.find(([kind, action]) => kind === "agent" && action === "start")!;
				const args = start.slice(start.indexOf("--") + 1);
				args[args.indexOf("--append-system-prompt") + 1] = systemPrompt;
				const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
				try {
					const child = promisify(execFile)(process.execPath, [cli, ...args, "--print", "--offline", "--no-context-files", prompt], { cwd, timeout: 20_000, maxBuffer: 64 * 1024 });
					child.child.stdin!.end();
					await child;
				} catch (error) {
					const child = error as Error & { stdout: string; stderr: string };
					throw new Error(`Native Pi failed (${requests.length} requests): ${child.stderr.slice(-2000)} ${child.stdout.slice(-2000)}`);
				}
				return undefined;
			});
			const app = harness({ cwd, herdr: async (args) => {
				if (args[0] === "agent" && args[1] === "start") systemPrompt = await readFile(args[args.indexOf("--append-system-prompt") + 1]!, "utf8");
				return fake.exec(args);
			}, availableModels: [nativeModel], currentModel: nativeModel });
			await app.handlers.get("session_start")!({}, app.ctx);
			const params = { mode: "direct", role: "worker", modelClass: "fast", name: "Scoped commit", task: `Authorized: execute ${command}. Do not change any other files or index entries. Do not push.` };
			await app.handlers.get("tool_call")!({ toolCallId: "commit", toolName: "delegate_task", input: params }, app.ctx);
			await app.tool.execute("commit", params, undefined, undefined, app.ctx);
			app.handlers.get("tool_result")!({ toolCallId: "commit" });
			assert.equal((await app.handlers.get("tool_call")!({ toolCallId: "other", toolName: "edit", input: {} }, app.ctx)).block, true);
			await waitFor(() => app.sentMessages.length === 1, 25_000);
			assert.equal(app.sentMessages[0]!.message.details.outcome, "completed", app.sentMessages[0]!.message.content);
			assert.equal(await app.handlers.get("tool_call")!({ toolCallId: "other", toolName: "edit", input: {} }, app.ctx), undefined);
			const record = app.sessionEntries[0].data;
			t.after(() => rm(dirname(record.sessionFile), { recursive: true, force: true }));
			assert.match(await readFile(record.sessionFile, "utf8"), /"role":"toolResult"/);
		});
		assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name), ["bash"]);
		assert.ok(JSON.stringify(requests[0].messages).includes("Direct shared-checkout boundary"));
		assert.equal(git("log", "-1", "--format=%s"), "authorized direct commit");
		assert.equal(git("diff", "--cached"), before);
		assert.equal(await readFile(join(cwd, "unstaged.txt"), "utf8"), "unrelated unstaged\n");
		assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "unrelated untracked\n");
		assert.equal(git("show", "HEAD:owned.txt"), "authorized write");
	});
});

test("potential-writer parallel tasks serialize and uncertain completion retains checkout admission", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "writer.md"), `---\nname: writer\ndescription: Writes\ntools: [bash]\nextensions: []\nskills: []\n---\nWrite only authorized files.\n`);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, (prompt) => prompt.startsWith("first") ? JSON.stringify({ outcome: "succeeded", answer: "done" }) : "", gate);
			const app = harness({ cwd, herdr: fake.exec });
			await app.handlers.get("session_start")!({}, app.ctx);
			const params = { mode: "direct", tasks: [
				{ role: "writer", name: "First", task: "first" },
				{ role: "worker", name: "Second", task: "second" },
				{ role: "writer", name: "Third", task: "third" },
			] };
			await app.handlers.get("tool_call")!({ toolCallId: "writers", toolName: "delegate_task", input: params }, app.ctx);
			await app.tool.execute("writers", params, undefined, undefined, app.ctx);
			app.handlers.get("tool_result")!({ toolCallId: "writers" });
			await waitFor(() => fake.calls.some(([kind, action]) => kind === "agent" && action === "wait"));
			assert.equal(app.sessionEntries.length, 1, "second tab cannot launch before first finishes");
			release();
			await waitFor(() => app.sentMessages.length === 1);
			assert.deepEqual(app.sentMessages[0]!.message.details.entries.map((entry: any) => entry.status), ["succeeded", "rejected", "rejected"]);
			assert.match(app.sentMessages[0]!.message.content, /Previous direct task did not complete exactly/);
			assert.equal((await app.handlers.get("tool_call")!({ toolCallId: "edit", toolName: "edit", input: {} }, app.ctx)).block, true);
			assert.equal(app.sessionEntries.length, 2, "retain exact recovery identities");
		});
	});
});

test("a failed writer with a normal final turn stops later tasks and retains admission", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "writer.md"), `---\nname: writer\ndescription: Writes\ntools: [bash]\nextensions: []\nskills: []\n---\nWrite only authorized files.\n`);
		await herdrEnvironment(async (cwd) => {
			for (const mode of ["tasks", "chain"] as const) {
				const fake = fakeHerdr(cwd, () => JSON.stringify({ outcome: "failed", answer: "Commit failed; partial changes remain." }));
				const app = harness({ cwd, herdr: fake.exec });
				const params = { mode: "direct", [mode]: [
					{ role: "writer", name: "First", task: "authorized commit" },
					{ role: "writer", name: "Second", task: "must not run" },
				] };
				await app.handlers.get("tool_call")!({ toolCallId: mode, toolName: "delegate_task", input: params }, app.ctx);
				await app.tool.execute(mode, params, undefined, undefined, app.ctx);
				app.handlers.get("tool_result")!({ toolCallId: mode });
				await waitFor(() => app.sentMessages.length === 1);
				assert.equal(app.sentMessages[0]!.message.details.entries[0].status, "rejected");
				assert.match(app.sentMessages[0]!.message.content, /Commit failed; partial changes remain/);
				assert.equal(app.sessionEntries.length, 1, "no second worker launches");
				assert.equal((await app.handlers.get("tool_call")!({ toolCallId: "edit", toolName: "edit", input: {} }, app.ctx)).block, true);
			}
		});
	});
});

test("direct resource resolution still rejects recursive delegation packages before opening a tab", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---\nname: worker\ndescription: Invalid\ntools: [bash]\nextensions: ["npm:@henryqw/pi-subagent"]\nskills: []\n---\nWork.\n`);
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd);
			const app = harness({ cwd, herdr: fake.exec });
			await app.handlers.get("tool_call")!({ toolCallId: "invalid", toolName: "delegate_task", input: { mode: "direct", role: "worker", name: "Invalid", task: "write" } }, app.ctx);
			await assert.rejects(app.tool.execute("invalid", { role: "worker", name: "Invalid", task: "write" }, undefined, undefined, app.ctx), /forbidden pi-subagent\/pi-mcp-adapter source/);
			assert.equal(fake.calls.length, 0);
		});
	});
});

test("direct widget shows one compact mode, role, route and measured-usage row", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, () => "answer", gate);
			const app = harness({ cwd, herdr: fake.exec, ui: true });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("widget", { role: "worker", name: "Search audit", task: "inspect" }, undefined, undefined, app.ctx);
			assert.equal(app.widget?.render(120).length, 1);
			assert.match(app.widget!.render(120)[0]!, /^⠋ D \[W\] Search audit · .*\/.* · — tok · /);
			release();
			await waitFor(() => app.sentMessages.length === 1);
			assert.match(app.widget!.render(120)[0]!, /✓ D \[W\] complete · Search audit · .* · 1\.5k tok · /);
			assert.ok(visibleWidth(app.widget!.render(26)[0]!) <= 26);
			assert.match(app.widget!.render(26)[0]!, /^✓ D \[W\] complete · /);
		});
	});
});

test("direct prompt acknowledges before turn settlement and accepts an already settled native session", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, () => "exact answer", gate);
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			const result = await app.tool.execute("ack", { role: "worker", name: "Ack", task: "inspect" }, undefined, undefined, app.ctx);
			assert.match(result.content[0].text, /Herdr tab:/);
			assert.equal(app.sentMessages.length, 0);
			assert.ok(fake.calls.every((args) => args[1] !== "prompt" || !args.includes("--wait")));
			release();
			await waitFor(() => app.sentMessages.length === 1);
			for (const status of ["idle", "done"]) {
				const instant = fakeHerdr(cwd, () => "instant answer", undefined, status);
				const other = harness({ cwd, herdr: instant.exec });
				other.handlers.get("session_start")?.({}, other.ctx);
				await other.tool.execute(`instant-${status}`, { role: "worker", name: "Instant", task: "inspect" }, undefined, undefined, other.ctx);
				await waitFor(() => other.sentMessages.length === 1);
				assert.match(other.sentMessages[0]!.message.content, /instant answer/);
				assert.equal(instant.calls.filter((args) => args[1] === "wait").length, 0);
			}
		});
	});
});

test("direct idle wait timeout accepts the persisted answer before another wait", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd, () => "answer after timeout");
			const app = harness({ cwd, herdr: async (args) => {
				const response = await fake.exec(args);
				if (args[0] === "agent" && args[1] === "prompt") {
					const body = JSON.parse(response.stdout);
					body.result.agent.agent_status = "idle";
					return { ...response, stdout: JSON.stringify(body) };
				}
				if (args[0] === "agent" && args[1] === "wait") {
					return { code: 1, stdout: JSON.stringify({ error: { code: "timeout" } }), stderr: "" };
				}
				return response;
			} });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("idle-timeout", { role: "worker", name: "Inspect", task: "inspect" }, undefined, undefined, app.ctx);
			await waitFor(() => app.sentMessages.length === 1);
			assert.equal(app.sentMessages[0]!.message.details.entries[0].summary, "answer after timeout");
			assert.equal(fake.calls.filter((args) => args[0] === "agent" && args[1] === "wait").length, 1);
		});
	});
});

test("direct chain waits for exact prior result and admits declared writer Roles", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd, (prompt) => prompt.includes("Potential-writer completion:")
				? JSON.stringify({ outcome: "succeeded", answer: "final exact" })
				: prompt.includes("first") ? "prior exact" : "final exact");
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("chain", { chain: [
				{ role: "worker", name: "First", task: "first" },
				{ role: "worker", name: "Second", task: "next: {previous}" },
			] }, undefined, undefined, app.ctx);
			await waitFor(() => app.sentMessages.length === 1);
			const prompts = fake.calls.filter(([kind, command]) => kind === "agent" && command === "prompt");
			assert.match(prompts[1]![3]!, /next: prior exact/);
			assert.match(app.sentMessages[0]!.message.content, /final exact/);
			await writeFile(join(agentDir, "config", "pi-subagent", "writer.md"), `---\nname: writer\ndescription: Writes\ntools: [bash]\nextensions: []\nskills: []\n---\nWrites.\n`);
			await app.handlers.get("tool_call")!({ toolCallId: "writer", toolName: "delegate_task", input: { mode: "direct", role: "writer", name: "Write", task: "implement" } }, app.ctx);
			await app.tool.execute("writer", { role: "writer", name: "Write", task: "implement" }, undefined, undefined, app.ctx);
			await waitFor(() => app.sentMessages.length === 2);
			const start = fake.calls.filter(([kind, command]) => kind === "agent" && command === "start").at(-1)!;
			assert.equal(start[start.indexOf(`--${ROLE_TOOL_POLICY_FLAG}`) + 1], '["bash"]');
			assert.equal(fake.calls.filter(([kind, command]) => kind === "tab" && command === "create").length, 3);
		});
	});
});

test("parallel direct delegation returns after first verified tab and delivers one ordered partial failure", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd, (prompt) => prompt.startsWith("second") ? "" : "exact answer");
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			const result = await app.tool.execute("parallel", { tasks: [
				{ role: "worker", name: "First", task: "first" },
				{ role: "worker", name: "Second", task: "second" },
			] }, undefined, undefined, app.ctx);
			assert.equal(fake.calls.filter(([kind, command]) => kind === "agent" && command === "start").length, 1);
			assert.equal(result.details.entries.length, 2);
			await waitFor(() => app.sentMessages.length === 1);
			const message = app.sentMessages[0]!.message;
			assert.deepEqual(message.details.entries.map(({ status }: any) => status), ["succeeded", "rejected"]);
			assert.deepEqual(message.details.entries.map(({ id, index, name, role }: any) => ({ id, index, name, role })), [
				{ id: "parallel:parallel:0", index: 0, name: "First", role: "worker" },
				{ id: "parallel:parallel:1", index: 1, name: "Second", role: "worker" },
			]);
			assert.equal(message.details.entries[0].summary, "exact answer");
			assert.match(message.details.entries[1].summary, /recover from Herdr tab w-test:t3/);
			assert.match(message.content, /empty final answer/);
			assert.match(message.content, /recover from Herdr tab/);
			assert.deepEqual(app.sentMessages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
		});
	});
});

test("repeated Herdr wait timeouts stop after idle policy without imposing a task lifetime", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await writeFile(join(agentDir, "config", "pi-subagent", "config.json"), JSON.stringify({ timeout: { idleMinutes: 0.0001 } }));
		await herdrEnvironment(async (cwd) => {
			const fake = fakeHerdr(cwd, undefined, undefined, "working", true);
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("idle", { role: "worker", name: "Idle", task: "inspect" }, undefined, undefined, app.ctx);
			await waitFor(() => app.sentMessages.length === 1);
			assert.match(app.sentMessages[0]!.message.content, /made no progress/);
			assert.match(app.sentMessages[0]!.message.content, /recover from Herdr tab w-test:t2/);
			assert.ok(fake.calls.some((args) => args[1] === "wait"));
			assert.equal(app.sentMessages[0]!.message.details.tabs[0].tabId, "w-test:t2");
		});
	});
});

test("parallel tabs persist exact identities across a session switch without a follow-up", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, () => "late answer", gate);
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("parallel-switch", { tasks: [
				{ role: "worker", name: "First", task: "first" },
				{ role: "worker", name: "Second", task: "second" },
			] }, undefined, undefined, app.ctx);
			await waitFor(() => app.sessionEntries.length === 2);
			const originalBranch = app.sessionEntries;
			app.switchBranch();
			const switched = app.handlers.get("session_start")?.({}, app.ctx);
			release();
			await switched;
			assert.equal(app.sentMessages.length, 0);
			await recoverDirect(app);
			for (const record of app.sessionEntries) {
				assert.ok(app.notifications.some(({ message }) => message.includes(record.data.tabId) && message.includes(record.data.sessionFile)));
			}
			assert.deepEqual(originalBranch.map(({ data }) => data.tabId), ["w-test:t2", "w-test:t3"]);
			assert.deepEqual(app.sessionEntries.map(({ data }) => data.tabId), ["w-test:t2", "w-test:t3"]);
		});
	});
});

test("switch during tab creation retains exact identity before cancellation; unknown start/prompt outcomes retain recovery", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			for (const stage of ["tab", "start", "start-ack", "prompt"] as const) {
				let entered!: () => void;
				let release!: () => void;
				const reached = new Promise<void>((resolve) => { entered = resolve; });
				const gate = new Promise<void>((resolve) => { release = resolve; });
				const fake = fakeHerdr(cwd);
				const app = harness({ cwd, herdr: async (args, options) => {
					const response = await fake.exec(args); // Herdr has already applied the operation.
					if (args[0] === (stage === "tab" ? "tab" : "agent") && args[1] === (stage === "tab" ? "create" : stage === "start-ack" ? "start" : stage)) {
						entered();
						if (stage === "tab") {
							assert.equal(options?.signal, undefined, "tab creation must survive cancellation to return its identity");
							await gate;
						} else {
							await Promise.race([gate, new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
							if (options?.signal?.aborted && stage !== "start-ack") return { code: -1, stdout: "", stderr: "", killed: true };
						}
					}
					return response;
				} });
				await app.handlers.get("session_start")?.({}, app.ctx);
				const launching = app.tool.execute(`switch-${stage}`, { role: "worker", name: "Check", task: "inspect" }, undefined, undefined, app.ctx);
				let retainedPrompt: string | undefined;
				const rejected = assert.rejects(launching, (error: Error) => {
					retainedPrompt = /Direct Role prompt retained at (\S+) after uncertain start/.exec(error.message)?.[1];
					return /Direct launch|Launching session changed/.test(error.message);
				});
				await reached;
				const originalBranch = app.sessionEntries;
				app.switchBranch();
				const switched = app.handlers.get("session_start")?.({}, app.ctx);
				if (stage === "tab") {
					assert.equal(app.sessionEntries.length, 0);
					assert.equal(fake.calls.some(([kind, action]) => kind === "agent" && action === "start"), false);
				}
				release();
				await Promise.all([rejected, switched]);
				if (retainedPrompt) {
					const directory = join(await realpath(tmpdir()), "pi-subagent-role-");
					assert.ok(retainedPrompt.startsWith(directory) && retainedPrompt.endsWith("/system-prompt"));
					await rm(dirname(retainedPrompt), { recursive: true, force: true });
				}
				assert.equal(app.sentMessages.length, 0);
				assert.equal(app.sessionEntries.length, 1);
				assert.equal(app.sessionEntries[0]!.data.tabId, "w-test:t2");
				assert.equal(originalBranch.length, stage === "tab" ? 0 : 1);
				assert.equal(fake.calls.filter(([kind, action]) => kind === "agent" && action === "prompt").length, stage === "prompt" ? 1 : 0);
				await recoverDirect(app);
				assert.ok(app.notifications.some(({ message }) => message.includes(`tab ${JSON.stringify(app.sessionEntries[0]!.data.tabId)}`)
					&& message.includes(`session ${JSON.stringify(app.sessionEntries[0]!.data.sessionFile)}`)));
			}
		});
	});
});

test("session shutdown cancels the exact direct agent and suppresses a late result", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, () => "late answer", gate);
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("late", { role: "worker", name: "Late", task: "inspect" }, undefined, undefined, app.ctx);
			await waitFor(() => fake.calls.some(([kind, command]) => kind === "agent" && command === "wait"));
			const shutdown = app.handlers.get("session_shutdown")?.({}, app.ctx);
			await waitFor(() => fake.calls.some(([kind, command]) => kind === "agent" && command === "send-keys"));
			release();
			await shutdown;
			assert.equal(app.sentMessages.length, 0);
		});
	});
});

test("queued chain step rechecks Role capability before opening a tab", async () => {
	await environment(async (agentDir) => {
		await writeWorkerRole(agentDir);
		await herdrEnvironment(async (cwd) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const fake = fakeHerdr(cwd, () => "exact prior", gate);
			const app = harness({ cwd, herdr: fake.exec });
			app.handlers.get("session_start")?.({}, app.ctx);
			await app.tool.execute("chain-reload", { chain: [
				{ role: "worker", name: "First", task: "inspect" },
				{ role: "worker", name: "Second", task: "next: {previous}" },
			] }, undefined, undefined, app.ctx);
			await waitFor(() => fake.calls.some(([kind, command]) => kind === "agent" && command === "wait"));
			await writeFile(join(agentDir, "config", "pi-subagent", "worker.md"), `---\nname: worker\ndescription: Writes\ntools: [bash]\nextensions: []\nskills: []\n---\nWrites.\n`);
			release();
			await waitFor(() => app.sentMessages.length === 1);
			assert.deepEqual(app.sentMessages[0]!.message.details.entries.map(({ status }: any) => status), ["succeeded", "rejected"]);
			assert.match(app.sentMessages[0]!.message.content, /became write-capable after admission/);
			assert.equal(fake.calls.filter(([kind, command]) => kind === "tab" && command === "create").length, 1);
		});
	});
});
