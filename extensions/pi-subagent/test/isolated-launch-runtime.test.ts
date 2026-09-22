import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXECUTION_BUDGET_ENV, type EphemeralSubagentExecutionBudget } from "../src/ephemeral.ts";
import { ISOLATED_MODEL_TASK, RoleLaunchRuntime } from "../src/launch-runtime.ts";
import type { OperationContext } from "../src/runner.ts";
import {
	type ChangesetTaskRequest,
	type ExecuteRequest,
	type Judgment,
	type ModelClass,
	type TaskRequest,
	type TextTaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";

const MAIN: WorkspaceIdentity = {
	branch: "main",
	head: "1".repeat(40),
	index: "2".repeat(40),
	tree: "2".repeat(40),
};
const EMPTY_MCP_CONFIG_MODULE = `data:text/javascript,${encodeURIComponent("export const loadMcpConfig = () => ({ mcpServers: {} });")}`;

type RoleFixture = {
	name: string;
	tools?: string[];
	skills?: string[];
	mcps?: string[];
	prompt?: string;
};

function changesetTask(
	id: string,
	role: string,
	modelClass: ModelClass,
	judgment?: Judgment,
): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role,
		modelClass,
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: [],
		contextFrom: [],
		checks: [{ command: "node", args: ["--version"] }],
		...(judgment === undefined ? {} : { judgment }),
	};
}

function textTask(id: string, role: string, modelClass: ModelClass): TextTaskRequest {
	return {
		id,
		kind: "text",
		role,
		modelClass,
		requirements: `Research ${id}.`,
		deliverable: `Explain ${id}.`,
		dependsOn: [],
		contextFrom: [],
	};
}

function request(tasks: TaskRequest[], finalJudgment?: Judgment): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		mode: "isolated",
		approval: "scoped",
		tasks,
		finalChecks: [{ command: "node", args: ["--version"] }],
		...(finalJudgment === undefined ? {} : { finalJudgment }),
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

function roleMarkdown(input: RoleFixture): string {
	const lines = (values: string[]) => values.length ? values.map((value) => `  - ${JSON.stringify(value)}`).join("\n") : "  []";
	return `---
name: ${JSON.stringify(input.name)}
description: ${JSON.stringify(`Test ${input.name}`)}
tools:
${lines(input.tools ?? [])}
extensions:
  []
skills:
${lines(input.skills ?? [])}
mcps:
${lines(input.mcps ?? [])}
---
${input.prompt ?? `Test ${input.name} prompt.`}
`;
}

async function writeProfiles(agentDir: string): Promise<void> {
	const profiles = {
		fast: { model: "test-provider/fast-model", thinkingLevel: "low" },
		balanced: { model: "test-provider/balanced-model", thinkingLevel: "medium" },
		frontier: { model: "test-provider/frontier-model", thinkingLevel: "high" },
		fav: { model: "test-provider/fav-model", thinkingLevel: "high" },
	};
	await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
		profiles: Object.fromEntries(Object.entries(profiles).map(([name, route]) => [name, { primary: route }])),
		tasks: {},
	}));
}

