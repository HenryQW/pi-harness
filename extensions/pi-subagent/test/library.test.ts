import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import childToolPolicy from "../extensions/role-tools.ts";
import {
	createRoleLaunch,
	EXECUTION_BUDGET_ENV,
	finalizeRoleLaunch,
	parseRoleMcpAllowlist,
	prepareRoleLaunch,
	resolveConfiguredRoleLaunch,
	resolveRoleLaunch,
	resolveRolePackageResources,
	ROLE_MCP_POLICY_FLAG,
	roleMcpFlagValue,
	ROLE_TOOL_POLICY_FLAG,
	selectRoleMcpConfig,
	type Role,
} from "../src/index.ts";

const model: NonNullable<ExtensionContext["model"]> = {
	provider: "openai-codex-2",
	id: "gpt-test",
	name: "Test",
	api: "openai-responses",
	baseUrl: "https://example.test",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
	reasoning: true,
	thinkingLevelMap: { medium: "medium", high: "high" },
};

test("child role policy keeps selected built-ins and activates loaded extension tools", () => {
	let sessionStart: (() => void) | undefined;
	let activeTools = ["read", "bash", "edit", "write", "extension_tool"];
	const pi = {
		registerFlag(name: string) { assert.equal(name, ROLE_TOOL_POLICY_FLAG); },
		getFlag(name: string) {
			assert.equal(name, ROLE_TOOL_POLICY_FLAG);
			return JSON.stringify(["read"]);
		},
		on(event: string, handler: () => void) {
			if (event === "session_start") sessionStart = handler;
		},
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "ask_question", sourceInfo: { source: "builtin" } },
			{ name: "delegate_task", sourceInfo: { source: "npm:pi-subagent" } },
			{ name: "extension_tool", sourceInfo: { source: "npm:example-extension" } },
			{ name: "sdk_tool", sourceInfo: { source: "sdk" } },
			{ name: "inline_tool", sourceInfo: { source: "inline" } },
		],
		setActiveTools(names: string[]) { activeTools = names; },
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;

	childToolPolicy(pi);
	assert.ok(sessionStart);
	sessionStart();
	assert.deepEqual(activeTools, ["read", "extension_tool"]);
});

test("child role policy verifies the final filtered registry once before the first turn", () => {
	const start = (requested: string[], registersProviderTool: boolean) => {
		const events: string[] = [];
		const handlers: Array<() => void> = [];
		const registry = [{ name: "read", sourceInfo: { source: "builtin" } }];
		let activeTools: string[] = ["read"];
		const pi = {
			registerFlag() {},
			getFlag: () => JSON.stringify(requested),
			on(event: string, handler: () => void) {
				if (event === "session_start") handlers.push(handler);
			},
			getAllTools() {
				events.push("getAllTools");
				return registry;
			},
			setActiveTools(names: string[]) {
				events.push("setActiveTools");
				activeTools = names.filter((name) => registry.some((tool) => tool.name === name));
			},
			getActiveTools() {
				events.push("getActiveTools");
				return activeTools;
			},
		} as unknown as ExtensionAPI;
		if (registersProviderTool) {
			handlers.push(() => {
				events.push("provider session_start");
				registry.push({ name: "provider_tool", sourceInfo: { source: "npm:provider" } });
			});
		}
		childToolPolicy(pi);
		return {
			events,
			start() {
				for (const handler of handlers) handler();
				events.push("turn_start");
			},
		};
	};

	const registered = start(["provider_tool"], true);
	registered.start();
	assert.deepEqual(registered.events, ["provider session_start", "getAllTools", "setActiveTools", "getActiveTools", "turn_start"]);

	const unavailable = start(["tyop", "missing_provider"], false);
	assert.throws(() => unavailable.start(), /unavailable tools: tyop, missing_provider.*provider extension/);
	assert.deepEqual(unavailable.events, ["getAllTools", "setActiveTools", "getActiveTools"]);
});

