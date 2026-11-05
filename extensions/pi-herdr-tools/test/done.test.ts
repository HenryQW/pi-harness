import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, readFile, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { checkoutAdmission, withWorktreeLock } from "@henryqw/pi-herdr";
import herdrDoneExtension from "../internal/done.ts";
import { runLockedGit } from "../internal/locked-git.ts";
import { CommandManager } from "../internal/commands.ts";
import { CommandRemovalBlocked, readJob, recordNonDispatch, writePrivate, type JobSpec } from "../internal/command-state.ts";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HerdrRequestError } from "@henryqw/pi-herdr";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
type ExecCall = { command: string; args: string[]; options: { cwd: string } };
type Executor = (call: ExecCall) => ExecResult | Promise<ExecResult>;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const checkout = await mkdtemp(join(tmpdir(), "pi-herdr-done-"));
const mainCheckoutDir = await mkdtemp(join(tmpdir(), "pi-herdr-done-main-"));
after(async () => {
	await rm(checkout, { recursive: true, force: true });
	await rm(mainCheckoutDir, { recursive: true, force: true });
});

function harness(executor: Executor = () => ok(),
	guardRemoval: Parameters<typeof herdrDoneExtension>[1] = async (_checkout, operation) => operation(-1),
	recoverRemoval?: Parameters<typeof herdrDoneExtension>[2],
	nativeMutation?: typeof runLockedGit,
) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const events = new Map<string, () => void>();
	const inherited: number[][] = [], lockInodes: Array<Array<number | null>> = [];
	const api = {
		on(name: string, handler: () => void) { events.set(name, handler); },
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "done") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			const call = { command: executable, args, options };
			calls.push(call);
			return executor(call);
		},
	} as unknown as ExtensionAPI;
	herdrDoneExtension(api, guardRemoval, recoverRemoval, async (mutation, descriptors) => {
		inherited.push([...descriptors]);
		lockInodes.push(descriptors.map(fd => fd >= 0 ? fstatSync(fd).ino : null));
		if (nativeMutation) return await nativeMutation(mutation, descriptors);
		const args = mutation.operation === "remove" ? ["worktree", "remove", ...(mutation.force ? ["--force"] : []), mutation.checkout] : ["pull", "--ff-only"];
		const result = await api.exec("git", args, { cwd: mutation.cwd });
		if (result.code !== 0 || result.killed) throw new Error(result.stderr || "killed");
	});
	assert.ok(command);
	return { command, calls, events, inherited, lockInodes };
}

function snapshotExecutor(options: {
	toplevel?: string;
	mainCheckout?: string;
	bareMain?: boolean;
	panes?: unknown[];
	tabs?: unknown[];
	removeResult?: ExecResult;
	pullResult?: ExecResult;
} = {}): Executor {
	return async ({ command, args }) => {
		if (command === "git" && args[0] === "rev-parse") return ok(`${args.includes("--git-common-dir") ? join(options.mainCheckout ?? mainCheckoutDir, ".git") : options.toplevel ?? checkout}\n`);
		if (command === "herdr" && args[0] === "pane") return ok(JSON.stringify({ result: { pane: { pane_id: "p1", tab_id: "w1:t1", workspace_id: "w1", cwd: checkout } } }));
		if (command === "herdr" && args[0] === "workspace") return ok(JSON.stringify({ result: { workspace: { workspace_id: "w1", worktree: {
			checkout_path: checkout, repo_root: options.mainCheckout ?? mainCheckoutDir, repo_key: join(options.mainCheckout ?? mainCheckoutDir, ".git"), is_linked_worktree: true,
		} } } }));
		if (command === "herdr" && args[0] === "tab" && args[1] === "get") return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t1", workspace_id: "w1" } } }));
		if (command === "git" && args[0] === "worktree" && args[1] === "list") {
			assert.deepEqual(args, ["worktree", "list", "--porcelain", "-z"]);
			const main = options.mainCheckout ?? mainCheckoutDir;
			const bare = options.bareMain ? "bare\0" : "";
			return ok(`worktree ${main}\0${bare}HEAD s\0branch b\0\0worktree ${checkout}\0HEAD s\0branch b\0\0`);
		}
		if (command === "herdr" && args[0] === "api") {
			return ok(JSON.stringify({ result: { snapshot: { panes: options.panes ?? [] } } }));
		}
		if (command === "herdr" && args[0] === "tab") {
			return ok(JSON.stringify({ result: { tabs: [
				{ tab_id: "w1:t1", workspace_id: "w1" },
				...(options.tabs ?? []),
			] } }));
		}
		if (command === "git" && args[0] === "worktree") return options.removeResult ?? ok();
		if (command === "git" && args[0] === "pull") return options.pullResult ?? ok();
		return ok();
	};
}

