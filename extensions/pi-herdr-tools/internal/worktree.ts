import { setTimeout as delay } from "node:timers/promises";
import { absolutePath, type WorktreeSource } from "./repository.ts";
import { herdrCommandFailure, startPiAgent, type HerdrClient, type HerdrExecResult } from "@henryqw/pi-herdr";

type Herdr = HerdrClient<{ cwd: string }>;

type WorkspaceInfo = {
	workspace_id?: unknown;
	worktree?: {
		checkout_path?: unknown;
		repo_root?: unknown;
		repo_key?: unknown;
		is_linked_worktree?: unknown;
	} | null;
};

export type HerdrWorkspace = {
	workspaceId: string;
	checkout: string | undefined;
	repoRoot: string | undefined;
	repoKey: string | undefined;
	isLinkedWorktree: boolean;
};

type CreatedWorktree = {
	workspaceId: string;
	tabId: string;
	rootPaneId: string;
	checkoutPath: string;
};

type LaunchTarget = { tabId: string; paneId: string };

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
	return value;
}

/** Resolve the Herdr workspace that owns `paneId`, with its Git worktree identity. */
export async function resolveWorkspace(herdr: Herdr, cwd: string, paneId: string): Promise<HerdrWorkspace> {
	const paneResponse = await herdr.json(["pane", "get", paneId], { cwd });
	const pane = (paneResponse as { result?: { pane?: { workspace_id?: unknown } } }).result?.pane;
	const workspaceId = requiredString(pane?.workspace_id, "Herdr pane response workspace_id");
	const workspaceResponse = await herdr.json(["workspace", "get", workspaceId], { cwd });
	const workspace = (workspaceResponse as { result?: { workspace?: WorkspaceInfo } }).result?.workspace;
	if (requiredString(workspace?.workspace_id, "Herdr workspace response workspace_id") !== workspaceId) {
		throw new Error(`Herdr workspace response did not match ${workspaceId}.`);
	}
	const checkout = workspace?.worktree == null
		? undefined
		: requiredString(workspace.worktree.checkout_path, "Herdr workspace response checkout_path");
	const repoRoot = typeof workspace?.worktree?.repo_root === "string" && workspace.worktree.repo_root.trim()
		? workspace.worktree.repo_root
		: undefined;
	const isLinkedWorktree = workspace?.worktree?.is_linked_worktree === true;
	if (isLinkedWorktree && !repoRoot) {
		throw new Error("Herdr workspace response is missing worktree.repo_root for a linked worktree.");
	}
	const repoKey = typeof workspace?.worktree?.repo_key === "string" ? workspace.worktree.repo_key : undefined;
	return { workspaceId, checkout, repoRoot, repoKey, isLinkedWorktree };
}

/** Prove the exact pane, tab, workspace, and checkout relationship before mutation. */
export async function verifyPaneTarget(herdr: Herdr, cwd: string, target: CreatedWorktree, source: { repoRoot: string; repoKey: string }, allowNested = false): Promise<string> {
	const response = await herdr.json(["pane", "get", target.rootPaneId], { cwd });
	const pane = (response.result as { pane?: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown; cwd?: unknown } } | undefined)?.pane;
	if (pane?.pane_id !== target.rootPaneId || pane.tab_id !== target.tabId || pane.workspace_id !== target.workspaceId ||
		(pane.cwd !== target.checkoutPath && !(allowNested && typeof pane.cwd === "string" && absolutePath(pane.cwd, "Pane cwd").startsWith(`${target.checkoutPath}/`)))) {
		throw new Error("Herdr pane does not own the exact tab, workspace, and checkout.");
	}
	const tabResponse = await herdr.json(["tab", "get", target.tabId], { cwd });
	const tab = (tabResponse.result as { tab?: { tab_id?: unknown; workspace_id?: unknown } } | undefined)?.tab;
	if (tab?.tab_id !== target.tabId || tab.workspace_id !== target.workspaceId) throw new Error("Herdr tab does not belong to the target workspace.");
	const workspace = await resolveWorkspace(herdr, cwd, target.rootPaneId);
	if (workspace.workspaceId !== target.workspaceId || workspace.checkout !== target.checkoutPath || !workspace.isLinkedWorktree ||
		workspace.repoRoot !== source.repoRoot || workspace.repoKey !== source.repoKey) throw new Error("Herdr workspace does not own the selected linked checkout.");
	return requiredString(pane.cwd, "Herdr pane cwd");
}

/**
 * Run `herdr worktree create` and parse its response. A killed or incomplete
 * create is ambiguous: Herdr may have retained partial worktree state, so the
 * error names every returned identifier. `action` prefixes that error.
 */
