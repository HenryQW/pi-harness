import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { lock } from "proper-lockfile";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { biliConfigPath, syncBiliModels } from "../dist/bili-sync.js";

const model = (id: string) => ({ provider: "test", id, name: id, api: "openai-responses", baseUrl: "https://example.test", input: ["text"], contextWindow: 100000, maxTokens: 10000, reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });
const models = [model("first"), model("second")];
const ctx = { model: models[0], scopedModels: [], modelRegistry: { getAvailable: () => models } } as any;

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "bili-sync-"));
	const previousHome = process.env.HOME;
	const previousCwd = process.cwd();
	process.env.HOME = dir;
	process.chdir(dir);
	const path = join(dir, "bili.json");
	const agentDir = join(dir, "agent");
	const taskDir = join(agentDir, "config", "pi-task-models");
	mkdirSync(taskDir, { recursive: true });
	const profiles = (id: string) => {
		const primary = { model: `test/${id}`, thinkingLevel: "low" };
		writeFileSync(join(taskDir, "config.json"), JSON.stringify({ profiles: { fast: { primary }, balanced: { primary } } }));
	};
	profiles("first");
	return { dir, path, agentDir, profiles, close: () => {
		process.chdir(previousCwd);
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	} };
}

test("delegate config path follows environment overrides", () => {
	assert.equal(biliConfigPath({ BILI_CONFIG_FILE: "./override.json", XDG_CONFIG_HOME: "/ignored" }), resolve("./override.json"));
	assert.equal(biliConfigPath({ XDG_CONFIG_HOME: "/tmp/bili-test" }), "/tmp/bili-test/billion-context/billion-context.json");
});

test("sync preserves legacy behavior, permissions, other fields and invalid files", async () => {
	const f = fixture();
	try {
		await syncBiliModels(ctx, f.path, f.agentDir);
		assert.throws(() => readFileSync(f.path), { code: "ENOENT" });
		for (const text of ['{"pi":{}}', '{"pi":{"subagents":false}}', '{"pi":{"subagents":{"enabled":false,"agents":{"worker":{"model":"old/model"}}}}}', '{"other":true}']) {
			writeFileSync(f.path, text);
			await syncBiliModels(ctx, f.path, f.agentDir);
			assert.equal(readFileSync(f.path, "utf8"), text);
		}
		writeFileSync(f.path, '{"pi":{"subagents":{"enabled":true}}}');
		assert.deepEqual(await syncBiliModels(ctx, f.path, f.agentDir), []);
		assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pi.subagents.agents.worker.model, "test/first");
		for (const text of ['{bad', '{"pi":{"subagents":[]}}', '{"pi":{"subagents":{"agents":{"worker":{"thinkingLevel":"bad"}}}}}']) {
			writeFileSync(f.path, text);
			await assert.rejects(syncBiliModels(ctx, f.path, f.agentDir), /issues/);
			assert.equal(readFileSync(f.path, "utf8"), text);
		}
		writeFileSync(f.path, JSON.stringify({ other: { keep: true }, pi: { subagents: { maxDepth: 4, agents: { worker: { model: "old/model", note: "keep" }, custom: { model: "custom/model" } } } } }));
		chmodSync(f.path, 0o640);
		chmodSync(f.dir, 0o755);
		assert.deepEqual(await syncBiliModels(ctx, f.path, f.agentDir), []);
		assert.equal(statSync(f.path).mode & 0o777, 0o640);
		assert.equal(statSync(f.dir).mode & 0o777, 0o755);
		let saved = JSON.parse(readFileSync(f.path, "utf8"));
		assert.deepEqual(saved.other, { keep: true });
		assert.equal(saved.pi.subagents.maxDepth, 4);
		assert.deepEqual(saved.pi.subagents.agents.worker, { model: "test/first", thinkingLevel: "low", note: "keep" });
		assert.deepEqual(saved.pi.subagents.agents.custom, { model: "custom/model" });
		const first = readFileSync(f.path, "utf8");
		await syncBiliModels(ctx, f.path, f.agentDir);
		assert.equal(readFileSync(f.path, "utf8"), first);
		writeFileSync(join(f.agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
			profiles: { fast: { primary: { model: "test/missing", thinkingLevel: "low" }, fallback: { model: "test/first", thinkingLevel: "low" } }, balanced: { primary: { model: "test/second", thinkingLevel: "high" } } },
			tasks: { "billion-context/acp-worker": "fast" },
		}));
		await syncBiliModels({ ...ctx, model: models[0], scopedModels: [{ model: models[0], thinkingLevel: "low" }] }, f.path, f.agentDir);
		saved = JSON.parse(readFileSync(f.path, "utf8"));
		assert.equal(saved.pi.subagents.agents.worker.model, "test/first");
		assert.deepEqual(saved.pi.subagents.agents.reviewer, { model: "test/second", thinkingLevel: "high" });
	} finally { f.close(); }
});