test("child role policy rejects a malformed tool flag", () => {
	let sessionStart: (() => void) | undefined;
	const pi = {
		registerFlag() {},
		getFlag: () => "not-json",
		on(event: string, handler: () => void) {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as ExtensionAPI;

	childToolPolicy(pi);
	assert.ok(sessionStart);
	assert.throws(sessionStart, /pi-subagent-role-tools must be JSON tool names/);
});

test("child budget payload requires the executor runtime origin", () => {
	const previousBudget = process.env[EXECUTION_BUDGET_ENV];
	process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 50, maxMs: 30 * 60_000 });
	try {
		assert.throws(() => childToolPolicy({ registerFlag() {}, on() {} } as unknown as ExtensionAPI), /JSON execution budget/);
	} finally {
		if (previousBudget === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previousBudget;
	}
});

test("child budget requires maxTurns and optional maxTokens to be safe integers >= 1", () => {
	const previousBudget = process.env[EXECUTION_BUDGET_ENV];
	try {
		process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 1, maxMs: 30 * 60_000, startedAt: 0, maxTokens: 1 });
		assert.doesNotThrow(() => childToolPolicy({ registerFlag() {}, on() {} } as unknown as ExtensionAPI));
		for (const field of ["maxTurns", "maxTokens"] as const) {
			for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 1, maxMs: 30 * 60_000, startedAt: 0, [field]: value });
				assert.throws(() => childToolPolicy({ registerFlag() {}, on() {} } as unknown as ExtensionAPI), /JSON execution budget/);
			}
		}
	} finally {
		if (previousBudget === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previousBudget;
	}
});

test("child budget warnings use executor time and apply each threshold once", () => {
	const previousBudget = process.env[EXECUTION_BUDGET_ENV];
	const originalNow = Date.now;
	let now = 0;
	process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 50, maxMs: 30 * 60_000, startedAt: 0 });
	Date.now = () => now;
	try {
		const policy = () => {
			let turnEnd: ((event: any) => void) | undefined;
			const sent: Array<{ message: any; options: any }> = [];
			childToolPolicy({
				registerFlag() {},
				on(event: string, handler: (event: any) => void) {
					if (event === "turn_end") turnEnd = handler;
				},
				sendMessage(message: any, options: any) { sent.push({ message, options }); },
			} as unknown as ExtensionAPI);
			assert.ok(turnEnd);
			return { sent, turnEnd };
		};
		const continuing = {
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "toolCall" }] },
			toolResults: [],
		};

		now = 10 * 60_000;
		const executorTimed = policy();
		now = 24 * 60_000;
		executorTimed.turnEnd(continuing);
		assert.match(executorTimed.sent[0]!.message.content, /^\*\*Execution budget warning:\*\* 49 of 50 turns and approximately 6 of 30 minutes/);

		now = 0;
		const separate = policy();
		for (let turn = 1; turn < 40; turn++) separate.turnEnd(continuing);
		assert.equal(separate.sent.length, 0);
		separate.turnEnd(continuing);
		assert.match(separate.sent[0]!.message.content, /^\*\*Execution budget warning:\*\* 10 of 50 turns and approximately 30 of 30 minutes/);
		now = 24 * 60_000;
		separate.turnEnd(continuing);
		assert.match(separate.sent[1]!.message.content, /^\*\*Execution budget warning:\*\* 9 of 50 turns and approximately 6 of 30 minutes/);
		separate.turnEnd(continuing);
		assert.equal(separate.sent.length, 2);

		now = 0;
		const combined = policy();
		for (let turn = 1; turn < 40; turn++) combined.turnEnd(continuing);
		now = 24 * 60_000;
		combined.turnEnd(continuing);
		assert.deepEqual(combined.sent, [{
			message: {
				customType: "pi-subagent-execution-budget",
				content: "**Execution budget warning:** 10 of 50 turns and approximately 6 of 30 minutes remain before forced termination.\nConverge now: stop expanding scope, complete the highest-priority required work, perform only essential validation, and return a concise final result. If completion is impossible, follow your role’s recovery requirements and report the blocker and exact remaining work. This warning does not change your role, scope, or permissions.",
				display: true,
			},
			options: { deliverAs: "steer", triggerTurn: false },
		}]);
		combined.turnEnd(continuing);
		assert.equal(combined.sent.length, 1);

		now = 0;
		const terminal = policy();
		for (let turn = 1; turn < 40; turn++) terminal.turnEnd(continuing);
		terminal.turnEnd({ ...continuing, message: { role: "assistant", content: [] } });
		assert.deepEqual(terminal.sent, []);
	} finally {
		Date.now = originalNow;
		if (previousBudget === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previousBudget;
	}
});

