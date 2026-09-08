import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	executeGitHubMerge,
	selectMergeMethod,
} from "./pr-merge.ts";
import {
	linkInferredPullRequest,
	loadCurrentPullRequest,
	samePullRequestSnapshot,
	type CurrentPullRequest,
} from "./pr-github.ts";
import {
	deriveNextStep,
	type NextStep,
} from "./pr-routing.ts";

type WorkflowNextStep = Extract<NextStep, "create" | "update-branch" | "sweep" | "fix-ci">;

const WORKFLOWS: Record<WorkflowNextStep, string> = {
	create: "skill:pi-pr-create",
	"update-branch": "skill:pi-pr-update-branch",
	sweep: "skill:pi-pr-comment-sweep",
	"fix-ci": "skill:pi-pr-fix-ci",
};

type PrCommandPi = Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
export type PrCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<NextStep>;

type PrCommandDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	linkInferredPullRequest?: typeof linkInferredPullRequest;
};

function dispatchWorkflow(
	pi: PrCommandPi,
	ctx: ExtensionCommandContext,
	commandName: string,
	instructions: string,
): void {
	const command = pi.getCommands().find((candidate) =>
		candidate.name === commandName &&
		candidate.source === "skill" &&
		candidate.sourceInfo.origin === "package"
	);
	if (!command) throw new Error(`${commandName} failed: bundled workflow is unavailable`);

	const options = ctx.isIdle()
		? { expandPromptTemplates: true }
		: { deliverAs: "followUp" as const, expandPromptTemplates: true };
	pi.sendUserMessage(`/${command.name}${instructions ? ` ${instructions}` : ""}`, options);
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
	return current.id === fresh.id && current.number === fresh.number &&
		current.url.href === fresh.url.href && current.host === fresh.host &&
		current.head.repository === fresh.head.repository &&
		current.head.ref === fresh.head.ref && current.head.oid === fresh.head.oid &&
		current.base.repository === fresh.base.repository &&
		current.base.ref === fresh.base.ref && current.base.oid === fresh.base.oid;
}

async function mergePullRequest(
	pi: PrCommandPi,
	ctx: ExtensionCommandContext,
	current: CurrentPullRequest,
	load: typeof loadCurrentPullRequest,
): Promise<boolean> {
	if (!current.merge) throw new Error(`PR #${current.number} merge failed: merge capabilities are unavailable`);
	const method = selectMergeMethod(current.merge);
	const confirmed = await ctx.ui.confirm(
		`Merge PR #${current.number}?`,
		`Method: ${method}.`,
	);
	if (!confirmed) return false;

	await executeGitHubMerge({
		exec: (command, args, options) => pi.exec(command, args, {
			...options,
			signal: ctx.signal,
			timeout: 10_000,
		}),
		cwd: ctx.cwd,
		pullRequestId: current.id,
		hostname: current.host,
		expectedHead: current.head.oid,
		expectedBase: current.base,
		headFetchSource: current.headFetchSource,
		allowedMergeMethods: current.merge.allowedMergeMethods,
		viewerDefaultMergeMethod: current.merge.viewerDefaultMergeMethod,
		revalidateReadiness: async (local) => {
			const discovery = await load(pi, ctx, local);
			if (discovery.kind !== "current") {
				throw new Error(`PR #${current.number} merge cancelled: pull request is no longer current`);
			}
			const fresh = discovery.pullRequest;
			if (!isSameConfirmedMerge(current, fresh)) {
				throw new Error(`PR #${current.number} merge cancelled: confirmed pull request context changed`);
			}
			if (deriveNextStep(discovery) !== "merge") {
				throw new Error(`PR #${fresh.number} merge cancelled: pull request is no longer merge-ready`);
			}
			if (!fresh.merge) throw new Error(`PR #${fresh.number} merge failed: merge capabilities are unavailable`);
			const freshMethod = selectMergeMethod(fresh.merge);
			if (freshMethod !== method) {
				throw new Error(`PR #${fresh.number} merge cancelled: merge method changed from ${method} to ${freshMethod}`);
			}
		},
	});
	return true;
}

async function linkPullRequest(
	pi: PrCommandPi,
	ctx: ExtensionCommandContext,
	current: CurrentPullRequest,
	load: typeof loadCurrentPullRequest,
	link: typeof linkInferredPullRequest,
): Promise<void> {
	const targetName = `${current.target.remote}/${current.target.ref}`;
	const confirmed = await ctx.ui.confirm(
		`Link pull request branch to ${targetName}?`,
		`Set ${targetName} as the push target for this branch.`,
	);
	if (!confirmed) return;

	const discovery = await load(pi, ctx);
	if (
		discovery.kind !== "current" ||
		discovery.pullRequest.target.provenance !== "inferred" ||
		!samePullRequestSnapshot(current, discovery.pullRequest)
	) throw new Error("Link branch cancelled: inferred pull request context changed");
	await link(pi, ctx, discovery.pullRequest);
}

export function createPrCommandHandler(
	pi: PrCommandPi,
	dependencies: PrCommandDependencies = {},
): PrCommandHandler {
	const load = dependencies.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const link = dependencies.linkInferredPullRequest ?? linkInferredPullRequest;
	return async (args, ctx) => {
		const instructions = args.trim();
		const discovery = await load(pi, ctx);
		const nextStep = deriveNextStep(discovery);
		if (instructions && !(nextStep in WORKFLOWS)) {
			throw new Error("The current /pr route does not accept instructions");
		}
		if (discovery.kind === "inactive") return nextStep;
		if (discovery.kind === "blocked") {
			return nextStep;
		}
		if (nextStep === "none") {
			if (discovery.kind === "current") {
				const notification = noActionNotification(discovery.pullRequest);
				ctx.ui.notify(notification.message, notification.type);
			}
			return nextStep;
		}
		if (nextStep === "link-branch") {
			if (discovery.kind !== "current") throw new Error("/pr link failed: pull request is unavailable");
			await linkPullRequest(pi, ctx, discovery.pullRequest, load, link);
			return nextStep;
		}
		if (nextStep === "merge") {
			if (discovery.kind !== "current") throw new Error("/pr merge failed: pull request is unavailable");
			return await mergePullRequest(pi, ctx, discovery.pullRequest, load) ? "merge" : "none";
		}

		if (!(nextStep in WORKFLOWS)) throw new Error(`/pr cannot dispatch route ${nextStep}`);
		dispatchWorkflow(pi, ctx, WORKFLOWS[nextStep as WorkflowNextStep], instructions);
		return nextStep;
	};
}
