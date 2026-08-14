import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyConfigCommand,
	ConfigStore,
	DEFAULT_CONFIG,
	formatConfig,
	parseConfig,
} from "../internal/config.ts";

test("config commands expose a small validated settings interface", () => {
	let config = { ...DEFAULT_CONFIG };
	config = applyConfigCommand(config, "auto-submit on").config;
	config = applyConfigCommand(config, "model anthropic/claude-sonnet").config;
	config = applyConfigCommand(config, "thinking xhigh").config;
	config = applyConfigCommand(config, "tools read-only").config;
	config = applyConfigCommand(config, "split down").config;

	assert.deepEqual(config, {
		autoSubmit: true,
		model: "anthropic/claude-sonnet",
		thinkingLevel: "xhigh",
		tools: "read-only",
		split: "down",
	});
	assert.match(formatConfig(config), /auto-submit: on/);
	assert.deepEqual(applyConfigCommand(config, "reset").config, DEFAULT_CONFIG);
	assert.throws(() => applyConfigCommand(config, "model not-a-qualified-model"), /btw config/);
	assert.throws(() => applyConfigCommand(config, "tools dangerous"), /btw config/);
});

test("parseConfig fills omitted values and rejects invalid values", () => {
	assert.deepEqual(parseConfig({ autoSubmit: true }), { ...DEFAULT_CONFIG, autoSubmit: true });
	assert.deepEqual(parseConfig({ model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" }), {
		...DEFAULT_CONFIG,
		model: "openai-codex/gpt-5.6-luna",
		thinkingLevel: "max",
	});
	assert.throws(() => parseConfig({ thinkingLevel: "huge" }), /thinkingLevel/);
	assert.throws(() => parseConfig({ split: "left" }), /split/);
});

test("ConfigStore defaults to Pi's private config directory", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-btw-agent-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	});
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.equal(new ConfigStore().path, join(directory, "config", "pi-herdr-btw.json"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("ConfigStore persists private config and resets it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-btw-config-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	});
	const path = join(directory, "config.json");
	const store = new ConfigStore(path);
	const config = { ...DEFAULT_CONFIG, autoSubmit: true, tools: "none" as const };

	assert.deepEqual(await store.load(), DEFAULT_CONFIG);
	await store.save(config);
	assert.deepEqual(await store.load(), config);
	assert.equal(JSON.parse(await readFile(path, "utf8")).tools, "none");
	if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await store.reset(), DEFAULT_CONFIG);
	assert.deepEqual(await store.load(), DEFAULT_CONFIG);
});
