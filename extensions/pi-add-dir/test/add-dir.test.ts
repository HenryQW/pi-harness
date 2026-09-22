import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { buildContextInjection, collectSkillPaths, findFiles, resolveDir, scanDirContext } from "../extensions/add-dir-helpers.ts";
import { createAddDirConfigStore } from "../extensions/add-dir-config.ts";
import addDirExtension, { createExternalAutocompleteProvider } from "../extensions/add-dir.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface ExecResult {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

const execFileAsync = promisify(execFile);

async function realExec(command: string, args: string[], options: { cwd?: string } = {}): Promise<ExecResult> {
	try {
		const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
		return { code: 0, killed: false, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string };
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			killed: failure.killed ?? false,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
		};
	}
}

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await realExec("git", args, { cwd });
	assert.equal(result.code, 0, result.stderr);
}

async function defaultExec(_command: string, args: string[], options: { cwd?: string } = {}): Promise<ExecResult> {
	if (options.cwd === process.cwd() && args[0] === "rev-parse") {
		return { code: 0, killed: false, stdout: "true\n", stderr: "" };
	}
	if (options.cwd === process.cwd() && args[0] === "config" && args.includes("--get-all")) {
		return { code: 1, killed: false, stdout: "", stderr: "" };
	}
	return { code: 128, killed: false, stdout: "", stderr: "not a git repository" };
}

function loadExtension(options: {
	agentDir?: string;
	exec?: (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;
} = {}): {
	appendedEntries: Array<{ customType: string; data: unknown }>;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	sentMessages: Array<{ content: string; expandPromptTemplates?: boolean }>;
	tools: Map<string, RegisteredTool>;
} {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
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
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
		exec: options.exec ?? defaultExec,
		sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }) {
			sentMessages.push({ content, expandPromptTemplates: options?.expandPromptTemplates });
		},
	} as unknown as ExtensionAPI, { agentDir: options.agentDir ?? join(tmpdir(), `pi-add-dir-test-${process.pid}`) });
	return { appendedEntries, commands, handlers, sentMessages, tools };
}

function extensionContext(cwd: string, getBranch: () => unknown[], reload = async () => {}): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch },
		ui: { addAutocompleteProvider() {}, setWidget() {} },
		reload,
	} as unknown as ExtensionContext;
}

function interactiveContext(
	cwd: string,
	getBranch: () => unknown[],
	options: {
		notifications?: Array<{ message: string; level: string }>;
		reload?: () => Promise<void>;
		select?: (title: string, choices: string[]) => Promise<string | undefined>;
	} = {},
): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		sessionManager: { getBranch },
		ui: {
			addAutocompleteProvider() {},
			setWidget() {},
			notify(message: string, level: string) {
				options.notifications?.push({ message, level });
			},
			async input() {
				return undefined;
			},
			select: options.select ?? (async () => undefined),
		},
		reload: options.reload ?? (async () => {}),
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

test("injects external context through a stable named prompt section", async () => {
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		await writeFile(join(external, "AGENTS.md"), "Follow external instructions.\n");
		const branch = [{
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: external, label: "external" }] },
		}];
		const { handlers } = loadExtension();
		await handlers.get("session_start")!({}, extensionContext(process.cwd(), () => branch));
		const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };

		assert.equal(await handlers.get("before_agent_start")!(event, {} as ExtensionContext), undefined);
		assert.equal(event.systemPrompt, "base");
		assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["pi_add_dir"]);
		assert.match(event.systemPromptOptions.sections.pi_add_dir!, /External Directories.*Follow external instructions/s);
	} finally {
		await rm(external, { recursive: true, force: true });
	}
});

