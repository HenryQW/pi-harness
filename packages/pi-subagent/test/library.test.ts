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
	listManagedSubagents,
	managedSubagentName,
	managedSubagentWorkspaceId,
	promptManagedSubagent,
	reconcileManagedSubagentPane,
	reconcileManagedSubagentTab,
	resolveRoleLaunch,
	retireManagedSubagentTab,
	ROLE_TOOL_POLICY_FLAG,
	startManagedSubagent,
	type ManagedSubagentExecutor,
	type PiLaunch,
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
		taskId: "pi-example/review",
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

test("managed Herdr Subagent host reconciles, retries killed pane contention, prompts, lists, and retires", async () => {
	const herdr = fakeHerdr();
	const retryDelays: number[] = [];
	const options = { execute: herdr.execute, delay: async (milliseconds: number) => { retryDelays.push(milliseconds); } };
	const workspaceId = await managedSubagentWorkspaceId("/main", "main-pane", options);
	const host = { cwd: "/main", workspaceId };
	const launch: PiLaunch = { env: { RUN_ID: "run-1" }, args: ["--no-session", "--model", "test/model"] };
	const root = await reconcileManagedSubagentTab(host, { cwd: "/work", launch, label: "task-1" }, options);
	assert.deepEqual(await reconcileManagedSubagentTab(host, { cwd: "/work", launch, label: "task-1" }, options), root);
	const pane = await reconcileManagedSubagentPane(host, root.tabId, root.paneId, "/work", launch, "review", options);
	const name = managedSubagentName(workspaceId, "run-1", "task-1", "review");
	assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.equal(name, managedSubagentName(workspaceId, "run-1", "task-1", "review"));
	assert.notEqual(name, managedSubagentName(workspaceId, "run-1", "task-1", "implement"));
	assert.equal(await startManagedSubagent(host, name, pane, launch, options), "started");
	assert.equal(await startManagedSubagent(host, name, pane, launch, options), "existing");
	await promptManagedSubagent(host, name, { instruction: "review" }, options);
	assert.deepEqual(await listManagedSubagents(host, options), new Map([[pane, "working"]]));
	assert.ok(herdr.calls.some((args) => args.includes("RUN_ID=run-1")));
	assert.equal(herdr.calls.filter((args) => args[0] === "agent" && args[1] === "start" && args.includes("test/model")).length, 2);
	assert.deepEqual(retryDelays, [250]);
	assert.ok(herdr.calls.some((args) => args[0] === "agent" && args[1] === "prompt" && args.at(-1) === JSON.stringify({ instruction: "review" })));
	await retireManagedSubagentTab(host, root.tabId, options);
	assert.equal(herdr.tabs.size, 0);
});

function valueAfter(args: string[], flag: string): string {
	return args[args.indexOf(flag) + 1]!;
}

function valuesAfter(args: string[], flag: string): string[] {
	return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}

function fakeHerdr() {
	let tabNumber = 0;
	let paneNumber = 0;
	let agentStartAttempts = 0;
	const tabs = new Map<string, { tab_id: string; label: string; workspace_id: string }>();
	const panes = new Map<string, { pane_id: string; tab_id: string; label?: string }>();
	const agents = new Map<string, string>();
	const calls: string[][] = [];
	const execute: ManagedSubagentExecutor = async (command, input) => {
		assert.equal(command, "herdr");
		const args = [...input];
		calls.push(args);
		switch (args.slice(0, 2).join(" ")) {
			case "pane list":
				return ok({ result: { panes: [...panes.values(), { pane_id: "main-pane", workspace_id: "workspace-1" }] } });
			case "tab list":
				return ok({ result: { tabs: [...tabs.values()] } });
			case "tab create": {
				const tabId = `tab-${++tabNumber}`;
				const paneId = `pane-${++paneNumber}`;
				tabs.set(tabId, { tab_id: tabId, label: valueAfter(args, "--label"), workspace_id: valueAfter(args, "--workspace") });
				panes.set(paneId, { pane_id: paneId, tab_id: tabId });
				return ok({ result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } });
			}
			case "pane split": {
				const paneId = `pane-${++paneNumber}`;
				panes.set(paneId, { pane_id: paneId, tab_id: panes.get(valueAfter(args, "--pane"))!.tab_id });
				return ok({ result: { pane: { pane_id: paneId } } });
			}
			case "pane rename":
				panes.get(args[2]!)!.label = args[3];
				return ok({ result: {} });
			case "agent get":
				return agents.has(args[2]!)
					? ok({ result: { agent: { pane_id: agents.get(args[2]!) } } })
					: fail("agent_not_found");
			case "agent start":
				if (++agentStartAttempts === 1) {
					return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }), killed: true };
				}
				agents.set(args[2]!, valueAfter(args, "--pane"));
				return ok({ result: {} });
			case "agent prompt":
				return ok({ result: {} });
			case "agent list":
				return ok({ result: { agents: [
					...[...agents.values()].map((paneId) => ({ pane_id: paneId, workspace_id: "workspace-1", agent_status: "working" })),
					{ pane_id: "foreign", workspace_id: "workspace-2", agent_status: "idle" },
				] } });
			case "tab close":
				tabs.delete(args[2]!);
				for (const [paneId, pane] of panes) if (pane.tab_id === args[2]) panes.delete(paneId);
				return ok({ result: {} });
			case "tab get":
				return tabs.has(args[2]!) ? ok({ result: { tab: tabs.get(args[2]!) } }) : fail("tab_not_found");
			default:
				return { code: 1, stdout: "", stderr: `Unexpected Herdr call: ${args.join(" ")}` };
		}
	};
	return { execute, calls, tabs };
}

function ok(value: unknown) {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fail(code: string) {
	return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
}
