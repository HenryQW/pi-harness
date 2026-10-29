import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure } from "@henryqw/pi-herdr";
import { Type } from "typebox";
import {
	createWorktree,
	errorMessage,
	launchPiAgent,
	prepareWorktreeLaunch,
	requiredString,
	resolveWorkspace,
} from "./worktree.ts";

import { selectWorktreeSource, verifyCheckout } from "./repository.ts";

const PROMPT_TIMEOUT_MS = 30_000;

const nonEmpty = (description: string) => Type.String({ description, minLength: 1, pattern: "\\S" });

const HandoffParams = Type.Object({
	project: Type.Optional(nonEmpty("Explicit Git project path, absolute or relative to the current working directory; required outside the pane workspace repository")),
	branch: nonEmpty("New Git branch for the worktree, created from local main"),
	label: nonEmpty("Short Herdr workspace label"),
	// Herdr agent names must match this pattern; checking it here fails before any mutation.
	agentName: Type.String({
		description: "Unique Herdr agent name for the new Pi agent: lowercase letter, then up to 31 of a-z, 0-9, _ or -",
		pattern: "^[a-z][a-z0-9_-]{0,31}$",
	}),
	prompt: nonEmpty("Self-contained task prompt for the new agent"),
});

/** Register `herdr_handoff` only inside Herdr, where it can run. */
export default function herdrHandoffExtension(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	pi.registerTool({
		name: "herdr_handoff",
		label: "Herdr Handoff",
		description: "Create a Herdr worktree from local main, start Pi in it, and submit a self-contained task prompt. Focus does not change.",
		promptSnippet: "Hand off a separate task to a new Pi agent in a new Herdr worktree from local main",
		promptGuidelines: [
			"Use herdr_handoff only when the user asks to hand off a task to a new worktree, for example through /handoff-worktree.",
		],
		parameters: HandoffParams,
		executionMode: "sequential",

		async execute(_toolCallId, { branch, label, agentName, prompt, project }, signal, _onUpdate, ctx) {
			const paneId = requiredString(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
			const workspace = await resolveWorkspace(herdr, ctx.cwd, paneId);
			const repository = await selectWorktreeSource(pi, herdr, ctx.cwd, workspace, project, "handoff", branch);

			signal?.throwIfAborted();
			const worktree = await createWorktree(herdr, ctx.cwd, [
				"worktree", "create", "--cwd", repository.repoRoot,
				"--branch", branch, "--base", repository.base, "--label", label, "--no-focus",
			], "Handoff", repository);
			const { workspaceId, checkoutPath } = worktree;
			const { target, onPaneBusy, verify } = await prepareWorktreeLaunch(herdr, ctx.cwd, worktree, repository,
				() => verifyCheckout(pi, worktree.checkoutPath, repository)).catch((error: unknown) => {
				throw new Error(
					`Handoff launch preparation failed; retained Herdr workspace ${workspaceId}, tab ${worktree.tabId}, root pane ${worktree.rootPaneId}, branch ${branch}, checkout ${checkoutPath}: ${errorMessage(error)}`,
					{ cause: error },
				);
			});
			const retained = () =>
				`Herdr workspace ${workspaceId}, tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}`;
			if (signal?.aborted) throw new Error(`Handoff was cancelled before agent start; retained ${retained()}.`);
			await launchPiAgent(herdr, ctx.cwd, { action: "Handoff", name: agentName, pane: target.paneId, args: [], retained, onPaneBusy, verify });

			const promptArgs = [
				"agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--timeout", String(PROMPT_TIMEOUT_MS),
			];
			if (signal?.aborted) throw new Error(`Handoff was cancelled before prompt delivery; retained ${retained()}, and agent ${agentName}.`);
			const delivered = await herdr.exec(promptArgs, { cwd: ctx.cwd });
			if (delivered.code !== 0 || delivered.killed) {
				throw new Error(
					`Handoff prompt was not confirmed for agent ${agentName}; retained ${retained()}, and agent ${agentName}: ${herdrCommandFailure(promptArgs, delivered)}`,
				);
			}

			const details = { workspaceId, tabId: target.tabId, paneId: target.paneId, branch, checkoutPath, agentName };
			return {
				content: [{
					type: "text" as const,
					text: `Handed off to agent ${agentName}, which is working in Herdr workspace ${workspaceId} (tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}). Focus did not change.`,
				}],
				details,
			};
		},
	});
}
