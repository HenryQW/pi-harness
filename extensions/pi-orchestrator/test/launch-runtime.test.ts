import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRoles, type ResolvedRoleLaunch } from "@henryqw/pi-subagent";
import {
	createRoleLaunchRuntime,
	normalizeResolvedRoleLaunch,
	ORCHESTRATOR_MODEL_TASK,
	selectRequiredRolesForRequest,
	type NormalizeResolvedRoleLaunchInput,
} from "../src/launch-runtime.ts";
import type { OperationContext } from "../src/runner.ts";
import {
	type ExecuteRequest,
	type ModelClass,
	type NormalizedLaunchRecord,
	type TaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";

const MAIN: WorkspaceIdentity = {
	branch: "main",
	head: "1".repeat(40),
	index: "2".repeat(40),
	tree: "2".repeat(40),
};
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

function task(id: string, modelClass: ModelClass = "fast", judgment?: TaskRequest["judgment"]): TaskRequest {
	return {
		id,
		modelClass,
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: [],
		checks: [{ command: "node", args: ["--version"] }],
		...(judgment ? { judgment } : {}),
	};
}

function request(tasks: TaskRequest[] = [task("task-a")], finalJudgment?: ExecuteRequest["finalJudgment"]): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 60_000,
		tasks,
		finalChecks: [{ command: "node", args: ["--version"] }],
		...(finalJudgment ? { finalJudgment } : {}),
	};
}

function model(provider: string, id: string): NonNullable<ExtensionContext["model"]> {
	return {
		provider,
		id,
		name: id,
		api: "anthropic-messages",
		baseUrl: "https://example.test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
	};
}

function builtinTool(name: string): ReturnType<ExtensionAPI["getAllTools"]>[number] {
	return {
		name,
		description: name,
		parameters: {} as never,
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
	};
}

function extensionTool(name: string, path: string, source = "local"): ReturnType<ExtensionAPI["getAllTools"]>[number] {
	return {
		name,
		description: name,
		parameters: {} as never,
		sourceInfo: { path, source, scope: "user", origin: "top-level" },
	};
}

class Events {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

	on(name: string, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(listener);
		this.listeners.set(name, listeners);
		return () => listeners.delete(listener);
	}

	emit(name: string, payload: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) listener(payload);
	}
}

function operationContext(): OperationContext {
	return { signal: new AbortController().signal, timeoutMs: 60_000, deadline: Date.now() + 60_000 };
}

function roleMarkdown(input: {
	name: "implementer" | "reviewer";
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	mcps?: string[];
	prompt?: string;
}): string {
	const lines = (values: string[]) => values.length ? values.map((value) => `  - ${JSON.stringify(value)}`).join("\n") : "  []";
	return `---
name: ${input.name}
description: Test ${input.name}
tools:
${lines(input.tools ?? (input.name === "reviewer" ? ["read", "grep", "find", "ls"] : [...BUILTIN_TOOL_NAMES]))}
extensions:
${lines(input.extensions ?? [])}
skills:
${lines(input.skills ?? [])}
mcps:
${lines(input.mcps ?? [])}
${input.name === "implementer" ? "isolation: worktree\n" : ""}---
${input.prompt ?? `Test ${input.name} prompt.`}
`;
}

async function writeProfiles(agentDir: string, overrides: Partial<Record<ModelClass, { model: string; thinkingLevel: string }>> = {}): Promise<void> {
	const defaults = {
		fast: { model: "test-provider/fast-model", thinkingLevel: "low" },
		balanced: { model: "test-provider/balanced-model", thinkingLevel: "medium" },
		frontier: { model: "test-provider/frontier-model", thinkingLevel: "high" },
		fav: { model: "test-provider/fav-model", thinkingLevel: "high" },
	};
	await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
		profiles: Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([name, route]) => [name, { primary: route }])),
		tasks: {},
	}));
}

