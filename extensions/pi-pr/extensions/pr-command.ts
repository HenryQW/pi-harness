import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { executeGitHubMerge } from "./pr-merge.ts";
import { needsFeedbackAttention } from "./pr-feedback-attention.ts";
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

type WorkflowNextStep = Extract<NextStep, "create" | "publish-work" | "update-branch" | "sweep" | "fix-ci">;

const WORKFLOWS: Record<WorkflowNextStep, string> = {
	create: "skill:pi-pr-create",
	"publish-work": "skill:pi-pr-publish-work",
	"update-branch": "skill:pi-pr-update-branch",
	sweep: "skill:pi-pr-comment-sweep",
	"fix-ci": "skill:pi-pr-fix-ci",
};
type WorkflowReservation =
	| { route: "create"; target: PullRequestTarget }
	| { route: Exclude<WorkflowNextStep, "create">; pullRequest: CurrentPullRequest };
type WorkflowLaunchAction = "prepare" | "inspect" | "rebase" | "start" | "resume" | "collect";
type WorkflowReservationResult = { runId: string; action: WorkflowLaunchAction };

type PrCommandPi = Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
export type PrCommandInvocation = ((nextStep: NextStep) => void) & {
	sessionGeneration: number;
	assertCurrent(): void;
	completedRoutes?: ReadonlySet<string>;
};
export type PrCommandHandler = (
	args: string,
	ctx: ExtensionContext,
	onRouteResolved?: PrCommandInvocation,
) => Promise<NextStep>;

export type WorkflowPromptIdentity = Readonly<{
	route: WorkflowNextStep;
	skill: string;
	runId: string;
	action: WorkflowLaunchAction;
}>;

export type PrCommandDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	needsFeedbackAttention?: typeof needsFeedbackAttention;
	linkInferredPullRequest?: typeof linkInferredPullRequest;
	inspectSweepRecovery?: (pullRequest: CurrentPullRequest, ctx: ExtensionContext) => Promise<boolean>;
	inspectBranchRecovery?: (pullRequest: CurrentPullRequest, ctx: ExtensionContext) => Promise<boolean>;
	reserveWorkflow?: (
		reservation: WorkflowReservation,
		ctx: ExtensionContext,
		invocation?: PrCommandInvocation,
	) => Promise<WorkflowReservationResult>;
	markWorkflowPromptQueued?: (identity: WorkflowPromptIdentity, queued: boolean) => void;
	releaseWorkflow?: (runId: string, invocation?: PrCommandInvocation) => void;
};

function workflowReservation(
	nextStep: WorkflowNextStep,
	discovery: Awaited<ReturnType<typeof loadCurrentPullRequest>>,
): WorkflowReservation {
	if (nextStep === "create") {
		if (discovery.kind !== "none") throw new Error("/pr create failed: creation target is unavailable");
		return { route: "create", target: discovery.creationTarget };
	}
	if (discovery.kind !== "current") throw new Error(`/pr ${nextStep} failed: pull request is unavailable`);
	return { route: nextStep, pullRequest: discovery.pullRequest };
}

function packageWorkflowCommand(pi: PrCommandPi, route: WorkflowNextStep) {
	const workflow = WORKFLOWS[route];
	const command = pi.getCommands().find((candidate) =>
		candidate.name === workflow &&
		candidate.source === "skill" &&
		candidate.sourceInfo.origin === "package"
	);
	if (!command) throw new Error(`${workflow} failed: bundled workflow is unavailable`);
	return command;
}

async function dispatchWorkflow(
	pi: PrCommandPi,
	ctx: ExtensionContext,
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
		const reserved = await reserve(reservation, ctx, invocation);
		runId = reserved.runId;
		invocation?.assertCurrent();
		const queued = !ctx.isIdle();
		const identity = { route, skill: workflow.name, runId, action: reserved.action };
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
	if (pullRequest.conditions.ci === "failure-blocked") {
		return { message: `PR #${pullRequest.number} has a failed CI check that cannot run the CI fix workflow`, type: "warning" };
	}
	const mutatingWorkflowSelected = pullRequest.conditions.conflict ||
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
	ctx: ExtensionContext,
	current: CurrentPullRequest,
	load: typeof loadCurrentPullRequest,
	needsFeedback: typeof needsFeedbackAttention,
): Promise<void> {
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
			if (await needsFeedback(fresh, { cwd: ctx.cwd, signal: ctx.signal, load })) {
				throw new Error(`PR #${fresh.number} merge cancelled: new feedback needs review`);
			}
		},
	});
}