export async function createWorktree(
	herdr: Herdr,
	cwd: string,
	args: readonly string[],
	action: string,
	source: WorktreeSource,
): Promise<CreatedWorktree> {
	let createdWorktree: HerdrExecResult;
	try { createdWorktree = await herdr.exec(args, { cwd }); }
	catch (error) { throw new Error(`${action} allocation is uncertain; inspect Herdr workspaces for repository ${source.repoRoot}. Do not replay or delete it: ${errorMessage(error)}`, { cause: error }); }

	let workspaceId: string | undefined;
	let tabId: string | undefined;
	let rootPaneId: string | undefined;
	let checkoutPath: string | undefined;
	let returnedPath: string | undefined;
	let returnedBranch: string | undefined;
	try {
		const response: unknown = JSON.parse(createdWorktree.stdout);
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new Error("Herdr worktree create returned invalid JSON");
		}
		// Herdr nests checkout_path under workspace.worktree; the top-level
		// result.worktree uses `path` instead.
		const result = (response as {
			result?: {
				type?: unknown;
				workspace?: WorkspaceInfo;
				tab?: { tab_id?: unknown; workspace_id?: unknown };
				root_pane?: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown; cwd?: unknown };
				worktree?: { path?: unknown; is_linked_worktree?: unknown; open_workspace_id?: unknown; branch?: unknown };
			};
		}).result;
		// Collect every returned identifier before validating so recovery
		// keeps all known IDs even when an earlier field is missing.
		workspaceId = typeof result?.workspace?.workspace_id === "string" ? result.workspace.workspace_id : undefined;
		tabId = typeof result?.tab?.tab_id === "string" ? result.tab.tab_id : undefined;
		rootPaneId = typeof result?.root_pane?.pane_id === "string" ? result.root_pane.pane_id : undefined;
		checkoutPath = typeof result?.workspace?.worktree?.checkout_path === "string" && result.workspace.worktree.checkout_path.trim()
			? result.workspace.worktree.checkout_path
			: undefined;
		returnedPath = typeof result?.worktree?.path === "string" ? result.worktree.path : undefined;
		returnedBranch = typeof result?.worktree?.branch === "string" ? result.worktree.branch : source.branch;
		if (createdWorktree.killed) {
			throw new Error("Herdr worktree create was killed before completion.");
		}
		const missing = [
			[workspaceId, "workspace_id"],
			[tabId, "tab_id"],
			[rootPaneId, "root_pane.pane_id"],
			[checkoutPath, "workspace.worktree.checkout_path"],
		].filter(([value]) => !value).map(([, label]) => label);
		if (missing.length > 0) {
			throw new Error(`Herdr worktree create response is missing ${missing.join(", ")}.`);
		}
		if (createdWorktree.code !== 0) throw new Error(herdrCommandFailure(args, createdWorktree));
		absolutePath(checkoutPath, "Created checkout");
		if (result?.type !== "worktree_created" || result.workspace?.worktree?.repo_root !== source.repoRoot ||
			result.workspace.worktree.repo_key !== source.repoKey || result.workspace.worktree.is_linked_worktree !== true ||
			result.worktree?.path !== checkoutPath || result.worktree?.is_linked_worktree !== true || result.worktree?.open_workspace_id !== workspaceId ||
			(source.branch !== undefined && result.worktree?.branch !== source.branch) ||
			result.tab?.workspace_id !== workspaceId || result.root_pane?.workspace_id !== workspaceId ||
			result.root_pane?.tab_id !== tabId || result.root_pane?.cwd !== checkoutPath) {
			throw new Error("Herdr creation response repository, checkout, workspace, tab, or pane did not match.");
		}
	} catch (error) {
		const known = [
			workspaceId && `workspace ${workspaceId}`,
			tabId && `tab ${tabId}`,
			rootPaneId && `root pane ${rootPaneId}`,
			checkoutPath && `checkout ${checkoutPath}`,
			returnedPath && returnedPath !== checkoutPath && `returned worktree path ${returnedPath}`,
			returnedBranch && `branch ${returnedBranch}`,
		].filter(Boolean).join(", ");
		throw new Error(
			`${action} could not be confirmed after creating a Herdr worktree${known ? ` (${known})` : ""}; Herdr may have retained a partial worktree workspace for ${source.repoRoot}. Do not replay or delete it; inspect herdr workspace list: ${errorMessage(error)}${createdWorktree.code !== 0 || createdWorktree.killed ? ` (${herdrCommandFailure(args, createdWorktree)})` : ""}`,
			{ cause: error },
		);
	}
	return { workspaceId: workspaceId!, tabId: tabId!, rootPaneId: rootPaneId!, checkoutPath: checkoutPath! };
}