async function harness(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-launch-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "root");
	const agentDir = join(directory, "agent");
	const orchestratorEntrypoint = join(directory, "orchestrator-entry.ts");
	await mkdir(root);
	await writeFile(orchestratorEntrypoint, "export default function orchestrator() {}\n");
	await writeProfiles(agentDir);
	const models = [
		model("test-provider", "fast-model"),
		model("test-provider", "balanced-model"),
		model("test-provider", "frontier-model"),
		model("test-provider", "fav-model"),
		model("openai-codex-2", "codex-model"),
	];
	const commands: ReturnType<ExtensionAPI["getCommands"]> = [];
	const tools: ReturnType<ExtensionAPI["getAllTools"]> = BUILTIN_TOOL_NAMES.map(builtinTool);
	const events = new Events();
	const pi = {
		events,
		getCommands: () => commands,
		getAllTools: () => tools,
	} as unknown as Pick<ExtensionAPI, "events" | "getCommands" | "getAllTools">;
	const ctx = {
		cwd: root,
		model: models[0],
		scopedModels: [],
		modelRegistry: { getAvailable: () => models },
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;
	const resolvedCwds: string[] = [];
	const inspectedRoots: string[] = [];
	const preflightOrder: string[] = [];
	let resolvedRoot: string | undefined;
	const runtime = createRoleLaunchRuntime({
		pi,
		context: () => ctx,
		resolveRoot: async (cwd) => {
			preflightOrder.push("root");
			resolvedCwds.push(cwd);
			return resolvedRoot ?? await realpath(root);
		},
		inspectMain: async ({ root: inspected }) => {
			preflightOrder.push("main");
			inspectedRoots.push(inspected);
			return { ...MAIN };
		},
		orchestratorEntrypoint,
		agentDir,
	});
	async function setRole(role: Parameters<typeof roleMarkdown>[0]): Promise<void> {
		const directory = join(agentDir, "config", "pi-subagent");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, `${role.name}.md`), roleMarkdown(role));
	}
	return {
		directory, root, agentDir, orchestratorEntrypoint, models, commands, tools, events, pi, ctx, runtime,
		resolvedCwds, inspectedRoots, preflightOrder, setResolvedRoot: (value: string) => { resolvedRoot = value; }, setRole,
	};
}

async function preflight(fixture: Awaited<ReturnType<typeof harness>>, definition = request()) {
	return await fixture.runtime.preflight({ request: definition, cwd: fixture.root }, operationContext());
}

async function installRolePackage(fixture: Awaited<ReturnType<typeof harness>>, name = "@example/role") {
	const root = join(fixture.agentDir, "npm", "node_modules", ...name.split("/"));
	const extension = join(root, "extension.ts");
	const skill = join(root, "SKILL.md");
	const prompt = join(root, "prompt.md");
	const theme = join(root, "theme.json");
	await mkdir(root, { recursive: true });
	await Promise.all([
		writeFile(extension, "export default function roleExtension() {}\n"),
		writeFile(skill, "---\nname: package-skill\ndescription: Test package Skill\n---\nUse the package Skill.\n"),
		writeFile(prompt, "Package prompt.\n"),
		writeFile(theme, "{}\n"),
		writeFile(join(root, "package.json"), JSON.stringify({
			name,
			version: "1.0.0",
			pi: {
				extensions: ["./extension.ts"],
				skills: ["./SKILL.md"],
				prompts: ["./prompt.md"],
				themes: ["./theme.json"],
			},
		})),
	]);
	return { extension, skill, prompt, theme };
}

async function installMcpAdapter(fixture: Awaited<ReturnType<typeof harness>>) {
	const root = join(fixture.agentDir, "npm", "node_modules", "pi-mcp-adapter");
	const extension = join(root, "index.ts");
	const configModule = join(root, "config.js");
	const config = join(fixture.agentDir, "mcp.json");
	await mkdir(root, { recursive: true });
	await Promise.all([
		writeFile(extension, "export default function adapter() {}\n"),
		writeFile(configModule, "import { readFileSync } from 'node:fs';\nexport const loadMcpConfig = (path) => JSON.parse(readFileSync(path, 'utf8'));\n"),
		writeFile(config, JSON.stringify({
			mcpServers: {
				"real-browser": { url: "https://browser.test" },
				codegraph: { command: "codegraph" },
				ambient: { command: "ambient" },
			},
			settings: { directTools: true },
		})),
		writeFile(join(root, "package.json"), JSON.stringify({
			name: "pi-mcp-adapter",
			version: "1.0.0",
			type: "module",
			exports: { ".": "./index.ts", "./config": "./config.js" },
			pi: { extensions: ["./index.ts"] },
		})),
	]);
	return { extension, configModule, config };
}

