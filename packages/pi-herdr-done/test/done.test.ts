import assert from "node:assert/strict";
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
	workspaceId: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
	if (herdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = herdrEnv;
	if (workspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = workspaceId;
	try {
		await run();
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
	}
}

const context = (events: string[] = [], confirmed = true) => ({
	cwd: "/repo/worktree",
	waitForIdle: async () => { events.push("idle"); },
	ui: { confirm: async (title: string, message: string) => { events.push(`confirm:${title}:${message}`); return confirmed; } },
}) as unknown as ExtensionCommandContext;

test("/done waits for idle then asks Herdr to remove the current worktree without force", async () => {
	await withHerdrEnvironment("1", "workspace-current", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events));
		assert.deepEqual(events, [
			"confirm:Done:Close and remove the current Herdr worktree?",
			"idle",
		]);
		assert.deepEqual(app.calls, [{
			command: "herdr",
			args: ["worktree", "remove", "--workspace", "workspace-current"],
			options: { cwd: "/repo/worktree" },
		}]);
	});
});

test("/done --force skips confirmation and forwards explicit force to Herdr", async () => {
	await withHerdrEnvironment("1", "workspace-current", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("--force", context(events));
		assert.deepEqual(events, ["idle"]);
		assert.deepEqual(app.calls[0]?.args, [
			"worktree", "remove", "--workspace", "workspace-current", "--force",
		]);
	});
});

test("declined confirmation leaves the worktree untouched", async () => {
	await withHerdrEnvironment("1", "workspace-current", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events, false));
		assert.deepEqual(events, ["confirm:Done:Close and remove the current Herdr worktree?"]);
		assert.deepEqual(app.calls, []);
	});
});

test("/done fails safely outside a current Herdr worktree and preserves Herdr removal errors", async (t) => {
	await t.test("rejects arguments and missing Herdr context before execution", async () => {
		for (const [args, herdrEnv, workspaceId, expected] of [
			["--yes", "1", "workspace-current", /Usage: \/done \[--force\]/],
			["", undefined, "workspace-current", /inside Herdr/],
			["", "1", undefined, /HERDR_WORKSPACE_ID/],
		] as const) {
			await withHerdrEnvironment(herdrEnv, workspaceId, async () => {
				const app = harness();
				await assert.rejects(app.command(args, context()), expected);
				assert.deepEqual(app.calls, []);
			});
		}
	});

	await t.test("surfaces dirty-worktree refusal", async () => {
		await withHerdrEnvironment("1", "workspace-current", async () => {
			const app = harness({
				stdout: "",
				stderr: '{"error":{"code":"dirty_worktree_requires_force"}}',
				code: 1,
				killed: false,
			});
			await assert.rejects(app.command("", context()), /dirty_worktree_requires_force/);
		});
	});
});
