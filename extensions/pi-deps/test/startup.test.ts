import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import depsExtension from "../extensions/deps.ts";

async function fixture(t: TestContext, status: object = { state: "running" }) {
	const gitDir = await mkdtemp(join(tmpdir(), "pi-deps-startup-"));
	t.after(() => rm(gitDir, { recursive: true, force: true }));
	const stateDir = join(gitDir, "pi-deps");
	const statusPath = join(stateDir, "status.json");
	await mkdir(stateDir);
	await writeFile(statusPath, JSON.stringify(status));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const ready = Promise.withResolvers<void>();
	const cleared = Promise.withResolvers<void>();
	const statuses: (string | undefined)[] = [];
	const widgets: string[][] = [];
	const notices: string[] = [];
	depsExtension({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand() {},
		exec: async () => ({ code: 0, killed: false, stdout: gitDir, stderr: "" }),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: gitDir,
		mode: "tui",
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
				if (text) ready.resolve();
				else cleared.resolve();
			},
			setWidget: (_key: string, content: string[]) => widgets.push(content),
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;
	const shutdown = () => handlers.get("session_shutdown")!({}, ctx);
	t.after(shutdown);
	return { statusPath, statuses, widgets, notices, ctx, ready: ready.promise, cleared: cleared.promise,
		start: () => handlers.get("session_start")!({}, ctx), shutdown };
}

test("install progress is dim, animated, non-blocking, and silently clears on success", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const run = await fixture(t);
	await run.start(); // A later session_start handler can run immediately.
	await run.ready;
	assert.match(run.statuses.at(-1)!, /^<dim>⠋ deps · installing 0s<\/dim>$/);
	t.mock.timers.tick(100);
	assert.match(run.statuses.at(-1)!, /⠙ deps · installing 0s/);
	t.mock.timers.tick(1100);
	assert.match(run.statuses.at(-1)!, /installing 1s/);
	await writeFile(run.statusPath, JSON.stringify({ state: "ok" }));
	await run.cleared;
	assert.deepEqual(run.widgets, []);
	assert.deepEqual(run.notices, []);
	await assert.rejects(readFile(run.statusPath), { code: "ENOENT" });
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
});

test("failed installs retain a visible error and log path without a success widget", async (t) => {
	const run = await fixture(t, { state: "error", message: "pnpm exited 1" });
	await run.start();
	await run.cleared;
	assert.match(run.widgets[0]![0]!, /install failed: pnpm exited 1/);
	assert.match(run.widgets[0]![1]!, /pi-deps\/install\.log$/);
	assert.equal(run.statuses.at(-1), undefined);
});

test("shutdown clears progress and leaves the installer result unconsumed", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const run = await fixture(t);
	await run.start();
	await run.ready;
	await run.shutdown();
	await run.cleared;
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	await setImmediate();
	assert.equal(run.statuses.length, count);
	assert.deepEqual(run.notices, []);
	assert.equal(JSON.parse(await readFile(run.statusPath, "utf8")).state, "running");
});

test("the ten-minute watch limit clears the spinner and explains how to check the install", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const run = await fixture(t);
	await run.start();
	await run.ready;
	t.mock.timers.tick(10 * 60_000);
	await run.cleared;
	assert.match(run.widgets[0]![0]!, /stopped waiting.*ten minutes.*check the log/);
	assert.match(run.widgets[0]![1]!, /install\.log$/);
});