function recordsByKey(records: readonly NormalizedLaunchRecord[]): Record<string, NormalizedLaunchRecord> {
	return Object.fromEntries(records.map((record) => [record.key, record]));
}

function resolvedArgs(record: NormalizedLaunchRecord, prompt = "Resolved Role prompt.\nSecond line."): string[] {
	const args = [...record.args];
	args.splice(record.promptArgIndex, 0, "--append-system-prompt", prompt);
	return args;
}

function transientPromptPath(args: readonly string[]): string {
	const index = args.indexOf("--append-system-prompt");
	assert.ok(index >= 0);
	assert.equal(args.lastIndexOf("--append-system-prompt"), index);
	assert.ok(args[index + 1]);
	return args[index + 1]!;
}

test("default correlation tokens contain 96 bits as 24 lowercase hex characters", async (t) => {
	const fixture = await harness(t);
	const token = fixture.runtime.randomToken();
	assert.match(token, /^[0-9a-f]{24}$/);
	assert.equal(Buffer.from(token, "hex").byteLength, 12);
});

test("preflight registers its Model Task and resolves each distinct Role/model class once", async (t) => {
	const fixture = await harness(t);
	const discovered: unknown[] = [];
	fixture.events.on("@henryqw/pi-task-models:model-task-response", (value) => discovered.push(value));
	fixture.events.emit("@henryqw/pi-task-models:model-task-request", { requestId: "request-12345678" });
	assert.equal((discovered[0] as { task: unknown }).task && JSON.stringify((discovered[0] as { task: unknown }).task), JSON.stringify(ORCHESTRATOR_MODEL_TASK));

	const definition = request([
		task("task-a", "fast", { criterion: "Review A.", modelClass: "balanced" }),
		task("task-b", "fast", { criterion: "Review B.", modelClass: "balanced" }),
		task("task-c", "frontier"),
	], { criterion: "Final review.", modelClass: "frontier" });
	const prepared = await preflight(fixture, definition);
	assert.equal(prepared.root, await realpath(fixture.root));
	assert.deepEqual(prepared.main, MAIN);
	assert.deepEqual(prepared.launchRecords.map(({ key }) => key), [
		"implementer/fast", "reviewer/balanced", "implementer/frontier", "reviewer/frontier",
	]);
	assert.deepEqual(prepared.launchRecords.map(({ model }) => model), [
		"test-provider/fast-model", "test-provider/balanced-model", "test-provider/frontier-model", "test-provider/frontier-model",
	]);
	assert.deepEqual(fixture.resolvedCwds, [fixture.root]);
	assert.deepEqual(fixture.inspectedRoots, [await realpath(fixture.root)]);
	assert.deepEqual(fixture.preflightOrder, ["root", "main"]);
});

test("preflight rejects a root resolver result that is not already canonical", async (t) => {
	const fixture = await harness(t);
	fixture.setResolvedRoot(`${await realpath(fixture.root)}/`);
	await assert.rejects(preflight(fixture), /non-canonical path/i);
	assert.deepEqual(fixture.preflightOrder, ["root"]);
	assert.deepEqual(fixture.inspectedRoots, []);
});

