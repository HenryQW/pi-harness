import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildContextInjection, collectSkillPaths, findFiles, scanDirContext } from "../extensions/add-dir-helpers.ts";
import addDirExtension from "../extensions/add-dir.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function loadExtension(): {
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	sentMessages: Array<{ content: string; expandPromptTemplates?: boolean }>;
	tools: Map<string, RegisteredTool>;
} {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sentMessages: Array<{ content: string; expandPromptTemplates?: boolean }> = [];
	const tools = new Map<string, RegisteredTool>();
	addDirExtension({
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		appendEntry() {},
		sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }) {
			sentMessages.push({ content, expandPromptTemplates: options?.expandPromptTemplates });
		},
	} as unknown as ExtensionAPI);
	return { commands, handlers, sentMessages, tools };
}

function extensionContext(cwd: string, getBranch: () => unknown[], reload = async () => {}): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch },
		ui: { setWidget() {} },
		reload,
	} as unknown as ExtensionContext;
}

test("registers external skills without duplicating Pi's skill prompt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const skill = join(dir, ".pi", "skills", "demo", "SKILL.md");
		await mkdir(join(skill, ".."), { recursive: true });
		await writeFile(join(dir, "AGENTS.md"), "Follow external instructions.\n");
		await writeFile(skill, "---\ndescription: Native Pi skill\n---\n");

		const added = [{ absolutePath: dir, label: "external" }];
		assert.deepEqual(collectSkillPaths(added), [skill]);
		assert.deepEqual([...scanDirContext(dir).skills], ["demo"]);
		const injection = buildContextInjection(added);
		assert.match(injection, /Follow external instructions/);
		assert.doesNotMatch(injection, /Native Pi skill|Skills from/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("finds files recursively while skipping dependency and Git trees", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const matches = [join(dir, "src", "main.ts"), join(dir, ".hidden", "config.ts")];
		for (const file of [...matches, join(dir, "node_modules", "ignored.ts"), join(dir, ".git", "ignored.ts")]) {
			await mkdir(join(file, ".."), { recursive: true });
			await writeFile(file, "");
		}

		assert.deepEqual((await findFiles(dir, "*.ts", 10)).sort(), matches.sort());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ignores symbolic links and their descendants when finding files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	const target = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const included = join(root, "src", "main.ts");
		await mkdir(join(included, ".."), { recursive: true });
		await mkdir(join(target, "nested"), { recursive: true });
		await writeFile(included, "");
		await writeFile(join(target, "nested", "linked.ts"), "");
		await symlink(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

		assert.deepEqual(await findFiles(root, "*.ts", 10), [included]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test("returns no results when an external directory disappears", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	await rm(dir, { recursive: true, force: true });
	assert.deepEqual(await findFiles(dir, "*.ts", 1), []);
});

test("rejects an ancestor of the current working directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const cwd = join(root, "project");
		await mkdir(cwd);
		const { tools } = loadExtension();
		const addDirectory = tools.get("add_directory")!;

		await assert.rejects(
			addDirectory.execute("call", { path: root }, undefined, undefined, extensionContext(cwd, () => [])),
			/overlaps current working directory scope/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("queues a resource reload when tree navigation changes added directories", async () => {
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		let branch: unknown[] = [
			{
				type: "custom",
				customType: "add-dir:state",
				data: { dirs: [{ absolutePath: external, label: "external" }] },
			},
		];
		let reloads = 0;
		const { commands, handlers, sentMessages } = loadExtension();
		const ctx = extensionContext(process.cwd(), () => branch, async () => {
			reloads += 1;
		});

		await handlers.get("session_start")!({}, ctx);
		await handlers.get("session_tree")!({}, ctx);
		assert.deepEqual(sentMessages, []);

		branch = [];
		await handlers.get("session_tree")!({}, ctx);
		assert.deepEqual(sentMessages, [{ content: "/dir-reload", expandPromptTemplates: true }]);
		await commands.get("dir-reload")!.handler("", ctx as ExtensionCommandContext);
		assert.equal(reloads, 1);
	} finally {
		await rm(external, { recursive: true, force: true });
	}
});

test("reports non-missing filesystem failures", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const loop = join(root, "loop");
		await symlink("loop", loop);
		const { tools } = loadExtension();

		await assert.rejects(
			tools.get("add_directory")!.execute(
				"call",
				{ path: loop },
				undefined,
				undefined,
				extensionContext(process.cwd(), () => []),
			),
			/Cannot access directory:.*(?:ELOOP|too many symbolic links)/i,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
