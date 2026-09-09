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
	type PullRequestTarget,
} from "./pr-routing.ts";

export type WorkflowNextStep = Extract<NextStep, "create" | "update-branch" | "sweep" | "fix-ci">;

const WORKFLOWS: Record<WorkflowNextStep, { command: string; action: string }> = {
	create: { command: "skill:pi-pr-create", action: "prepare" },
	"update-branch": { command: "skill:pi-pr-update-branch", action: "merge" },
	sweep: { command: "skill:pi-pr-comment-sweep", action: "start" },
	"fix-ci": { command: "skill:pi-pr-fix-ci", action: "collect" },
};
const CREATE_BASE = /^--base=([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:[^\s\0]+)$/;

export type WorkflowReservation =
	| { route: "create"; target: PullRequestTarget; base?: string }
	| { route: Exclude<WorkflowNextStep, "create">; pullRequest: CurrentPullRequest };

type PrCommandPi = Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
export type PrCommandInvocation = {
	sessionGeneration: number;
	assertCurrent(): void;
};
export type PrCommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
	invocation?: PrCommandInvocation,
) => Promise<NextStep>;

export type WorkflowPromptIdentity = Readonly<{
	route: WorkflowNextStep;
	skill: string;
	runId: string;
	action: string;
}>;

export type PrCommandDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	linkInferredPullRequest?: typeof linkInferredPullRequest;
	reserveWorkflow?: (
		reservation: WorkflowReservation,
		ctx: ExtensionCommandContext,
		invocation?: PrCommandInvocation,
	) => Promise<string>;
	markWorkflowPromptQueued?: (identity: WorkflowPromptIdentity, queued: boolean) => void;
	releaseWorkflow?: (runId: string, invocation?: PrCommandInvocation) => void;
};

function createBase(instructions: string): string | undefined {
	if (!instructions) return undefined;
	const match = CREATE_BASE.exec(instructions);
	if (!match) throw new Error("PR creation accepts only --base=<host>/<owner>/<repository>:<ref>");
	return match[1]!;
}

function workflowReservation(
	nextStep: WorkflowNextStep,
	discovery: Awaited<ReturnType<typeof loadCurrentPullRequest>>,
	instructions: string,
): WorkflowReservation {
	if (nextStep === "create") {
		if (discovery.kind !== "none") throw new Error("/pr create failed: creation target is unavailable");
		const base = createBase(instructions);
		return { route: "create", target: discovery.creationTarget, ...(base === undefined ? {} : { base }) };
	}
	if (instructions) throw new Error("The current /pr helper route does not accept instructions");
	if (discovery.kind !== "current") throw new Error(`/pr ${nextStep} failed: pull request is unavailable`);
	return { route: nextStep, pullRequest: discovery.pullRequest };
}

function packageWorkflowCommand(pi: PrCommandPi, route: WorkflowNextStep) {
	const workflow = WORKFLOWS[route];
	const command = pi.getCommands().find((candidate) =>
		candidate.name === workflow.command &&
		candidate.source === "skill" &&
		candidate.sourceInfo.origin === "package"
	);
	if (!command) throw new Error(`${workflow.command} failed: bundled workflow is unavailable`);
	return { command, action: workflow.action };
}

async function dispatchWorkflow(
	pi: PrCommandPi,
	ctx: ExtensionCommandContext,
	route: WorkflowNextStep,
	reservation: WorkflowReservation,
	invocation: PrCommandInvocation | undefined,
	reserve: NonNullable<PrCommandDependencies["reserveWorkflow"]>,
	markPromptQueued: NonNullable<PrCommandDependencies["markWorkflowPromptQueued"]>,
	release: NonNullable<PrCommandDependencies["releaseWorkflow"]>,
): Promise<void> {
	const workflow = packageWorkflowCommand(pi, route);
	let runId: string | undefined;
	try {
		runId = await reserve(reservation, ctx, invocation);
		invocation?.assertCurrent();
		const queued = !ctx.isIdle();
		const identity = { route, skill: workflow.command.name, runId, action: workflow.action };
		markPromptQueued(identity, queued);
		const options = queued
			? { deliverAs: "followUp" as const, expandPromptTemplates: true }
			: { expandPromptTemplates: true };
		invocation?.assertCurrent();
		pi.sendUserMessage(`/${identity.skill} runId=${identity.runId} action=${identity.action}`, options);
	} catch (error) {
		if (runId !== undefined) release(runId, invocation);
		throw error;
	}
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
	const reserve = dependencies.reserveWorkflow ?? (async () => {
		throw new Error("/pr workflow tools are unavailable");
	});
	const markPromptQueued = dependencies.markWorkflowPromptQueued ?? (() => {});
	const release = dependencies.releaseWorkflow ?? (() => {});
	return async (args, ctx, invocation) => {
		const instructions = args.trim();
		const discovery = await load(pi, ctx);
		invocation?.assertCurrent();
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
		const route = nextStep as WorkflowNextStep;
		const reservation = workflowReservation(route, discovery, instructions);
		await dispatchWorkflow(pi, ctx, route, reservation, invocation, reserve, markPromptQueued, release);
		return nextStep;
	};
}
