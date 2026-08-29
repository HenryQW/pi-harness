import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import childToolPolicy from "../extensions/role-tools.ts";
import {
	CHILD_EXCLUDED_TOOL_NAMES,
	CHILD_EXCLUDED_TOOLS,
	createRoleLaunch,
	EXECUTION_BUDGET_ENV,
	resolveRoleLaunch,
	ROLE_TOOL_POLICY_FLAG,
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
	thinkingLevelMap: { high: "high" },
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

test("child excluded tool names derive the CLI value", () => {
	assert.deepEqual(CHILD_EXCLUDED_TOOL_NAMES, ["delegate_task", "delegate_flow", "delegate_flow_continue", "ask_question"]);
	assert.equal(CHILD_EXCLUDED_TOOLS, CHILD_EXCLUDED_TOOL_NAMES.join(","));
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

test("assigned Role launch merges caller policy and resolves effective Pi resources", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-library-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
		profiles: { frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } } },
		tasks: { "pi-example/review": "frontier" },
	}));
	const role: Role = {
		name: "reviewer",
		description: "Reviews changes",
		tools: ["read"],
		extensions: ["/roles/reviewer.ts"],
		skills: ["security", "missing"],
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

	const launch = resolveRoleLaunch(pi, ctx, {
		role,
		task: {
			id: "pi-example/review",
			label: "Example review",
			purpose: "Review one requested change.",
			defaultProfile: "fast",
		},
		agentDir,
		extensions: ["/caller/adapter.ts", "/roles/reviewer.ts"],
		tools: ["submit", "read"],
		env: { CALLER_ID: "run-1" },
	});

	assert.deepEqual(launch.env, { CALLER_ID: "run-1" });
	assert.equal(launch.model, model);
	assert.equal(launch.thinkingLevel, "high");
	assert.deepEqual(launch.missingSkills, ["missing"]);
	assert.deepEqual(launch.args.slice(0, 5), [
		"--no-session", "--no-extensions", "--no-skills",
		"--exclude-tools", "delegate_task,delegate_flow,delegate_flow_continue,ask_question",
	]);
	assert.deepEqual(valuesAfter(launch.args, "--extension").slice(0, 2), ["/roles/reviewer.ts", "/caller/adapter.ts"]);
	assert.equal(valuesAfter(launch.args, "--extension").filter((path) => path.endsWith("/pi-multi-codex/extensions/multi-codex.ts")).length, 1);
	const extensionArgs = valuesAfter(launch.args, "--extension");
	assert.match(extensionArgs.at(-1)!, /pi-subagent\/extensions\/role-tools\.ts$/);
	assert.deepEqual(valuesAfter(launch.args, "--skill"), ["/effective/security/SKILL.md"]);
	assert.equal(launch.args.includes("--tools"), false);
	assert.equal(launch.args.includes("--no-tools"), false);
	assert.equal(valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(["read", "submit"]));
	assert.equal(valueAfter(launch.args, "--model"), "openai-codex-2/gpt-test");
	assert.equal(valueAfter(launch.args, "--thinking"), "high");
	assert.ok(launch.args.includes("--no-approve"));
	assert.equal(
		valueAfter(launch.args, "--append-system-prompt"),
		"You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.\n\nReview only the requested change.",
	);

	assert.equal(valueAfter(launch.args, "--exclude-tools"), "delegate_task,delegate_flow,delegate_flow_continue,ask_question");
});

function valueAfter(args: string[], flag: string): string {
	return args[args.indexOf(flag) + 1]!;
}

function valuesAfter(args: string[], flag: string): string[] {
	return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}
