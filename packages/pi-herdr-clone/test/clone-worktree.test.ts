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
	const root = await mkdtemp(join(tmpdir(), "pi-herdr-clone-wt-"));
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
	respond?: (args: string[]) => Promise<ExecResult | undefined> | ExecResult | undefined,
) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const events: string[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "clone-worktree") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			calls.push({ command: executable, args, options });
			events.push(`exec:${args.slice(0, 2).join(" ")}`);
			// Returning undefined from respond defers to the built-in responders.
			const custom = respond ? await respond(args) : undefined;
			if (custom) return custom;
			if (args[0] === "workspace" && args[1] === "get") {
				return success({
					result: {
						workspace: {
							workspace_id: args[2],
							worktree: { checkout_path: cwd },
						},
					},
				});
			}
			if (args[0] === "pane" && args[1] === "get") {
				return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
			}
			if (args[0] === "worktree" && args[1] === "create") {
				return success({
					result: {
						workspace: { workspace_id: "workspace-new" },
						tab: { tab_id: "tab-new" },
						root_pane: { pane_id: "pane-root" },
						worktree: { checkout_path: "/tmp/checkout" },
					},
				});
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

async function withPane(value: string | undefined, run: () => Promise<void>): Promise<void> {
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousPaneId = process.env.HERDR_PANE_ID;
	process.env.HERDR_ENV = "1";
	if (value === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = value;
	try {
		await run();
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPaneId;
	}
}

test("/clone-worktree copies only the active path into a worktree workspace and launches exact Herdr argv", async () => {
	const data = await fixture();
	try {
		await withPane("pane-alias", async () => {
			const before = await readFile(data.sessionFile, "utf8");
			let starts = 0;
			const app = harness(data.manager, data.cwd, (args) => {
				if (args[0] === "pane") {
					if (args[2] === "pane-root") {
						return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: "pi" } } });
					}
					return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				}
				if (args[0] === "worktree" && args[1] === "create") {
					return success({
						result: {
							workspace: { workspace_id: "workspace-new" },
							tab: { tab_id: "tab-new" },
							root_pane: { pane_id: "pane-root" },
							worktree: { checkout_path: "/repos/pi-packages/.herdr-checkouts/wt-x" },
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return success({
						result: { tab: { tab_id: "tab-clone" }, root_pane: { pane_id: "pane-clone" } },
					});
				}
				if (args[0] === "agent") {
					starts += 1;
					return starts === 1
						? { stdout: JSON.stringify({ error: { code: "agent_pane_busy" } }), stderr: "", code: 1, killed: false }
						: success();
				}
				return undefined;
			});
			await app.command("", app.ctx);

			assert.deepEqual(app.events, [
				"waitForIdle",
				"exec:pane get",
				"exec:workspace get",
				"exec:worktree create",
				"exec:pane get",
				"exec:tab create",
				"exec:agent start",
				"exec:agent start",
				"exec:tab focus",
			]);
			assert.ok(app.calls.every((call) => call.command === "herdr" && call.options.cwd === data.cwd));
			assert.deepEqual(app.calls[0].args, ["pane", "get", "pane-alias"]);
			assert.deepEqual(app.calls[2].args, ["worktree", "create", "--workspace", "workspace-live", "--no-focus"]);
			assert.deepEqual(app.calls[3].args, ["pane", "get", "pane-root"]);
			assert.deepEqual(app.calls[4].args, [
				"tab", "create", "--workspace", "workspace-new",
				"--cwd", "/repos/pi-packages/.herdr-checkouts/wt-x", "--no-focus",
			]);
			assert.deepEqual(app.calls[7].args, ["tab", "focus", "tab-clone"]);
			const start = app.calls[5].args;
			assert.match(start[2]!, /^clone-[a-f0-9]{24}$/);
			assert.deepEqual(start.slice(3, 8), ["--kind", "pi", "--pane", "pane-clone", "--"]);
			assert.equal(start[8], "--session");
			const cloneFile = start[9]!;;
			await stat(cloneFile);

			const clone = SessionManager.open(cloneFile);
			assert.equal(clone.getHeader()?.cwd, "/repos/pi-packages/.herdr-checkouts/wt-x");
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
			assert.equal(app.notifications.length, 1);
			assert.equal(app.notifications[0]?.type, "info");
			assert.match(app.notifications[0]!.message, /workspace-new.*checkout \/repos\/pi-packages\/\.herdr-checkouts\/wt-x/s);
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("/clone-worktree starts the clone in the root pane when no plugin agent claims it", async () => {
	const data = await fixture();
	try {
		await withPane("pane-alias", async () => {
			let paneGets = 0;
			const app = harness(data.manager, data.cwd, (args) => {
				if (args[0] === "pane") {
					if (args[2] === "pane-root") {
						paneGets += 1;
						return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new" } } });
					}
					return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				}
				if (args[0] === "worktree" && args[1] === "create") {
					return success({
						result: {
							workspace: { workspace_id: "workspace-new" },
							tab: { tab_id: "tab-new" },
							root_pane: { pane_id: "pane-root" },
							worktree: { checkout_path: "/repos/wt-x" },
						},
					});
				}
				return undefined;
			});
			await app.command("", app.ctx);

			assert.equal(paneGets >= 12, true);
			assert.equal(app.calls.some((call) => call.args[0] === "tab" && call.args[1] === "create"), false);
			const start = app.calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
			assert.ok(start);
			assert.deepEqual(start.args.slice(3, 8), ["--kind", "pi", "--pane", "pane-root", "--"]);
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("/clone-worktree moves to an extra tab when the root pane becomes busy after polling", async () => {
	const data = await fixture();
	try {
		await withPane("pane-alias", async () => {
			const starts: string[] = [];
			const app = harness(data.manager, data.cwd, (args) => {
				if (args[0] === "pane") {
					if (args[2] === "pane-root") {
						return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new" } } });
					}
					return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				}
				if (args[0] === "worktree" && args[1] === "create") {
					return success({
						result: {
							workspace: { workspace_id: "workspace-new" },
							tab: { tab_id: "tab-new" },
							root_pane: { pane_id: "pane-root" },
							worktree: { checkout_path: "/repos/wt-x" },
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return success({ result: { tab: { tab_id: "tab-clone" }, root_pane: { pane_id: "pane-clone" } } });
				}
				if (args[0] === "agent") {
					starts.push(args[6]!);
					return starts.length === 1
						? { stdout: JSON.stringify({ error: { code: "agent_pane_busy" } }), stderr: "", code: 1, killed: false }
						: success();
				}
				return undefined;
			});
			await app.command("", app.ctx);

			assert.deepEqual(starts, ["pane-root", "pane-clone"]);
			assert.deepEqual(app.calls.at(-1)?.args, ["tab", "focus", "tab-clone"]);
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("/clone-worktree reports recovered IDs from an incomplete extra-tab response", async () => {
	const data = await fixture();
	try {
		await withPane("pane-alias", async () => {
			const app = harness(data.manager, data.cwd, (args) => {
				if (args[0] === "pane") {
					if (args[2] === "pane-root") {
						return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: "pi" } } });
					}
					return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
				}
				if (args[0] === "worktree" && args[1] === "create") {
					return success({
						result: {
							workspace: { workspace_id: "workspace-new" },
							tab: { tab_id: "tab-new" },
							root_pane: { pane_id: "pane-root" },
							worktree: { checkout_path: "/repos/wt-x" },
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return success({ result: { tab: { tab_id: "tab-clone" }, root_pane: {} } });
				}
				return undefined;
			});
			await assert.rejects(app.command("", app.ctx), (error: Error) => {
				assert.match(error.message, /workspace workspace-new/);
				assert.match(error.message, /tab tab-clone/);
				assert.match(error.message, /missing root_pane\.pane_id/);
				return true;
			});
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("/clone-worktree inside a linked worktree creates the worktree from the repo parent workspace", async () => {
	const data = await fixture();
	try {
		await mkdir(join(data.root, "wt"));
		await withPane("pane-linked", async () => {
			const app = harness(data.manager, data.cwd, (args) => {
				if (args[0] === "pane") {
					if (args[2] === "pane-root") {
						return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: "pi" } } });
					}
					return success({ result: { pane: { pane_id: "pane-linked", workspace_id: "workspace-linked" } } });
				}
				if (args[0] === "workspace" && args[1] === "get") {
					return success({
						result: {
							workspace: {
								workspace_id: args[2],
								worktree: {
									checkout_path: join(data.root, "wt"),
									repo_root: "/repos/main",
									is_linked_worktree: true,
								},
							},
						},
					});
				}
				if (args[0] === "workspace" && args[1] === "list") {
					return success({
						result: {
							type: "workspace_list",
							workspaces: [
								{ workspace_id: "workspace-parent", worktree: { checkout_path: "/repos/main", is_linked_worktree: false } },
								{ workspace_id: "workspace-linked", worktree: { checkout_path: join(data.root, "wt"), repo_root: "/repos/main", is_linked_worktree: true } },
							],
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return success({
						result: { tab: { tab_id: "tab-clone" }, root_pane: { pane_id: "pane-clone" } },
					});
				}
				if (args[0] === "worktree" && args[1] === "create") {
					return success({
						result: {
							workspace: { workspace_id: "workspace-new" },
							tab: { tab_id: "tab-new" },
							root_pane: { pane_id: "pane-root" },
							worktree: { checkout_path: "/repos/wt-x" },
						},
					});
				}
				return undefined;
			});
			await app.command("", app.ctx);

			const create = app.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "create");
			assert.deepEqual(create?.args, ["worktree", "create", "--workspace", "workspace-parent", "--no-focus"]);
			assert.equal(app.notifications.length, 1);
			assert.equal(app.notifications[0]?.type, "info");
		});
	} finally {
		await rm(data.root, { recursive: true, force: true });
	}
});

test("worktree creation failures happen before cloning and retain nothing of the clone", async (t) => {
	await t.test("a definitively failed worktree create never creates a clone", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "worktree") return { stdout: "", stderr: "worktree create denied", code: 1, killed: false };
					return undefined;
				});
				await assert.rejects(app.command("", app.ctx), /worktree create denied/);
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [
					["pane", "get"],
					["workspace", "get"],
					["worktree", "create"],
				]);
				assert.deepEqual(await readdir(data.sessionDir), [basename(data.sessionFile)]);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});

	await t.test("a killed worktree create is ambiguous and creates no clone", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "worktree") return { stdout: "", stderr: "killed mid-create", code: 9, killed: true };
					return undefined;
				});
				await assert.rejects(app.command("", app.ctx), (error: Error) => {
					assert.match(error.message, /could not be confirmed/);
					assert.match(error.message, /partial worktree workspace/);
					return true;
				});
				assert.equal(app.calls.some((call) => call.args[0] === "agent"), false);
				assert.deepEqual(await readdir(data.sessionDir), [basename(data.sessionFile)]);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});

	await t.test("an incomplete worktree response retains the worktree IDs and creates no clone", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					if (args[0] === "worktree") {
						return success({
							result: {
								workspace: {},
								tab: { tab_id: "tab-new" },
								root_pane: { pane_id: "pane-root" },
								worktree: { checkout_path: "/repos/wt-x" },
							},
						});
					}
					return undefined;
				});
				await assert.rejects(app.command("", app.ctx), (error: Error) => {
					assert.match(error.message, /could not be confirmed/);
					assert.match(error.message, /tab-new/);
					assert.match(error.message, /pane-root/);
					assert.match(error.message, /missing workspace_id/);
					return true;
				});
				assert.equal(app.calls.some((call) => call.args[0] === "agent"), false);
				assert.deepEqual(await readdir(data.sessionDir), [basename(data.sessionFile)]);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});

	await t.test("agent start failure retains worktree artifacts and skips focus", async () => {
		const data = await fixture();
		try {
			await withPane("pane-current", async () => {
				const app = harness(data.manager, data.cwd, (args) => {
					if (args[0] === "pane") {
						if (args[2] === "pane-root") {
							return success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: "pi" } } });
						}
						return success({ result: { pane: { pane_id: "pane-current", workspace_id: "workspace-live" } } });
					}
					if (args[0] === "tab" && args[1] === "create") {
						return success({
							result: { tab: { tab_id: "tab-clone" }, root_pane: { pane_id: "pane-clone" } },
						});
					}
					if (args[0] === "worktree") {
						return success({
							result: {
								workspace: { workspace_id: "workspace-new" },
								tab: { tab_id: "tab-new" },
								root_pane: { pane_id: "pane-root" },
								worktree: { checkout_path: "/repos/wt-x" },
							},
						});
					}
					if (args[0] === "agent") return { stdout: "", stderr: "timed out", code: 9, killed: true };
					return undefined;
				});
				await assert.rejects(app.command("", app.ctx), (error: Error) => {
					assert.match(error.message, /could not be confirmed/);
					assert.match(error.message, /clone-[a-f0-9]{24}/);
					assert.match(error.message, /workspace-new/);
					assert.match(error.message, /tab-clone/);
					assert.match(error.message, /pane-clone/);
					assert.match(error.message, /timed out/);
					return true;
				});
				assert.equal(app.calls.some((call) => call.args[1] === "focus"), false);
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	});
});