test("effective user Role overrides supply exact tools and only a durable prompt hash", async (t) => {
	const fixture = await harness(t);
	await fixture.setRole({ name: "implementer", tools: ["read"], prompt: "Use the user override exactly." });
	const prepared = await preflight(fixture);
	const record = prepared.launchRecords[0]! as NormalizedLaunchRecord;
	const serialized = JSON.stringify(record);
	assert.deepEqual(record.tools, ["read"]);
	assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
	assert.match(record.roleFingerprint, /^[0-9a-f]{64}$/);
	assert.doesNotMatch(serialized, /Use the user override exactly|append-system-prompt|system-prompt/);
	assert.equal("prompt" in record, false);
	assert.equal("rawArgs" in record, false);
});

test("required Role selection fails closed on missing or ambiguous Roles", () => {
	const implementer = { name: "implementer", description: "i", tools: [], extensions: [], skills: [], systemPrompt: "i" };
	const reviewer = { name: "reviewer", description: "r", tools: ["read", "grep", "find", "ls"], extensions: [], skills: [], systemPrompt: "r" };
	assert.throws(() => selectRequiredRolesForRequest([], request()), /implementer.*missing or ambiguous/i);
	assert.throws(() => selectRequiredRolesForRequest([implementer, implementer], request()), /implementer.*missing or ambiguous/i);
	assert.throws(
		() => selectRequiredRolesForRequest([implementer], request([task("task-a", "fast", { criterion: "Review.", modelClass: "fast" })])),
		/reviewer.*missing or ambiguous/i,
	);
	assert.equal(selectRequiredRolesForRequest([implementer, reviewer], request()).get("implementer"), implementer);
});

test("missing Skills and duplicate canonical resources fail preflight", async (t) => {
	await t.test("missing Skill", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole({ name: "implementer", skills: ["missing"] });
		await assert.rejects(preflight(fixture), /missing Skills?: missing/i);
	});
	await t.test("two Skill names resolve to one file", async (t) => {
		const fixture = await harness(t);
		const skill = join(fixture.directory, "SKILL.md");
		await writeFile(skill, "skill\n");
		fixture.commands.push(
			{ name: "skill:first", source: "skill", sourceInfo: { path: skill, source: "local", scope: "user", origin: "top-level" } },
			{ name: "skill:second", source: "skill", sourceInfo: { path: skill, source: "local", scope: "user", origin: "top-level" } },
		);
		await fixture.setRole({ name: "implementer", skills: ["first", "second"] });
		await assert.rejects(preflight(fixture), /Skill paths contains duplicate or ambiguous/i);
	});
	await t.test("extension aliases canonicalize to one file", async (t) => {
		const fixture = await harness(t);
		const extension = join(fixture.directory, "extension.ts");
		const nested = join(fixture.directory, "nested");
		await mkdir(nested);
		await writeFile(extension, "export default function x() {}\n");
		await fixture.setRole({ name: "implementer", extensions: [extension, join(nested, "..", "extension.ts")] });
		await assert.rejects(preflight(fixture), /extensions contains duplicate or ambiguous/i);
	});
});

test("Implementer package sources resolve to exact fingerprinted child resources", async (t) => {
	const fixture = await harness(t);
	const expected = await installRolePackage(fixture);
	await fixture.setRole({ name: "implementer", extensions: ["npm:@example/role"] });
	const record = (await preflight(fixture)).launchRecords[0]! as NormalizedLaunchRecord;
	assert.deepEqual(record.roleExtensions.slice(0, -1), [await realpath(expected.extension)]);
	assert.deepEqual(record.roleSkills, [await realpath(expected.skill)]);
	assert.deepEqual(record.rolePrompts, [await realpath(expected.prompt)]);
	assert.deepEqual(record.roleThemes, [await realpath(expected.theme)]);
	assert.deepEqual(record.resources.map(({ kind }) => kind), ["extension", "extension", "skill", "prompt", "theme"]);
	assert.ok(record.args.includes("--no-prompt-templates"));
	assert.ok(record.args.includes("--no-themes"));
	assert.ok(!record.args.includes("npm:@example/role"));
	await writeFile(expected.prompt, "changed package prompt\n");
	await assert.rejects(fixture.runtime.acquireLaunch(record, operationContext()), /prompt fingerprint drifted/i);
});

