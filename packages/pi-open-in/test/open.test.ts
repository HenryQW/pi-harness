import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openInExtension, { configuredOpenUri } from "../extensions/open.ts";

type Command = (args: string, ctx: { cwd: string }) => Promise<void>;

test("config validation, default fallback, and safe URI omission", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-in-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configFile = join(agentDir, "config", "pi-open-in.json");
	mkdirSync(join(agentDir, "config"), { recursive: true });

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
	const open = commands.get("open")!;
	const ctx = { cwd: "/some/cwd" };

	// Missing config falls back to the default command.
	await open("", ctx);
	assert.deepEqual(execCalls.at(-1), ["code", ctx.cwd]);

	// Valid non-code command yields no URI; valid code command yields one.
	writeFileSync(configFile, `${JSON.stringify({ command: "cursor" })}\n`);
	assert.equal(configuredOpenUri(ctx.cwd), undefined);
	writeFileSync(configFile, `${JSON.stringify({ command: "code" })}\n`);
	assert.match(configuredOpenUri("/some/path") ?? "", /^vscode:\/\/file\/some\/path$/);

	// Malformed JSON and unknown keys make /open fail visibly and leave the file untouched;
	// configuredOpenUri omits the URI instead of throwing.
	for (const invalid of ["{not json", JSON.stringify({ command: "code", extra: 1 }), JSON.stringify({ command: "" })]) {
		writeFileSync(configFile, invalid);
		await assert.rejects(() => open("", ctx), /Invalid/);
		assert.equal(readFileSync(configFile, "utf8"), invalid);
		assert.equal(configuredOpenUri(ctx.cwd), undefined);
	}
});