test("legacy sync selects the effective delegate and preserves all other fields", async () => {
	const f = fixture();
	try {
		const homeFile = join(f.dir, CONFIG_DIR_NAME, "acp.json");
		const projectDir = join(f.dir, "project");
		const projectFile = join(projectDir, CONFIG_DIR_NAME, "acp.json");
		const context = { ...ctx, cwd: projectDir };
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(projectFile, JSON.stringify({ debug: true, secret: "project" }));
		await syncBiliModels(context, f.path, f.agentDir);
		let home = JSON.parse(readFileSync(homeFile, "utf8"));
		assert.equal(home.delegate.agents.worker.model, "test/first");
		assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf8")), { debug: true, secret: "project" });

		writeFileSync(homeFile, JSON.stringify({ secret: "global", delegate: { maxDepth: 4, agents: { worker: { note: "keep" }, custom: { model: "custom/model" } } } }));
		await syncBiliModels(context, f.path, f.agentDir);
		home = JSON.parse(readFileSync(homeFile, "utf8"));
		assert.equal(home.secret, "global");
		assert.equal(home.delegate.maxDepth, 4);
		assert.deepEqual(home.delegate.agents.worker, { note: "keep", model: "test/first", thinkingLevel: "low" });
		assert.deepEqual(home.delegate.agents.custom, { model: "custom/model" });
		const before = readFileSync(homeFile, "utf8");
		writeFileSync(projectFile, JSON.stringify({ debug: true, delegate: { asyncTimeoutMinutes: 9, agents: { worker: { note: "project" } } } }));
		await syncBiliModels(context, f.path, f.agentDir);
		assert.equal(readFileSync(homeFile, "utf8"), before);
		const project = JSON.parse(readFileSync(projectFile, "utf8"));
		assert.equal(project.delegate.asyncTimeoutMinutes, 9);
		assert.deepEqual(project.delegate.agents.worker, { note: "project", model: "test/first", thinkingLevel: "low" });
		assert.equal(project.debug, true);
	} finally { f.close(); }
});

