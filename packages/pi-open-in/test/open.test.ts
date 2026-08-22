import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import openInExtension, { configuredOpenUri } from "../extensions/open.ts";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

type Registration = {
	name: string;
	description?: string;
	handler: Command;
};

function loadCommands(
	calls: Array<{ command: string; args: string[] }>,
	result = { stdout: "", stderr: "", code: 0, killed: false },
): Map<string, Registration> {
	const commands = new Map<string, Registration>();
	openInExtension({
		registerCommand(name: string, options: { description?: string; handler: Command }) {
			commands.set(name, { name, ...options });
		},
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			return result;
		},
	} as unknown as ExtensionAPI);
	return commands;
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-open-in-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("/set-open-in saves command used by /open", async () => {
	await withAgentDir(async (agentDir) => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const notifications: string[] = [];
		const commands = loadCommands(calls);
		const ctx = {
			cwd: "/tmp/project",
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;

		assert.deepEqual([...commands.keys()], ["open", "set-open-in"]);
		assert.equal(
			commands.get("open")?.description,
			"Open the current path with the configured command",
		);
		assert.equal(
			configuredOpenUri("/tmp/project folder#1"),
			"vscode://file/tmp/project%20folder%231",
		);
		assert.equal(
			configuredOpenUri("\\\\server\\share\\project folder#1"),
			"vscode://file//server/share/project%20folder%231",
		);

		await commands.get("set-open-in")?.handler("codex", ctx);
		assert.deepEqual(
			JSON.parse(await readFile(join(agentDir, "config", "pi-open-in.json"), "utf8")),
			{ command: "codex" },
		);
		assert.deepEqual(notifications, ["Saved open-in command: codex"]);
		assert.equal(configuredOpenUri("/tmp/project"), undefined);

		await commands.get("open")?.handler("", ctx);
		assert.deepEqual(calls, [{ command: "codex", args: ["/tmp/project"] }]);
	});
});

test("/open description is static regardless of configured command", async () => {
	await withAgentDir(async (agentDir) => {
		await mkdir(join(agentDir, "config"), { recursive: true });
		await writeFile(
			join(agentDir, "config", "pi-open-in.json"),
			JSON.stringify({ command: "codex" }),
		);

		const commands = loadCommands([]);
		assert.equal(
			commands.get("open")?.description,
			"Open the current path with the configured command",
		);
	});
});

test("/open separates configured command arguments", async () => {
	await withAgentDir(async (agentDir) => {
		await mkdir(join(agentDir, "config"), { recursive: true });
		await writeFile(
			join(agentDir, "config", "pi-open-in.json"),
			JSON.stringify({ command: "open -a Cursor" }),
		);

		const calls: Array<{ command: string; args: string[] }> = [];
		const commands = loadCommands(calls);
		const ctx = { cwd: "/tmp/project" } as ExtensionCommandContext;

		await commands.get("open")!.handler("", ctx);
		assert.deepEqual(calls, [
			{ command: "open", args: ["-a", "Cursor", "/tmp/project"] },
		]);
	});
});

test("/open reports nonzero command results", async () => {
	await withAgentDir(async () => {
		const ctx = { cwd: "/tmp/project" } as ExtensionCommandContext;
		for (const [stderr, expected] of [
			["  Cursor failed\n", /Cursor failed/],
			["", /exit code 9/],
		] as Array<[string, RegExp]>) {
			const commands = loadCommands([], { stdout: "", stderr, code: 9, killed: false });
			await assert.rejects(commands.get("open")!.handler("", ctx), expected);
		}
	});
});