test("Role extensions reject unresolved, non-regular, duplicate, and self resources", async (t) => {
	for (const [name, extension, pattern, prepare] of [
		["remote", "https://example.test/role.ts", /resolved no resources/i],
		["file URL", "file:///tmp/role.ts", /resolved no resources/i],
		["missing", "missing.ts", /resolved no resources/i, async (fixture: Awaited<ReturnType<typeof harness>>) => join(fixture.directory, "missing.ts")],
		["directory", "directory", /regular file/i, async (fixture: Awaited<ReturnType<typeof harness>>) => {
			const path = join(fixture.directory, "role-dir");
			await mkdir(path);
			return path;
		}],
	] as const) {
		await t.test(name, async (t) => {
			const fixture = await harness(t);
			const selected = prepare ? await prepare(fixture) : extension;
			await fixture.setRole({ name: "implementer", extensions: [selected] });
			await assert.rejects(preflight(fixture), pattern);
		});
	}
	await t.test("canonical self entrypoint", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole({ name: "implementer", extensions: [fixture.orchestratorEntrypoint] });
		await assert.rejects(preflight(fixture), /self source/i);
	});
});

test("tool provenance accepts built-ins and exact child extensions", async (t) => {
	await t.test("built-ins", async (t) => {
		const fixture = await harness(t);
		const prepared = await preflight(fixture);
		assert.deepEqual(prepared.launchRecords[0]!.tools, BUILTIN_TOOL_NAMES);
	});
	await t.test("exact child extension", async (t) => {
		const fixture = await harness(t);
		const extension = join(fixture.directory, "child-tool.ts");
		await writeFile(extension, "export default function childTool() {}\n");
		await fixture.setRole({ name: "implementer", tools: ["child_tool"], extensions: [extension] });
		fixture.tools.splice(0, fixture.tools.length, extensionTool("child_tool", extension));
		const prepared = await preflight(fixture);
		const record = prepared.launchRecords[0]! as NormalizedLaunchRecord;
		assert.deepEqual(record.tools, ["child_tool"]);
		assert.equal(record.roleExtensions[0], await realpath(extension));
	});
});

test("tool preflight rejects missing, child-excluded, sdk, inline, unknown, unverifiable, ambiguous, and wrong-extension tools", async (t) => {
	const cases: {
		name: string;
		toolName: string;
		tool?(fixture: Awaited<ReturnType<typeof harness>>, declaredExtension: string): ReturnType<ExtensionAPI["getAllTools"]>[number][];
		pattern: RegExp;
	}[] = [
		{ name: "missing", toolName: "custom", pattern: /missing from Main/i },
		{ name: "child-excluded", toolName: "orchestrate_execute", tool: () => [builtinTool("orchestrate_execute")], pattern: /excluded from child/i },
		{ name: "sdk", toolName: "custom", tool: () => [extensionTool("custom", "<sdk:custom>", "sdk")], pattern: /forbidden sdk provenance/i },
		{ name: "inline", toolName: "custom", tool: (_fixture, extension) => [extensionTool("custom", extension, "inline")], pattern: /forbidden inline provenance/i },
		{ name: "unknown", toolName: "custom", tool: (_fixture, extension) => [extensionTool("custom", extension, "unknown")], pattern: /forbidden unknown provenance/i },
		{ name: "unverifiable", toolName: "custom", tool: (_fixture, extension) => [{ ...extensionTool("custom", extension), sourceInfo: { path: extension, source: "local" } as never }], pattern: /unverifiable sourceInfo/i },
		{ name: "ambiguous", toolName: "custom", tool: (_fixture, extension) => [extensionTool("custom", extension), extensionTool("custom", extension)], pattern: /ambiguous.*registry/i },
		{ name: "wrong-extension", toolName: "custom", tool: (fixture) => [extensionTool("custom", join(fixture.directory, "other-tool.ts"))], pattern: /not included in that child launch/i },
	];
	for (const entry of cases) {
		await t.test(entry.name, async (t) => {
			const fixture = await harness(t);
			const extension = join(fixture.directory, "declared-tool.ts");
			await writeFile(extension, "export default function declared() {}\n");
			await writeFile(join(fixture.directory, "other-tool.ts"), "export default function other() {}\n");
			await fixture.setRole({ name: "implementer", tools: [entry.toolName], extensions: [extension] });
			fixture.tools.splice(0, fixture.tools.length, ...(entry.tool?.(fixture, extension) ?? []));
			await assert.rejects(preflight(fixture), entry.pattern);
		});
	}
});

