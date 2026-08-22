import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure, hasHerdrErrorCode, type HerdrClient, type HerdrExecResult } from "@henryqw/pi-herdr";
import { lock } from "proper-lockfile";

type WorkspaceInfo = {
	workspace_id?: unknown;
	worktree?: { checkout_path?: unknown } | null;
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
	let sourceStat;
	try {
		sourceStat = await stat(sessionFile);
	} catch (error) {
		throw new Error(`Persisted Pi session file does not exist: ${sessionFile}`, { cause: error });
	}
	if (!sourceStat.isFile()) throw new Error(`Persisted Pi session path is not a file: ${sessionFile}`);

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
	return { sessionFile, leafId, workspaceId, checkout };
}

async function createBranchedClone(
	ctx: ExtensionCommandContext,
	source: SourceContext,
	cwd: string,
): Promise<string> {
	const session = SessionManager.open(source.sessionFile, ctx.sessionManager.getSessionDir(), cwd);
	const createdClone = session.createBranchedSession(source.leafId);
	if (!createdClone) throw new Error("Pi did not create a persisted clone session file.");
	const cloneFile = resolve(createdClone);
	let cloneStat;
	try {
		cloneStat = await stat(cloneFile);
	} catch (error) {
		throw new Error(`Pi clone session file was not created: ${cloneFile}`, { cause: error });
	}
	if (!cloneStat.isFile()) throw new Error(`Pi clone session path is not a file: ${cloneFile}`);
	return cloneFile;
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
): Promise<string> {
	const agentName = `clone-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const startArgs = [
		"agent", "start", agentName, "--kind", "pi", "--pane", rootPaneId,
		"--", "--session", cloneFile,
	];
	try {
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const result = await herdr.exec(startArgs, { cwd: ctx.cwd });
			if (result.code === 0 && !result.killed) return agentName;
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
	const herdr = createHerdrClient<{ cwd: string }>((command, args, options) =>
		pi.exec(command, [...args], options));

	pi.registerCommand("clone-tab", {
		description: "Clone the current conversation path into a new Herdr tab",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const source = await resolveSource("clone-tab", herdr, ctx);
			const release = source.checkout ? await lock(source.checkout) : undefined;

			let cloneFile: string;
			let createdTab: HerdrExecResult;
			try {
				cloneFile = await createBranchedClone(ctx, source, ctx.cwd);
				const tabCreateArgs = ["tab", "create", "--workspace", source.workspaceId, "--cwd", ctx.cwd, "--no-focus"] as const;
				createdTab = await herdr.exec(tabCreateArgs, { cwd: ctx.cwd });
				if (createdTab.code !== 0 || createdTab.killed) {
					await discardCloneOrAggregate(cloneFile, new Error(herdrCommandFailure(tabCreateArgs, createdTab)));
				}
			} finally {
				await release?.();
			}

			let tabId: string | undefined;
			let rootPaneId: string | undefined;
			try {
				const tabResponse: unknown = JSON.parse(createdTab.stdout);
				if (!tabResponse || typeof tabResponse !== "object" || Array.isArray(tabResponse)) {
					throw new Error("Herdr tab create returned invalid JSON");
				}
				const result = (tabResponse as {
					result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
				}).result;
				tabId = requiredString(result?.tab?.tab_id, "Herdr tab response tab_id");
				rootPaneId = requiredString(result?.root_pane?.pane_id, `Herdr tab ${tabId} root pane_id`);
			} catch (error) {
				throw new Error(
					`Clone launch could not be confirmed after creating a Herdr tab; retained${tabId ? ` Herdr tab ${tabId} and` : ""} session ${cloneFile}: ${errorMessage(error)}`,
					{ cause: error },
				);
			}
			const agentName = await launchCloneAgent(herdr, ctx, rootPaneId!, cloneFile, `Herdr tab ${tabId}, root pane ${rootPaneId}, and session ${cloneFile}`);

			try {
				await herdr.run(["tab", "focus", tabId!], { cwd: ctx.cwd });
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

			// Create the worktree before the clone so the session header can be
			// stamped with the fresh checkout cwd. A killed or incomplete create is
			// ambiguous: Herdr may have retained partial worktree state.
			const worktreeCreateArgs = ["worktree", "create", "--workspace", source.workspaceId, "--no-focus"] as const;
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
				const result = (response as {
					result?: {
						workspace?: { workspace_id?: unknown };
						tab?: { tab_id?: unknown };
						root_pane?: { pane_id?: unknown };
						worktree?: { checkout_path?: unknown };
					};
				}).result;
				// Collect every returned identifier before validating so recovery
				// keeps all known IDs even when an earlier field is missing.
				workspaceId = typeof result?.workspace?.workspace_id === "string" ? result.workspace.workspace_id : undefined;
				tabId = typeof result?.tab?.tab_id === "string" ? result.tab.tab_id : undefined;
				rootPaneId = typeof result?.root_pane?.pane_id === "string" ? result.root_pane.pane_id : undefined;
				checkoutPath = typeof result?.worktree?.checkout_path === "string" ? result.worktree.checkout_path : undefined;
				const missing = [
					[workspaceId, "workspace_id"],
					[tabId, "tab_id"],
					[rootPaneId, "root_pane.pane_id"],
					[checkoutPath, "worktree.checkout_path"],
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

			let cloneFile: string;
			const release = source.checkout ? await lock(source.checkout) : undefined;
			try {
				cloneFile = await createBranchedClone(ctx, source, checkoutPath!);
			} catch (error) {
				throw new Error(
					`Clone session could not be created for Herdr worktree workspace ${workspaceId} (tab ${tabId}, checkout ${checkoutPath}); retained worktree without a clone session: ${errorMessage(error)}`,
					{ cause: error },
				);
			} finally {
				await release?.();
			}
			const agentName = await launchCloneAgent(
				herdr, ctx, rootPaneId!, cloneFile,
				`Herdr workspace ${workspaceId}, tab ${tabId}, root pane ${rootPaneId}, and session ${cloneFile}`,
			);

			try {
				await herdr.run(["tab", "focus", tabId!], { cwd: ctx.cwd });
			} catch (error) {
				ctx.ui.notify(
					`Clone agent ${agentName} started in Herdr worktree workspace ${workspaceId} (tab ${tabId}, checkout ${checkoutPath}), but focus failed: ${errorMessage(error)}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Cloned current conversation into Herdr worktree workspace ${workspaceId} (tab ${tabId}, checkout ${checkoutPath}, agent ${agentName}).`,
				"info",
			);
		},
	});
}