async function withHerdrEnvironment(
	herdrEnv: string | undefined,
	tabId: string | undefined,
	run: () => Promise<void>,
	workspaceId: string | null | undefined = "w1",
): Promise<void> {
	const setEnvironment = (values: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const environment = {
		HERDR_ENV: herdrEnv,
		HERDR_TAB_ID: tabId,
		HERDR_WORKSPACE_ID: workspaceId ?? undefined,
		HERDR_PANE_ID: "p1",
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	setEnvironment(environment);
	try {
		await run();
	} finally {
		setEnvironment(previous);
	}
}

const context = (events: string[] = [], confirmed = true) => ({
	cwd: "/repo/worktree/nested", hasUI: true, mode: "tui", sessionManager: SessionManager.inMemory(checkout),
	waitForIdle: async () => { events.push("idle"); },
	ui: { confirm: async (title: string, message: string) => { events.push(`confirm:${title}:${message}`); return confirmed; } },
}) as unknown as ExtensionCommandContext;

test("/done resolves the checkout root, skips own tab, removes the checkout, then closes the tab", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor({
			panes: [
				{ tab_id: "w1:t1", cwd: checkout },
				{ tab_id: "w1:t1", cwd: `${checkout}/nested` },
			],
		}));
		const events: string[] = [];
		await app.command("", context(events));
		assert.deepEqual(events, [
			"confirm:Done:Close its Herdr tabs and remove the current worktree?",
			"idle",
		]);
		assert.deepEqual(app.calls.filter((call) => !["pane", "workspace"].includes(call.args[0]!) && call.args[1] !== "get" && !call.args.includes("--git-common-dir") && !(call.args[0] === "rev-parse" && call.options.cwd === checkout)), [
			{ command: "git", args: ["rev-parse", "--show-toplevel"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], options: { cwd: checkout } },
			{ command: "herdr", args: ["api", "snapshot"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "herdr", args: ["tab", "list"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["worktree", "remove", checkout], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["pull", "--ff-only"], options: { cwd: mainCheckoutDir } },
			{ command: "herdr", args: ["tab", "close", "w1:t1"], options: { cwd: tmpdir() } },
		]);
	});
});

test("/done closes all other tabs in its workspace", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor({
			panes: [
				{ tab_id: "w1:t2", cwd: checkout },
				{ tab_id: "w1:t3", cwd: `${checkout}/nested` },
			],
			tabs: [
				{ tab_id: "w1:t2", workspace_id: "w1", label: "Implementer" },
				{ tab_id: "w1:t3", workspace_id: "w1", label: "Reviewer" },
				{ tab_id: "w1:t4", workspace_id: "w1", label: "Different checkout" },
				{ tab_id: "w2:t1", workspace_id: "w2", label: "Other workspace" },
			],
		}));
		await app.command("", context());
		assert.deepEqual(
			app.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] !== "get").map((call) => call.args),
			[
				["tab", "list"],
				["tab", "close", "w1:t2"],
				["tab", "close", "w1:t3"],
				["tab", "close", "w1:t4"],
				["tab", "close", "w1:t1"],
			],
		);
		assert.ok(app.calls.findIndex((call) => call.args[1] === "remove") < app.calls.findIndex((call) => call.args[2] === "w1:t2"));
	});
});

test("/done --force and -f skip confirmation and dependents check, forwarding force to git", async () => {
	for (const flag of ["--force", "-f"]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				panes: [{ tab_id: "w2:t9", cwd: checkout }],
			}));
			const events: string[] = [];
			await app.command(flag, context(events));
			assert.deepEqual(events, ["idle"]);
			assert.equal(app.calls.some((c) => c.command === "herdr" && c.args[0] === "api"), false);
			assert.deepEqual(app.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove")?.args,
				["worktree", "remove", "--force", checkout]);
		});
	}
});

