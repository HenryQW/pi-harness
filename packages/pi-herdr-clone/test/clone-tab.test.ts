import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { lock } from "proper-lockfile";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	fixture,
	success,
	tabHarness as harness,
	withEnvironment,
	withPane,
} from "./helper.ts";

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
						? { stdout: JSON.stringify({ error: { code: "agent_pane_busy" } }), stderr: "", code: 1, killed: true }
						: success();
				}
				return success();
			});
			await app.command("", app.ctx);

			assert.deepEqual(app.events, [
				"waitForIdle",
				"exec:pane get",
				"exec:workspace get",
				"exec:tab create",
				"exec:agent start",
				"exec:agent start",
				"exec:tab focus",
			]);
			assert.ok(app.calls.every((call) => call.command === "herdr" && call.options.cwd === activeCwd));
			assert.deepEqual(app.calls[0].args, ["pane", "get", "pane-alias"]);
			assert.deepEqual(app.calls[2].args, [
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
			assert.deepEqual(app.calls[5].args, ["tab", "focus", "tab-new"]);
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

		await t.test("checkout removal lock prevents clone creation", async () => {
			await withPane("pane-current", async () => {
				const release = await lock(data.cwd);
				try {
					const app = harness(data.manager, data.cwd);
					await assert.rejects(app.command("", app.ctx), /already being held/);
					assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [
						["pane", "get"],
						["workspace", "get"],
					]);
					assert.deepEqual(await readdir(data.sessionDir), [basename(data.sessionFile)]);
				} finally {
					await release();
				}
			});
		});

		await t.test("a failed tab create removes its clone", async () => {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "tab") return { stdout: "", stderr: "tab create denied", code: 1, killed: false };
					return success();
				});
				await assert.rejects(app.command("", app.ctx), /tab create denied/);
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [
					["pane", "get"],
					["workspace", "get"],
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
	await t.test("an invalid created tab retains clone and reports the tab", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "tab") return success({ result: { tab: { tab_id: "tab-new" }, root_pane: {} } });
					return success();
				});
				await assert.rejects(app.command("", app.ctx), (error: Error) => {
					assert.match(error.message, /could not be confirmed/);
					assert.match(error.message, /tab-new/);
					assert.match(error.message, /root_pane\.pane_id/);
					return true;
				});
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [
					["pane", "get"],
					["workspace", "get"],
					["tab", "create"],
				]);
				const leftover = (await readdir(data.sessionDir)).filter((name) => name !== basename(data.sessionFile));
				assert.equal(leftover.length, 1);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});

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

test("/clone-tab clones an un-persisted session from live state", async () => {
	const data = await fixture();
	try {
		// Simulate a fresh session whose first turn is still running: Pi defers
		// all writes until the first assistant entry, so the file never hit disk.
		const running = SessionManager.create(data.cwd, data.sessionDir);
		running.appendMessage({ role: "user", content: "in-flight turn", timestamp: 9 });
		await assert.rejects(stat(running.getSessionFile()!));

		await withPane("pane-live", async () => {
			let cloneFileArg: string | undefined;
			const app = harness(running, data.cwd, (args) => {
				if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				if (args[0] === "workspace") return success({ result: { workspace: { workspace_id: args[2], worktree: null } } });
				if (args[0] === "tab" && args[1] === "create") return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
				if (args[0] === "agent") {
					cloneFileArg = args.at(-1);
					return success();
				}
				return success();
			});
			await app.command("", app.ctx);

			assert.ok(cloneFileArg);
			const clone = SessionManager.open(cloneFileArg!);
			assert.equal(clone.getHeader()?.cwd, data.cwd);
			assert.equal(
				clone.getEntries().some((entry) =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "in-flight turn"),
				true,
			);
			assert.notEqual(cloneFileArg, running.getSessionFile());
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});