async function harness(
	t: test.TestContext,
	executionBudget?: () => Omit<EphemeralSubagentExecutionBudget, "startedAt">,
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-launch-"));
	const root = join(directory, "root");
	const agentDir = join(directory, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(root);
	await writeProfiles(agentDir);
	const models = [
		model("test-provider", "fast-model"),
		model("test-provider", "balanced-model"),
		model("test-provider", "frontier-model"),
		model("test-provider", "fav-model"),
	];
	const commands: ReturnType<ExtensionAPI["getCommands"]> = [];
	const events = new Events();
	let roleLaunchResolutions = 0;
	const pi = {
		events,
		getCommands: () => {
			roleLaunchResolutions += 1;
			return commands;
		},
	} as unknown as Pick<ExtensionAPI, "events" | "getCommands">;
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
	const runtime = new RoleLaunchRuntime({
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
		executionBudget,
	});
	async function setRole(file: string, role: RoleFixture): Promise<void> {
		const rolesDir = join(agentDir, "config", "pi-subagent");
		await mkdir(rolesDir, { recursive: true });
		await writeFile(join(rolesDir, file), roleMarkdown(role));
	}
	return {
		root,
		events,
		runtime,
		resolvedCwds,
		inspectedRoots,
		preflightOrder,
		roleLaunchResolutions: () => roleLaunchResolutions,
		setResolvedRoot: (value: string) => { resolvedRoot = value; },
		setRole,
	};
}

async function preflight(fixture: Awaited<ReturnType<typeof harness>>, definition: ExecuteRequest) {
	return await fixture.runtime.preflight({ request: definition, cwd: fixture.root }, operationContext());
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

test("preflight registers its Model Task and resolves each distinct explicit Role/model class including judgments", async (t) => {
	const fixture = await harness(t);
	const discovered: unknown[] = [];
	fixture.events.on("@henryqw/pi-task-models:model-task-response", (value) => discovered.push(value));
	fixture.events.emit("@henryqw/pi-task-models:model-task-request", { requestId: "request-12345678" });
	assert.deepEqual((discovered[0] as { task: unknown }).task, ISOLATED_MODEL_TASK);

	await fixture.setRole("author.md", { name: "change author" });
	await fixture.setRole("reviewer.md", { name: "audit reviewer" });
	const reviewerJudgment: Judgment = { role: "audit reviewer", modelClass: "balanced", criterion: "Review the change." };
	const definition = request([
		changesetTask("task-a", "change author", "fast", reviewerJudgment),
		changesetTask("task-b", "change author", "fast", reviewerJudgment),
		textTask("task-c", "change author", "frontier"),
	], { role: "audit reviewer", modelClass: "frontier", criterion: "Review the final result." });
	const prepared = await preflight(fixture, definition);

	assert.equal(prepared.root, await realpath(fixture.root));
	assert.deepEqual(prepared.main, MAIN);
	assert.equal(fixture.roleLaunchResolutions(), 4);
	assert.deepEqual(fixture.resolvedCwds, [fixture.root]);
	assert.deepEqual(fixture.inspectedRoots, [await realpath(fixture.root)]);
	assert.deepEqual(fixture.preflightOrder, ["root", "main"]);
});

test("preflight rejects a non-canonical root before Main validation", async (t) => {
	const fixture = await harness(t);
	fixture.setResolvedRoot(`${await realpath(fixture.root)}/`);
	const definition = request([changesetTask("task-a", "unconfigured", "fast")]);

	await assert.rejects(preflight(fixture, definition), /non-canonical path/i);
	assert.deepEqual(fixture.preflightOrder, ["root"]);
	assert.deepEqual(fixture.inspectedRoots, []);
	assert.equal(fixture.roleLaunchResolutions(), 0);
});

test("Pi Subagent rejects missing or ambiguous Role, Skill, and MCP configuration", async (t) => {
	await t.test("missing Role", async (t) => {
		const fixture = await harness(t);
		await assert.rejects(
			preflight(fixture, request([changesetTask("task-a", "missing role", "fast")])),
			/Required configured Role missing role is missing or ambiguous\./,
		);
	});

	await t.test("ambiguous Role", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole("first.md", { name: "duplicate role" });
		await fixture.setRole("second.md", { name: "duplicate role" });
		await assert.rejects(
			preflight(fixture, request([changesetTask("task-a", "duplicate role", "fast")])),
			/Duplicate Subagent role: duplicate role\./,
		);
	});

	await t.test("missing Skill", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole("skill.md", { name: "skill role", skills: ["unavailable"] });
		await assert.rejects(
			preflight(fixture, request([changesetTask("task-a", "skill role", "fast")])),
			/Role skill role requires missing Skills: unavailable\./,
		);
	});

	await t.test("missing MCP", async (t) => {
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "pi-mcp-adapter/config") return { url: EMPTY_MCP_CONFIG_MODULE, shortCircuit: true };
				return nextResolve(specifier, context);
			},
		});
		const fixture = await harness(t);
		await fixture.setRole("mcp.md", { name: "mcp role", mcps: ["codegraph"] });
		await assert.rejects(
			preflight(fixture, request([changesetTask("task-a", "mcp role", "fast")])),
			/Role MCP servers are not configured: codegraph\./,
		);
	});

	await t.test("ambiguous MCP", async (t) => {
		const fixture = await harness(t);
		await fixture.setRole("mcp.md", { name: "mcp role", mcps: ["codegraph", "codegraph"] });
		await assert.rejects(
			preflight(fixture, request([changesetTask("task-a", "mcp role", "fast")])),
			/mcps contains duplicate MCP server names\./,
		);
	});
});