test("/done refuses with blocking tab labels when another Herdr tab uses the checkout", async () => {
	for (const cwd of [checkout, `${checkout}/sub`]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				panes: [{ tab_id: "w2:t9", cwd }, { tab_id: "w3:t4", cwd }],
				tabs: [
					{ tab_id: "w2:t9", workspace_id: "w2", label: "Fix puid pgid" },
					{ tab_id: "w3:t4", workspace_id: "w3" },
				],
			}));
			await assert.rejects(
				app.command("", context()),
				/still used by Herdr tabs Fix puid pgid, w3:t4/);
			assert.equal(app.calls.some((call) => call.args[1] === "remove" || call.args[1] === "close"), false);
		});
	}
});

test("/done removes the checkout, pulls the parent, and closes its tab when another tab uses the parent", async () => {
	for (const cwd of [mainCheckoutDir, `${mainCheckoutDir}/sub`]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ panes: [{ tab_id: "w2:t9", cwd }] }));
			await app.command("", context());
			assert.ok(app.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove"));
			assert.ok(app.calls.some((c) => c.args[0] === "pull"));
			assert.deepEqual(app.calls.at(-1), {
				command: "herdr",
				args: ["tab", "close", "w1:t1"],
				options: { cwd: tmpdir() },
			});
		});
	}
});

test("/done does not check or remove while clone creation holds the checkout lock", async () => {
	await withHerdrEnvironment("1", "w1:t1", () => withWorktreeLock(checkout, async () => {
		const app = harness(snapshotExecutor());
		await assert.rejects(app.command("", context()), /already being held/);
		assert.deepEqual(app.calls.map((call) => call.args[0]), ["rev-parse", "worktree"]);
	}));
});

test("declined confirmation leaves the worktree untouched", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events, false));
		assert.deepEqual(events, ["confirm:Done:Close its Herdr tabs and remove the current worktree?"]);
		assert.deepEqual(app.calls, []);
	});
});

test("/done fails safely before any execution and preserves removal errors", async (t) => {
	await t.test("rejects arguments and missing Herdr context before execution", async () => {
		for (const [args, herdrEnv, tabId, workspaceId, expected] of [
			["--yes", "1", "w1:t1", "w1", /Usage: \/done \[--force\|-f\]/],
			["-f extra", "1", "w1:t1", "w1", /Usage: \/done \[--force\|-f\]/],
			["", undefined, "w1:t1", "w1", /inside Herdr/],
			["", "1", undefined, "w1", /HERDR_TAB_ID/],
			["", "1", "w1:t1", null, /HERDR_WORKSPACE_ID/],
		] as const) {
			await withHerdrEnvironment(herdrEnv, tabId, async () => {
				const app = harness();
				await assert.rejects(app.command(args, context()), expected);
				assert.deepEqual(app.calls, []);
			}, workspaceId);
		}
	});

	await t.test("rejects mismatched Herdr tab and workspace context before removal", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor());
			await assert.rejects(app.command("", context()), /does not own the exact tab, workspace, and checkout/);
			assert.equal(app.calls.some((call) => call.args[1] === "remove"), false);
		}, "w9");
	});

	await t.test("refuses the main checkout even with force", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ mainCheckout: checkout }));
			await assert.rejects(app.command("--force", context()), /registered linked checkout/);
			assert.equal(app.calls.some((c) => c.args[1] === "remove" || c.args[1] === "close"), false);
			assert.equal(app.calls.some((c) => c.args[0] === "pull"), false);
		});
	});

	await t.test("skips the parent pull when the primary repository is bare", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ bareMain: true }));
			await app.command("--force", context());
			assert.equal(app.calls.some((c) => c.args[0] === "pull"), false);
		});
	});

	await t.test("surfaces dirty-worktree refusal and skips tab close", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				tabs: [{ tab_id: "w1:t2", workspace_id: "w1" }],
				removeResult: { stdout: "", stderr: "error: the following file is dirty", code: 1 },
			}));
			await assert.rejects(app.command("", context()), /dirty/);
			assert.equal(app.calls.some((call) => call.args[1] === "close"), false);
		});
	});

	await t.test("surfaces a failed parent pull but closes the removed checkout's tab", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				tabs: [{ tab_id: "w1:t2", workspace_id: "w1" }],
				pullResult: { stdout: "", stderr: "error: Your local changes would be overwritten by merge", code: 1 },
			}));
			await assert.rejects(app.command("--force", context()), /overwritten by merge/);
			// --force skips the dependents check, so no herdr api snapshot call.
			assert.deepEqual(
				app.calls.filter((call) => call.args[1] === "close").map((call) => call.args[2]),
				["w1:t2", "w1:t1"],
			);
		});
	});

	await t.test("treats a killed removal as failure", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				removeResult: { stdout: "", stderr: "", code: 0, killed: true },
			}));
			await assert.rejects(app.command("", context()), /killed/);
			assert.equal(app.calls.some((call) => call.args[1] === "close"), false);
		});
	});
});

