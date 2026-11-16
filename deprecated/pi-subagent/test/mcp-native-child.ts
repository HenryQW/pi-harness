import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import roleMcp from "../extensions/role-mcp.ts";
import roleTools from "../extensions/role-tools.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRoleLaunch, loadRoleMcpConfig, ROLE_TOOL_POLICY_FLAG, roleToolPolicyFromArgv } from "../src/index.ts";

// The parent supplies a private home and no inherited credentials. No model call is made.
const [entry, root] = process.argv.slice(2);
const native = await import(entry!);
const server = { command: process.execPath, args: [fileURLToPath(new URL("./mcp-native-server.mjs", import.meta.url))] };
await mkdir(join(root!, ".pi"), { recursive: true });
await writeFile(join(root!, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { exposure: "direct", toolExposure: { private: "direct" } } } }));
for (const [exposure, declared, additions] of [[undefined, [], []], ["deferred", [], []], ["direct", ["codemode"], []], ["hidden", ["tool_search"], []], ["deferred", [], ["tool_search"]]] as const) {
	await writeFile(join(root!, "mcp.json"), JSON.stringify({ autoEnableCodemode: true, mcpServers: {
		local: { ...server, ...(exposure ? { exposure } : {}), toolExposure: { permitted: "direct", private: "hidden", "script*": "codemode-deferred", delayed: "deferred" } },
		unselected: { command: "must-not-start", exposure: "invalid" },
	} }));
	const launch = createRoleLaunch({ getCommands: () => [] }, { isProjectTrusted: () => true }, {
		role: { name: "worker", description: "Local discovery", tools: [...declared], extensions: ["builtin:tool-search", "builtin:codemode"], skills: [], mcps: ["local"], systemPrompt: "Use selected tools." },
		tools: additions,
		route: { model: { provider: "local-test", id: "unused", name: "Local test", api: "openai-responses", baseUrl: "http://localhost", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100, reasoning: false }, thinkingLevel: "off" },
	});
	process.argv = [process.execPath, "pi", ...launch.args];
	const selected = roleToolPolicyFromArgv(launch.args);
	const excludeTools = launch.args[launch.args.indexOf("--exclude-tools") + 1]!.split(",");
	let registerLate!: () => void;
	let finishLate!: () => void;
	const lateEvent = new Promise<void>((resolve) => { finishLate = resolve; });
	const settingsManager = native.SettingsManager.inMemory();
	const loader = new native.DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [native.createCodemodeExtension({ models: false }), native.createToolSearchExtension(),
			// Use the actual adapter at the peer floor; an explicit entry probes another installed native contract.
			entry === import.meta.resolve("@earendil-works/pi-coding-agent") ? roleMcp : native.createMcpExtension({ loadConfig: () => loadRoleMcpConfig(root!, ["local"]) }), roleTools,
			(pi: ExtensionAPI) => {
				registerLate = () => {
					native.createToolSearchExtension()(pi);
					pi.registerMcpServer("late", { ...server, enabled: false, exposure: "deferred" });
				};
				pi.on("mcp_servers_change", () => { finishLate(); });
			}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	loader.getExtensions().runtime.flagValues.set(ROLE_TOOL_POLICY_FLAG, JSON.stringify(selected));
	const modelRuntime = await native.ModelRuntime.create({ authPath: join(root!, "auth.json"), modelsPath: null, modelsStorePath: join(root!, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
	const { session } = await native.createAgentSession({ cwd: root, agentDir: root, modelRuntime, resourceLoader: loader, settingsManager, excludeTools, sessionManager: native.SessionManager.inMemory(root) });
	try {
		await session.bindExtensions({ onError: (error: unknown) => { throw new Error(JSON.stringify(error)); } });
		// Native connections start in the background. Wait for the observable registry, not a fixed delay.
		for (let attempts = 0; !session.getAllTools().some((tool: { name: string }) => tool.name === "mcp__local__fallback") && attempts < 200; attempts++) await setTimeout(25);
		const tools = new Map(session.getAllTools().filter((tool: { name: string }) => tool.name.startsWith("mcp__")).map((tool: { name: string; exposure: string }) => [tool.name, tool.exposure]));
		assert.deepEqual(Object.fromEntries(tools), {
			mcp__local__permitted: "direct", mcp__local__private: "hidden", mcp__local__scripted: "deferred", mcp__local__delayed: "deferred", mcp__local__fallback: exposure === "direct" || exposure === "hidden" ? exposure : "deferred",
		});
		assert.deepEqual(new Set(session.getActiveToolNames()), new Set([...selected, "mcp__local__permitted", ...(exposure === "direct" ? ["mcp__local__fallback"] : [])]));
		registerLate();
		await lateEvent;
		assert.equal(session.getActiveToolNames().includes("tool_search"), selected.includes("tool_search"));
		assert.equal(session.getAllTools().some((tool: { name: string }) => tool.name === "tool_search"), selected.includes("tool_search"));
		assert.equal(session.getActiveToolNames().includes("codemode"), selected.includes("codemode"));
		assert.equal(session.getCallableToolNames().includes("mcp__local__private"), false);
		const ctx = session.extensionRunner.createToolContext("native-test", undefined);
		const result = await session.getToolDefinition("mcp__local__permitted").execute("direct-test", {}, undefined, undefined, ctx);
		assert.deepEqual(result.content, [{ type: "text", text: "permitted" }]);
		await assert.rejects(session.getToolDefinition("mcp__local__private").execute("hidden-test", {}, undefined, undefined, ctx), /no longer available/);
		if (selected.some((name) => name === "tool_search")) {
			await session.getToolDefinition("tool_search").execute("search-test", { query: "delayed", limit: 1 }, undefined, undefined, ctx);
			assert.equal(session.getActiveToolNames().includes("mcp__local__delayed"), true);
			assert.equal(session.getActiveToolNames().includes("mcp__local__private"), false);
		}
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown" });
		session.dispose();
	}
}
console.log("Native MCP exposure, calls, discovery, and Role activation passed.");