test("Implementer MCP policy and adapter config are fingerprinted while Reviewer judgment MCP access is filtered", async (t) => {
	const fixture = await harness(t);
	const adapter = await installMcpAdapter(fixture);
	await fixture.setRole({ name: "implementer", mcps: ["real-browser", "codegraph"] });
	await fixture.setRole({ name: "reviewer", mcps: ["codegraph"] });
	assert.deepEqual(loadRoles(fixture.agentDir).find(({ name }) => name === "implementer")!.mcps, ["real-browser", "codegraph"]);
	const prepared = await preflight(fixture, request([
		task("task-a", "fast", { criterion: "Review.", modelClass: "fast" }),
	]));
	const implementer = prepared.launchRecords.find(({ role }) => role === "implementer")! as NormalizedLaunchRecord;
	const reviewer = prepared.launchRecords.find(({ role }) => role === "reviewer")! as NormalizedLaunchRecord;
	assert.deepEqual(implementer.env, {});
	assert.deepEqual(implementer.roleMcps, ["real-browser", "codegraph"]);
	assert.deepEqual(implementer.roleMcpResources, [await realpath(adapter.extension), await realpath(adapter.configModule)]);
	assert.ok(implementer.mcpConfigSha256);
	assert.ok(implementer.args.includes("--pi-subagent-role-mcps"));
	assert.ok(implementer.args.includes("--pi-subagent-role-mcp-config-sha256"));
	assert.match(implementer.roleExtensions.at(-2)!, /pi-subagent\/extensions\/role-mcp\.ts$/);
	assert.deepEqual(reviewer.env, {});
	assert.equal(reviewer.roleMcps, undefined);
	assert.equal(reviewer.roleMcpResources, undefined);
	assert.equal(reviewer.mcpConfigSha256, undefined);
	assert.doesNotMatch(reviewer.roleExtensions.join("\n"), /role-mcp\.ts$/);

	await writeFile(adapter.extension, "export default function changedAdapter() {}\n");
	await assert.rejects(fixture.runtime.acquireLaunch(implementer, operationContext()), /drifted/i);
	await writeFile(adapter.extension, "export default function adapter() {}\n");
	const config = JSON.parse(await readFile(adapter.config, "utf8"));
	config.mcpServers.codegraph.command = "changed-codegraph";
	await writeFile(adapter.config, JSON.stringify(config));
	await assert.rejects(fixture.runtime.acquireLaunch(implementer, operationContext()), /drifted/i);
});