async function linkPullRequest(
	pi: PrCommandPi,
	ctx: ExtensionContext,
	current: CurrentPullRequest,
	load: typeof loadCurrentPullRequest,
	link: typeof linkInferredPullRequest,
): Promise<CurrentPullRequest> {
	const discovery = await load(pi, ctx);
	if (
		discovery.kind !== "current" ||
		discovery.pullRequest.target.provenance !== "inferred" ||
		!samePullRequestSnapshot(current, discovery.pullRequest)
	) throw new Error("Link branch cancelled: inferred pull request context changed");
	return await link(pi, ctx, discovery.pullRequest);
}

export function createPrCommandHandler(
	pi: PrCommandPi,
	dependencies: PrCommandDependencies = {},
): PrCommandHandler {
	const load = dependencies.loadCurrentPullRequest ?? loadCurrentPullRequest;
	const needsFeedback = dependencies.needsFeedbackAttention ?? needsFeedbackAttention;
	const link = dependencies.linkInferredPullRequest ?? linkInferredPullRequest;
	const inspectSweepRecovery = dependencies.inspectSweepRecovery ?? (async () => false);
	const inspectBranchRecovery = dependencies.inspectBranchRecovery ?? (async () => false);
	const reserve = dependencies.reserveWorkflow ?? (async () => {
		throw new Error("/pr workflow tools are unavailable");
	});
	const markPromptQueued = dependencies.markWorkflowPromptQueued ?? (() => {});
	const release = dependencies.releaseWorkflow ?? (() => {});
	const handle = async (
		args: string, ctx: ExtensionContext,
		onRouteResolved?: PrCommandInvocation,
		linkedAuthority?: CurrentPullRequest,
	): Promise<NextStep> => {
		if (args.trim()) throw new Error("/pr does not accept arguments");
		const discovery = await load(pi, ctx);
		onRouteResolved?.assertCurrent();
		if (linkedAuthority && (discovery.kind !== "current" || discovery.pullRequest.target.provenance !== "configured" ||
			!isSameConfirmedMerge(linkedAuthority, discovery.pullRequest))) {
			throw new Error("Link branch continuation cancelled: configured pull request context changed");
		}
		let nextStep = deriveNextStep(discovery);
		if (discovery.kind === "current" && discovery.pullRequest.lifecycle === "open" &&
			!discovery.pullRequest.conditions.draft && discovery.pullRequest.target.provenance === "configured" &&
			await inspectBranchRecovery(discovery.pullRequest, ctx)) {
			nextStep = "update-branch";
			onRouteResolved?.assertCurrent();
		}
		if (nextStep !== "update-branch" && discovery.kind === "current" && discovery.pullRequest.lifecycle === "open" &&
			!discovery.pullRequest.conditions.draft && discovery.pullRequest.target.provenance === "configured" &&
			await inspectSweepRecovery(discovery.pullRequest, ctx)) {
			nextStep = "sweep";
			onRouteResolved?.assertCurrent();
		}
		if (discovery.kind === "current" && (nextStep === "merge" || nextStep === "none") &&
			discovery.pullRequest.lifecycle === "open" && !discovery.pullRequest.conditions.draft &&
			discovery.pullRequest.target.provenance === "configured" &&
			discovery.pullRequest.local.worktree === "clean" && discovery.pullRequest.local.head === "equal") {
			if (await needsFeedback(discovery.pullRequest, { cwd: ctx.cwd, signal: ctx.signal, load })) nextStep = "sweep";
			onRouteResolved?.assertCurrent();
		}
		onRouteResolved?.(nextStep);
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
			const linked = await linkPullRequest(pi, ctx, discovery.pullRequest, load, link);
			if (linked.target.provenance !== "configured") throw new Error("Link branch failed: target was not configured");
			return await handle("", ctx, onRouteResolved, linked);
		}
		if (nextStep === "merge") {
			if (discovery.kind !== "current") throw new Error("/pr merge failed: pull request is unavailable");
			await mergePullRequest(pi, ctx, discovery.pullRequest, load, needsFeedback);
			return "merge";
		}

		if (!(nextStep in WORKFLOWS)) throw new Error(`/pr cannot dispatch route ${nextStep}`);
		const route = nextStep as WorkflowNextStep;
		if (onRouteResolved?.completedRoutes?.has(route)) {
			ctx.ui.notify(`PR ${route} already ran; inspect fresh state before retrying`, "warning");
			return "none";
		}
		const reservation = workflowReservation(route, discovery);
		await dispatchWorkflow(
			pi,
			ctx,
			route,
			reservation,
			onRouteResolved,
			reserve,
			markPromptQueued,
			release,
		);
		return nextStep;
	};
	return handle;
}
