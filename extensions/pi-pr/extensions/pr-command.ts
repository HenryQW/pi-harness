import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import { executeGitHubMerge } from "./pr-merge.ts";
import type { MergeMethod, PrRun } from "./pr-run.ts";
import { syncLocalHead } from "./pr-sync.ts";
import { needsFeedbackAttention } from "./pr-feedback-attention.ts";
import {
	linkInferredPullRequest,
	loadCurrentPullRequest,
	samePullRequestSnapshot,
	type CurrentPullRequest,
	type CurrentPullRequestDiscovery,
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
export const WORKFLOW_ROUTES: ReadonlySet<string> = new Set(Object.keys(WORKFLOWS));
/** GitHub recomputes mergeability shortly after a push; re-read a few times before giving up. */
export const REFRESH_ATTEMPTS = 3;
export const REFRESH_DELAY_MS = 5_000;
type WorkflowReservation =
	| { route: "create"; target: PullRequestTarget }
	| { route: Exclude<WorkflowNextStep, "create">; pullRequest: CurrentPullRequest };
type WorkflowLaunchAction = "prepare" | "inspect" | "rebase" | "start" | "resume" | "collect";
type WorkflowReservationResult = { runId: string; action: WorkflowLaunchAction };

type PrCommandPi = Pick<ExtensionAPI, "exec" | "getCommands" | "sendUserMessage">;
/** A model-started entry. Scope `lifecycle` runs every `/pr` route except the merge, which it runs only with `agentMerge`. */
export type PublicationRequest = { base?: string; allowUpstream: boolean; scope?: "publication" | "update-branch" | "lifecycle" };

export type PrCommandInvocation = ((nextStep: NextStep) => void) & {
	sessionGeneration: number;
	assertCurrent(): void;
	run: PrRun;
	publication?: PublicationRequest;
	onDiscovery?: (discovery: CurrentPullRequestDiscovery) => void;
	/** Receives each reason that routing stopped without a route, so a model-started entry can return it. */
	onStop?: (reason: string) => void;
	staleRediscoveries?: number;
	replanAuthority?: CurrentPullRequest;
};
export type PrCommandHandler = (
	args: string,
	ctx: ExtensionContext,
	onRouteResolved: PrCommandInvocation,
) => Promise<NextStep>;

export type WorkflowPromptIdentity = Readonly<{
	route: WorkflowNextStep;
	skill: string;
	path: string;
	runId: string;
	action: WorkflowLaunchAction;
	projectPath: string;
}>;

export type PrCommandDependencies = {
	loadCurrentPullRequest?: typeof loadCurrentPullRequest;
	needsFeedbackAttention?: typeof needsFeedbackAttention;
	linkInferredPullRequest?: typeof linkInferredPullRequest;
	inspectSweepRecovery?: (pullRequest: CurrentPullRequest, ctx: ExtensionContext) => Promise<boolean>;
	inspectBranchRecovery?: (pullRequest: CurrentPullRequest, ctx: ExtensionContext) => Promise<boolean>;
	syncLocalHead?: typeof syncLocalHead;
	refreshAttempts?: number;
	refreshDelayMs?: number;
	/** Test override for the CI poll sleep; the budget still follows the run policy. */
	ciPollMs?: number;
	reserveWorkflow?: (
		reservation: WorkflowReservation,
		ctx: ExtensionContext,
		invocation: PrCommandInvocation,
	) => Promise<WorkflowReservationResult>;
	markWorkflowPromptQueued?: (identity: WorkflowPromptIdentity, queued: boolean) => void;
	releaseWorkflow?: (runId: string, invocation: PrCommandInvocation) => void;
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
	invocation: PrCommandInvocation,
	reserve: NonNullable<PrCommandDependencies["reserveWorkflow"]>,
	markPromptQueued: NonNullable<PrCommandDependencies["markWorkflowPromptQueued"]>,
	release: NonNullable<PrCommandDependencies["releaseWorkflow"]>,
): Promise<void> {
	const workflow = packageWorkflowCommand(pi, route);
	let runId: string | undefined;
	try {
		const reserved = await reserve(reservation, ctx, invocation);
		runId = reserved.runId;
		invocation.assertCurrent();
		const queued = !ctx.isIdle();
		const identity = { route, skill: workflow.name, path: workflow.sourceInfo.path, runId, action: reserved.action, projectPath: ctx.cwd };
		markPromptQueued(identity, queued);
		invocation.assertCurrent();
		// Busy-session launches are consumed by agent_before_settle, not user input queues.
		if (!queued) pi.sendUserMessage(`/${identity.skill} runId=${identity.runId} action=${identity.action} projectPath=${JSON.stringify(identity.projectPath)}`, { expandPromptTemplates: true });
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
	if (pullRequest.conditions.ci === "running") {
		// Routing stops instead of waiting when a review is also pending, so name both.
		return { message: `PR #${pullRequest.number} is waiting for ${pullRequest.conditions.review === "pending" ? "CI and review" : "CI"}`, type: "warning" };
	}
	if (pullRequest.conditions.review === "pending") {
		return { message: `PR #${pullRequest.number} is waiting for review`, type: "warning" };
	}
	if (pullRequest.conditions.policy === "pending") {
		return { message: `PR #${pullRequest.number} is blocked by merge policy`, type: "warning" };
	}
	return { message: `PR #${pullRequest.number} has no available action`, type: "warning" };
}

type ConfirmedMerge = Pick<CurrentPullRequest, "id" | "number" | "url" | "host" | "head" | "base">;

export function isSameConfirmedMerge(current: ConfirmedMerge, fresh: ConfirmedMerge): boolean {
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
	mergeMethod: MergeMethod,
): Promise<void> {
	await executeGitHubMerge({
		mergeMethod,
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
	const sync = dependencies.syncLocalHead ?? syncLocalHead;
	const refreshAttempts = dependencies.refreshAttempts ?? REFRESH_ATTEMPTS;
	const refreshDelayMs = dependencies.refreshDelayMs ?? REFRESH_DELAY_MS;
	const reserve = dependencies.reserveWorkflow ?? (async () => {
		throw new Error("/pr workflow tools are unavailable");
	});
	const markPromptQueued = dependencies.markWorkflowPromptQueued ?? (() => {});
	const release = dependencies.releaseWorkflow ?? (() => {});
	const handle = async (
		args: string, ctx: ExtensionContext,
		onRouteResolved: PrCommandInvocation,
		linkedAuthority?: CurrentPullRequest,
		refreshes = 0,
		waiting?: "wait-ci" | "wait-review",
	): Promise<NextStep> => {
		if (args.trim()) throw new Error("/pr does not accept arguments");
		const stop = (message: string, type: "info" | "warning"): "none" => {
			onRouteResolved.onStop?.(message);
			ctx.ui.notify(message, type);
			return "none";
		};
		const discovery = await load(pi, ctx);
		onRouteResolved.assertCurrent();
		onRouteResolved.onDiscovery?.(discovery);
		if (discovery.kind === "current") onRouteResolved.run.observeRemote(discovery.pullRequest.head.oid);
		if (onRouteResolved.replanAuthority && (discovery.kind !== "current" ||
			!samePullRequestSnapshot(onRouteResolved.replanAuthority, discovery.pullRequest))) {
			throw new Error("PR stale-route rediscovery cancelled: frozen PR identity, destination, or remote head changed");
		}
		if (linkedAuthority && (discovery.kind !== "current" || discovery.pullRequest.target.provenance !== "configured" ||
			!isSameConfirmedMerge(linkedAuthority, discovery.pullRequest))) {
			throw new Error("Link branch continuation cancelled: configured pull request context changed");
		}
		const publication = onRouteResolved.publication;
		if (publication?.base && discovery.kind === "current" && publication.base !== discovery.pullRequest.base.ref) {
			throw new Error(`Requested base ${publication.base} differs from current PR base ${discovery.pullRequest.base.ref}; no retargeting is authorized`);
		}
		const updateOnly = publication?.scope === "update-branch";
		const lifecycle = publication?.scope === "lifecycle";
		// A model-started entry cannot run /pr, so its stop reasons name the entry that it can start.
		const again = publication ? "start a fresh pi_git_pr entry" : "run /pr again";
		if (updateOnly && discovery.kind === "blocked") {
			onRouteResolved("blocked");
			return "blocked";
		}
		if (updateOnly && (discovery.kind !== "current" || discovery.pullRequest.lifecycle !== "open" ||
			discovery.pullRequest.conditions.draft || discovery.pullRequest.target.provenance !== "configured")) {
			throw new Error("Branch update needs a configured, open, non-draft current PR; resolve discovery or upstream setup separately");
		}
		let nextStep = deriveNextStep(discovery);
		if (discovery.kind === "current" && discovery.pullRequest.lifecycle === "open" &&
			!discovery.pullRequest.conditions.draft && discovery.pullRequest.target.provenance === "configured" &&
			await inspectBranchRecovery(discovery.pullRequest, ctx)) {
			nextStep = "update-branch";
			onRouteResolved.assertCurrent();
		}
		if (!updateOnly && nextStep !== "update-branch" && discovery.kind === "current" && discovery.pullRequest.lifecycle === "open" &&
			!discovery.pullRequest.conditions.draft && discovery.pullRequest.target.provenance === "configured" &&
			await inspectSweepRecovery(discovery.pullRequest, ctx)) {
			nextStep = "sweep";
			onRouteResolved.assertCurrent();
		}
		if ((!publication || lifecycle) && discovery.kind === "current" && (nextStep === "merge" || nextStep === "none" || nextStep === "wait-ci" || nextStep === "wait-review") &&
			discovery.pullRequest.lifecycle === "open" && !discovery.pullRequest.conditions.draft &&
			discovery.pullRequest.target.provenance === "configured" &&
			discovery.pullRequest.local.worktree === "clean" && discovery.pullRequest.local.head === "equal") {
			if (await needsFeedback(discovery.pullRequest, { cwd: ctx.cwd, signal: ctx.signal, load })) nextStep = "sweep";
			onRouteResolved.assertCurrent();
		}
		if (updateOnly) {
			if (!["update-branch", "refresh", "none"].includes(nextStep)) {
				throw new Error(`Branch-update-only authorization stops before ${nextStep}; ${["sync-local", "publish-work"].includes(nextStep)
					? "reconcile local work separately, then request the base update"
					: "no confirmed conflict or required base update remains; request other work separately"}. No other route is authorized`);
			}
		} else if (publication) {
			if ((nextStep === "link-branch" || nextStep === "create" && discovery.kind === "none" && discovery.creationTarget.provenance === "inferred") && !publication.allowUpstream) {
				throw new Error("Publication needs repository-local upstream configuration; ask for permission, then set allowUpstream: true");
			}
			if (!lifecycle && !["create", "publish-work", "sync-local", "link-branch", "blocked", "none"].includes(nextStep)) {
				const reason = `Create/update authorization stops before ${nextStep}${discovery.kind === "current" ? `: ${discovery.pullRequest.url.href}` : ""}; the lifecycle scope or /pr continues only when the user authorized that work`;
				// Return here: the generic no-action notice below would add a second, misleading stop reason.
				onRouteResolved("none");
				return stop(reason, "info");
			}
		}
		onRouteResolved(nextStep);
		if (discovery.kind === "inactive") {
			if (discovery.nonGitHubHosts) {
				const hosts = discovery.nonGitHubHosts.join(", ");
				stop(`/pr needs a GitHub remote: gh has no credentials for ${hosts}; for GitHub Enterprise, run gh auth login --hostname <host>`, "warning");
			}
			return nextStep;
		}
		if (discovery.kind === "blocked") {
			return nextStep;
		}
		if (nextStep === "none") {
			if (discovery.kind === "current") {
				const notification = noActionNotification(discovery.pullRequest);
				stop(notification.message, notification.type);
			} else if (discovery.kind === "none") {
				// The footer already shows this state, so only a model-started entry receives the reason.
				onRouteResolved.onStop?.("No pull request exists for this branch, and the branch has no local work to publish or cannot open one");
			}
			return nextStep;
		}
		if (nextStep === "link-branch") {
			if (discovery.kind !== "current") throw new Error("/pr link failed: pull request is unavailable");
			const linked = await linkPullRequest(pi, ctx, discovery.pullRequest, load, link);
			if (linked.target.provenance !== "configured") throw new Error("Link branch failed: target was not configured");
			return await handle("", ctx, onRouteResolved, linked);
		}
		if (nextStep === "sync-local") {
			if (discovery.kind !== "current") throw new Error("/pr sync failed: pull request is unavailable");
			const current = discovery.pullRequest;
			if (onRouteResolved.run.hasCompleted("sync-local", current.head.oid)) {
				return stop("PR sync-local already ran; inspect fresh state before retrying", "warning");
			}
			const synced = await sync({ cwd: ctx.cwd, authority: current, signal: ctx.signal, loadCurrentPullRequest: load });
			onRouteResolved.assertCurrent();
			onRouteResolved.run.complete("sync-local", current.head.oid);
			const verb = synced.kind === "fast-forwarded" ? "fast-forwarded to" : synced.kind === "rebased" ? "rebased onto" : "already at";
			ctx.ui.notify(`PR #${current.number}: local branch ${verb} the PR head`, "info");
			return await handle("", ctx, onRouteResolved);
		}
		if (nextStep === "refresh") {
			if (discovery.kind !== "current") throw new Error("/pr refresh failed: pull request is unavailable");
			if (refreshes >= refreshAttempts) {
				return stop(`PR #${discovery.pullRequest.number} mergeability is still being computed by GitHub; ${again}`, "warning");
			}
			await delay(refreshDelayMs, undefined, { signal: ctx.signal });
			onRouteResolved.assertCurrent();
			// Keep the wait state, so a wait interrupted by pending mergeability does not announce itself again.
			return await handle("", ctx, onRouteResolved, undefined, refreshes + 1, waiting);
		}
		if (nextStep === "wait-ci" || nextStep === "wait-review") {
			if (discovery.kind !== "current") throw new Error("/pr wait failed: pull request is unavailable");
			const current = discovery.pullRequest;
			const run = onRouteResolved.run;
			// CI and Codex review waits share one per-invocation budget.
			const interval = run.consumeCiWait();
			if (interval === null) {
				const budget = run.policy.ciWaitMinutes;
				return stop(nextStep === "wait-review"
					? `PR #${current.number} is still waiting for the Codex review of the current head; ${again} later`
					: budget > 0
					? `PR #${current.number} is still waiting for CI after ${budget} min; ${again} later`
					: `PR #${current.number} is waiting for CI`, "warning");
			}
			if (waiting !== nextStep) {
				const subject = nextStep === "wait-review" ? "waiting for the Codex review" : "CI is running";
				ctx.ui.notify(`PR #${current.number}: ${subject}; checking every ${run.policy.ciPollSeconds} s for up to ${run.policy.ciWaitMinutes} min`, "info");
			}
			await delay(dependencies.ciPollMs ?? interval, undefined, { signal: ctx.signal });
			onRouteResolved.assertCurrent();
			return await handle("", ctx, onRouteResolved, undefined, 0, nextStep);
		}
		if (nextStep === "merge") {
			if (discovery.kind !== "current") throw new Error("/pr merge failed: pull request is unavailable");
			const current = discovery.pullRequest;
			const mergeMethod = onRouteResolved.run.policy.mergeMethod;
			// A model-started lifecycle merges only with agentMerge; otherwise the user confirms through /pr or pi_pr_merge.
			if (lifecycle) {
				if (!onRouteResolved.run.policy.agentMerge) {
					return stop(`PR #${current.number} is merge-ready at head ${current.head.oid}; the lifecycle scope merges only with agentMerge, so a merge needs the user's confirmation`, "info");
				}
				await mergePullRequest(pi, ctx, current, load, needsFeedback, mergeMethod);
				stop(`PR #${current.number} merged at head ${current.head.oid} into ${current.base.ref} with ${mergeMethod}, as agentMerge permits`, "info");
				return "merge";
			}
			if (!ctx.hasUI) return stop(`PR #${current.number} is merge-ready; merge needs confirmation in an interactive session`, "info");
			const confirmed = await ctx.ui.confirm(
				`Merge PR #${current.number}?`,
				`${current.url.href}\nHead ${current.head.oid.slice(0, 12)} into ${current.base.ref} with ${mergeMethod}.`,
				{ signal: ctx.signal },
			);
			onRouteResolved.assertCurrent();
			if (!confirmed) return stop(`PR #${current.number} is merge-ready; merge declined`, "info");
			await mergePullRequest(pi, ctx, current, load, needsFeedback, mergeMethod);
			return "merge";
		}

		if (!(nextStep in WORKFLOWS)) throw new Error(`/pr cannot dispatch route ${nextStep}`);
		const route = nextStep as WorkflowNextStep;
		if (onRouteResolved.run.hasCompleted(route, discovery.kind === "current" ? discovery.pullRequest.head.oid : null) ||
			route === "update-branch" && onRouteResolved.run.hasCompletedRoute(route)) {
			const codexFindings = discovery.kind === "current" && discovery.pullRequest.conditions.codex?.findings;
			return stop(route === "sweep" && codexFindings
				? `PR sweep already ran; ${codexFindings} unresolved Codex P0/P1 findings block the merge prompt`
				: `PR ${route} already ran; inspect fresh state before retrying`, "warning");
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