export function parseCreatedTab(createdTab: HerdrExecResult, workspaceId: string, checkoutPath?: string): { tabId: string; rootPaneId: string } {
	let tabId: string | undefined;
	let rootPaneId: string | undefined;
	try {
		const response: unknown = JSON.parse(createdTab.stdout);
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new Error("Herdr tab create returned invalid JSON");
		}
		const result = (response as { result?: { tab?: { tab_id?: unknown; workspace_id?: unknown }; root_pane?: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown; cwd?: unknown } } }).result;
		tabId = typeof result?.tab?.tab_id === "string" && result.tab.tab_id.trim() ? result.tab.tab_id : undefined;
		rootPaneId = typeof result?.root_pane?.pane_id === "string" && result.root_pane.pane_id.trim()
			? result.root_pane.pane_id
			: undefined;
		const missing = [!tabId && "tab_id", !rootPaneId && "root_pane.pane_id"].filter(Boolean).join(", ");
		if (missing) throw new Error(`Herdr tab create response is missing ${missing}.`);
		if (createdTab.code !== 0 || createdTab.killed) throw new Error(herdrCommandFailure(["tab", "create"], createdTab));
		if (checkoutPath !== undefined && (result?.tab?.workspace_id !== workspaceId || result.root_pane?.workspace_id !== workspaceId ||
			result.root_pane?.tab_id !== tabId || result.root_pane?.cwd !== checkoutPath)) throw new Error("Created tab does not match the workspace and checkout.");
		return { tabId: tabId!, rootPaneId: rootPaneId! };
	} catch (error) {
		const retained = [`workspace ${workspaceId}`, tabId && `tab ${tabId}`, rootPaneId && `root pane ${rootPaneId}`]
			.filter(Boolean).join(", ");
		throw new Error(`Herdr tab create response could not be parsed; retained ${retained}: ${errorMessage(error)}${createdTab.code !== 0 || createdTab.killed ? ` (${herdrCommandFailure(["tab", "create"], createdTab)})` : ""}`, { cause: error });
	}
}

// A worktree layout plugin (e.g. herdr-plus) can start its own agent in a new
// worktree's root pane right after creation. Give it a moment to appear so the
// new agent can move to its own tab instead of failing with agent_pane_busy.
async function waitForRootPaneAgent(herdr: Herdr, cwd: string, paneId: string): Promise<string | undefined> {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const response = await herdr.json(["pane", "get", paneId], { cwd });
		const agent = (response as { result?: { pane?: { agent?: unknown } } }).result?.pane?.agent;
		if (typeof agent === "string" && agent.trim()) return agent;
		await delay(250);
	}
	return undefined;
}

/**
 * Choose the pane for a new agent in a created worktree. A layout plugin may
 * claim the root pane; park the agent in its own tab so both coexist. The
 * returned target updates in place when `onPaneBusy` creates that tab later.
 */
export async function prepareWorktreeLaunch(
	herdr: Herdr,
	cwd: string,
	worktree: CreatedWorktree,
	source: WorktreeSource,
	verifyGit: () => Promise<void>,
): Promise<{ target: LaunchTarget; onPaneBusy?: () => Promise<string>; verify: () => Promise<void> }> {
	const target: LaunchTarget = { tabId: worktree.tabId, paneId: worktree.rootPaneId };
	const verify = async () => {
		try {
			await verifyGit();
			await verifyPaneTarget(herdr, cwd, { ...worktree, tabId: target.tabId, rootPaneId: target.paneId }, source);
		} catch (error) {
			throw new Error(`Launch verification failed; retained workspace ${worktree.workspaceId}, tab ${target.tabId}, pane ${target.paneId}, checkout ${worktree.checkoutPath}: ${errorMessage(error)}`, { cause: error });
		}
	};
	await verify();
	const createTab = async (): Promise<string> => {
		const tabArgs = ["tab", "create", "--workspace", worktree.workspaceId, "--cwd", worktree.checkoutPath, "--no-focus"] as const;
		const createdTab = await herdr.exec(tabArgs, { cwd });
		({ tabId: target.tabId, rootPaneId: target.paneId } = parseCreatedTab(createdTab, worktree.workspaceId, worktree.checkoutPath));
		await verify();
		return target.paneId;
	};
	try {
		if (await waitForRootPaneAgent(herdr, cwd, worktree.rootPaneId)) await createTab();
	} catch (error) {
		throw new Error(`Launch preparation failed; retained workspace ${worktree.workspaceId}, tab ${target.tabId}, pane ${target.paneId}, checkout ${worktree.checkoutPath}: ${errorMessage(error)}`, { cause: error });
	}
	return { target, onPaneBusy: target.paneId === worktree.rootPaneId ? createTab : undefined, verify };
}

/**
 * Start a Pi agent and wrap every failure as an ambiguous launch that names the
 * retained resources. `retained` is read at failure time so a busy-pane move
 * reports the final target.
 */
export async function launchPiAgent(
	herdr: Herdr,
	cwd: string,
	input: {
		action: string;
		name: string;
		pane: string;
		args: readonly string[];
		retained: () => string;
		onPaneBusy?: () => Promise<string>;
		verify?: () => Promise<void>;
	},
): Promise<void> {
	let pane = input.pane;
	try { await input.verify?.(); }
	catch (error) { throw new Error(`${input.action} was not launched; retained ${input.retained()}: ${errorMessage(error)}`, { cause: error }); }
	try {
		const result = await startPiAgent(herdr, {
			name: input.name,
			pane,
			args: input.args,
			options: { cwd },
			onPaneBusy: input.onPaneBusy
				? async () => (pane = await input.onPaneBusy!())
				: undefined,
		});
		if (result.code === 0 && !result.killed) return;
		const startArgs = ["agent", "start", input.name, "--kind", "pi", "--pane", pane, "--", ...input.args];
		throw new Error(herdrCommandFailure(startArgs, result));
	} catch (error) {
		throw new Error(
			`${input.action} launch could not be confirmed after starting agent ${input.name}; retained ${input.retained()}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}
