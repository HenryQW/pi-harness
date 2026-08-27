import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import childToolPolicy from "../extensions/role-tools.ts";
import {
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
			return JSON.stringify(["read", "ask_question"]);
		},
		on(event: string, handler: () => void) {
			if (event === "session_start") sessionStart = handler;
		},
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "delegate_task", sourceInfo: { source: "npm:pi-subagent" } },
			{ name: "auto_dag_execute", sourceInfo: { source: "npm:pi-auto-dag" } },
			{ name: "auto_dag_acknowledge", sourceInfo: { source: "npm:pi-auto-dag" } },
			{ name: "extension_tool", sourceInfo: { source: "npm:example-extension" } },
			{ name: "sdk_tool", sourceInfo: { source: "sdk" } },
			{ name: "inline_tool", sourceInfo: { source: "inline" } },
		],
		setActiveTools(names: string[]) { activeTools = names; },
	} as unknown as ExtensionAPI;

	childToolPolicy(pi);
	assert.ok(sessionStart);
	sessionStart();
	assert.deepEqual(activeTools, ["read", "extension_tool"]);
	assert.equal(activeTools.includes("auto_dag_execute"), false);
	assert.equal(activeTools.includes("auto_dag_acknowledge"), false);
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

test("omitted Role tools preserve active Main built-ins and add caller protocol tools", () => {
	const role: Role = {
		name: "worker",
		description: "Uses Main defaults and caller protocol tools",
		tools: undefined,
		extensions: ["/roles/worker.ts"],
		skills: [],
		systemPrompt: "Do bounded work.",
	};
	const mainPi = {
		getCommands: () => [],
		getActiveTools: () => ["read", "bash", "parent_extension", "ask_question"],
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "parent_extension", sourceInfo: { source: "npm:parent-extension" } },
			{ name: "ask_question", sourceInfo: { source: "npm:parent-extension" } },
		],
	} as unknown as Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getCommands">;
	const launch = createRoleLaunch(mainPi, { isProjectTrusted: () => true }, {
		role,
		route: { model, thinkingLevel: "high" },
		extensions: ["/caller/protocol.ts"],
		tools: ["caller_protocol", "ask_question"],
	});

	assert.deepEqual(valuesAfter(launch.args, "--extension").slice(0, 2), ["/roles/worker.ts", "/caller/protocol.ts"]);
	assert.match(valuesAfter(launch.args, "--extension").at(-1)!, /pi-subagent\/extensions\/role-tools\.ts$/);
	assert.equal(valueAfter(launch.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(["read", "bash", "caller_protocol", "ask_question"]));

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
	} as unknown as ExtensionAPI;

	childToolPolicy(childPi);
	assert.ok(sessionStart);
	sessionStart();
	assert.deepEqual(activeTools, ["read", "bash", "caller_protocol", "role_extension", "caller_extension"]);
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
		getActiveTools: () => ["read", "bash", "parent_tool"],
		getAllTools: () => [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "parent_tool", sourceInfo: { source: "npm:parent-extension" } },
		],
	} as unknown as Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getCommands">;
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
		"--exclude-tools", "delegate_task,delegate_flow,delegate_flow_continue,ask_question,auto_dag_execute,auto_dag_acknowledge",
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

	const defaultTools = resolveRoleLaunch(pi, ctx, {
		role: { ...role, tools: undefined },
		taskId: "pi-example/review",
		agentDir,
		extensions: ["/caller/adapter.ts"],
		tools: ["submit"],
	});
	assert.equal(defaultTools.args.includes("--tools"), false);
	assert.equal(defaultTools.args.includes("--no-tools"), false);
	assert.equal(valueAfter(defaultTools.args, `--${ROLE_TOOL_POLICY_FLAG}`), JSON.stringify(["read", "bash", "submit"]));
	assert.equal(valuesAfter(defaultTools.args, "--extension").some((path) => path.endsWith("/pi-subagent/extensions/role-tools.ts")), true);
	assert.equal(valueAfter(defaultTools.args, "--exclude-tools"), "delegate_task,delegate_flow,delegate_flow_continue,ask_question,auto_dag_execute,auto_dag_acknowledge");
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