test("forced completion cannot bypass managed-command ownership", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor(), async (path) => {
			assert.equal(path, checkout);
			throw new Error("Active or unknown background commands block worktree removal");
		});
		await assert.rejects(app.command("--force", context()), /Active or unknown/);
		assert.equal(app.calls.some((call) => call.args.includes("remove") || call.args.includes("close")), false);
	});
});

test("/done fails closed for folder workspaces, other checkouts, and stale pane ownership, including force", async () => {
	for (const force of ["", "--force"]) for (const mode of ["folder", "other-checkout", "other-repository", "other-pane", "other-tab", "outside-pane", "nested-repository", "missing-pane"] as const) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			if (mode === "missing-pane") delete process.env.HERDR_PANE_ID;
			const fallback = snapshotExecutor();
			const app = harness(async (call) => {
				const { command, args, options } = call;
				if (args[0] === "workspace") return ok(JSON.stringify({ result: { workspace: { workspace_id: "w1", worktree: mode === "folder" ? null : {
					checkout_path: mode === "other-checkout" ? mainCheckoutDir : checkout,
					repo_root: mainCheckoutDir, repo_key: mode === "other-repository" ? "/other/.git" : join(mainCheckoutDir, ".git"), is_linked_worktree: true,
				} } } }));
				if (args[0] === "pane") return ok(JSON.stringify({ result: { pane: {
					pane_id: mode === "other-pane" ? "p2" : "p1", tab_id: mode === "other-tab" ? "w1:t2" : "w1:t1", workspace_id: "w1",
					cwd: mode === "outside-pane" ? mainCheckoutDir : mode === "nested-repository" ? `${checkout}/nested` : checkout,
				} } }));
				if (command === "git" && options.cwd === `${checkout}/nested`) return ok(`${checkout}/nested\n`);
				return fallback(call);
			});
			await assert.rejects(app.command(force, context()), /linked checkout|does not own|HERDR_PANE_ID/, mode);
			assert.equal(app.calls.some((call) => call.args[1] === "remove" || call.args[1] === "close" || call.args[0] === "pull"), false, mode);
		});
	}
});

test("/done accepts a pane in a subdirectory of its exact linked checkout", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const fallback = snapshotExecutor();
		const app = harness((call) => call.args[0] === "pane"
			? ok(JSON.stringify({ result: { pane: { pane_id: "p1", tab_id: "w1:t1", workspace_id: "w1", cwd: `${checkout}/nested` } } }))
			: fallback(call));
		await app.command("--force", context());
		assert.ok(app.calls.some((call) => call.args[1] === "remove"));
	});
});