test("acquireLaunch carries one configured non-refilling budget into a retained worker", async (t) => {
	const fixture = await harness(t, () => ({ maxTurns: 7, maxTokens: 8_000, maxMs: 90_000 }));
	await fixture.setRole("worker.md", { name: "worker" });
	const before = Date.now();
	const handle = await fixture.runtime.acquireLaunch("worker", "fast", operationContext());
	try {
		const budget = JSON.parse(handle.launch.env[EXECUTION_BUDGET_ENV]!) as EphemeralSubagentExecutionBudget;
		assert.deepEqual({ ...budget, startedAt: 0 }, { maxTurns: 7, maxTokens: 8_000, maxMs: 90_000, startedAt: 0 });
		assert.ok(budget.startedAt >= before && budget.startedAt <= Date.now());
	} finally {
		await handle.cleanup();
	}
});

test("acquireLaunch materializes exactly one private prompt file with integrity and cleanup", async (t) => {
	const fixture = await harness(t);
	const prompt = "Use the Writer Role prompt exactly.";
	await fixture.setRole("writer.md", { name: "writer", tools: ["read"], prompt });
	const handle = await fixture.runtime.acquireLaunch("writer", "fast", operationContext());
	const path = transientPromptPath(handle.launch.args);

	try {
		assert.equal(handle.launch.role, "writer");
		assert.equal(handle.launch.modelClass, "fast");
		assert.deepEqual(handle.launch.tools, ["read"]);
		assert.equal(handle.launch.args.filter((arg) => arg === "--append-system-prompt").length, 1);
		assert.ok(!handle.launch.args.includes(prompt));
		const contents = await readFile(path, "utf8");
		assert.ok(contents.endsWith(prompt));
		assert.equal((await lstat(path)).mode & 0o7777, 0o600);
		assert.equal((await lstat(dirname(path))).mode & 0o7777, 0o700);

		await handle.cleanup();
		await handle.cleanup();
		await assert.rejects(lstat(path), /ENOENT/);
		await assert.rejects(lstat(dirname(path)), /ENOENT/);
	} finally {
		await handle.cleanup();
	}
});

test("acquireLaunch accepts arbitrary Role names and re-resolves changed configuration just in time", async (t) => {
	const fixture = await harness(t);
	const role = "release manager";
	await fixture.setRole("release.md", { name: role, prompt: "Original release prompt." });
	await preflight(fixture, request([textTask("task-a", role, "fast")]));
	await fixture.setRole("release.md", { name: role, tools: ["read"], prompt: "Updated release prompt." });

	const handle = await fixture.runtime.acquireLaunch(role, "fast", operationContext());
	try {
		assert.equal(handle.launch.role, role);
		assert.deepEqual(handle.launch.tools, ["read"]);
		const contents = await readFile(transientPromptPath(handle.launch.args), "utf8");
		assert.ok(contents.endsWith("Updated release prompt."));
		assert.doesNotMatch(contents, /Original release prompt\./);
		assert.equal(fixture.roleLaunchResolutions(), 2);
	} finally {
		await handle.cleanup();
	}
});
