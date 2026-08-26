import { randomUUID } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
	createHerdrClient,
	herdrCommandFailure,
	hasHerdrErrorCode,
	withWorktreeLock,
	type HerdrClient,
	type HerdrExecResult,
} from "@henryqw/pi-herdr";

type WorkspaceInfo = {
	workspace_id?: unknown;
	worktree?: {
		checkout_path?: unknown;
		repo_root?: unknown;
		is_linked_worktree?: unknown;
	} | null;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
	return value;
}

type SourceContext = {
	sessionFile: string;
	leafId: string;
	workspaceId: string;
	checkout: string | undefined;
	repoRoot: string | undefined;
	isLinkedWorktree: boolean;
	/** False while Pi has not flushed the session yet (no assistant entry on disk). */
	persisted: boolean;
};

async function resolveSource(
	commandName: string,
	herdr: HerdrClient<{ cwd: string }>,
	ctx: ExtensionCommandContext,
): Promise<SourceContext> {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error(`/${commandName} requires the current Pi session inside Herdr (HERDR_ENV=1).`);
	}
	const requestedPaneId = requiredString(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
	const currentSessionFile = requiredString(
		ctx.sessionManager.getSessionFile(),
		"Persisted Pi session file",
	);
	const leafId = requiredString(ctx.sessionManager.getLeafId(), "Current Pi session leaf");
	const sessionFile = resolve(currentSessionFile);
	let persisted = true;
	try {
		if (!(await stat(sessionFile)).isFile()) throw new Error(`Persisted Pi session path is not a file: ${sessionFile}`);
	} catch (error) {
		// Pi defers all session-file writes until the first assistant message
		// completes, so a fresh session mid-first-turn has no file on disk.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		persisted = false;
	}

	const paneResponse = await herdr.json(["pane", "get", requestedPaneId], { cwd: ctx.cwd });
	const pane = (paneResponse as { result?: { pane?: { pane_id?: unknown; workspace_id?: unknown } } }).result?.pane;
	requiredString(pane?.pane_id, "Herdr pane response pane_id");
	const workspaceId = requiredString(pane?.workspace_id, "Herdr pane response workspace_id");
	const workspaceResponse = await herdr.json(["workspace", "get", workspaceId], { cwd: ctx.cwd });
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
	return { sessionFile, leafId, workspaceId, checkout, repoRoot, isLinkedWorktree, persisted };
}