test("/done excludes a second manager through actual removal and releases store and admission on failure", async (t) => {
	const store = await mkdtemp(join(tmpdir(), "pi-done-command-store-"));
	t.after(() => rm(store, { recursive: true, force: true }));
	const key = await realpath(checkout);
	const host = () => ({ on() {}, exec: async () => ({ code: 0, stdout: key + "\n" }) });
	const admission = checkoutAdmission(host());
	const owner = new CommandManager(store, admission);
	const request = t.mock.fn(async () => { throw new Error("must not dispatch"); });
	const other = new CommandManager(store, checkoutAdmission(host()), request);
	const previousSocket = process.env.HERDR_SOCKET_PATH, previousLease = process.env.PI_SUBAGENT_PROCESS_LEASE, argv = process.argv;
	process.env.HERDR_SOCKET_PATH = "/tmp/test-herdr.sock"; delete process.env.PI_SUBAGENT_PROCESS_LEASE; process.argv = argv.slice(0, 2);
	t.after(() => {
		if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previousSocket;
		if (previousLease === undefined) delete process.env.PI_SUBAGENT_PROCESS_LEASE; else process.env.PI_SUBAGENT_PROCESS_LEASE = previousLease;
		process.argv = argv;
	});
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const fallback = snapshotExecutor();
		let resumed!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => { resumed = resolve; }), removing = new Promise<void>(resolve => { entered = resolve; });
		const app = harness(async (call) => {
			if (call.command === "git" && call.args[1] === "remove") {
				entered(); await gate;
				await rm(checkout, { recursive: true });
			}
			return fallback(call);
		}, (path, operation) => owner.guardRemoval(path, operation));
		// A failed removal operation must not leave either ownership layer held.
		await assert.rejects(owner.guardRemoval(checkout, async () => { throw new Error("removal failed"); }), /removal failed/);
		(await admission.reserve("after-failure", key))();
		const removal = app.command("--force", context());
		try {
			await removing;
			await assert.rejects(other.launch({ command: "true", access: "write", callId: "race", callEntryId: "entry", sessionId: "other", sessionFile: null, cwd: key, checkout: key },
				{ runtimeMs: 5000, outputBytes: 4096, concurrency: 4, retainedJobs: 100 }), { code: "ELOCKED" });
			assert.equal(request.mock.callCount(), 0);
			await assert.rejects(admission.reserve("conflict", key), /active writer/);
		} finally { resumed(); await removal; }
		await assert.rejects(realpath(checkout), { code: "ENOENT" });
		assert.equal(await withWorktreeLock(store, async () => true), true);
		(await admission.reserve("after-removal", key))();
		await mkdir(checkout);
	});
});

async function recoveryFixture(t: test.TestContext) {
	const store = await mkdtemp(join(tmpdir(), "pi-done-recovery-"));
	t.after(() => rm(store, { recursive: true, force: true }));
	const key = await realpath(checkout);
	const admission = checkoutAdmission({ on() {}, exec: async () => ({ code: 0, stdout: key + "\n" }) });
	const manager = new CommandManager(store, admission);
	const ctx = context();
	const spec: JobSpec = { version: 1, id: randomUUID(), token: randomUUID(), callId: "call", callEntryId: "launch", sessionId: ctx.sessionManager.getSessionId(), sessionFile: null,
		createdAt: Date.now() - 60_000, cwd: key, checkout: key, workspaceId: "w1", socketPath: "/tmp/fixture.sock", command: "true", access: "write", runtimeMs: 5000, outputBytes: 4096 };
	const dir = join(store, spec.id);
	await mkdir(dir, { mode: 0o700 }); await writePrivate(join(dir, "spec.json"), spec);
	const other = { ...spec, id: randomUUID(), token: randomUUID(), checkout: await realpath(mainCheckoutDir) };
	await mkdir(join(store, other.id), { mode: 0o700 }); await writePrivate(join(store, other.id, "spec.json"), other);
	const choices: string[][] = [], notifications: string[] = [], answers: Array<string | undefined> = [];
	ctx.ui.select = async (_title, options) => {
		// Recovery dialogs must run outside both removal locks.
		await withWorktreeLock(checkout, () => withWorktreeLock(store, async () => {}));
		choices.push(options); return answers.shift();
	};
	ctx.ui.input = async () => { await withWorktreeLock(checkout, () => withWorktreeLock(store, async () => {})); return answers.shift(); };
	ctx.ui.notify = message => { notifications.push(message); };
	return { store, manager, ctx, spec, dir, other, choices, notifications, answers };
}