test("legacy sync leaves disabled and malformed files unchanged and does not create a file without routes", async () => {
	const f = fixture();
	try {
		const homeFile = join(f.dir, CONFIG_DIR_NAME, "acp.json");
		const projectDir = join(f.dir, "project");
		const projectFile = join(projectDir, CONFIG_DIR_NAME, "acp.json");
		const context = { ...ctx, cwd: projectDir };
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(f.agentDir, "config", "pi-task-models", "config.json"), '{"profiles":{}}');
		assert.ok((await syncBiliModels(context, f.path, f.agentDir)).length);
		assert.throws(() => readFileSync(homeFile), { code: "ENOENT" });
		f.profiles("first");
		for (const text of ['{"delegate":false}', '{"delegate":{"enabled":false,"maxDepth":4}}']) {
			writeFileSync(projectFile, text);
			await syncBiliModels(context, f.path, f.agentDir);
			assert.equal(readFileSync(projectFile, "utf8"), text);
			assert.throws(() => readFileSync(homeFile), { code: "ENOENT" });
		}
		for (const text of ['{secret: "private",}', '{"delegate":{"agents":{"worker":[]}}}', '{"delegate":null}']) {
			writeFileSync(projectFile, text);
			await assert.rejects(syncBiliModels(context, f.path, f.agentDir), (error: Error) => !error.message.includes("private") && /issues/.test(error.message));
			assert.equal(readFileSync(projectFile, "utf8"), text);
		}
		rmSync(projectFile);
		mkdirSync(join(f.dir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(homeFile, '{"delegate":false}');
		await syncBiliModels(context, f.path, f.agentDir);
		assert.equal(readFileSync(homeFile, "utf8"), '{"delegate":false}');
		writeFileSync(homeFile, '{bad');
		await assert.rejects(syncBiliModels(context, f.path, f.agentDir), /issues/);
		assert.equal(readFileSync(homeFile, "utf8"), '{bad');
	} finally { f.close(); }
});

test("sync refuses symlinks and rechecks the section under the lock", async () => {
	const f = fixture();
	try {
		const target = join(f.dir, "target.json");
		writeFileSync(target, '{"pi":{"subagents":{}}}');
		symlinkSync(target, f.path);
		await assert.rejects(syncBiliModels(ctx, f.path, f.agentDir), /issues/);
		assert.ok(lstatSync(f.path).isSymbolicLink());
		assert.equal(readFileSync(target, "utf8"), '{"pi":{"subagents":{}}}');
		rmSync(f.path);
		writeFileSync(f.path, '{"pi":{"subagents":{}}}');
		const release = await lock(f.path, { realpath: false, lockfilePath: `${f.path}.lock` });
		const pending = syncBiliModels(ctx, f.path, f.agentDir);
		writeFileSync(f.path, '{"pi":{"subagents":{"enabled":false}}}');
		await release();
		await pending;
		assert.equal(readFileSync(f.path, "utf8"), '{"pi":{"subagents":{"enabled":false}}}');
	} finally { f.close(); }
});

test("delegate ownership gates startup and assignment sync after delayed registration", async () => {
	const f = fixture();
	try {
		const { createTaskModelsExtension } = await import("../dist/index.js");
		const listeners = new Map<string, Set<(payload: any) => void>>();
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let tools: any[] = [];
		let command: any;
		const pi = {
			events: {
				on(name: string, fn: (payload: any) => void) {
					const set = listeners.get(name) ?? new Set();
					set.add(fn); listeners.set(name, set);
					return () => set.delete(fn);
				},
				emit(name: string, payload: any) { for (const fn of listeners.get(name) ?? []) fn(payload); },
			},
			on(name: string, fn: (event: any, ctx: any) => unknown) {
				const set = handlers.get(name) ?? [];
				set.push(fn); handlers.set(name, set);
			},
			getAllTools: () => tools,
			registerCommand(_name: string, value: any) { command = value; },
		};
		createTaskModelsExtension(pi as any, { agentDir: f.agentDir, delegateConfigPath: f.path });
		const emit = async (name: string, context: any) => {
			for (const handler of handlers.get(name) ?? []) await handler({}, context);
		};
		let selections: string[] = [];
		const warnings: string[] = [];
		const context = { ...ctx, hasUI: true, ui: {
			notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
			select: async (_label: string, options: string[]) => {
				const selected = selections.shift()!;
				assert.ok(options.includes(selected));
				return selected;
			},
		} };
		const assign = async (profile: string) => {
			const current = profile === "fast" ? "balanced" : "fast";
			selections = [`Delegate worker · billion-context/acp-worker · ${current}`, profile];
			await command.handler("", context);
		};
		writeFileSync(join(f.agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({ profiles: {
			fast: { primary: { model: "test/second", thinkingLevel: "high" } },
			balanced: { primary: { model: "test/first", thinkingLevel: "low" } },
		} }));
		const homeFile = join(f.dir, CONFIG_DIR_NAME, "acp.json");
		await emit("session_start", context);
		await emit("before_agent_start", context);
		await assign("fast");
		assert.throws(() => readFileSync(homeFile), { code: "ENOENT" });

		writeFileSync(f.path, '{"pi":{"subagents":{}}}');
		tools = [{ name: "acp_delegate", sourceInfo: { origin: "package", source: "npm:standalone-integration" } }];
		await emit("session_start", context);
		await emit("before_agent_start", context);
		await assign("balanced");
		assert.equal(readFileSync(f.path, "utf8"), '{"pi":{"subagents":{}}}');
		assert.throws(() => readFileSync(homeFile), { code: "ENOENT" });

		tools = [];
		await emit("session_start", context);
		tools = [{ name: "acp_delegate", sourceInfo: { origin: "package", source: "npm:billion-context" } }];
		assert.equal(readFileSync(f.path, "utf8"), '{"pi":{"subagents":{}}}');
		await emit("before_agent_start", context);
		assert.equal(JSON.parse(readFileSync(f.path, "utf8")).pi.subagents.agents.worker.model, "test/first");
		writeFileSync(f.path, '{"pi":{"subagents":{}}}');
		await emit("before_agent_start", context);
		assert.equal(readFileSync(f.path, "utf8"), '{"pi":{"subagents":{}}}');
		await assign("fast");
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).pi.subagents.agents.worker, { model: "test/second", thinkingLevel: "high" });
		const nonStrict = '{"secret":"private-value", /* comment */ "pi":{"subagents":{}}}';
		writeFileSync(f.path, nonStrict);
		await assign("balanced");
		assert.equal(readFileSync(f.path, "utf8"), nonStrict);
		assert.ok(warnings.some((warning) => warning.includes("invalid JSON")));
		assert.ok(warnings.every((warning) => !warning.includes("private-value")));
	} finally { f.close(); }
});

test("unavailable role routes leave their settings intact while available roles sync", async () => {
	const f = fixture();
	try {
		writeFileSync(f.path, '{"pi":{"subagents":{"agents":{"worker":{"model":"old/model"}}}}}');
		writeFileSync(join(f.agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({ profiles: {
			fast: { primary: { model: "test/first", thinkingLevel: "low" } },
			balanced: { primary: { model: "test/missing", thinkingLevel: "low" } },
		} }));
		const errors = await syncBiliModels(ctx, f.path, f.agentDir);
		assert.ok(errors.some((error) => error.includes("billion-context/acp-worker")));
		const agents = JSON.parse(readFileSync(f.path, "utf8")).pi.subagents.agents;
		assert.deepEqual(agents.worker, { model: "old/model" });
		assert.deepEqual(agents.researcher, { model: "test/first", thinkingLevel: "low" });
	} finally { f.close(); }
});
