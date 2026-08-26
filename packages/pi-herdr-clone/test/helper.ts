import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import herdrCloneExtension from "../extensions/clone-tab.ts";

export type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type ExecCall = { command: string; args: string[]; options: { cwd: string } };
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Respond = (args: string[]) => Promise<ExecResult | undefined> | ExecResult | undefined;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const success = (value: unknown = ""): ExecResult => ({
	stdout: typeof value === "string" ? value : JSON.stringify(value),
	stderr: "",
	code: 0,
	killed: false,
});

export async function fixture() {
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
	commandName: "clone-tab" | "clone-worktree",
	sessionManager: ExtensionCommandContext["sessionManager"],
	cwd: string,
	respond?: Respond,
) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const events: string[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === commandName) command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			calls.push({ command: executable, args, options });
			events.push(`exec:${args.slice(0, 2).join(" ")}`);
			const workspaceGet = args[0] === "workspace" && args[1] === "get";
			if (commandName === "clone-tab" && workspaceGet) return workspaceResponse(args, cwd);
			const custom = respond ? await respond(args) : undefined;
			if (custom) return custom;
			if (workspaceGet) return workspaceResponse(args, cwd);
			if (args[0] === "pane" && args[1] === "get") {
				return success({ result: { pane: { pane_id: "pane-live", workspace_id: "workspace-live" } } });
			}
			if (commandName === "clone-tab" && args[0] === "tab" && args[1] === "create") {
				return success({ result: { tab: { tab_id: "tab-new" }, root_pane: { pane_id: "pane-root" } } });
			}
			if (commandName === "clone-worktree" && args[0] === "worktree" && args[1] === "create") {
				return success({
					result: {
						workspace: { workspace_id: "workspace-new", worktree: { checkout_path: "/tmp/checkout" } },
						tab: { tab_id: "tab-new" },
						root_pane: { pane_id: "pane-root" },
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

function workspaceResponse(args: string[], cwd: string): ExecResult {
	return success({
		result: {
			workspace: {
				workspace_id: args[2],
				worktree: { checkout_path: cwd },
			},
		},
	});
}

export function tabHarness(
	sessionManager: ExtensionCommandContext["sessionManager"],
	cwd: string,
	respond?: Respond,
) {
	return harness("clone-tab", sessionManager, cwd, respond);
}

export function worktreeHarness(
	sessionManager: ExtensionCommandContext["sessionManager"],
	cwd: string,
	respond?: Respond,
) {
	return harness("clone-worktree", sessionManager, cwd, respond);
}

export async function withEnvironment(
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

export async function withPane(value: string | undefined, run: () => Promise<void>): Promise<void> {
	await withEnvironment("1", value, run);
}