for (const force of ["", "--force"])
test(`/done ${force} reuses scoped recovery and makes one fresh attempt after typed release`, async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		Object.assign(f.ctx, { mode: "rpc" });
		f.answers.push("Cancel and recheck", "Recheck proof", "Release protection despite this risk", f.spec.id);
		const app = harness(snapshotExecutor(), (path, operation) => f.manager.guardRemoval(path, operation), (path, ctx, check) => f.manager.recoverRemoval(path, ctx, check));
		await app.command(force, f.ctx);
		assert.equal(f.choices[0]![0], "Keep protection");
		assert.deepEqual(JSON.parse(await readFile(join(f.dir, "cancel.json"), "utf8")), { id: f.spec.id, token: f.spec.token });
		assert.equal((await f.manager.get(f.spec.id)).state, "unknown");
		assert.equal((await f.manager.get(f.spec.id)).released, true);
		assert.equal((await f.manager.get(f.other.id)).released, undefined);
		assert.equal(app.calls.filter(call => call.args[1] === "list" && call.command === "git").length, 2);
		assert.equal(app.calls.filter(call => call.args[1] === "remove").length, 1);
		assert.ok(app.inherited[0]!.length === 2 && app.inherited[0]!.every(fd => Number.isInteger(fd) && fd >= 0));
		assert.ok(app.inherited[1]!.length === 1 && app.inherited[1]![0]! >= 0);
		assert.deepEqual(app.lockInodes, [[(await stat(checkout + ".lock")).ino, (await stat(f.store + ".lock")).ino], [(await stat(mainCheckoutDir + ".lock")).ino]]);
	});
});

test("/done recovery accepts real completion proof without writing a release", async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		const select = f.ctx.ui.select;
		f.ctx.ui.select = async (title, options) => {
			await select(title, options);
			await recordNonDispatch(await readJob(f.dir), new HerdrRequestError("closed", "not sent", false));
			return "Recheck proof";
		};
		const app = harness(snapshotExecutor(), (path, operation) => f.manager.guardRemoval(path, operation), (path, ctx, check) => f.manager.recoverRemoval(path, ctx, check));
		await app.command("--force", f.ctx);
		assert.equal((await f.manager.get(f.spec.id)).released, undefined);
		assert.match(f.notifications.at(-1)!, /Verified completion/);
		assert.equal(app.calls.filter(call => call.args[1] === "remove").length, 1);
	});
});

for (const choice of [undefined, "Keep protection", "wrong-id", "non-ui", "record-lock", "store-lock", "checkout-lock"])
test(`/done recovery preserves protection for ${choice ?? "Escape"}`, async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		const app = harness(snapshotExecutor(), (path, operation) => f.manager.guardRemoval(path, operation), (path, ctx, check) => f.manager.recoverRemoval(path, ctx, check));
		if (choice === "wrong-id") f.answers.push("Release protection despite this risk", "wrong");
		else f.answers.push(choice);
		if (choice === "non-ui") Object.assign(f.ctx, { hasUI: false });
		const run = () => app.command("--force", f.ctx);
		if (choice === "store-lock" || choice === "checkout-lock") {
			await withWorktreeLock(choice === "store-lock" ? f.store : checkout, async () => { await assert.rejects(run(), { code: "ELOCKED" }); });
			assert.equal(f.choices.length, 0);
		} else if (choice === "record-lock") {
			// A held start lock cannot be stolen, even after typed consent.
			f.answers.splice(0, 1, "Release protection despite this risk", f.spec.id);
			await withWorktreeLock(join(f.dir, "spec.json"), async () => { await assert.rejects(run(), { code: "ELOCKED" }); });
		} else if (choice === "wrong-id" || choice === "non-ui") await assert.rejects(run(), /exact command ID|Active or unknown/);
		else await run();
		assert.equal((await f.manager.get(f.spec.id)).released, undefined);
		assert.equal(app.calls.some(call => call.args[1] === "remove"), false);
	});
});

