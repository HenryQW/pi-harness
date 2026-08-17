import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure, hasHerdrErrorCode } from "@henryqw/pi-herdr";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
	return value;
}

export default function herdrCloneExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ cwd: string }>((command, args, options) =>
		pi.exec(command, [...args], options));

	pi.registerCommand("clone-tab", {
		description: "Clone the current conversation path into a new Herdr tab",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (process.env.HERDR_ENV !== "1") {
				throw new Error("/clone-tab requires the current Pi session inside Herdr (HERDR_ENV=1).");
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

			const session = SessionManager.open(sessionFile, ctx.sessionManager.getSessionDir(), ctx.cwd);
			const createdClone = session.createBranchedSession(leafId);
			if (!createdClone) throw new Error("Pi did not create a persisted clone session file.");
			const cloneFile = resolve(createdClone);
			let cloneStat;
			try {
				cloneStat = await stat(cloneFile);
			} catch (error) {
				throw new Error(`Pi clone session file was not created: ${cloneFile}`, { cause: error });
			}
			if (!cloneStat.isFile()) throw new Error(`Pi clone session path is not a file: ${cloneFile}`);

			let tabId: string;
			let rootPaneId: string;
			try {
				const tabResponse = await herdr.json([
					"tab", "create", "--workspace", workspaceId, "--cwd", ctx.cwd, "--no-focus",
				], { cwd: ctx.cwd });
				const result = (tabResponse as {
					result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
				}).result;
				tabId = requiredString(result?.tab?.tab_id, "Herdr tab response tab_id");
				rootPaneId = requiredString(result?.root_pane?.pane_id, `Herdr tab ${tabId} root pane_id`);
			} catch (error) {
				try {
					await unlink(cloneFile);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						`${errorMessage(error)} Clone cleanup also failed for ${cloneFile}: ${errorMessage(cleanupError)}`,
					);
				}
				throw error;
			}

			const agentName = `clone-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
			const startArgs = [
				"agent", "start", agentName, "--kind", "pi", "--pane", rootPaneId,
				"--", "--session", cloneFile,
			];
			try {
				for (let attempt = 1; attempt <= 5; attempt += 1) {
					const result = await herdr.exec(startArgs, { cwd: ctx.cwd });
					if (result.code === 0 && !result.killed) break;
					if (!hasHerdrErrorCode(result, "agent_pane_busy") || attempt === 5) {
						throw new Error(herdrCommandFailure(startArgs, result));
					}
					await delay(250);
				}
			} catch (error) {
				throw new Error(
					`Clone launch could not be confirmed after starting agent ${agentName}; retained Herdr tab ${tabId}, root pane ${rootPaneId}, and session ${cloneFile}: ${errorMessage(error)}`,
					{ cause: error },
				);
			}

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
}
