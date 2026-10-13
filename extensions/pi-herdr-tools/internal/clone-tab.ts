import { randomUUID } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
	withWorktreeLock,
	type HerdrClient,
	type HerdrExecResult,
} from "@henryqw/pi-herdr";
import {
	createWorktree,
	errorMessage,
	launchPiAgent,
	parseCreatedTab,
	prepareWorktreeLaunch,
	requiredString,
	resolveWorkspace,
	worktreeParentWorkspace,
	type HerdrWorkspace,
} from "./worktree.ts";

type SourceContext = HerdrWorkspace & {
	sessionFile: string;
	leafId: string;
	/** False while Pi has not flushed the session yet (no conversation message on disk). */
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
		// Pi defers all session-file writes until the first conversation message
		// (user message since 0.99, first assistant reply before), so a fresh
		// session can have live entries but no file on disk.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		persisted = false;
	}

	return { sessionFile, leafId, persisted, ...await resolveWorkspace(herdr, ctx.cwd, requestedPaneId) };
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

const cloneAgentName = () => `clone-${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export default function herdrCloneExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	pi.registerCommand("clone-tab", {
		description: "Clone the current conversation path into a new Herdr tab",
		handler: async (_args, ctx) => {
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
			const agentName = cloneAgentName();
			await launchPiAgent(herdr, ctx.cwd, {
				action: "Clone",
				name: agentName,
				pane: rootPaneId,
				args: ["--session", cloneFile],
				retained: () => `Herdr tab ${tabId}, root pane ${rootPaneId}, and session ${cloneFile}`,
			});

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
			const source = await resolveSource("clone-worktree", herdr, ctx);

			// Create the worktree before the clone so the session header can be
			// stamped with the fresh checkout cwd.
			const worktreeCreateArgs = [
				"worktree", "create", "--workspace", await worktreeParentWorkspace(herdr, ctx.cwd, source), "--no-focus",
			];
			const worktree = await createWorktree(herdr, ctx.cwd, worktreeCreateArgs, "Clone");
			const { workspaceId, tabId, checkoutPath } = worktree;
			const { target, onPaneBusy } = await prepareWorktreeLaunch(herdr, ctx.cwd, worktree);

			let cloneFile: string;
			try {
				cloneFile = source.checkout
					? await withWorktreeLock(source.checkout, () => createBranchedClone(ctx, source, checkoutPath))
					: await createBranchedClone(ctx, source, checkoutPath);
			} catch (error) {
				throw new Error(
					`Clone session could not be created for Herdr worktree workspace ${workspaceId} (tab ${tabId}, checkout ${checkoutPath}); retained worktree without a clone session: ${errorMessage(error)}`,
					{ cause: error },
				);
			}
			const agentName = cloneAgentName();
			await launchPiAgent(herdr, ctx.cwd, {
				action: "Clone",
				name: agentName,
				pane: target.paneId,
				args: ["--session", cloneFile],
				retained: () => `Herdr workspace ${workspaceId}, tab ${target.tabId}, root pane ${target.paneId}, and session ${cloneFile}`,
				onPaneBusy,
			});
			const targetTabId = target.tabId;

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
