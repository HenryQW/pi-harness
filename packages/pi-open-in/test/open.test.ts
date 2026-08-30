import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openInExtension, { configuredOpenUri, loadOpenInConfig } from "../extensions/open.ts";

type Context = { cwd: string; ui: { notify(message: string, type: string): void } };
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

	assert.deepEqual(loadOpenInConfig(agentDir), { source: "missing", value: { command: "code" } });
	assert.equal(configuredOpenUri("/some/path"), "vscode://file/some/path");
	assert.equal(existsSync(configDir), false);

	const commands = new Map<string, Command>();
	const execCalls: string[][] = [];
	const api = {
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		exec: async (executable: string, args: string[]) => {
			execCalls.push([executable, ...args]);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	openInExtension(api);

	const ctx: Context = {
		cwd: "/some/cwd",
		ui: { notify: () => {} },
	};
	assert.equal(existsSync(configDir), false);

	const open = commands.get("open")!;
	const setOpenIn = commands.get("set-open-in")!;
	await open("", ctx);
	assert.deepEqual(execCalls.at(-1), ["code", ctx.cwd]);

	await setOpenIn("cursor --reuse-window", ctx);
	assert.equal(readFileSync(configFile, "utf8"), '{\n  "command": "cursor --reuse-window"\n}\n');
	assert.equal(readFileSync(legacyConfigFile, "utf8"), '{"command":"cursor"}');
	assert.deepEqual(loadOpenInConfig(agentDir), { source: "file", value: { command: "cursor --reuse-window" } });
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

	for (const invalid of ["{not json", '{"command":"code","extra":1}', '{"command":""}']) {
		writeFileSync(configFile, invalid);
		assert.throws(() => loadOpenInConfig(agentDir));
		await assert.rejects(() => open("", ctx));
		assert.equal(readFileSync(configFile, "utf8"), invalid);
		assert.equal(configuredOpenUri(ctx.cwd), undefined);
	}
});
