import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import herdrDoneExtension from "../extensions/done.ts";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function harness(result: ExecResult = { stdout: "", stderr: "", code: 0, killed: false }) {
	let command: Command | undefined;
	const calls: Array<{ command: string; args: string[]; options: { cwd: string } }> = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "done") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			calls.push({ command: executable, args, options });
			return result;
		},
	} as unknown as ExtensionAPI;
	herdrDoneExtension(api);
	assert.ok(command);
	return { command, calls };
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
	cwd: "/repo/worktree",
	waitForIdle: async () => { events.push("idle"); },
	ui: { confirm: async (title: string, message: string) => { events.push(`confirm:${title}:${message}`); return confirmed; } },
}) as unknown as ExtensionCommandContext;

test("/done removes the worktree checkout then closes only the current tab without force", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events));
		assert.deepEqual(events, [
			"confirm:Done:Close and remove the current Herdr worktree?",
			"idle",
		]);
		assert.deepEqual(app.calls, [
			{
				command: "git",
				args: ["worktree", "remove", "."],
				options: { cwd: "/repo/worktree" },
			},
			{ command: "herdr", args: ["tab", "close", "w1:t1"], options: { cwd: tmpdir() } },
		]);
	});
});

test("/done --force skips confirmation and forwards force to git worktree remove", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("--force", context(events));
		assert.deepEqual(events, ["idle"]);
		assert.deepEqual(app.calls[0]?.args, ["worktree", "remove", "--force", "."]);
		assert.equal(app.calls.length, 2);
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

test("/done fails safely outside a current Herdr worktree and preserves removal errors", async (t) => {
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
			const app = harness({
				stdout: "",
				stderr: "error: the following file is dirty",
				code: 1,
				killed: false,
			});
			await assert.rejects(app.command("", context()), /dirty/);
			assert.equal(app.calls.length, 1);
		});
	});
});