for (const change of ["branch", "session", "lifecycle", "pane", "checkout", "worktrees", "ownership"])
test(`/done revalidates ${change} after recovery and never loops over fresh failures`, async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		let recovered = false;
		const fallback = snapshotExecutor();
		const app = harness(call => {
			if (recovered && change === "pane" && call.args[0] === "pane") return ok(JSON.stringify({ result: { pane: { pane_id: "other" } } }));
			if (recovered && change === "checkout" && call.args.includes("--git-common-dir")) return ok(mainCheckoutDir + "/other.git\n");
			if (recovered && change === "worktrees" && call.args[0] === "worktree" && call.args[1] === "list") return ok(`worktree ${mainCheckoutDir}\0HEAD a\0\0`);
			return fallback(call);
		}, (path, operation) => f.manager.guardRemoval(path, operation), async (path, ctx, check) => {
			const result = await f.manager.recoverRemoval(path, ctx, check);
			recovered = true;
			if (change === "branch") (f.ctx.sessionManager as SessionManager).appendMessage({ role: "user", content: "changed", timestamp: Date.now() });
			if (change === "session") t.mock.method(f.ctx.sessionManager, "getSessionId", () => "other-session");
			if (change === "lifecycle") app.events.get("session_before_switch")!();
			if (change === "ownership") {
				const spec = { ...f.spec, id: randomUUID(), token: randomUUID() };
				await mkdir(join(f.store, spec.id), { mode: 0o700 }); await writePrivate(join(f.store, spec.id, "spec.json"), spec);
			}
			return result;
		});
		f.answers.push("Release protection despite this risk", f.spec.id);
		await assert.rejects(app.command("--force", f.ctx), /lifecycle changed|identity changed|does not own|registered linked checkout|Active or unknown/);
		assert.equal(f.choices.length, 1);
		assert.equal(app.calls.some(call => call.args[1] === "remove"), false);
	});
});

test("/done never retries once removal may have started, even for an ownership-shaped failure", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const fallback = snapshotExecutor();
		let recovery = 0;
		const app = harness(call => {
			if (call.args[1] === "remove") throw new CommandRemovalBlocked("mutation already started");
			return fallback(call);
		}, undefined, async () => { recovery++; return true; });
		await assert.rejects(app.command("--force", context()), /mutation already started/);
		assert.equal(recovery, 0);
		assert.equal(app.calls.filter(call => call.args[1] === "remove").length, 1);
	});
});

test("/done requires separate consent for each blocking command in its checkout", async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		const second = { ...f.spec, id: randomUUID(), token: randomUUID() };
		await mkdir(join(f.store, second.id), { mode: 0o700 }); await writePrivate(join(f.store, second.id, "spec.json"), second);
		f.answers.push("Release protection despite this risk", "Release protection despite this risk");
		f.ctx.ui.input = async (_title, placeholder) => placeholder;
		const app = harness(snapshotExecutor(), (path, operation) => f.manager.guardRemoval(path, operation), (path, ctx, check) => f.manager.recoverRemoval(path, ctx, check));
		await app.command("--force", f.ctx);
		assert.equal(f.choices.length, 2);
		for (const id of [f.spec.id, second.id]) assert.equal((await f.manager.get(id)).released, true);
		assert.equal((await f.manager.get(f.other.id)).released, undefined);
		assert.equal(app.calls.filter(call => call.args[1] === "remove").length, 1);
	});
});

test("/done without a user interface cannot silently confirm normal removal", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const ctx = context(); Object.assign(ctx, { hasUI: false });
		const app = harness(snapshotExecutor());
		await assert.rejects(app.command("", ctx), /user interface for confirmation/);
		assert.equal(app.calls.length, 0);
	});
});

