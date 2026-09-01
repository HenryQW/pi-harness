import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
	executeGitHubMerge,
	selectMergeMethod,
} from "./pr-merge.ts";
import {
	loadCurrentPullRequest,
	type CurrentPullRequest,
} from "./pr-github.ts";
import {
	deriveNextStep,
	type NextStep,
} from "./pr-routing.ts";

type WorkflowNextStep = Exclude<NextStep, "none" | "merge">;

const WORKFLOWS: Record<WorkflowNextStep, string> = {
	create: "skill:pi-pr-create",
	"update-branch": "skill:pi-pr-update-branch",
	sweep: "skill:pi-pr-comment-sweep",
	"fix-ci": "skill:pi-pr-fix-ci",
};

type PrCommandPi = Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
export type PrCommandHandler = RegisteredCommand["handler"];

function dispatchWorkflow(pi: PrCommandPi, ctx: ExtensionCommandContext, commandName: string): void {
	const command = pi.getCommands().find((candidate) =>
		candidate.name === commandName &&
		candidate.source === "skill" &&
		candidate.sourceInfo.origin === "package",
	);
	if (!command) throw new Error(`${commandName} failed: bundled workflow is unavailable`);

	const options = ctx.isIdle()
		? { expandPromptTemplates: true }
		: { deliverAs: "followUp" as const, expandPromptTemplates: true };
	pi.sendUserMessage(`/${command.name}`, options);
}

function noActionNotification(pullRequest: CurrentPullRequest): { message: string; type: "info" | "warning" } {
	if (pullRequest.lifecycle === "merged" || pullRequest.lifecycle === "closed") {
		return { message: `PR #${pullRequest.number} is ${pullRequest.lifecycle}; no action needed`, type: "info" };
	}
	if (pullRequest.conditions.draft) {
		return { message: `PR #${pullRequest.number} is draft; no action available`, type: "warning" };
	}
	const mutatingWorkflowSelected = pullRequest.conditions.baseUpdateRequired || pullRequest.conditions.conflict ||
		pullRequest.conditions.changesRequested || pullRequest.conditions.unresolvedThreads > 0 ||
		pullRequest.conditions.ci === "failure";
	if (mutatingWorkflowSelected && pullRequest.local.worktree === "dirty") {
		return { message: `PR #${pullRequest.number} is blocked by a dirty worktree`, type: "warning" };
	}
	if (mutatingWorkflowSelected && pullRequest.local.head !== "equal") {
		return { message: `PR #${pullRequest.number} is blocked by local HEAD ${pullRequest.local.head}`, type: "warning" };
	}
	if (pullRequest.conditions.ci === "running") {
		return { message: `PR #${pullRequest.number} is waiting for CI`, type: "warning" };
	}
	if (pullRequest.conditions.review === "pending") {
		return { message: `PR #${pullRequest.number} is waiting for review`, type: "warning" };
	}
	if (pullRequest.conditions.policy === "pending") {
		return { message: `PR #${pullRequest.number} is blocked by merge policy`, type: "warning" };
	}
	if (pullRequest.local.worktree === "dirty") {
		return { message: `PR #${pullRequest.number} is blocked by a dirty worktree`, type: "warning" };
	}
	if (pullRequest.local.head === "ahead" || pullRequest.local.head === "diverged") {
		return { message: `PR #${pullRequest.number} is blocked by local HEAD ${pullRequest.local.head}`, type: "warning" };
	}
	return { message: `PR #${pullRequest.number} has no available action`, type: "warning" };
}

function isSameConfirmedMerge(current: CurrentPullRequest, fresh: CurrentPullRequest): boolean {
	return current.id === fresh.id && current.host === fresh.host &&
		current.head.oid === fresh.head.oid &&
		current.base.repository === fresh.base.repository &&
		current.base.ref === fresh.base.ref &&
		current.base.oid === fresh.base.oid;
}

async function mergePullRequest(
	pi: PrCommandPi,
	ctx: ExtensionCommandContext,
	current: CurrentPullRequest,
): Promise<void> {
	if (!current.merge) throw new Error(`PR #${current.number} merge failed: merge capabilities are unavailable`);
	const method = selectMergeMethod(current.merge);
	const confirmed = await ctx.ui.confirm(
		`Merge PR #${current.number} with ${method}?`,
		`Merge PR #${current.number} using ${method}.`,
	);
	if (!confirmed) return;

	const fresh = await loadCurrentPullRequest(pi, ctx);
	if (!fresh) throw new Error(`PR #${current.number} merge cancelled: pull request is no longer current`);
	if (!isSameConfirmedMerge(current, fresh)) {
		throw new Error(`PR #${current.number} merge cancelled: confirmed pull request context changed`);
	}
	if (deriveNextStep(fresh) !== "merge") {
		throw new Error(`PR #${fresh.number} merge cancelled: pull request is no longer merge-ready`);
	}
	if (!fresh.merge) throw new Error(`PR #${fresh.number} merge failed: merge capabilities are unavailable`);
	const freshMethod = selectMergeMethod(fresh.merge);
	if (freshMethod !== method) {
		throw new Error(`PR #${fresh.number} merge cancelled: merge method changed from ${method} to ${freshMethod}`);
	}
	await executeGitHubMerge({
		exec: (command, args, options) => pi.exec(command, args, {
			...options,
			signal: ctx.signal,
			timeout: 10_000,
		}),
		cwd: ctx.cwd,
		pullRequestId: fresh.id,
		hostname: fresh.host,
		expectedHead: current.head.oid,
		expectedBase: current.base,
		headFetchSource: fresh.headFetchSource,
		allowedMergeMethods: fresh.merge.allowedMergeMethods,
		viewerDefaultMergeMethod: fresh.merge.viewerDefaultMergeMethod,
	});
}

export function createPrCommandHandler(pi: PrCommandPi): PrCommandHandler {
	return async (args, ctx) => {
		if (args.trim()) throw new Error("/pr does not accept arguments");

		const current = await loadCurrentPullRequest(pi, ctx);
		const nextStep = deriveNextStep(current);
		if (nextStep === "none") {
			if (current) {
				const notification = noActionNotification(current);
				ctx.ui.notify(notification.message, notification.type);
			}
			return;
		}
		if (nextStep === "merge") {
			if (!current) throw new Error("/pr merge failed: pull request is unavailable");
			await mergePullRequest(pi, ctx, current);
			return;
		}

		dispatchWorkflow(pi, ctx, WORKFLOWS[nextStep]);
	};
}
