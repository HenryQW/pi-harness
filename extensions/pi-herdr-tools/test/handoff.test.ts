import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrHandoffExtension from "../internal/handoff.ts";
import { shellProbe, success, withPane, type ExecResult } from "./helper.ts";

type Execute = (id: string, params: Record<string, string>, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) =>
	Promise<{ content: Array<{ text: string }>; details: Record<string, string> }>;

const params = { branch: "fix/login", label: "Fix login", agentName: "login-fixer", prompt: "Fix the login bug.\nRun npm test." };

function harness(respond: (command: string, args: string[]) => ExecResult | undefined) {
	let execute: Execute | undefined;
	const calls: Array<{ command: string; args: string[] }> = [];
	const api = {
		registerTool(tool: { name: string; execute: Execute }) {
			if (tool.name === "herdr_handoff") execute = tool.execute;
		},
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			return respond(command, args) ?? shellProbe(args) ?? success();
		},
	} as unknown as ExtensionAPI;
	herdrHandoffExtension(api);
	assert.ok(execute);
	return { run: () => execute!("call-1", params, undefined, undefined, { cwd: "/repos/main-wt" }), calls };
}

function linkedWorktree(command: string, args: string[], rootAgent?: string): ExecResult | undefined {
	if (command === "git") return success("abc123\n");
	if (args[0] === "pane" && args[1] === "get") {
		return args[2] === "pane-root"
			? success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: rootAgent } } })
			: success({ result: { pane: { pane_id: "pane-linked", workspace_id: "workspace-linked" } } });
	}
	if (args[0] === "workspace" && args[1] === "get") {
		return success({ result: { workspace: {
			workspace_id: args[2],
			worktree: { checkout_path: "/repos/main-wt", repo_root: "/repos/main", is_linked_worktree: true },
		} } });
	}
	if (args[0] === "workspace" && args[1] === "list") {
		return success({ result: { workspaces: [
			{ workspace_id: "workspace-parent", worktree: { checkout_path: "/repos/main", is_linked_worktree: false } },
			{ workspace_id: "workspace-linked", worktree: { checkout_path: "/repos/main-wt", repo_root: "/repos/main", is_linked_worktree: true } },
		] } });
	}
	if (args[0] === "worktree" && args[1] === "create") {
		return success({ result: {
			workspace: { workspace_id: "workspace-new", worktree: { checkout_path: "/repos/fix-login" } },
			tab: { tab_id: "tab-new" },
			root_pane: { pane_id: "pane-root" },
		} });
	}
	if (args[0] === "tab" && args[1] === "create") {
		return success({ result: { tab: { tab_id: "tab-extra" }, root_pane: { pane_id: "pane-extra" } } });
	}
	return undefined;
}

test("herdr_handoff creates the worktree from main through the parent workspace and delivers the prompt", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) => linkedWorktree(command, args));
		const result = await app.run();

		const herdrArgs = app.calls.filter((call) => call.command === "herdr").map((call) => call.args);
		assert.deepEqual(herdrArgs.find((args) => args[0] === "worktree"), [
			"worktree", "create", "--workspace", "workspace-parent",
			"--branch", "fix/login", "--base", "main", "--label", "Fix login", "--no-focus",
		]);
		assert.deepEqual(herdrArgs.find((args) => args[1] === "start"), [
			"agent", "start", "login-fixer", "--kind", "pi", "--pane", "pane-root", "--",
		]);
		assert.deepEqual(herdrArgs.at(-1), [
			"agent", "prompt", "login-fixer", params.prompt, "--wait", "--until", "working", "--timeout", "30000",
		]);
		assert.equal(herdrArgs.some((args) => args[1] === "focus"), false);
		assert.deepEqual(result.details, {
			workspaceId: "workspace-new", tabId: "tab-new", paneId: "pane-root",
			branch: "fix/login", checkoutPath: "/repos/fix-login", agentName: "login-fixer",
		});
	});
});

test("herdr_handoff fails without a local main branch before any Herdr call", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) =>
			command === "git" ? { stdout: "", stderr: "", code: 1, killed: false } : linkedWorktree(command, args));
		await assert.rejects(app.run(), /local main branch.*nothing was created/);
		assert.deepEqual(app.calls.map((call) => call.command), ["git"]);
	});
});

test("herdr_handoff names every retained resource when prompt delivery fails", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) => args[0] === "agent" && args[1] === "prompt"
			? { stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }), stderr: "", code: 1, killed: false }
			: linkedWorktree(command, args, "pi"));
		await assert.rejects(app.run(), (error: Error) => {
			for (const pattern of [
				/workspace-new/, /tab-extra/, /pane-extra/, /fix\/login/, /\/repos\/fix-login/, /agent login-fixer/, /agent_prompt_stalled/,
			]) assert.match(error.message, pattern);
			return true;
		});
	});
});