test("one-turn Role starts with exactly one response-only handoff", () => {
	const previousBudget = process.env[EXECUTION_BUDGET_ENV];
	const handlers = new Map<string, (event: any) => any>();
	const events: string[] = [];
	const sent: Array<{ message: any; options: any }> = [];
	let activeTools = ["read"];
	process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 1, maxMs: 30 * 60_000, startedAt: Date.now() });
	try {
		childToolPolicy({
			registerFlag() {},
			getFlag: () => JSON.stringify(["read"]),
			on(event: string, handler: (event: any) => any) { handlers.set(event, handler); },
			getAllTools() {
				events.push("getAllTools");
				return [{ name: "read", sourceInfo: { source: "builtin" } }];
			},
			setActiveTools(names: string[]) {
				events.push(`setActiveTools:${names.join(",")}`);
				activeTools = names;
			},
			getActiveTools() {
				events.push("getActiveTools");
				return activeTools;
			},
			sendMessage(message: any, options: any) {
				events.push("sendMessage");
				sent.push({ message, options });
			},
		} as unknown as ExtensionAPI);

		handlers.get("session_start")?.({});
		events.push("providerTurn");
		assert.deepEqual(events, ["getAllTools", "setActiveTools:read", "getActiveTools", "setActiveTools:", "sendMessage", "providerTurn"]);
		assert.deepEqual(activeTools, []);
		assert.deepEqual(sent, [{
			message: {
				customType: "pi-subagent-final-handoff",
				content: "**Final handoff required.** Tools are disabled. If your assigned task or Role requires exact output, reply only with that output instead; it takes precedence over this decision packet. Otherwise, reply only with this decision packet:\n\n**Status:** completed | blocked | incomplete\n**Outcome:** one sentence describing what is now true\n**Evidence:** up to three concrete findings, changes, or checks; include an attempted approach only when it prevents Main from repeating failed work\n**Blocker:** none or the exact blocker\n**Risk:** none or one material risk\n**Suggested next:** none or one concrete action",
				display: true,
			},
			options: { deliverAs: "steer", triggerTurn: false },
		}]);

		handlers.get("turn_end")?.({
			type: "turn_end",
			message: { role: "assistant", content: [{ type: "toolCall" }] },
			toolResults: [],
		});
		assert.equal(sent.length, 1);
	} finally {
		if (previousBudget === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previousBudget;
	}
});

