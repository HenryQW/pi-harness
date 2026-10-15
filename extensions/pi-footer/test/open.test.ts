import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openInExtension, { configuredOpenUri, loadOpenInConfig } from "@henryqw/pi-footer/open-uri";

type Context = { cwd: string; hasUI: boolean; ui: { notify(message: string, type: string): void } };
type Command = (args: string, ctx: Context) => Promise<void>;
test("missing owner config uses code silently without read-time writes", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-in-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const configDir = join(agentDir, "config", "pi-open-in");
	const configFile = join(configDir, "config.json");
	const legacyConfigFile = join(agentDir, "config", "pi-open-in.json");
	mkdirSync(join(agentDir, "config"), { recursive: true });
	writeFileSync(legacyConfigFile, '{"command":"cursor"}');

	assert.deepEqual(loadOpenInConfig(agentDir), { status: "ok", source: "missing", value: { command: "code" }, issues: [] });
	assert.equal(configuredOpenUri("/some/path"), "vscode://file/some/path");
	assert.equal(existsSync(configDir), false);

	const commands = new Map<string, Command>();
	let sessionStart: ((event: unknown, ctx: Context) => void) | undefined;
	const execCalls: string[][] = [];
	const api = {
		on(event: string, handler: typeof sessionStart) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		exec: async (executable: string, args: string[]) => {
			execCalls.push([executable, ...args]);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	openInExtension(api);

	const notices: [string, string][] = [];
	const ctx: Context = {
		cwd: "/some/cwd",
		hasUI: true,
		ui: { notify: (message, type) => notices.push([message, type]) },
	};
	sessionStart!({}, ctx);
	assert.deepEqual(notices, []);
	assert.equal(existsSync(configDir), false);

	const open = commands.get("open")!;
	const setOpenIn = commands.get("set-open-in")!;
	await open("", ctx);
	assert.deepEqual(execCalls.at(-1), ["code", ctx.cwd]);

	await setOpenIn("cursor --reuse-window", ctx);
	assert.equal(readFileSync(configFile, "utf8"), '{\n  "command": "cursor --reuse-window"\n}\n');
	assert.equal(readFileSync(legacyConfigFile, "utf8"), '{"command":"cursor"}');
	assert.deepEqual(loadOpenInConfig(agentDir), { status: "ok", source: "file", value: { command: "cursor --reuse-window" }, issues: [] });
	assert.equal(configuredOpenUri(ctx.cwd), undefined);
	await open("", ctx);
	assert.deepEqual(execCalls.at(-1), ["cursor", "--reuse-window", ctx.cwd]);

	for (const [command, uri] of [
		["code", "vscode://file/some/path"],
		["code -n", "vscode://file/some/path?windowId=_blank"],
		["code --new-window", "vscode://file/some/path?windowId=_blank"],
	]) {
		writeFileSync(configFile, JSON.stringify({ command }));
		assert.equal(configuredOpenUri("/some/path"), uri);
	}

	// A bad key warns once per session and falls back to `code`; renders never notify.
	for (const [invalid, issue] of [
		["{not json", /invalid JSON/],
		['{"command":"cursor","extra":1}', /extra: unknown key/],
		['{"command":""}', /command: must be non-empty text/],
	] as const) {
		writeFileSync(configFile, invalid);
		notices.length = 0;
		const expected = invalid.includes("cursor") ? "cursor" : "code";
		assert.equal(loadOpenInConfig(agentDir).status, "ok");
		assert.equal(configuredOpenUri(ctx.cwd), expected === "code" ? "vscode://file/some/cwd" : undefined);
		assert.deepEqual(notices, []);
		await open("", ctx);
		await open("", ctx);
		assert.deepEqual(execCalls.at(-1), [expected, ctx.cwd]);
		assert.equal(notices.length, 1);
		assert.match(notices[0]![0], issue);
		assert.equal(notices[0]![1], "warning");
		assert.equal(readFileSync(configFile, "utf8"), invalid);
	}

	sessionStart!({}, ctx);
	assert.match(notices.at(-1)![0], /^pi-open-in config issues .*command: must be non-empty text/);

	// /set-open-in reports a problem in the file that it replaces.
	writeFileSync(configFile, '{"command":"code","typo":1}');
	notices.length = 0;
	await setOpenIn("zed", ctx);
	assert.deepEqual(notices, [
		[`pi-open-in config issues (${configFile}): typo: unknown key; defaults replace invalid settings.`, "warning"],
		["Saved open-in command: zed", "info"],
	]);
	assert.equal(readFileSync(configFile, "utf8"), '{\n  "command": "zed"\n}\n');
});