for (const force of ["", "--force"]) for (const mismatch of ["pane", "workspace", "pane-checkout"])
test(`/done ${force} rejects a mismatched ${mismatch} before recovery for a blocked checkout`, async (t) => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const f = await recoveryFixture(t);
		Object.assign(f.ctx, { mode: "rpc" });
		f.answers.push("Cancel and recheck", "Release protection despite this risk", f.spec.id);
		const fallback = snapshotExecutor();
		const app = harness(call => {
			if (call.args[0] === "pane" && mismatch !== "workspace") return ok(JSON.stringify({ result: { pane: {
				pane_id: mismatch === "pane" ? "other" : "p1", tab_id: "w1:t1", workspace_id: "w1", cwd: mismatch === "pane-checkout" ? mainCheckoutDir : checkout,
			} } }));
			if (call.args[0] === "workspace" && mismatch === "workspace") return ok(JSON.stringify({ result: { workspace: { workspace_id: "w1", worktree: {
				checkout_path: mainCheckoutDir, repo_root: mainCheckoutDir, repo_key: join(mainCheckoutDir, ".git"), is_linked_worktree: true,
			} } } }));
			return fallback(call);
		}, (path, operation) => f.manager.guardRemoval(path, operation), (path, ctx, check) => f.manager.recoverRemoval(path, ctx, check));
		await assert.rejects(app.command(force, f.ctx), /does not own/);
		assert.equal(f.choices.length, 0);
		for (const file of ["cancel.json", "released.json"]) await assert.rejects(readFile(join(f.dir, file)), { code: "ENOENT" });
		assert.equal(app.calls.some(call => call.args[1] === "remove"), false);
	});
});

for (const exitCode of [0, 7])
test(`/done bounds stderr drain after Git exits with ${exitCode}, not while Git is alive`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-done-drain-")), store = join(root, "store");
	await mkdir(store, { mode: 0o700 });
	const previousPath = process.env.PATH, previousRoot = process.env.DRAIN_ROOT;
	process.env.PATH = root + ":" + previousPath; process.env.DRAIN_ROOT = root;
	const waitForFile = async (name: string) => {
		for (let n = 0; n < 100; n++) {
			try { await readFile(join(root, name)); return; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await delay(20);
		}
		assert.fail(`Fixture did not create ${name}`);
	};
	const descendant = `const fs = require("node:fs"), root = process.env.DRAIN_ROOT;
process.stderr.on("error", () => {});
fs.writeFileSync(root + "/ready", "ready");
const timer = setInterval(() => {
 if (fs.existsSync(root + "/stop")) { clearInterval(timer); process.stderr.destroy(); fs.writeFileSync(root + "/stopped", "stopped"); }
 else process.stderr.write("descendant diagnostic\\n");
}, 20);`;
	await writeFile(join(root, "git"), `#!${process.execPath}
if (process.argv[2] === "pull") process.exit(0);
const fs = require("node:fs"), root = process.env.DRAIN_ROOT;
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", 2] }).unref();
const timer = setInterval(() => {
 if (fs.existsSync(root + "/exit")) { clearInterval(timer); process.stderr.write("Git final diagnostic\\n", () => process.exit(${exitCode})); }
}, 20);
`, { mode: 0o700 });
	t.after(async () => {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		if (previousRoot === undefined) delete process.env.DRAIN_ROOT; else process.env.DRAIN_ROOT = previousRoot;
		await rm(root, { recursive: true, force: true });
	});
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const key = await realpath(checkout);
		const manager = new CommandManager(store, checkoutAdmission({ on() {}, exec: async () => ({ code: 0, stdout: key + "\n" }) }));
		const app = harness(snapshotExecutor(), (path, operation) => manager.guardRemoval(path, operation), undefined, runLockedGit);
		const ctx = context(); Object.assign(ctx, { cwd: checkout });
		let finished = false;
		const result = app.command("--force", ctx).then(() => undefined, error => error as Error).finally(() => { finished = true; });
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await waitForFile("ready");
			await delay(200);
			assert.equal(finished, false, "no drain deadline while Git is alive");
			for (const path of [checkout, store]) await assert.rejects(withWorktreeLock(path, async () => {}), { code: "ELOCKED" });
			await writeFile(join(root, "exit"), "exit");
			const failure = await Promise.race([result, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Git exited but stderr prevented completion")), 2000); })]);
			if (exitCode === 0) assert.equal(failure, undefined);
			else { assert.match(failure!.message, /failed \(7\):[\s\S]*Git final diagnostic/); assert.ok(Buffer.byteLength(failure!.message) < 8500); }
			for (const path of [checkout, store]) await withWorktreeLock(path, async () => {});
		} finally {
			clearTimeout(deadline);
			await writeFile(join(root, "exit"), "exit"); await writeFile(join(root, "stop"), "stop");
			await result;
			await waitForFile("stopped");
		}
	});
});