test("child final handoff preserves exact-output contracts and reserves the final turn", () => {
	const previousBudget = process.env[EXECUTION_BUDGET_ENV];
	const policy = (maxTurns: number, maxTokens?: number) => {
		const handlers = new Map<string, (event: any) => any>();
		const events: string[] = [];
		const sent: Array<{ message: any; options: any }> = [];
		const toolSets: string[][] = [];
		let activeTools = ["read", "bash"];
		process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns, maxMs: 30 * 60_000, startedAt: Date.now(), ...(maxTokens === undefined ? {} : { maxTokens }) });
		childToolPolicy({
			registerFlag() {},
			getFlag: () => JSON.stringify(["read"]),
			on(event: string, handler: (event: any) => any) { handlers.set(event, handler); },
			getAllTools() {
				events.push("getAllTools");
				return [
					{ name: "read", sourceInfo: { source: "builtin" } },
					{ name: "bash", sourceInfo: { source: "builtin" } },
				];
			},
			setActiveTools(names: string[]) {
				events.push("setActiveTools");
				toolSets.push([...names]);
				activeTools = names;
			},
			getActiveTools() {
				events.push("getActiveTools");
				return activeTools;
			},
			sendMessage(message: any, options: any) { sent.push({ message, options }); },
		} as unknown as ExtensionAPI);
		return {
			events,
			sent,
			toolSets,
			activeTools: () => activeTools,
			start() { handlers.get("session_start")?.({}); },
			messageUpdate(totalTokens: number) {
				handlers.get("message_update")?.({
					type: "message_update",
					message: { role: "assistant", content: [], usage: { totalTokens } },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
				});
			},
			turnEnd(event: any) { handlers.get("turn_end")?.(event); },
		};
	};
	const continuing = {
		type: "turn_end",
		message: { role: "assistant", content: [{ type: "toolCall" }] },
		toolResults: [],
	};
	try {
		const tenTurns = policy(10);
		tenTurns.start();
		assert.deepEqual(tenTurns.events, ["getAllTools", "setActiveTools", "getActiveTools"]);
		for (let turn = 1; turn < 9; turn++) tenTurns.turnEnd(continuing);
		assert.deepEqual(tenTurns.activeTools(), ["read"]);
		assert.equal(tenTurns.sent.length, 1);
		assert.equal(tenTurns.sent[0]!.message.customType, "pi-subagent-execution-budget");

		tenTurns.turnEnd(continuing);
		assert.deepEqual(tenTurns.toolSets, [["read"], []]);
		assert.deepEqual(tenTurns.sent[1]!.options, { deliverAs: "steer", triggerTurn: false });
		assert.equal(tenTurns.sent[1]!.message.customType, "pi-subagent-final-handoff");
		assert.match(tenTurns.sent[1]!.message.content, /If your assigned task or Role requires exact output, reply only with that output instead; it takes precedence over this decision packet\./);
		assert.match(tenTurns.sent[1]!.message.content, /^\*\*Status:\*\* completed \| blocked \| incomplete$/m);
		assert.match(tenTurns.sent[1]!.message.content, /\*\*Outcome:\*\*.*one sentence/);
		assert.match(tenTurns.sent[1]!.message.content, /\*\*Evidence:\*\*.*up to three/);
		assert.match(tenTurns.sent[1]!.message.content, /\*\*Blocker:\*\*/);
		assert.match(tenTurns.sent[1]!.message.content, /\*\*Risk:\*\*/);
		assert.match(tenTurns.sent[1]!.message.content, /\*\*Suggested next:\*\*/);
		assert.doesNotMatch(tenTurns.sent[1]!.message.content, /Work attempted/);
		tenTurns.turnEnd(continuing);
		assert.equal(tenTurns.sent.length, 2);

		const terminalPenultimate = policy(10);
		terminalPenultimate.start();
		for (let turn = 1; turn < 9; turn++) terminalPenultimate.turnEnd(continuing);
		terminalPenultimate.turnEnd({ ...continuing, message: { role: "assistant", content: [] } });
		assert.deepEqual(terminalPenultimate.activeTools(), ["read"]);
		assert.deepEqual(terminalPenultimate.sent.map(({ message }) => message.customType), ["pi-subagent-execution-budget"]);

		const tokenBudget = policy(50, 100);
		tokenBudget.start();
		tokenBudget.messageUpdate(60);
		tokenBudget.messageUpdate(80);
		tokenBudget.turnEnd({ ...continuing, message: { ...continuing.message, usage: { totalTokens: 40 } } });
		assert.equal(tokenBudget.sent.length, 0);
		tokenBudget.messageUpdate(40);
		tokenBudget.turnEnd(continuing);
		assert.match(tokenBudget.sent[0]!.message.content, /20 of 100 tokens/);
		tokenBudget.messageUpdate(21);
		tokenBudget.turnEnd({ ...continuing, message: { role: "assistant", content: [] } });
		assert.deepEqual(tokenBudget.activeTools(), []);
		assert.deepEqual(tokenBudget.sent.map(({ message }) => message.customType), [
			"pi-subagent-execution-budget",
			"pi-subagent-final-handoff",
		]);
		assert.deepEqual(tokenBudget.sent[1]!.options, { deliverAs: "steer", triggerTurn: false });
		tokenBudget.messageUpdate(100);
		tokenBudget.turnEnd(continuing);
		assert.equal(tokenBudget.sent.length, 2);
	} finally {
		if (previousBudget === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previousBudget;
	}
});