test("includes added directories in @ file autocomplete", async () => {
	const external = join(tmpdir(), "external project");
	const externalPrefix = `@"${join(external, "query")}`;
	const seenPrefixes: string[] = [];
	const current: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol) {
			const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/@.*$/)?.[0] ?? "";
			seenPrefixes.push(prefix);
			if (prefix === "@query") {
				return {
					prefix,
					items: [
						{ value: "@local.ts", label: "local.ts" },
						{ value: "@local-test.ts", label: "local-test.ts" },
					],
				};
			}
			if (prefix === externalPrefix) {
				return {
					prefix,
					items: [{ value: `@"${join(external, "result.ts")}"`, label: "result.ts" }],
				};
			}
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const provider = createExternalAutocompleteProvider(current, () => [
		{ absolutePath: external, label: "external" },
	]);

	const suggestions = await provider.getSuggestions(["attach @query"], 0, 13, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(seenPrefixes, ["@query", externalPrefix]);
	assert.deepEqual(suggestions, {
		prefix: "@query",
		items: [
			{ value: "@local.ts", label: "local.ts" },
			{
				value: `@"${join(external, "result.ts")}"`,
				label: "result.ts",
				description: `external: @"${join(external, "result.ts")}"`,
			},
			{ value: "@local-test.ts", label: "local-test.ts" },
		],
	});
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

test("propagates abort reasons that resemble missing paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	await rm(dir, { recursive: true, force: true });
	const controller = new AbortController();
	const reason = { code: "ENOENT" };
	const search = findFiles(dir, "*.ts", 1, controller.signal);
	queueMicrotask(() => controller.abort(reason));
	await assert.rejects(search, (error) => error === reason);
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

test("loads global directories in a fresh session", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-add-dir-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-external-"));
	try {
		await writeFile(join(external, "AGENTS.md"), "Global external instructions.\n");
		await createAddDirConfigStore(agentDir).save({ directories: [external] });
		const { handlers } = loadExtension({ agentDir });
		await handlers.get("session_start")!({}, extensionContext(cwd, () => []));
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, {} as ExtensionContext);
		assert.match(event.systemPromptOptions.sections.pi_add_dir!, /Global external instructions/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
		await rm(external, { recursive: true, force: true });
	}
});

test("shares project directories across linked Git worktrees", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-git-"));
	const main = join(root, "main");
	const linked = join(root, "linked");
	const external = join(root, "external");
	const agentDir = join(root, "agent");
	try {
		await mkdir(main);
		await mkdir(external);
		await writeFile(join(external, "AGENTS.md"), "Shared worktree instructions.\n");
		await git(main, ["init", "-q"]);
		await git(main, ["config", "user.email", "test@example.com"]);
		await git(main, ["config", "user.name", "Test"]);
		await git(main, ["commit", "--allow-empty", "-qm", "init"]);
		await git(main, ["worktree", "add", "-q", "-b", "linked", linked]);
		await git(main, ["config", "--local", "--add", "pi-add-dir.directory", external]);

		const { handlers } = loadExtension({ agentDir, exec: realExec });
		await handlers.get("session_start")!({}, extensionContext(linked, () => []));
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, {} as ExtensionContext);
		assert.match(event.systemPromptOptions.sections.pi_add_dir!, /Shared worktree instructions/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a project Git config value containing a newline", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-git-newline-"));
	const repo = join(root, "repo");
	const external = join(root, "external");
	try {
		await mkdir(repo);
		await mkdir(external);
		await git(repo, ["init", "-q"]);
		await git(repo, ["config", "--local", "--add", "pi-add-dir.directory", `${external}\n/etc`]);
		const { handlers } = loadExtension({ agentDir: join(root, "agent"), exec: realExec });
		await assert.rejects(
			handlers.get("session_start")!({}, extensionContext(repo, () => [])),
			/Invalid project pi-add-dir configuration/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps concurrent project additions idempotent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-concurrent-"));
	const repo = join(root, "repo");
	const external = join(root, "external");
	try {
		await mkdir(repo);
		await mkdir(external);
		await git(repo, ["init", "-q"]);
		const first = loadExtension({ agentDir: join(root, "agent-1"), exec: realExec });
		const second = loadExtension({ agentDir: join(root, "agent-2"), exec: realExec });
		const firstNotifications: Array<{ message: string; level: string }> = [];
		const secondNotifications: Array<{ message: string; level: string }> = [];
		const firstCtx = interactiveContext(repo, () => [], { notifications: firstNotifications });
		const secondCtx = interactiveContext(repo, () => [], { notifications: secondNotifications });
		await Promise.all([
			first.handlers.get("session_start")!({}, firstCtx),
			second.handlers.get("session_start")!({}, secondCtx),
		]);
		await Promise.all([
			first.commands.get("dir-add")!.handler(`--project ${external}`, firstCtx as ExtensionCommandContext),
			second.commands.get("dir-add")!.handler(`--project ${external}`, secondCtx as ExtensionCommandContext),
		]);
		const result = await realExec("git", ["config", "--local", "--get-all", "pi-add-dir.directory"], { cwd: repo });
		assert.equal(result.code, 0);
		assert.deepEqual(result.stdout.trim().split(/\r?\n/), [resolveDir(external, repo)]);
		assert.deepEqual(firstNotifications.map(({ level }) => level), ["info"]);
		assert.deepEqual(secondNotifications.map(({ level }) => level), ["info"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps concurrent global additions idempotent", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-global-concurrent-"));
	const cwd = join(root, "project");
	const external = join(root, "external");
	const agentDir = join(root, "agent");
	try {
		await mkdir(cwd);
		await mkdir(external);
		const first = loadExtension({ agentDir });
		const second = loadExtension({ agentDir });
		const firstNotifications: Array<{ message: string; level: string }> = [];
		const secondNotifications: Array<{ message: string; level: string }> = [];
		const firstCtx = interactiveContext(cwd, () => [], { notifications: firstNotifications });
		const secondCtx = interactiveContext(cwd, () => [], { notifications: secondNotifications });
		await Promise.all([
			first.handlers.get("session_start")!({}, firstCtx),
			second.handlers.get("session_start")!({}, secondCtx),
		]);
		await Promise.all([
			first.commands.get("dir-add")!.handler(`--global ${external}`, firstCtx as ExtensionCommandContext),
			second.commands.get("dir-add")!.handler(`--global ${external}`, secondCtx as ExtensionCommandContext),
		]);
		assert.deepEqual(createAddDirConfigStore(agentDir).loadSync().value.directories, [resolveDir(external, cwd)]);
		assert.deepEqual(firstNotifications.map(({ level }) => level), ["info"]);
		assert.deepEqual(secondNotifications.map(({ level }) => level), ["info"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reloads when a concurrent global update changes external skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-global-resources-"));
	const cwd = join(root, "project");
	const skillDir = join(root, "skills");
	const plainDir = join(root, "plain");
	const agentDir = join(root, "agent");
	let reloads = 0;
	try {
		await mkdir(cwd);
		await mkdir(join(skillDir, ".pi", "skills", "demo"), { recursive: true });
		await mkdir(plainDir);
		await writeFile(join(skillDir, ".pi", "skills", "demo", "SKILL.md"), "---\ndescription: Demo\n---\n");
		const { commands, handlers } = loadExtension({ agentDir });
		const ctx = interactiveContext(cwd, () => [], {
			reload: async () => {
				reloads += 1;
			},
		});
		await handlers.get("session_start")!({}, ctx);
		await createAddDirConfigStore(agentDir).save({ directories: [resolveDir(skillDir, cwd)] });
		await commands.get("dir-add")!.handler(`--global ${plainDir}`, ctx as ExtensionCommandContext);
		assert.equal(reloads, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retries transient project config lock contention", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-external-"));
	let mutationAttempts = 0;
	let saved = false;
	try {
		const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
			if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
			if (args.includes("--get-all")) {
				return { code: saved ? 0 : 1, killed: false, stdout: saved ? `${resolveDir(external, cwd)}\0` : "", stderr: "" };
			}
			mutationAttempts += 1;
			if (mutationAttempts === 1) {
				return { code: 3, killed: false, stdout: "", stderr: "could not lock config file .git/config: File exists" };
			}
			saved = true;
			return { code: 0, killed: false, stdout: "", stderr: "" };
		};
		const notifications: Array<{ message: string; level: string }> = [];
		const { commands, handlers } = loadExtension({ exec });
		const ctx = interactiveContext(cwd, () => [], { notifications });
		await handlers.get("session_start")!({}, ctx);
		await commands.get("dir-add")!.handler(`--project ${external}`, ctx as ExtensionCommandContext);
		assert.equal(mutationAttempts, 2);
		assert.equal(notifications.at(-1)?.level, "info");
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(external, { recursive: true, force: true });
	}
});

test("promotes a session directory to global scope", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-add-dir-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-external-"));
	try {
		const branch = [{
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: external, label: "external" }] },
		}];
		const notifications: Array<{ message: string; level: string }> = [];
		const { appendedEntries, commands, handlers } = loadExtension({ agentDir });
		const ctx = interactiveContext(cwd, () => branch, { notifications });
		await handlers.get("session_start")!({}, ctx);
		await commands.get("dir-add")!.handler(`--global ${external}`, ctx as ExtensionCommandContext);

		assert.deepEqual(createAddDirConfigStore(agentDir).loadSync().value.directories, [resolveDir(external, cwd)]);
		assert.deepEqual(appendedEntries.at(-1), { customType: "add-dir:state", data: { dirs: [] } });
		assert.match(notifications.at(-1)!.message, /global scope/);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
		await rm(external, { recursive: true, force: true });
	}
});

test("uses session then project then global precedence for duplicate configured paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-precedence-"));
	const repo = join(root, "repo");
	const external = join(root, "external");
	const agentDir = join(root, "agent");
	try {
		await mkdir(repo);
		await mkdir(external);
		await git(repo, ["init", "-q"]);
		await git(repo, ["config", "--local", "--add", "pi-add-dir.directory", external]);
		await git(repo, ["config", "--local", "--add", "pi-add-dir.directory", external]);
		await createAddDirConfigStore(agentDir).save({ directories: [external] });
		const branch = [{
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: external, label: "external" }] },
		}];
		let choices: string[] = [];
		const { commands, handlers } = loadExtension({ agentDir, exec: realExec });
		const ctx = interactiveContext(repo, () => branch, {
			select: async (_title, values) => {
				choices = values;
				return undefined;
			},
		});
		await handlers.get("session_start")!({}, ctx);
		await commands.get("dir-ls")!.handler("", ctx as ExtensionCommandContext);
		assert.match(choices[0]!, /^\[session\]/);
		assert.match(choices[1]!, /^\[project\].*shadowed by session scope/);
		assert.match(choices[2]!, /^\[global\].*shadowed by session scope/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("removes the exact project path from local Git config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-remove-"));
	const repo = join(root, "repo");
	const external = join(root, "external[one]");
	try {
		await mkdir(repo);
		await mkdir(external);
		await git(repo, ["init", "-q"]);
		await git(repo, ["config", "--local", "--add", "pi-add-dir.directory", external]);
		const { commands, handlers } = loadExtension({ agentDir: join(root, "agent"), exec: realExec });
		const ctx = interactiveContext(repo, () => [], {
			select: async (_title, choices) => choices.find((choice) => choice.startsWith("[project]")),
		});
		await handlers.get("session_start")!({}, ctx);
		await commands.get("dir-ls")!.handler("", ctx as ExtensionCommandContext);
		const result = await realExec("git", ["config", "--local", "--get-all", "pi-add-dir.directory"], { cwd: repo });
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects project persistence outside a Git repository", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const external = await mkdtemp(join(tmpdir(), "pi-add-dir-external-"));
	try {
		const notifications: Array<{ message: string; level: string }> = [];
		const { commands, handlers } = loadExtension();
		const ctx = interactiveContext(cwd, () => [], { notifications });
		await handlers.get("session_start")!({}, ctx);
		await commands.get("dir-add")!.handler(`--project ${external}`, ctx as ExtensionCommandContext);
		assert.deepEqual(notifications.at(-1), {
			message: "Project-persistent directories require a Git repository.",
			level: "error",
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(external, { recursive: true, force: true });
	}
});

test("surfaces Git failures inside a discovered repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-broken-git-"));
	try {
		await mkdir(join(root, ".git"));
		const { handlers } = loadExtension({
			exec: async () => ({ code: 128, killed: false, stdout: "", stderr: "permission denied" }),
		});
		await assert.rejects(
			handlers.get("session_start")!({}, extensionContext(root, () => [])),
			/Cannot inspect Git repository: permission denied/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("warns and preserves missing or overlapping global directories", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-add-dir-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const missing = join(agentDir, "missing");
	try {
		await createAddDirConfigStore(agentDir).save({ directories: [missing, cwd] });
		const notifications: Array<{ message: string; level: string }> = [];
		const { handlers } = loadExtension({ agentDir });
		await handlers.get("session_start")!({}, interactiveContext(cwd, () => [], { notifications }));
		assert.equal(notifications.filter(({ level }) => level === "warning").length, 2);
		assert.deepEqual(createAddDirConfigStore(agentDir).loadSync().value.directories, [missing, cwd]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("writes skipped-directory warnings to stderr without UI", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-add-dir-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const missing = join(agentDir, "missing");
	const messages: string[] = [];
	const originalConsoleError = console.error;
	try {
		await createAddDirConfigStore(agentDir).save({ directories: [missing] });
		console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
		const { handlers } = loadExtension({ agentDir });
		await handlers.get("session_start")!({}, extensionContext(cwd, () => []));
		assert.deepEqual(messages, [`pi-add-dir: Skipped global external directory ${missing}: directory does not exist.`]);
	} finally {
		console.error = originalConsoleError;
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});

test("does not overwrite malformed global configuration", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-add-dir-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-add-dir-project-"));
	const configPath = join(agentDir, "config", "pi-add-dir", "config.json");
	try {
		await mkdir(join(configPath, ".."), { recursive: true });
		await writeFile(configPath, "{broken\n");
		const { handlers } = loadExtension({ agentDir });
		await assert.rejects(
			handlers.get("session_start")!({}, extensionContext(cwd, () => [])),
			/Cannot load pi-add-dir global config/,
		);
		assert.equal(await readFile(configPath, "utf8"), "{broken\n");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
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