test("Reviewer Role keeps exact tools while filtering configured resources from judgment launches", async (t) => {
	const reviewed = request([task("task-a", "fast", { criterion: "Review.", modelClass: "fast" })]);
	await t.test("mutable tool", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole({ name: "reviewer", tools: ["read", "grep", "find", "ls", "bash"] });
		await assert.rejects(preflight(fixture, reviewed), /Reviewer Role must declare only/i);
	});
	await t.test("configured resources", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole({ name: "reviewer", extensions: ["npm:@example/missing"], skills: ["missing"] });
		const record = (await preflight(fixture, reviewed)).launchRecords.find(({ role }) => role === "reviewer")! as NormalizedLaunchRecord;
		assert.deepEqual(record.roleSkills, []);
		assert.equal(record.rolePrompts, undefined);
		assert.equal(record.roleThemes, undefined);
		assert.equal(record.roleExtensions.length, 1);
		assert.match(record.roleExtensions[0]!, /pi-subagent\/extensions\/role-tools\.ts$/);
		assert.ok(!record.args.includes("npm:@example/missing"));
	});
	await t.test("resolved addition", async (t) => {
		const fixture = await harness(t);
		const prepared = await preflight(fixture, reviewed);
		const record = prepared.launchRecords.find(({ role }) => role === "reviewer")! as NormalizedLaunchRecord;
		const addition = join(fixture.directory, "provider-addition.ts");
		await writeFile(addition, "export default function x() {}\n");
		const launch: ResolvedRoleLaunch = {
			env: {},
			args: [...resolvedArgs(record), "--extension", addition],
			model: fixture.models.find(({ id }) => id === "fast-model")!,
			thinkingLevel: "low",
			missingSkills: [],
		};
		const reviewer = loadRoles(fixture.agentDir).find(({ name }) => name === "reviewer")!;
		await assert.rejects(normalizeResolvedRoleLaunch({
			role: "reviewer",
			modelClass: "fast",
			effectiveRole: reviewer,
			launch,
			commands: fixture.commands,
			tools: fixture.tools,
			knownFiles: {
				roleMcp: record.roleExtensions.at(-1)!,
				roleTools: record.roleExtensions.at(-1)!,
				multiCodex: record.roleExtensions.at(-1)!,
				orchestratorEntrypoint: fixture.orchestratorEntrypoint,
			},
		}), /does not match the exact pi-subagent resolved launch/i);
	});
});

test("the known no-tool provider adapter is the only optional Reviewer extension", async (t) => {
	const fixture = await harness(t);
	await writeProfiles(fixture.agentDir, { fast: { model: "openai-codex/gpt-codex", thinkingLevel: "low" } });
	fixture.models.push(model("openai-codex-2", "gpt-codex"));
	const reviewed = request([task("task-a", "fast", { criterion: "Review.", modelClass: "fast" })]);
	const prepared = await preflight(fixture, reviewed);
	const reviewer = prepared.launchRecords.find(({ role }) => role === "reviewer")! as NormalizedLaunchRecord;
	assert.equal(reviewer.model, "openai-codex-2/gpt-codex");
	assert.equal(reviewer.roleExtensions.length, 2);
	assert.match(reviewer.roleExtensions[0]!, /pi-multi-codex\/extensions\/multi-codex\.ts$/);
	assert.match(reviewer.roleExtensions[1]!, /pi-subagent\/extensions\/role-tools\.ts$/);
	assert.deepEqual(reviewer.roleSkills, []);
});

test("normalization rejects an environment outside the resolved Role policy", async (t) => {
	const fixture = await harness(t);
	const prepared = await preflight(fixture);
	const record = prepared.launchRecords[0]! as NormalizedLaunchRecord;
	const effectiveRole = loadRoles(fixture.agentDir).find(({ name }) => name === "implementer")!;
	const launch: ResolvedRoleLaunch = {
		env: { SECRET: "caller" },
		args: resolvedArgs(record),
		model: fixture.models.find(({ id }) => id === "fast-model")!,
		thinkingLevel: "low",
		missingSkills: [],
	};
	const input: NormalizeResolvedRoleLaunchInput = {
		role: "implementer",
		modelClass: "fast",
		effectiveRole,
		launch,
		commands: fixture.commands,
		tools: fixture.tools,
		knownFiles: {
			roleMcp: record.roleExtensions.at(-1)!,
			roleTools: record.roleExtensions.at(-1)!,
			multiCodex: record.roleExtensions.at(-1)!,
			orchestratorEntrypoint: fixture.orchestratorEntrypoint,
		},
	};
	await assert.rejects(normalizeResolvedRoleLaunch(input), /launch environment must be empty/i);
});