test("empty Role tools activate only trusted extension tools and caller additions", () => {
	const role: Role = {
		name: "worker",
		description: "Uses extension and caller tools",
		tools: [],
		extensions: ["/roles/worker.ts"],
		skills: [],
		systemPrompt: "Do bounded work.",
	};
	const mainPi = { getCommands: () => [] } as unknown as Pick<ExtensionAPI, "getCommands">;
	const launch = createRoleLaunch(mainPi, { isProjectTrusted: () => true }, {
		role,
		route: { model, thinkingLevel: "high" },
		extensions: ["/caller/protocol.ts"],
		tools: ["caller_protocol"],
	});

	assert.deepEqual(valuesAfter(launch.args, "--extension").slice(0, 2), ["/roles/worker.ts", "/caller/protocol.ts"]);
	assert.match(valuesAfter(launch.args, "--extension").at(-1)!, /pi-subagent\/extensions\/role-tools\.ts$/);
	assert.equal(valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(["caller_protocol"]));

	let sessionStart: (() => void) | undefined;
	let activeTools = ["read", "bash", "edit", "role_extension", "caller_protocol", "caller_extension"];
	const childPi = {
		registerFlag() {},
		getFlag: () => valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`),
		on(event: string, handler: () => void) {
			if (event === "session_start") sessionStart = handler;
		},
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "role_extension", sourceInfo: { source: "/roles/worker.ts" } },
			{ name: "caller_protocol", sourceInfo: { source: "/caller/protocol.ts" } },
			{ name: "caller_extension", sourceInfo: { source: "/caller/protocol.ts" } },
			{ name: "delegate_task", sourceInfo: { source: "npm:pi-subagent" } },
			{ name: "ask_question", sourceInfo: { source: "/caller/protocol.ts" } },
		],
		setActiveTools(names: string[]) { activeTools = names; },
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;

	childToolPolicy(childPi);
	assert.ok(sessionStart);
	sessionStart();
	assert.deepEqual(activeTools, ["caller_protocol", "role_extension", "caller_extension"]);
});

test("Role MCP allowlists load the adapter wrapper without allowing ambient servers", () => {
	const role: Role = {
		name: "worker",
		description: "Uses selected MCP servers",
		tools: [],
		extensions: [],
		skills: [],
		mcps: ["docs", "browser"],
		systemPrompt: "Use only the selected servers.",
	};
	const pi = { getCommands: () => [] } as unknown as Pick<ExtensionAPI, "getCommands">;
	const launch = createRoleLaunch(pi, { isProjectTrusted: () => true }, {
		role,
		route: { model, thinkingLevel: "high" },
	});

	const policyFlag = `--${ROLE_MCP_POLICY_FLAG}`;
	assert.deepEqual(parseRoleMcpAllowlist(roleMcpFlagValue(launch.args, policyFlag)), ["docs", "browser"]);
	assert.throws(() => roleMcpFlagValue([policyFlag], policyFlag), /requires a value/);
	assert.throws(() => roleMcpFlagValue([policyFlag, "[]", policyFlag, "[]"], policyFlag), /at most once/);
	assert.deepEqual(launch.env, {});
	assert.match(valuesAfter(launch.args, "--extension").at(-2)!, /pi-subagent\/extensions\/role-mcp\.ts$/);
	const noMcpLaunch = createRoleLaunch(pi, { isProjectTrusted: () => true }, {
		role: { ...role, mcps: [] },
		route: { model, thinkingLevel: "high" },
	});
	assert.equal(noMcpLaunch.args.includes(policyFlag), false);
	assert.ok(valuesAfter(noMcpLaunch.args, "--extension").every((extension) => !/[\\/]role-mcp\.ts$/.test(extension)));
	assert.deepEqual(selectRoleMcpConfig({
		mcpServers: { other: { url: "https://other.test" }, docs: { url: "https://docs.test" }, browser: { command: "browser" } },
		settings: { directTools: true, agentPluginPaths: ["./plugins"], hostConfigDiscovery: "on" },
	}, role.mcps!), {
		mcpServers: { docs: { url: "https://docs.test" }, browser: { command: "browser" } },
		settings: { directTools: true },
	});
	assert.throws(
		() => selectRoleMcpConfig({ mcpServers: { docs: {} } }, ["missing"]),
		/Role MCP servers are not configured: missing/,
	);
	assert.throws(
		() => createRoleLaunch(pi, { isProjectTrusted: () => true }, {
			role: { ...role, extensions: ["npm:pi-mcp-adapter"] },
			route: { model, thinkingLevel: "high" },
		}),
		/must select MCP servers with mcps/,
	);
	assert.throws(() => parseRoleMcpAllowlist("[\"docs\",\"docs\"]"), /duplicate MCP server names/);
});

test("Role launch resolves call, Role, then Model Task routes", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-library-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
		profiles: {
			balanced: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "medium" } },
			frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } },
		},
		tasks: { "pi-example/review": "frontier" },
	}));
	const role: Role = {
		name: "reviewer",
		description: "Reviews changes",
		modelClass: "balanced",
		tools: ["read", "grep", "read"],
		extensions: ["/roles/reviewer.ts"],
		skills: ["security"],
		systemPrompt: "Review only the requested change.",
	};
	const pi = {
		getCommands: () => [{
			name: "skill:security",
			source: "skill",
			sourceInfo: { path: "/effective/security/SKILL.md" },
		}],
	} as unknown as Pick<ExtensionAPI, "getCommands">;
	const ctx = {
		model,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [model] },
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;

	const task = {
		id: "pi-example/review",
		label: "Example review",
		purpose: "Review one requested change.",
		defaultProfile: "fast",
	} as const;
	const launch = resolveRoleLaunch(pi, ctx, {
		role,
		task,
		modelClass: "frontier",
		agentDir,
		extensions: ["/caller/adapter.ts", "/roles/reviewer.ts"],
		tools: ["submit", "read"],
		env: { CALLER_ID: "run-1" },
	});

	assert.deepEqual(launch.env, { CALLER_ID: "run-1" });
	assert.equal(launch.model, model);
	assert.equal(launch.thinkingLevel, "high");
	assert.deepEqual(launch.missingSkills, []);
	assert.deepEqual(launch.args.slice(0, 5), [
		"--no-session", "--no-extensions", "--no-skills",
		"--exclude-tools", "delegate_task,ask_question,subagent_status,subagent_resume,subagent_abort",
	]);
	assert.deepEqual(valuesAfter(launch.args, "--extension").slice(0, 2), ["/roles/reviewer.ts", "/caller/adapter.ts"]);
	assert.equal(valuesAfter(launch.args, "--extension").filter((path) => path.endsWith("/pi-multi-codex/extensions/multi-codex.ts")).length, 1);
	const extensionArgs = valuesAfter(launch.args, "--extension");
	assert.match(extensionArgs.at(-1)!, /pi-subagent\/extensions\/role-tools\.ts$/);
	assert.deepEqual(valuesAfter(launch.args, "--skill"), ["/effective/security/SKILL.md"]);
	assert.equal(launch.args.includes("--tools"), false);
	assert.equal(launch.args.includes("--no-tools"), false);
	assert.equal(valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(["read", "grep", "submit"]));
	assert.equal(valueAfter(launch.args, "--model"), "openai-codex-2/gpt-test");
	assert.equal(valueAfter(launch.args, "--thinking"), "high");
	assert.ok(launch.args.includes("--no-approve"));
	assert.equal(
		valueAfter(launch.args, "--append-system-prompt"),
		"You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.\n\nReview only the requested change.",
	);

	assert.equal(valueAfter(launch.args, "--exclude-tools"), "delegate_task,ask_question,subagent_status,subagent_resume,subagent_abort");

	const missingRole = { ...role, skills: [...role.skills, "missing"] };
	assert.throws(
		() => prepareRoleLaunch(pi, ctx, { role: missingRole, task, modelClass: "frontier", agentDir }),
		/Role reviewer requires missing Skills: missing\./,
	);

	const prepared = prepareRoleLaunch(pi, ctx, {
		role,
		task,
		modelClass: "frontier",
		agentDir,
		extensions: ["/caller/adapter.ts", "/roles/reviewer.ts"],
		tools: ["submit", "read"],
		env: { CALLER_ID: "run-1" },
	});
	const promptArgIndex = launch.args.indexOf("--append-system-prompt");
	assert.equal(prepared.role, "reviewer");
	assert.deepEqual(prepared.tools, ["read", "grep", "submit"]);
	assert.equal(Object.isFrozen(prepared.tools), true);
	assert.equal(prepared.promptArgIndex, promptArgIndex);
	assert.equal(prepared.systemPrompt, valueAfter(launch.args, "--append-system-prompt"));
	assert.deepEqual(prepared.args, [...launch.args.slice(0, promptArgIndex), ...launch.args.slice(promptArgIndex + 2)]);
	assert.equal(prepared.args.includes("--append-system-prompt"), false);
	const preparedDirectRoute = prepareRoleLaunch(pi, ctx, {
		role,
		route: { model, thinkingLevel: "high" },
		extensions: ["/caller/adapter.ts", "/roles/reviewer.ts"],
		tools: ["submit", "read"],
		env: { CALLER_ID: "run-1" },
	});
	assert.deepEqual(preparedDirectRoute.args, prepared.args);
	assert.deepEqual(preparedDirectRoute.tools, prepared.tools);
	assert.equal(preparedDirectRoute.args.includes("--append-system-prompt"), false);
	assert.equal(preparedDirectRoute.args.includes(preparedDirectRoute.systemPrompt), false);
	const finalized = finalizeRoleLaunch(prepared);
	assert.deepEqual(finalized, launch);
	assert.deepEqual(finalizeRoleLaunch(preparedDirectRoute), launch);
	assert.equal(finalized.args.filter((arg) => arg === "--append-system-prompt").length, 1);
	assert.throws(
		() => finalizeRoleLaunch({ ...prepared, args: finalized.args }),
		/already contains --append-system-prompt/,
	);
	assert.throws(
		() => prepareRoleLaunch(pi, ctx, { role: { ...role, name: "bad\0" }, task, agentDir }),
		/Role: name/,
	);

	const roleDefault = resolveRoleLaunch(pi, ctx, { role, task, agentDir });
	assert.equal(roleDefault.thinkingLevel, "medium");
	const taskDefault = resolveRoleLaunch(pi, ctx, {
		role: { ...role, modelClass: undefined },
		task,
		agentDir,
	});
	assert.equal(taskDefault.thinkingLevel, "high");
});

test("Role package resources resolve enabled paths; configured launches require a class, reject missing Skills, and deduplicate Skills", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-package-resources-"));
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const packageDir = join(agentDir, "npm", "node_modules", "@example", "role");
	const extension = join(packageDir, "extension.ts");
	const skill = join(packageDir, "SKILL.md");
	const namedSkill = join(packageDir, "named-skill.md");
	const prompt = join(packageDir, "prompt.md");
	const theme = join(packageDir, "theme.json");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(packageDir, { recursive: true }),
	]);
	await Promise.all([
		writeFile(extension, "export default function roleExtension() {}\n"),
		writeFile(skill, "---\nname: package-skill\ndescription: Test package Skill\n---\nUse the package Skill.\n"),
		writeFile(namedSkill, "---\nname: named-skill\ndescription: Test named Skill\n---\nUse the named Skill.\n"),
		writeFile(prompt, "Package prompt.\n"),
		writeFile(theme, "{}\n"),
		writeFile(join(packageDir, "package.json"), JSON.stringify({
			name: "@example/role",
			version: "1.0.0",
			pi: {
				extensions: ["./extension.ts"],
				skills: ["./SKILL.md"],
				prompts: ["./prompt.md"],
				themes: ["./theme.json"],
			},
		})),
	]);
	const role: Role = {
		name: "package-role",
		description: "Uses package resources",
		tools: [],
		extensions: ["npm:@example/role"],
		skills: [],
		systemPrompt: "Do bounded work.",
	};
	const ctx = { cwd, isProjectTrusted: () => false };

	assert.deepEqual(await resolveRolePackageResources({ ...role, extensions: [] }, ctx), {
		extensions: [], skills: [], prompts: [], themes: [],
	});
	assert.deepEqual(await resolveRolePackageResources(role, ctx), {
		extensions: [extension], skills: [skill], prompts: [prompt], themes: [theme],
	});

	await Promise.all([
		mkdir(join(agentDir, "config", "pi-subagent"), { recursive: true }),
		mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(agentDir, "config", "pi-subagent", "package-role.md"), `---
name: package-role
description: Uses package resources
modelClass: balanced
tools: [read, grep, read]
extensions:
  - npm:@example/role
skills:
  - package-skill
  - named-skill
  - package-skill
---
Do bounded work.
`),
		writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: {
				balanced: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "medium" } },
				frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } },
			},
		})),
	]);
	const pi = {
		getCommands: () => [
			{ name: "skill:package-skill", source: "skill", sourceInfo: { path: skill } },
			{ name: "skill:named-skill", source: "skill", sourceInfo: { path: namedSkill } },
		],
	} as unknown as Pick<ExtensionAPI, "getCommands">;
	const launchCtx = {
		...ctx,
		model,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [model] },
	} as unknown as ExtensionContext;
	await assert.rejects(
		resolveConfiguredRoleLaunch(pi, launchCtx, { role: "package-role" } as unknown as Parameters<typeof resolveConfiguredRoleLaunch>[2]),
		/requires an explicit modelClass/,
	);
	const missingNamedSkillPi = {
		getCommands: () => [
			{ name: "skill:package-skill", source: "skill", sourceInfo: { path: skill } },
		],
	} as unknown as Pick<ExtensionAPI, "getCommands">;
	await assert.rejects(
		resolveConfiguredRoleLaunch(missingNamedSkillPi, launchCtx, { role: "package-role", modelClass: "frontier" }),
		/Role package-role requires missing Skills: named-skill\./,
	);
	const launch = await resolveConfiguredRoleLaunch(pi, launchCtx, { role: "package-role", modelClass: "frontier" });
	assert.equal(launch.thinkingLevel, "high");
	assert.deepEqual(launch.tools, ["read", "grep"]);
	assert.equal(Object.isFrozen(launch.tools), true);
	assert.equal(valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(launch.tools));
	assert.deepEqual(valuesAfter(launch.args, "--skill"), [skill, namedSkill]);

	const emptyPackage = join(agentDir, "npm", "node_modules", "@example", "empty");
	await mkdir(emptyPackage, { recursive: true });
	await writeFile(join(emptyPackage, "package.json"), JSON.stringify({
		name: "@example/empty",
		version: "1.0.0",
		pi: { extensions: [], skills: [], prompts: [], themes: [] },
	}));
	await assert.rejects(
		resolveRolePackageResources({ ...role, extensions: ["npm:@example/empty"] }, ctx),
		/Role extension sources resolved no resources: npm:@example\/empty\./,
	);
});

function valueAfter(args: string[], flag: string): string {
	return args[args.indexOf(flag) + 1]!;
}

function valuesAfter(args: string[], flag: string): string[] {
	return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}