// Mirror of SessionManager.createBranchedSession for sessions Pi has not
// flushed to disk yet: serialize the live active path under a fresh header.
async function writeCloneFromLiveState(
	ctx: ExtensionCommandContext,
	source: SourceContext,
	cwd: string,
): Promise<string> {
	const sessionId = randomUUID();
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: source.sessionFile,
	};
	const entries = ctx.sessionManager.getBranch(source.leafId);
	if (entries.length === 0) throw new Error("Pi session has no entries to clone.");
	const cloneFile = join(
		ctx.sessionManager.getSessionDir(),
		`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
	);
	await writeFile(cloneFile, [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n");
	return cloneFile;
}

async function createBranchedClone(
	ctx: ExtensionCommandContext,
	source: SourceContext,
	cwd: string,
): Promise<string> {
	if (!source.persisted) return await writeCloneFromLiveState(ctx, source, cwd);
	const session = SessionManager.open(source.sessionFile, ctx.sessionManager.getSessionDir(), cwd);
	const createdClone = session.createBranchedSession(source.leafId);
	if (!createdClone) throw new Error("Pi did not create a persisted clone session file.");
	const cloneFile = resolve(createdClone);
	try {
		if ((await stat(cloneFile)).isFile()) return cloneFile;
	} catch (error) {
		throw new Error(`Pi clone session file was not created: ${cloneFile}`, { cause: error });
	}
	throw new Error(`Pi clone session path is not a file: ${cloneFile}`);
}

// A worktree layout plugin (e.g. herdr-plus) can start its own agent in a new
// worktree's root pane right after creation. Give it a moment to appear so the
// clone can move to its own tab instead of failing with agent_pane_busy.
async function waitForRootPaneAgent(
	herdr: HerdrClient<{ cwd: string }>,
	ctx: ExtensionCommandContext,
	paneId: string,
): Promise<string | undefined> {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const response = await herdr.json(["pane", "get", paneId], { cwd: ctx.cwd });
		const agent = (response as { result?: { pane?: { agent?: unknown } } }).result?.pane?.agent;
		if (typeof agent === "string" && agent.trim()) return agent;
		await delay(250);
	}
	return undefined;
}

function parseCreatedTab(createdTab: HerdrExecResult, workspaceId: string): { tabId: string; rootPaneId: string } {
	let tabId: string | undefined;
	let rootPaneId: string | undefined;
	try {
		const response: unknown = JSON.parse(createdTab.stdout);
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new Error("Herdr tab create returned invalid JSON");
		}
		const result = (response as { result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } } }).result;
		tabId = typeof result?.tab?.tab_id === "string" && result.tab.tab_id.trim() ? result.tab.tab_id : undefined;
		rootPaneId = typeof result?.root_pane?.pane_id === "string" && result.root_pane.pane_id.trim()
			? result.root_pane.pane_id
			: undefined;
		const missing = [!tabId && "tab_id", !rootPaneId && "root_pane.pane_id"].filter(Boolean).join(", ");
		if (missing) throw new Error(`Herdr tab create response is missing ${missing}.`);
		return { tabId: tabId!, rootPaneId: rootPaneId! };
	} catch (error) {
		const retained = [`workspace ${workspaceId}`, tabId && `tab ${tabId}`, rootPaneId && `root pane ${rootPaneId}`]
			.filter(Boolean).join(", ");
		throw new Error(`Herdr tab create response could not be parsed; retained ${retained}: ${errorMessage(error)}`, { cause: error });
	}
}

async function discardCloneOrAggregate(cloneFile: string, error: Error): Promise<never> {
	try {
		await unlink(cloneFile);
	} catch (cleanupError) {
		throw new AggregateError(
			[error, cleanupError],
			`${error.message} Clone cleanup also failed for ${cloneFile}: ${errorMessage(cleanupError)}`,
		);
	}
	throw error;
}

async function launchCloneAgent(
	herdr: HerdrClient<{ cwd: string }>,
	ctx: ExtensionCommandContext,
	rootPaneId: string,
	cloneFile: string,
	retained: string,
	onPaneBusy?: () => Promise<{ rootPaneId: string; retained: string }>,
): Promise<string> {
	const agentName = `clone-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	try {
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const startArgs = [
				"agent", "start", agentName, "--kind", "pi", "--pane", rootPaneId,
				"--", "--session", cloneFile,
			];
			const result = await herdr.exec(startArgs, { cwd: ctx.cwd });
			if (result.code === 0 && !result.killed) return agentName;
			if (hasHerdrErrorCode(result, "agent_pane_busy") && onPaneBusy) {
				({ rootPaneId, retained } = await onPaneBusy());
				onPaneBusy = undefined;
				continue;
			}
			if (!hasHerdrErrorCode(result, "agent_pane_busy") || attempt === 5) {
				throw new Error(herdrCommandFailure(startArgs, result));
			}
			await delay(250);
		}
		throw new Error("Herdr agent start retry loop exited unexpectedly.");
	} catch (error) {
		throw new Error(
			`Clone launch could not be confirmed after starting agent ${agentName}; retained ${retained}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

export default function herdrCloneExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	pi.registerCommand("clone-tab", {
		description: "Clone the current conversation path into a new Herdr tab",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const source = await resolveSource("clone-tab", herdr, ctx);
			const mutate = async (): Promise<{ createdTab: HerdrExecResult; cloneFile: string }> => {
				const cloneFile = await createBranchedClone(ctx, source, ctx.cwd);
				const tabCreateArgs = ["tab", "create", "--workspace", source.workspaceId, "--cwd", ctx.cwd, "--no-focus"] as const;
				const createdTab = await herdr.exec(tabCreateArgs, { cwd: ctx.cwd });
				if (createdTab.code !== 0 || createdTab.killed) {
					await discardCloneOrAggregate(cloneFile, new Error(herdrCommandFailure(tabCreateArgs, createdTab)));
				}
				return { createdTab, cloneFile };
			};
			const { createdTab, cloneFile } = source.checkout ? await withWorktreeLock(source.checkout, mutate) : await mutate();
			let tab: ReturnType<typeof parseCreatedTab>;
			try {
				tab = parseCreatedTab(createdTab, source.workspaceId);
			} catch (error) {
				throw new Error(
					`Clone launch could not be confirmed after creating a Herdr tab; retained session ${cloneFile}: ${errorMessage(error)}`,
					{ cause: error },
				);
			}
			const { tabId, rootPaneId } = tab;
			const agentName = await launchCloneAgent(herdr, ctx, rootPaneId, cloneFile, `Herdr tab ${tabId}, root pane ${rootPaneId}, and session ${cloneFile}`);

			try {
				await herdr.run(["tab", "focus", tabId], { cwd: ctx.cwd });
			} catch (error) {
				ctx.ui.notify(
					`Clone agent ${agentName} started in Herdr tab ${tabId} (root pane ${rootPaneId}), but focus failed: ${errorMessage(error)}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Cloned current conversation into Herdr tab ${tabId} (root pane ${rootPaneId}, agent ${agentName}).`,
				"info",
			);
		},
	});

	pi.registerCommand("clone-worktree", {
		description: "Clone the current conversation into Pi in a new Herdr Git worktree",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const source = await resolveSource("clone-worktree", herdr, ctx);

			// Herdr only creates worktrees from the repo parent workspace; running
			// /clone-worktree inside a linked worktree must retarget the parent.
			let targetWorkspaceId = source.workspaceId;
			if (source.isLinkedWorktree) {
				const listing = await herdr.json(["workspace", "list"], { cwd: ctx.cwd });
				const result = (listing as { result?: { workspaces?: WorkspaceInfo[] } }).result;
				const parent = (Array.isArray(result?.workspaces) ? result.workspaces : []).find((entry) =>
					entry.worktree != null && !entry.worktree.is_linked_worktree &&
					entry.worktree.checkout_path === source.repoRoot);
				targetWorkspaceId = typeof parent?.workspace_id === "string"
					? parent.workspace_id
					: requiredString(undefined, `Repo parent workspace for ${source.repoRoot} in herdr workspace list`);
			}
			// Create the worktree before the clone so the session header can be
			// stamped with the fresh checkout cwd. A killed or incomplete create is
			// ambiguous: Herdr may have retained partial worktree state.
			const worktreeCreateArgs = ["worktree", "create", "--workspace", targetWorkspaceId, "--no-focus"] as const;
			const createdWorktree = await herdr.exec(worktreeCreateArgs, { cwd: ctx.cwd });
			if (createdWorktree.code !== 0 && !createdWorktree.killed) {
				throw new Error(herdrCommandFailure(worktreeCreateArgs, createdWorktree));
			}

			let workspaceId: string | undefined;
			let tabId: string | undefined;
			let rootPaneId: string | undefined;
			let checkoutPath: string | undefined;
			try {
				const response: unknown = JSON.parse(createdWorktree.stdout);
				if (!response || typeof response !== "object" || Array.isArray(response)) {
					throw new Error("Herdr worktree create returned invalid JSON");
				}
				// Herdr nests checkout_path under workspace.worktree; the top-level
				// result.worktree uses `path` instead.
				const result = (response as {
					result?: {
						workspace?: { workspace_id?: unknown; worktree?: { checkout_path?: unknown } };
						tab?: { tab_id?: unknown };
						root_pane?: { pane_id?: unknown };
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
				const missing = [
					[workspaceId, "workspace_id"],
					[tabId, "tab_id"],
					[rootPaneId, "root_pane.pane_id"],
					[checkoutPath, "workspace.worktree.checkout_path"],
				].filter(([value]) => !value).map(([, label]) => label);
				if (missing.length > 0) {
					throw new Error(`Herdr worktree create response is missing ${missing.join(", ")}.`);
				}
			} catch (error) {
				const known = [
					workspaceId && `workspace ${workspaceId}`,
					tabId && `tab ${tabId}`,
					rootPaneId && `root pane ${rootPaneId}`,
					checkoutPath && `checkout ${checkoutPath}`,
				].filter(Boolean).join(", ");
				throw new Error(
					`Clone could not be confirmed after creating a Herdr worktree${known ? ` (${known})` : ""}; Herdr may have retained a partial worktree workspace, inspect herdr workspace list: ${errorMessage(error)}`,
					{ cause: error },
				);
			}

			// A layout plugin may have claimed the root pane; park the clone in its
			// own tab so both agents coexist.
			let targetTabId = tabId!;
			let targetPaneId = rootPaneId!;
			const createCloneTab = async (): Promise<void> => {
				const cloneTabArgs = ["tab", "create", "--workspace", workspaceId!, "--cwd", checkoutPath!, "--no-focus"] as const;
				const createdTab = await herdr.exec(cloneTabArgs, { cwd: ctx.cwd });
				if (createdTab.code !== 0 || createdTab.killed) {
					throw new Error(herdrCommandFailure(cloneTabArgs, createdTab));
				}
				({ tabId: targetTabId, rootPaneId: targetPaneId } = parseCreatedTab(createdTab, workspaceId!));
			};
			if (await waitForRootPaneAgent(herdr, ctx, rootPaneId!)) await createCloneTab();

			let cloneFile: string;
			try {
				cloneFile = source.checkout
					? await withWorktreeLock(source.checkout, () => createBranchedClone(ctx, source, checkoutPath!))
					: await createBranchedClone(ctx, source, checkoutPath!);
			} catch (error) {
				throw new Error(
					`Clone session could not be created for Herdr worktree workspace ${workspaceId} (tab ${tabId}, checkout ${checkoutPath}); retained worktree without a clone session: ${errorMessage(error)}`,
					{ cause: error },
				);
			}
			const agentName = await launchCloneAgent(
				herdr, ctx, targetPaneId, cloneFile,
				`Herdr workspace ${workspaceId}, tab ${targetTabId}, root pane ${targetPaneId}, and session ${cloneFile}`,
				targetPaneId === rootPaneId ? async () => {
					await createCloneTab();
					return {
						rootPaneId: targetPaneId,
						retained: `Herdr workspace ${workspaceId}, tab ${targetTabId}, root pane ${targetPaneId}, and session ${cloneFile}`,
					};
				} : undefined,
			);

			try {
				await herdr.run(["tab", "focus", targetTabId], { cwd: ctx.cwd });
			} catch (error) {
				ctx.ui.notify(
					`Clone agent ${agentName} started in Herdr worktree workspace ${workspaceId} (tab ${targetTabId}, checkout ${checkoutPath}), but focus failed: ${errorMessage(error)}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Cloned current conversation into Herdr worktree workspace ${workspaceId} (tab ${targetTabId}, checkout ${checkoutPath}, agent ${agentName}).`,
				"info",
			);
		},
	});
}