test("acquisition creates unique private OS-temp prompts and leaves no request launch directory", async (t) => {
	const fixture = await harness(t);
	await fixture.setRole({ name: "implementer", prompt: "Private Implementer Role prompt." });
	await fixture.setRole({ name: "reviewer", prompt: "Private Reviewer Role prompt." });
	const definition = request([
		task("task-a", "fast", { criterion: "Review.", modelClass: "fast" }),
		task("task-b", "frontier"),
	]);
	const prepared = await preflight(fixture, definition);
	const records = prepared.launchRecords as NormalizedLaunchRecord[];
	const serialized = JSON.stringify(records);
	assert.doesNotMatch(serialized, /Private (?:Implementer|Reviewer) Role prompt|append-system-prompt|system-prompt/);
	await assert.rejects(lstat(join(fixture.agentDir, "config", "pi-orchestrator")), /ENOENT/);

	const handles = await Promise.all(records.flatMap((record) => [
		fixture.runtime.acquireLaunch(record, operationContext()),
		fixture.runtime.acquireLaunch(record, operationContext()),
	]));
	const paths = handles.map(({ launch }) => transientPromptPath(launch.args));
	assert.equal(new Set(paths).size, paths.length);
	try {
		for (const [index, handle] of handles.entries()) {
			const path = paths[index]!;
			const contents = await readFile(path, "utf8");
			assert.match(contents, handle.launch.role === "implementer"
				? /Private Implementer Role prompt/
				: /Private Reviewer Role prompt/);
			assert.equal((await lstat(path)).mode & 0o7777, 0o600);
			assert.equal((await lstat(dirname(path))).mode & 0o7777, 0o700);
			assert.ok(!handle.launch.args.some((arg) => arg.includes(contents)));
			assert.equal("prompt" in handle.launch, false);
			assert.equal("rawArgs" in handle.launch, false);
		}
	} finally {
		await Promise.all(handles.map(({ cleanup }) => cleanup()));
	}
	for (const path of paths) {
		await assert.rejects(lstat(path), /ENOENT/);
		await assert.rejects(lstat(dirname(path)), /ENOENT/);
	}
	await Promise.all(handles.map(({ cleanup }) => cleanup()));
});

test("recovery and every acquisition exact-compare freshly resolved Role state", async (t) => {
	await t.test("route drift on recovery", async (t) => {
		const fixture = await harness(t);
		const definition = request([task("task-a", "fast", { criterion: "Review.", modelClass: "balanced" })]);
		const prepared = await preflight(fixture, definition);
		const records = recordsByKey(prepared.launchRecords as NormalizedLaunchRecord[]);
		assert.deepEqual(
			await fixture.runtime.recoverLaunchRecords({ root: prepared.root, request: definition, records }, operationContext()),
			prepared.launchRecords,
		);
		await writeProfiles(fixture.agentDir, { fast: { model: "test-provider/frontier-model", thinkingLevel: "high" } });
		await assert.rejects(
			fixture.runtime.recoverLaunchRecords({ root: prepared.root, request: definition, records }, operationContext()),
			/Role identity, route, argv, resources, tools, or prompt hash drifted/i,
		);
	});

	await t.test("prompt drift immediately before launch", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole({ name: "implementer", prompt: "Original Role prompt." });
		const record = (await preflight(fixture)).launchRecords[0]! as NormalizedLaunchRecord;
		await fixture.setRole({ name: "implementer", prompt: "Changed Role prompt." });
		await assert.rejects(
			fixture.runtime.acquireLaunch(record, operationContext()),
			/prompt hash drifted immediately before launch/i,
		);
	});

	await t.test("selected resource drift immediately before launch", async (t) => {
		const fixture = await harness(t);
		const extension = join(fixture.directory, "mutable-extension.ts");
		await writeFile(extension, "version one\n");
		await fixture.setRole({ name: "implementer", tools: ["read"], extensions: [extension] });
		const record = (await preflight(fixture)).launchRecords[0]! as NormalizedLaunchRecord;
		await writeFile(extension, "version two\n");
		await assert.rejects(fixture.runtime.acquireLaunch(record, operationContext()), /extension fingerprint drifted/i);
	});

	await t.test("complete durable record drift", async (t) => {
		const fixture = await harness(t);
		const record = (await preflight(fixture)).launchRecords[0]! as NormalizedLaunchRecord;
		record.args.push("--unsafe");
		await assert.rejects(fixture.runtime.acquireLaunch(record, operationContext()), /record fingerprint drifted/i);
	});
});
