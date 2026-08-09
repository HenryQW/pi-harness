import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import modelThinkingExtension from "../extensions/model-thinking.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;

test("persists and applies model thinking levels", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-model-thinking-"));
	const configFile = join(agentDir, "config", "model-thinking.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const handlers = new Map<string, Handler>();
		let command: Command | undefined;
		let commandName: string | undefined;
		const levels: string[] = [];
		let status = "";
		modelThinkingExtension({
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, options: { handler: Command }) {
				commandName = name;
				command = options.handler;
			},
			getThinkingLevel: () => levels.at(-1) ?? "off",
			setThinkingLevel: (level: string) => levels.push(level),
		} as unknown as ExtensionAPI);

		const model = { provider: "openai-codex", id: "gpt-test" };
		let selected = "high";
		const ctx = {
			model,
			ui: {
				select: async () => selected,
				notify(message: string) {
					status = message;
				},
			},
		} as unknown as ExtensionContext;

		assert.equal(commandName, "model-thinking");
		await command?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { "openai-codex/gpt-test": "high" });
		assert.deepEqual(levels, ["high"]);

		levels.length = 0;
		handlers.get("session_start")?.({}, ctx);
		assert.deepEqual(levels, ["high"]);

		levels.length = 0;
		status = "";
		await handlers.get("model_select")?.({ model }, ctx);
		status = `Model: ${model.id}`; // Pi writes its own status after model_select handlers finish.
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(levels, ["high"]);
		assert.equal(status, "Model Thinking auto set thinking to high.");

		status = "";
		await handlers.get("model_select")?.({ model, previousModel: { provider: "other", id: "model" } }, ctx);
		status = `Model: ${model.id}`;
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(status, "Model Thinking auto set thinking to high.");

		selected = "unknown";
		await command?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { "openai-codex/gpt-test": "high" });

		selected = "Use current level";
		await command?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), {});

		await writeFile(configFile, "{broken");
		selected = "low";
		await command?.("", ctx);
		assert.equal(await readFile(configFile, "utf8"), "{broken");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
});
