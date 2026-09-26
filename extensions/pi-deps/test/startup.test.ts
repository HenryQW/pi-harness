import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import depsExtension from "../extensions/deps.ts";

test("a running install does not delay later session_start handlers", async () => {
	const gitDir = await mkdtemp(join(tmpdir(), "pi-deps-startup-"));
	const stateDir = join(gitDir, "pi-deps");
	const statusPath = join(stateDir, "status.json");
	await mkdir(stateDir);
	await writeFile(statusPath, JSON.stringify({ state: "running" }));
	const handlers: Array<(event: { type: "session_start" }, ctx: ExtensionContext) => Promise<void> | void> = [];
	let widgetStarted!: () => void;
	const widgetReady = new Promise<void>((resolve) => { widgetStarted = resolve; });
	let footerStarted = false;
	const pi = {
		on(event: string, handler: (event: { type: "session_start" }, ctx: ExtensionContext) => Promise<void> | void) {
			if (event === "session_start") handlers.push(handler);
		},
		registerCommand() {},
		exec: async () => ({ code: 0, killed: false, stdout: gitDir, stderr: "" }),
	} as unknown as ExtensionAPI;
	depsExtension(pi);
	handlers.push(() => { footerStarted = true; });
	const ctx = {
		cwd: gitDir,
		mode: "tui",
		ui: { setWidget: () => widgetStarted() },
	} as unknown as ExtensionContext;
	const startup = (async () => {
		for (const handler of handlers) await handler({ type: "session_start" }, ctx);
	})();
	try {
		await widgetReady;
		await setImmediate();
		assert.equal(footerStarted, true);
	} finally {
		await writeFile(statusPath, JSON.stringify({ state: "ok" }));
		await startup;
		await rm(gitDir, { recursive: true, force: true });
	}
});
