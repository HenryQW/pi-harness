import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import addDirExtension from "../extensions/add-dir.ts";
import {
	buildContextInjection,
	collectSkillPaths,
	findFiles,
	invalidateContextCache,
	resolveDir,
	scanDirContext,
} from "../extensions/add-dir-helpers.ts";

async function tempDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-add-dir-test-"));
}

async function makeFixture(): Promise<{ root: string; external: string }> {
	const root = await tempDirectory();
	const external = join(root, "external");
	await mkdir(join(external, ".agents", "skills", "review"), { recursive: true });
	await mkdir(join(external, ".pi", "skills", "plan"), { recursive: true });
	await mkdir(join(external, "src", "nested"), { recursive: true });
	await mkdir(join(external, "node_modules", "ignored"), { recursive: true });
	await mkdir(join(external, ".git", "ignored"), { recursive: true });
	await writeFile(join(external, "AGENTS.md"), "root instructions");
	await writeFile(join(external, ".pi", "AGENTS.md"), "pi instructions");
	await writeFile(join(external, "CLAUDE.md"), "claude instructions");
	await writeFile(join(external, ".agents", "skills", "review", "SKILL.md"), "---\ndescription: Review code\n---\nbody");
	await writeFile(join(external, ".pi", "skills", "plan", "SKILL.md"), "---\ndescription: Plan work\n---\nbody");
	await writeFile(join(external, "root.ts"), "root");
	await writeFile(join(external, "src", "index.ts"), "index");
	await writeFile(join(external, "src", "nested", "case.test.ts"), "test");
	await writeFile(join(external, "node_modules", "ignored", "bad.ts"), "ignored");
	await writeFile(join(external, ".git", "ignored", "bad.ts"), "ignored");
	return { root, external };
}

test("context scanning and native glob search cover external directory", async () => {
	const { root, external } = await makeFixture();
	try {
		const context = scanDirContext(external);
		assert.match(context.agentsMd ?? "", /root instructions/);
		assert.match(context.agentsMd ?? "", /pi instructions/);
		assert.equal(context.claudeMd, "claude instructions");
		assert.deepEqual([...context.skills.keys()], ["plan", "review"]);
		assert.deepEqual(collectSkillPaths([{ absolutePath: external, label: "external", addedAt: 1 }]).length, 2);

		invalidateContextCache();
		const injection = buildContextInjection([{ absolutePath: external, label: "external", addedAt: 1 }]);
		assert.match(injection, /root instructions/);
		assert.match(injection, /\/skill:review/);
		assert.match(injection, /Plan work/);

		const nested = await findFiles(external, "src/**/*.ts", 50);
		assert.deepEqual(
			new Set(nested),
			new Set([join(external, "src", "index.ts"), join(external, "src", "nested", "case.test.ts")]),
		);
		const tests = await findFiles(external, "**/*.test.ts", 50);
		assert.deepEqual(tests, [join(external, "src", "nested", "case.test.ts")]);
		assert.deepEqual(await findFiles(external, "*.ts", 1), [join(external, "root.ts")]);
		assert.equal((await findFiles(external, "bad.ts", 50)).length, 0);
		await assert.rejects(findFiles(external, "", 50), /pattern must not be blank/);
	} finally {
		await rm(root, { recursive: true, force: true });
		invalidateContextCache();
	}
});

type Handler = (event: any, ctx: ExtensionContext) => any;
type RegisteredCommand = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<any> };

function loadExtension(stateBranch: any[] = []) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const entries: unknown[] = [];
	addDirExtension({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type: "custom", customType: type, data });
		},
	} as unknown as ExtensionAPI);
	return { commands, entries, handlers, tools };
}

function context(cwd: string, branch: any[] = [], selected?: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify() {},
			input: async () => undefined,
			select: async () => selected,
			setWidget() {},
		},
		reload: async () => {},
	} as unknown as ExtensionContext;
}

test("package manifest loads only factory extensions", async () => {
	const agentDir = await tempDirectory();
	const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
	try {
		const result = spawnSync(
			process.execPath,
			[cli, "--no-extensions", "--no-skills", "--no-context-files", "--offline", "--extension", "."],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				timeout: 10_000,
			},
		);
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.ifError(result.error);
		assert.equal(result.status, 0, output);
		assert.doesNotMatch(output, /add-dir-helpers\.ts/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("commands and tools persist state, inject context, register skills, and search", async () => {
	const { root, external } = await makeFixture();
	try {
		const loaded = loadExtension();
		const ctx = context(root);
		await loaded.handlers.get("session_start")!({ type: "session_start" }, ctx);

		assert.equal(loaded.commands.has("dir-add"), true);
		assert.equal(loaded.commands.has("dir-ls"), true);
		assert.equal(loaded.commands.has("add-dir"), false);
		assert.equal(loaded.commands.has("remove-dir"), false);
		assert.equal(loaded.commands.has("dirs"), false);

		const addTool = loaded.tools.get("add_directory")!;
		const added = await addTool.execute("call-1", { path: external }, undefined, undefined, ctx);
		assert.equal(added.details.directory, resolveDir(external, root));
		assert.equal(added.details.skillCount, 2);
		assert.equal(loaded.entries.length, 1);
		assert.match(added.content[0].text, /AGENTS\.md content has been injected/);

		const resources = await loaded.handlers.get("resources_discover")!({ cwd: root }, ctx);
		assert.equal(resources.skillPaths.length, 2);
		const prompt = await loaded.handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
		assert.match(prompt.systemPrompt, /root instructions/);
		assert.match(prompt.systemPrompt, /external/);

		const search = await loaded.tools.get("search_external_files")!.execute(
			"call-2",
			{ pattern: "src/**/*.test.ts" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(search.details.totalFound, 1);
		assert.match(search.content[0].text, /case\.test\.ts/);
		await assert.rejects(addTool.execute("call-3", { path: external }, undefined, undefined, ctx), /Already added/);
		await loaded.commands.get("dir-ls")!.handler("", context(root, [], `external - ${added.details.directory}`));
		assert.equal(await loaded.handlers.get("resources_discover")!({ cwd: root }, ctx), undefined);

		const persisted = (loaded.entries[0] as { data: unknown }).data;
		const resumed = loadExtension([
			{
				type: "custom",
				customType: "add-dir:state",
				data: persisted,
			},
		]);
		const resumedContext = context(root, [
			{
				type: "custom",
				customType: "add-dir:state",
				data: persisted,
			},
		]);
		await resumed.handlers.get("session_start")!({ type: "session_start" }, resumedContext);
		const resumedResources = await resumed.handlers.get("resources_discover")!({ cwd: root }, resumedContext);
		assert.equal(resumedResources.skillPaths.length, 2);
		assert.equal(await readFile(join(external, "AGENTS.md"), "utf8"), "root instructions");
	} finally {
		await rm(root, { recursive: true, force: true });
		invalidateContextCache();
	}
});
