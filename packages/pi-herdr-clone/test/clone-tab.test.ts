import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import herdrCloneExtension from "../extensions/clone-tab.ts";

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type ExecCall = { command: string; args: string[]; options: { cwd: string } };
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const success = (value: unknown = ""): ExecResult => ({
	stdout: typeof value === "string" ? value : JSON.stringify(value),
	stderr: "",
	code: 0,
	killed: false,
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-clone-"));
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	await mkdir(cwd);
	const manager = SessionManager.create(cwd, sessionDir);
	const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	const activeId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "active" }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	manager.branch(rootId);
	const siblingId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "sibling" }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 3,
	});
	manager.branch(activeId);
	return { root, cwd, sessionDir, manager, activeId, siblingId, sessionFile: manager.getSessionFile()! };
}

function harness(
	sessionManager: ExtensionCommandContext["sessionManager"],
	cwd: string,
	respond?: (args: string[]) => Promise<ExecResult> | ExecResult,
) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const events: string[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "clone-tab") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			calls.push({ command: executable, args, options });
			events.push(`exec:${args.slice(0, 2).join(" ")}`);
			if (respond) return await respond(args);
			if (args[0] === "pane" && args[1] === "get") {
				return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
			}
			if (args[0] === "tab" && args[1] === "create") {
				return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
			}
			return success();
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		sessionManager,
		waitForIdle: async () => { events.push("waitForIdle"); },
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;
	herdrCloneExtension(api);
	assert.ok(command);
	return { command, ctx, calls, events, notifications };
}

