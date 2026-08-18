import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
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
	config = applyConfigCommand(config, "tools read-only").config;
	config = applyConfigCommand(config, "split down").config;

	assert.deepEqual(config, {
		autoSubmit: true,
		tools: "read-only",
		split: "down",
	});
	assert.match(formatConfig(config), /auto-submit: on/);
	assert.deepEqual(applyConfigCommand(config, "reset").config, DEFAULT_CONFIG);
	assert.throws(() => applyConfigCommand(config, "model provider/model"), /btw config/);
	assert.throws(() => applyConfigCommand(config, "tools dangerous"), /btw config/);
});

test("parseConfig fills omitted values and rejects invalid values", () => {
	assert.deepEqual(parseConfig({ autoSubmit: true }), { ...DEFAULT_CONFIG, autoSubmit: true });
	assert.deepEqual(parseConfig({ tools: "none", split: "down" }), {
		...DEFAULT_CONFIG,
		tools: "none",
		split: "down",
	});
	assert.throws(() => parseConfig({ tools: "dangerous" }), /tools/);
	assert.throws(() => parseConfig({ model: "provider/model" }), /unknown config key/);
	assert.throws(() => parseConfig({ split: "left" }), /split/);
});

test("ConfigStore serializes read-modify-write updates", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-btw-config-lock-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	});
	const path = join(directory, "config.json");
	const first = new ConfigStore(path);
	const second = new ConfigStore(path);
	await first.save(DEFAULT_CONFIG);

	await Promise.all([
		first.update((config) => ({ ...config, autoSubmit: true })),
		second.update((config) => ({ ...config, tools: "none" })),
	]);

	assert.deepEqual(await first.load(), {
		...DEFAULT_CONFIG,
		autoSubmit: true,
		tools: "none",
	});
});

test("ConfigStore reclaims a stale lock without recursive deletion", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-btw-config-stale-lock-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	});
	const path = join(directory, "config.json");
	const lockPath = `${path}.lock`;
	await mkdir(lockPath, { mode: 0o700 });
	await writeFile(join(lockPath, "owner-stale"), "stale", { encoding: "utf8", mode: 0o600 });
	const stale = new Date(Date.now() - 60_000);
	await utimes(lockPath, stale, stale);

	const store = new ConfigStore(path);
	await store.save({ ...DEFAULT_CONFIG, tools: "none" });

	assert.deepEqual(await store.load(), { ...DEFAULT_CONFIG, tools: "none" });
	await assert.rejects(lstat(lockPath), { code: "ENOENT" });
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
