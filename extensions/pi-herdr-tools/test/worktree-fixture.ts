import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import herdrCloneExtension from "../internal/clone-tab.ts";
import herdrHandoffExtension from "../internal/handoff.ts";
import { fixture, shellProbe, success, type ExecResult } from "./helper.ts";

export const head = "a".repeat(40);
export const main = "b".repeat(40);
export const params = { branch: "fix/login", label: "Fix login", agentName: "login-fixer", prompt: "Fix the login bug.\nRun npm test." };
export type Call = { command: string; args: string[]; options: { cwd: string } };
export type Override = (call: Call) => ExecResult | undefined;

/** Only the process boundary is simulated. No live Herdr resource is created. */
export async function worktreeFixture(kind: "clone" | "handoff", settings: { folder?: boolean; linked?: boolean; busy?: boolean } = {}) {
	const data = await fixture();
	const primary = data.cwd;
	const selected = settings.linked ? join(data.root, "linked") : primary;
	if (settings.linked) await mkdir(selected);
	const cwd = settings.folder ? data.root : selected;
	const checkout = join(data.root, "new-checkout");
	const repoKey = join(primary, ".git");
	const base = kind === "clone" ? head : main;
	const worktree = { repo_root: primary, repo_key: repoKey, checkout_path: checkout, is_linked_worktree: true };
	const newPane = (id: string) => ({ pane_id: id, tab_id: id === "pane-root" ? "tab-new" : "tab-extra", workspace_id: "workspace-new", cwd: checkout,
		agent: settings.busy && id === "pane-root" ? "pi" : undefined });
	const allocation = () => ({ result: {
		type: "worktree_created",
		workspace: { workspace_id: "workspace-new", worktree },
		tab: { tab_id: "tab-new", workspace_id: "workspace-new" },
		root_pane: newPane("pane-root"),
		worktree: { path: checkout, is_linked_worktree: true, open_workspace_id: "workspace-new", branch: params.branch },
	} });
	let allocated = false;
	let override: Override = () => undefined;
	const calls: Call[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let tool: any;
	const api = {
		registerCommand(name: string, value: { handler: typeof handler }) { if (name === "clone-worktree") handler = value.handler; },
		registerTool(value: unknown) { tool = value; },
		exec: async (command: string, args: string[], options: { cwd: string }) => {
			const call = { command, args, options };
			calls.push(call);
			if (command === "herdr" && args[0] === "worktree" && args[1] === "create") allocated = true;
			const custom = override(call);
			if (custom) return custom;
			if (command === "git") {
				const path = resolve(options.cwd);
				if (![primary, selected, checkout].includes(path)) return { stdout: "", stderr: "not a git repository", code: 128, killed: false };
				if (args.includes("--show-toplevel")) return success(path + "\n");
				if (args.includes("--git-common-dir")) return success(repoKey + "\n");
				if (args[0] === "worktree") return success(`worktree ${primary}\0HEAD ${main}\0\0worktree ${selected}\0HEAD ${head}\0\0${allocated ? `worktree ${checkout}\0HEAD ${base}\0\0` : ""}`);
				if (args[0] === "show-ref") return { stdout: "", stderr: "", code: 1, killed: false };
				if (args[0] === "check-ref-format") return success(params.branch);
				if (args[0] === "symbolic-ref") return success(`refs/heads/${params.branch}\n`);
				if (args.includes("refs/heads/main^{commit}")) return success(main + "\n");
				if (args.includes("HEAD^{commit}")) return success((path === checkout ? base : head) + "\n");
				throw new Error(`Unexpected git arguments: ${args}`);
			}
			const probe = shellProbe(args);
			if (probe) return probe;
			if (args[0] === "pane" && args[1] === "get") return success({ result: { pane: args[2] === "pane-current"
				? { pane_id: "pane-current", tab_id: "tab-current", workspace_id: "workspace-current", cwd }
				: newPane(args[2]!) } });
			if (args[0] === "workspace" && args[1] === "get") return success({ result: { workspace: { workspace_id: args[2],
				worktree: args[2] === "workspace-new" ? worktree : settings.folder ? null : { ...worktree, checkout_path: selected, is_linked_worktree: !!settings.linked } } } });
			if (args[0] === "worktree" && args[1] === "list") return success({ result: { type: "worktree_list",
				source: { repo_key: repoKey, repo_root: primary, source_checkout_path: primary },
				worktrees: [{ path: primary, is_linked_worktree: false, is_bare: false }] } });
			if (args[0] === "worktree" && args[1] === "create") return success(allocation());
			if (args[0] === "tab" && args[1] === "get") return success({ result: { tab: { tab_id: args[2], workspace_id: "workspace-new" } } });
			if (args[0] === "tab" && args[1] === "create") return success({ result: { tab: { tab_id: "tab-extra", workspace_id: "workspace-new" }, root_pane: newPane("pane-extra") } });
			if (args[0] === "agent" || (args[0] === "tab" && args[1] === "focus")) return success();
			throw new Error(`Unexpected Herdr arguments: ${args}`);
		},
	} as unknown as ExtensionAPI;
	if (kind === "clone") herdrCloneExtension(api); else herdrHandoffExtension(api);
	const ctx = { cwd, sessionManager: data.manager, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } } as unknown as ExtensionCommandContext;
	return { ...data, primary, selected, contextCwd: cwd, checkout, repoKey, base, calls, allocation, notifications,
		setOverride(value: Override) { override = value; },
		run(project?: string, signal?: AbortSignal) { return kind === "clone" ? handler(project ?? "", ctx) : tool.execute("call", { ...params, ...(project === undefined ? {} : { project }) }, signal, undefined, ctx); },
		get schema() { return tool?.parameters; },
	};
}