async function withEnvironment(
	herdrEnv: string | undefined,
	paneId: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousPaneId = process.env.HERDR_PANE_ID;
	if (herdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = herdrEnv;
	if (paneId === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = paneId;
	try {
		await run();
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPaneId;
	}
}

async function withPane(value: string | undefined, run: () => Promise<void>): Promise<void> {
	await withEnvironment("1", value, run);
}

test("/clone-tab retries a briefly busy root pane, copies only the active path, and launches exact Herdr argv", async () => {
	const data = await fixture();
	try {
		const activeCwd = join(data.root, "active-project");
		await mkdir(activeCwd);
		await withPane("pane-alias", async () => {
			const before = await readFile(data.sessionFile, "utf8");
			let starts = 0;
			const app = harness(data.manager, activeCwd, (args) => {
				if (args[0] === "pane") {
					return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				}
				if (args[0] === "tab" && args[1] === "create") {
					return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
				}
				if (args[0] === "agent") {
					starts += 1;
					return starts === 1
						? { stdout: JSON.stringify({ error: { code: "agent_pane_busy" } }), stderr: "", code: 1, killed: false }
						: success();
				}
				return success();
			});
			await app.command("", app.ctx);

			assert.deepEqual(app.events, [
				"waitForIdle",
				"exec:pane get",
				"exec:tab create",
				"exec:agent start",
				"exec:agent start",
				"exec:tab focus",
			]);
			assert.ok(app.calls.every((call) => call.command === "herdr" && call.options.cwd === activeCwd));
			assert.deepEqual(app.calls[0].args, ["pane", "get", "pane-alias"]);
			assert.deepEqual(app.calls[1].args, [
				"tab", "create", "--workspace", "workspace-live", "--cwd", activeCwd, "--no-focus",
			]);
			const startCalls = app.calls.filter((call) => call.args[0] === "agent");
			assert.equal(startCalls.length, 2);
			assert.deepEqual(startCalls[0].args, startCalls[1].args);
			const start = startCalls[0].args;
			assert.match(start[2]!, /^clone-[a-f0-9]{24}$/);
			assert.deepEqual(start.slice(0, 2), ["agent", "start"]);
			assert.deepEqual(start.slice(3, 8), ["--kind", "pi", "--pane", "pane-root", "--"]);
			assert.equal(start[8], "--session");
			const cloneFile = start[9]!;
			assert.equal(cloneFile.startsWith("/"), true);
			assert.deepEqual(app.calls[4].args, ["tab", "focus", "tab-new"]);
			await stat(cloneFile);

			const clone = SessionManager.open(cloneFile);
			assert.notEqual(data.manager.getHeader()?.cwd, activeCwd);
			assert.equal(clone.getHeader()?.cwd, activeCwd);
			const text = clone.getEntries().flatMap((entry) => {
				if (entry.type !== "message" || !("content" in entry.message)) return [];
				const content = entry.message.content;
				return typeof content === "string"
					? [content]
					: content.flatMap((part) => part.type === "text" ? [part.text] : []);
			});
			assert.deepEqual(text, ["root", "active"]);
			assert.equal(clone.getEntry(data.siblingId), undefined);
			assert.equal(data.manager.getLeafId(), data.activeId);
			assert.equal(await readFile(data.sessionFile, "utf8"), before);
			assert.equal(app.notifications[0]?.type, "info");
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("trust-boundary failures prevent agent launch and failed tab creation removes the clone", async (t) => {
	const data = await fixture();
	try {
		await t.test("missing or wrong HERDR_ENV stops before Herdr", async () => {
			for (const herdrEnv of [undefined, "0"] as const) {
				await withEnvironment(herdrEnv, "pane-current", async () => {
					const app = harness(data.manager, data.cwd);
					await assert.rejects(app.command("", app.ctx), /inside Herdr.*HERDR_ENV=1/);
					assert.deepEqual(app.calls, []);
				});
			}
		});

		await t.test("missing launch prerequisites stop before Herdr", async () => {
			for (const [pane, sessionFile, leaf, expected] of [
				[undefined, data.sessionFile, data.activeId, /HERDR_PANE_ID/],
				["pane-current", undefined, data.activeId, /Persisted Pi session file/],
				["pane-current", data.sessionFile, null, /Current Pi session leaf/],
			] as const) {
				await withPane(pane, async () => {
					const app = harness({
						getSessionFile: () => sessionFile,
						getLeafId: () => leaf,
						getSessionDir: () => data.sessionDir,
					} as ExtensionCommandContext["sessionManager"], data.cwd);
					await assert.rejects(app.command("", app.ctx), expected);
					assert.deepEqual(app.calls, []);
					assert.deepEqual(app.events, ["waitForIdle"]);
				});
			}
		});

		await t.test("a malformed pane response prevents cloning", async () => {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) =>
					args[0] === "pane"
						? success({ result: { pane: { pane_id: "pane-current" } } })
						: success());
				await assert.rejects(app.command("", app.ctx), /workspace_id/);
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [["pane", "get"]]);
			});
		});

		await t.test("an invalid created tab never starts an agent and removes its clone", async () => {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "tab") return success({ result: { tab: { tab_id: "tab-new" }, root_pane: {} } });
					return success();
				});
				await assert.rejects(app.command("", app.ctx), /root pane_id/);
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [
					["pane", "get"],
					["tab", "create"],
				]);
				assert.deepEqual(await readdir(data.sessionDir), [basename(data.sessionFile)]);
			});
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("launch-attempt failures retain recovery artifacts while focus failure reports a started clone", async (t) => {
	await t.test("agent start failure retains clone and reports every Herdr ID", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "tab") return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
					if (args[0] === "agent") return { stdout: "", stderr: "timed out", code: 9, killed: true };
					return success();
				});
				await assert.rejects(app.command("", app.ctx), (error: Error) => {
					assert.match(error.message, /could not be confirmed/);
					assert.match(error.message, /clone-[a-f0-9]{24}/);
					assert.match(error.message, /tab-new/);
					assert.match(error.message, /pane-root/);
					assert.match(error.message, /timed out/);
					return true;
				});
				const start = app.calls.find((call) => call.args[0] === "agent")!;
				await stat(start.args.at(-1)!);
				assert.equal(app.calls.some((call) => call.args[1] === "focus"), false);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});

	await t.test("focus failure is visible without turning the successful start into a launch failure", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "tab" && args[1] === "create") return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
					if (args[0] === "tab" && args[1] === "focus") return { stdout: "", stderr: "focus denied", code: 5, killed: false };
					return success();
				});
				await app.command("", app.ctx);
				assert.equal(app.notifications.length, 1);
				assert.equal(app.notifications[0]?.type, "warning");
				assert.match(app.notifications[0]!.message, /agent .* started.*focus failed/i);
				assert.doesNotMatch(app.notifications[0]!.message, /launch failed/i);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});
});
