import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { lock } from "proper-lockfile";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import herdrDoneExtension from "../extensions/done.ts";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
type ExecCall = { command: string; args: string[]; options: { cwd: string } };
type Executor = (call: ExecCall) => ExecResult | Promise<ExecResult>;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const checkout = await mkdtemp(join(tmpdir(), "pi-herdr-done-"));
after(async () => await rm(checkout, { recursive: true, force: true }));

function harness(executor: Executor = () => ok()) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "done") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			const call = { command: executable, args, options };
			calls.push(call);
			return executor(call);
		},
	} as unknown as ExtensionAPI;
	herdrDoneExtension(api);
	assert.ok(command);
	return { command, calls };
}

function snapshotExecutor(options: {
	toplevel?: string;
	panes?: unknown[];
	tabs?: unknown[];
	removeResult?: ExecResult;
} = {}): Executor {
	return async ({ command, args }) => {
		if (command === "git" && args[0] === "rev-parse") return ok(`${options.toplevel ?? checkout}\n`);
		if (command === "herdr" && args[0] === "api") {
			return ok(JSON.stringify({ result: { snapshot: { panes: options.panes ?? [] } } }));
		}
		if (command === "herdr" && args[0] === "tab") {
			return ok(JSON.stringify({ result: { tabs: options.tabs ?? [] } }));
		}
		if (command === "git" && args[0] === "worktree") return options.removeResult ?? ok();
		return ok();
	};
}

async function withHerdrEnvironment(
	herdrEnv: string | undefined,
	tabId: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousTabId = process.env.HERDR_TAB_ID;
	if (herdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = herdrEnv;
	if (tabId === undefined) delete process.env.HERDR_TAB_ID;
	else process.env.HERDR_TAB_ID = tabId;
	try {
		await run();
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousTabId === undefined) delete process.env.HERDR_TAB_ID;
		else process.env.HERDR_TAB_ID = previousTabId;
	}
}

const context = (events: string[] = [], confirmed = true) => ({
	cwd: "/repo/worktree/nested",
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
			"confirm:Done:Close and remove the current Herdr worktree?",
			"idle",
		]);
		assert.deepEqual(app.calls, [
			{ command: "git", args: ["rev-parse", "--show-toplevel"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "herdr", args: ["api", "snapshot"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["worktree", "remove", checkout], options: { cwd: "/repo/worktree/nested" } },
			{ command: "herdr", args: ["tab", "close", "w1:t1"], options: { cwd: tmpdir() } },
		]);
	});
});

test("/done --force skips confirmation and dependents check, forwards force to git worktree remove", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor({
			panes: [{ tab_id: "w2:t9", cwd: checkout }],
		}));
		await app.command("--force", context());
		assert.deepEqual(app.calls.find((c) => c.args[0] === "worktree")?.args,
			["worktree", "remove", "--force", checkout]);
	});
});

test("/done refuses with blocking tab labels when another Herdr tab still uses the checkout", async () => {
	for (const cwd of [checkout, `${checkout}/sub`]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				panes: [{ tab_id: "w2:t9", cwd }, { tab_id: "w3:t4", cwd }],
				tabs: [
					{ tab_id: "w2:t9", label: "Fix puid pgid" },
					{ tab_id: "w3:t4" },
				],
			}));
			await assert.rejects(
				app.command("", context()),
				/still used by Herdr tabs Fix puid pgid, w3:t4/);
			assert.equal(app.calls.length, 3);
		});
	}
});

test("/done does not check or remove while clone creation holds the checkout lock", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const release = await lock(checkout);
		try {
			const app = harness(snapshotExecutor());
			await assert.rejects(app.command("", context()), /already being held/);
			assert.deepEqual(app.calls.map((call) => call.args[0]), ["rev-parse"]);
		} finally {
			await release();
		}
	});
});

test("declined confirmation leaves the worktree untouched", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events, false));
		assert.deepEqual(events, ["confirm:Done:Close and remove the current Herdr worktree?"]);
		assert.deepEqual(app.calls, []);
	});
});

test("/done fails safely before any execution and preserves removal errors", async (t) => {
	await t.test("rejects arguments and missing Herdr context before execution", async () => {
		for (const [args, herdrEnv, tabId, expected] of [
			["--yes", "1", "w1:t1", /Usage: \/done \[--force\]/],
			["", undefined, "w1:t1", /inside Herdr/],
			["", "1", undefined, /HERDR_TAB_ID/],
		] as const) {
			await withHerdrEnvironment(herdrEnv, tabId, async () => {
				const app = harness();
				await assert.rejects(app.command(args, context()), expected);
				assert.deepEqual(app.calls, []);
			});
		}
	});

	await t.test("surfaces dirty-worktree refusal and skips tab close", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				removeResult: { stdout: "", stderr: "error: the following file is dirty", code: 1 },
			}));
			await assert.rejects(app.command("", context()), /dirty/);
			assert.equal(app.calls.length, 3);
		});
	});

	await t.test("treats a killed removal as failure", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				removeResult: { stdout: "", stderr: "", code: 0, killed: true },
			}));
			await assert.rejects(app.command("", context()), /killed/);
			assert.equal(app.calls.length, 3);
		});
	});
});
