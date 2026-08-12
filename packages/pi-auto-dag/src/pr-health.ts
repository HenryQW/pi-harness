import { basename, dirname, join, resolve } from "node:path";
import { commandFailure, commandOutput, errorMessage, recordedGateEvidence, requiredGateProcessPath, runRequiredGate, type CommandRunner } from "./command.ts";
import { revalidateResolvedProfile, type AvailableSkill } from "./config.ts";
import { gateCommandAmendments, requiredGateCommand } from "./final-gate.ts";
import { assertAttachedBranch, deleteExpectedBranch, ensureChildWorktree, findAppliedCherryPick, retireChildWorktree, verifySingleCommit } from "./git.ts";
import { executionIssues } from "./graph.ts";
import { assertRunBoundary } from "./intake.ts";
import type { HealthCheckEvidence, HealthFastForwardIntent, LocalIssue, PrHealthState, ProjectConfig, RequiredGateEvidence, RunState, SubmitReviewEnvelope, WorkerEnvelope } from "./model.ts";
import { assertSamePullRequest, viewOpenPullRequest } from "./pull-request.ts";
import { actionTicketPath, assertActiveActionTicket, ensureActionTicket, eventReceiptPath, readWorkerReceipt, rejectWorkerEnvelope, reviewId, rotateRejectedActionTicket, WorkerEnvelopeRejectedError, writeWorkerReceipt } from "./review-ticket.ts";
import { recordGateExecution, reviewPrompt, type ReviewPromptMode } from "./review.ts";
import { hasAcceptedWorkerEvent, readRunState, recordAcceptedWorkerEvent, writeRunState, type Uuid } from "./state.ts";
import { findWorkerTab, promptWorkerAgent, reconcileWorkerTab, retireWorkerTab, startWorkerAgent, workerAgentName } from "./worker-host.ts";
import { createWorkerLaunch, workerDeliveryContext, WORKER_ROLE_EVENTS, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { array, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

export interface PrHealthOptions {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
	availableSkills?: () => readonly AvailableSkill[] | undefined;
}

export async function preflightPrHealthEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	options: PrHealthOptions,
): Promise<{ receiptPath: string; receiptAccepted: boolean }> {
	const receiptPath = eventReceiptPath(state.main_worktree, state.run_id, envelope.event_id);
	const safeReceiptPath = envelope.receipt_path === receiptPath ? receiptPath : undefined;
	const issueId = finalCheck(state).id;
	if (envelope.run_id !== state.run_id || envelope.issue_id !== issueId) {
		return await rejectWorkerEnvelope(safeReceiptPath, envelope.event_id, "PR-health event belongs to another retained run", options.uuid);
	}
	if (!safeReceiptPath) throw new Error("Worker receipt path does not belong to retained run");
	const existing = await readWorkerReceipt(receiptPath);
	if (existing && existing.event_id !== envelope.event_id) throw new Error("Worker receipt belongs to another event");
	if (existing?.status === "rejected") {
		await rotateHealthActionTicket(state, envelope, options);
		throw new WorkerEnvelopeRejectedError(`Auto DAG event ${envelope.event_id} rejected: ${existing.reason ?? "lifecycle rejected event"}`);
	}
	const receiptAccepted = existing?.status === "accepted";
	const accepted = hasAcceptedWorkerEvent(state, envelope);
	if (receiptAccepted && !accepted) throw new Error(`Auto DAG event ${envelope.event_id} has an accepted receipt without matching state`);
	if (!accepted) {
		try {
			await assertActiveActionTicket(
				actionTicketPath(state.main_worktree, state.run_id, issueId, "pr_health", envelope.role),
				envelope,
			);
		} catch (error) {
			if (error instanceof WorkerEnvelopeRejectedError) {
				await writeWorkerReceipt(receiptPath, { event_id: envelope.event_id, status: "rejected", reason: errorMessage(error) }, options.uuid);
				await rotateHealthActionTicket(state, envelope, options);
			}
			throw error;
		}
	}
	return { receiptPath, receiptAccepted };
}

export async function runPrHealth(
	state: RunState,
	envelope: WorkerEnvelope | undefined,
	options: PrHealthOptions,
): Promise<RunState> {
	const preflight = envelope ? await preflightPrHealthEnvelope(state, envelope, options) : undefined;
	state = await resumePrHealth(state, options);
	const config = await loadPrHealthConfig(state, options);
	if (state.phase !== "completed" || !state.pr) {
		throw new Error("PR health requires a completed retained run with an integration PR");
	}
	const recoveringRepair = ["applying", "pushing", "post_push_cleanup"].includes(state.health?.status ?? "");
	if (state.health?.status === "applying") state = await applyHealthRepair(state, options);
	if (state.health?.status === "pushing") state = await continueHealthPush(state, options);
	if (state.health?.status === "post_push_cleanup") state = await completeHealthRepair(state, options);
	if (recoveringRepair && !envelope) return state;
	state = await fastForwardToPrHead(state, options);
	if (envelope) {
		const accepted = hasAcceptedWorkerEvent(state, envelope);
		if (preflight!.receiptAccepted && !accepted) throw new Error(`Auto DAG event ${envelope.event_id} has an accepted receipt without matching state`);
		if (accepted) {
			const resumed = await resumePendingHealthWork(state, config, options);
			state = resumed ?? state;
			await writeWorkerReceipt(preflight!.receiptPath, { event_id: envelope.event_id, status: "accepted" }, options.uuid);
			return state;
		}
	}
	if (state.health?.status === "blocked") {
		if (envelope) {
			const reason = state.health.summary ?? "PR health is blocked";
			await writeWorkerReceipt(preflight!.receiptPath, { event_id: envelope.event_id, status: "rejected", reason }, options.uuid);
			throw new Error(reason);
		}
		if (state.health.head !== state.integration_head && hasFailedHealthGate(state.health)) {
			state = await completeHealthRepair(state, options);
			return await startHealthTriage(state, config, options);
		}
		return await retryFailedHealthGate(state, config, options);
	}
	if (envelope) {
		try {
			state = await acceptHealthEnvelope(recordAcceptedWorkerEvent(state, envelope), envelope, config, options);
		} catch (error) {
			const persisted = await readRunState(state.main_worktree, state.run_id);
			if (!persisted || !hasAcceptedWorkerEvent(persisted, envelope)) {
				await writeWorkerReceipt(preflight!.receiptPath, { event_id: envelope.event_id, status: "rejected", reason: errorMessage(error) }, options.uuid);
				await rotateHealthActionTicket(state, envelope, options);
			}
			throw error;
		}
		state = await save(state, options);
		await writeWorkerReceipt(preflight!.receiptPath, { event_id: envelope.event_id, status: "accepted" }, options.uuid);
		return state;
	}
	if (state.health?.status === "triaging" && state.health.actionable === false) return await completeHealthyTriage(state, options);
	if (!state.health || state.health.status === "completed") return await startHealthTriage(state, config, options);
	return await resumePendingHealthWork(state, config, options) ?? state;
}

async function rotateHealthActionTicket(state: RunState, envelope: WorkerEnvelope, options: PrHealthOptions): Promise<void> {
	await rotateRejectedActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, finalCheck(state).id, "pr_health", envelope.role),
		envelope.event_id,
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
}

async function resumePendingHealthWork(state: RunState, config: ProjectConfig, options: PrHealthOptions): Promise<RunState | undefined> {
	const health = state.health;
	if (health?.status === "triaging" && health.actionable === false) return await completeHealthyTriage(state, options);
	if (health?.status === "triaging" && health.actionable === true) return await startHealthRepair(state, config, options);
	if (health?.status === "triaging") return await ensureHealthReviewer(state, config, options, "resume");
	if (health?.status === "repairing") return await ensureHealthCoder(state, config, options, "resume");
	if (health?.status === "reviewing") return await ensureHealthReviewer(state, config, options, "resume");
	return undefined;
}

async function loadPrHealthConfig(state: RunState, options: PrHealthOptions): Promise<ProjectConfig> {
	try {
		return await assertRunBoundary(state, options.runner, options.availableSkills?.());
	} catch (error) {
		await save({ ...state, phase: "blocked", block_reason: errorMessage(error) }, options);
		throw error;
	}
}

/** Reconcile PR-health fast-forward and cherry-pick effects from durable intent. */
export async function resumePrHealth(state: RunState, options: PrHealthOptions): Promise<RunState> {
	state = await abortPrHealthCherryPick(state, options);
	state = await recoverHealthFastForward(state, options);
	const health = state.health;
	if (health?.status === "applying" && health.integration_intent) {
		const integrationHead = await findAppliedCherryPick(options.runner, state.main_worktree, state.integration_branch, state.integration_head, health.integration_intent, "Main integration");
		if (integrationHead) {
			return await save({
				...state,
				integration_head: integrationHead,
				health: { ...health, status: "pushing" },
			}, options);
		}
	}
	return state;
}

/** Abort cleanup reaches only retained PR-health resources. */
export async function cleanupPrHealth(state: RunState, options: PrHealthOptions): Promise<RunState> {
	if (state.phase !== "aborted" || state.cleanup_blocks?.length || !state.health) return state;
	const issue = finalCheck(state);
	let health = state.health;
	for (const key of ["reviewer_tab_id", "coder_tab_id"] as const) {
		try {
			const label = `auto-dag:${state.run_id}:health:${health.attempt}:${key === "reviewer_tab_id" ? "reviewer" : "coder"}`;
			const tabId = health[key] ?? (await findWorkerTab(state, label, options))?.tab_id;
			if (!tabId) {
				state = await save(clearLifecycleCleanupBlock(state, issue.id, "tab"), options);
				continue;
			}
			await retireWorkerTab(state, tabId, options);
			health = { ...health, [key]: undefined };
			state = await save(clearLifecycleCleanupBlock({ ...state, health }, issue.id, "tab"), options);
		} catch (error) {
			return await recordLifecycleCleanupBlock(state, issue.id, "tab", errorMessage(error), options);
		}
	}
	if (health.worktree) {
		try {
			await retireChildWorktree(options.runner, state.main_worktree, health.worktree, health.branch ?? healthBranch(state, positiveInteger(health.attempt, "PR-health attempt")), "PR-health repair");
		} catch (error) {
			return await recordLifecycleCleanupBlock(state, issue.id, "worktree", errorMessage(error), options);
		}
		health = { ...health, worktree: undefined };
		state = await save(clearLifecycleCleanupBlock({ ...state, health }, issue.id, "worktree"), options);
	} else {
		state = await save(clearLifecycleCleanupBlock(state, issue.id, "worktree"), options);
	}
	return state;
}

async function abortPrHealthCherryPick(state: RunState, options: PrHealthOptions): Promise<RunState> {
	await assertAttachedBranch(options.runner, state.main_worktree, state.integration_branch, "Main integration");
	const result = await options.runner("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd: state.main_worktree });
	if (result.code === 1) return state;
	if (result.code !== 0) throw new Error(commandFailure("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], result));
	const commit = result.stdout.trim();
	const health = state.health;
	if (health?.integration_intent !== commit) return state;
	await commandOutput(options.runner, "git", ["cherry-pick", "--abort"], state.main_worktree);
	return await save({
		...state,
		health: {
			...health,
			status: "repairing",
			activity_started_at: timestamp(options),
			integration_intent: undefined,
			review_findings: [...(health.review_findings ?? []), "Integration cherry-pick conflicted; produce a fresh repair commit."],
		},
	}, options);
}

async function startHealthTriage(state: RunState, config: ProjectConfig, options: PrHealthOptions): Promise<RunState> {
	const previous = state.health;
	const attempt = (previous?.attempt ?? 0) + 1;
	const health: PrHealthState = {
		status: "triaging",
		activity_started_at: timestamp(options),
		head: state.integration_head,
		attempt,
		review_round: 1,
		reviewer_agent: workerAgentName(state.workspace_id, state.run_id, `health-${attempt}`, "reviewer"),
		instruction_pending: true,
	};
	state = await save({
		...state,
		health,
		...(previous ? { health_history: [...(state.health_history ?? []), previous] } : {}),
	}, options);
	return await ensureHealthReviewer(state, config, options, "triage");
}

async function ensureHealthReviewer(
	state: RunState,
	config: ProjectConfig,
	options: PrHealthOptions,
	mode: "triage" | "review" | "resume",
): Promise<RunState> {
	let health = requiredHealth(state);
	const issue = finalCheck(state);
	if (health.status === "reviewing") {
		const commit = nonEmptyString(health.commit, "PR-health repair commit");
		await verifyHealthRepairCommit(state, commit, options);
		const evidence = recordedGateEvidence(health, commit);
		if (!evidence) {
			const execution = await runRequiredGate(
				options.runner,
				requiredGateCommand(state, issue),
				commit,
				nonEmptyString(health.worktree, "PR-health repair worktree"),
				config.required_gate_timeout_ms,
				requiredGateProcessPath(state.main_worktree, state.run_id),
				{ kind: "health", issue_id: issue.id },
			);
			state = await recordGateExecution(state, { kind: "health", issue_id: issue.id }, execution, options.uuid);
			health = requiredHealth(state);
		}
		const gate = requiredHealthGate(health, nonEmptyString(health.commit, "PR-health repair commit"));
		if (gate.exit_code !== 0) return await blockHealth(state, `Required gate exited with code ${gate.exit_code}; reviewer was not launched`, options);
	}
	let launch = await workerLaunch(state, issue, config, "reviewer");
	const label = `auto-dag:${state.run_id}:health:${health.attempt}:reviewer`;
	const resource = await reconcileWorkerTab(state, {
		tab_id: health.reviewer_tab_id,
		pane_id: health.reviewer_pane,
		cwd: state.main_worktree,
		launch,
		label,
	}, options);
	if (health.reviewer_tab_id !== resource.tab_id || health.reviewer_pane !== resource.pane_id) {
		health = { ...health, reviewer_tab_id: resource.tab_id, reviewer_pane: resource.pane_id };
		state = await save({ ...state, health }, options);
	}
	const agent = nonEmptyString(health.reviewer_agent, "PR-health reviewer agent");
	launch = await workerLaunch(state, issue, config, "reviewer");
	const started = await startWorkerAgent(state, agent, nonEmptyString(health.reviewer_pane, "PR-health reviewer pane"), launch, options, {
		beforeStart: async () => {
			const latest = requiredHealth(state);
			if (!latest.instruction_pending) state = await save({ ...state, health: { ...latest, instruction_pending: true } }, options);
		},
	});
	health = requiredHealth(state);
	const needsInstruction = Boolean(health.instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = mode === "resume" && needsInstruction ? (health.status === "triaging" ? "triage" : "review") : mode;
	let prompt: Record<string, unknown>;
	if (!needsInstruction) {
		prompt = { type: "auto_dag_resend" };
	} else if (promptMode === "triage") {
		prompt = {
			type: "auto_dag_pr_health_triage",
			run_id: state.run_id,
			delivery: workerDeliveryContext(state.graph),
			pr: state.pr,
			integration_head: state.integration_head,
			attempt: health.attempt,
			review_round: health.review_round,
			instruction: "Read-only PR health triage: inspect unresolved review threads and failing checks for this exact open PR. Submit only a concise summary, actionable boolean, unresolved thread node IDs, and failing-check name/link/output evidence.",
		};
	} else {
		const reviewMode: ReviewPromptMode = started !== "existing" || health.review_round === 1 ? "full" : "update";
		const amendments = gateCommandAmendments(state, issue.id);
		prompt = reviewPrompt({
			kind: "pr_health_repair",
			graph: state.graph,
			issue,
			worktree: nonEmptyString(health.worktree, "PR-health repair worktree"),
			base: nonEmptyString(health.base, "PR-health repair base"),
			gate: requiredHealthGate(health, nonEmptyString(health.commit, "PR-health repair commit")),
			prior_findings: health.review_findings,
			context: {
				pr: state.pr,
				triage: { summary: health.summary, thread_ids: health.thread_ids, checks: health.checks },
				approval_findings: "Only triaged thread IDs fixed by this repair.",
				...(amendments.length ? { gate_command_amendments: amendments } : {}),
			},
		}, reviewMode);
	}
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "pr_health", "reviewer"),
		{
			attempt: positiveInteger(health.attempt, "PR-health attempt"),
			review_round: positiveInteger(health.review_round, "PR-health review round"),
			role: "reviewer",
			...(health.status === "reviewing" ? { review_id: healthReviewId(state, health, issue.id) } : {}),
		},
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await revalidateResolvedProfile(config, config.reviewer_profile);
	await promptWorkerAgent(state, agent, prompt, options);
	if (needsInstruction) state = await save({ ...state, health: { ...requiredHealth(state), instruction_pending: undefined } }, options);
	return state;
}

async function acceptHealthEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrHealthOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	if (envelope.run_id !== state.run_id || envelope.issue_id !== issue.id) throw new Error("PR-health event belongs to another retained run");
	const health = requiredHealth(state);
	if (envelope.type === "submit_health") return await submitHealthTriage(state, envelope, config, options);
	if (envelope.type === "request_review") {
		if (envelope.role !== "implementer") throw new Error("Only the PR-health coder can request repair review");
		if (health.status !== "repairing") throw new Error(`PR-health repair request is stale while health is ${health.status}`);
		return await requestHealthRepairReview(state, envelope, config, options);
	}
	if (envelope.type === "submit_review") {
		if (envelope.role !== "reviewer") throw new Error("Only the same PR-health reviewer can submit repair review");
		if (health.status !== "reviewing") throw new Error(`PR-health review submission is stale while health is ${health.status}`);
		return await submitHealthRepairReview(state, envelope, config, options);
	}
	if (envelope.type === "block_task" && health.status === "triaging" && envelope.role === "reviewer" && matchesHealthBlock(health, envelope, false)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health triage block reason"), options);
	if (envelope.type === "block_task" && health.status === "repairing" && envelope.role === "implementer" && matchesHealthBlock(health, envelope, true)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health repair block reason"), options);
	if (envelope.type === "block_task" && health.status === "reviewing" && envelope.role === "reviewer" && matchesHealthBlock(health, envelope, false)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health review block reason"), options);
	if (envelope.type === "block_task") throw new Error(`PR-health block event is stale while health is ${health.status}`);
	throw new Error(`Unexpected PR-health event ${envelope.type} while health is ${health.status}`);
}

async function submitHealthTriage(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrHealthOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the PR-health reviewer can submit health triage");
	const health = requiredHealth(state);
	if (health.status !== "triaging") throw new Error(`PR-health triage is stale while health is ${health.status}`);
	if (envelope.attempt !== health.attempt || envelope.review_round !== health.review_round) throw new Error("PR-health triage event is stale");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health triage was accepted", options);
	}
	const actionable = envelope.payload.actionable;
	if (typeof actionable !== "boolean") throw new Error("PR-health actionable must be a boolean");
	const next: PrHealthState = {
		...health,
		summary: nonEmptyString(envelope.payload.summary, "PR-health summary"),
		actionable,
		thread_ids: stringArray(envelope.payload.thread_ids ?? [], "PR-health thread IDs"),
		checks: healthChecks(envelope.payload.checks ?? []),
	};
	state = await save({ ...state, health: next }, options);
	if (!actionable) return await completeHealthyTriage(state, options);
	return await startHealthRepair(state, config, options);
}

async function completeHealthyTriage(state: RunState, options: PrHealthOptions): Promise<RunState> {
	let health = requiredHealth(state);
	if (health.reviewer_tab_id) {
		await retireWorkerTab(state, health.reviewer_tab_id, options);
		health = { ...health, reviewer_tab_id: undefined, reviewer_pane: undefined };
		state = await save({ ...state, health }, options);
	}
	return await save({ ...state, health: { ...health, status: "completed" } }, options);
}

async function startHealthRepair(state: RunState, config: ProjectConfig, options: PrHealthOptions): Promise<RunState> {
	let health = requiredHealth(state);
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair started", options);
	}
	const attempt = positiveInteger(health.attempt, "PR-health attempt");
	health = {
		...health,
		status: "repairing",
		activity_started_at: timestamp(options),
		base: state.integration_head,
		worktree: healthWorktreePath(state, attempt),
		branch: healthBranch(state, attempt),
		commit: undefined,
		review_round: 0,
		coder_agent: workerAgentName(state.workspace_id, state.run_id, `health-${attempt}`, "implementer"),
		instruction_pending: true,
	};
	state = await save({ ...state, health }, options);
	return await ensureHealthCoder(state, config, options, "initial");
}

async function ensureHealthCoder(
	state: RunState,
	config: ProjectConfig,
	options: PrHealthOptions,
	mode: "initial" | "revision" | "resume",
): Promise<RunState> {
	let health = requiredHealth(state);
	await ensureHealthWorktree(state, options);
	const issue = finalCheck(state);
	const repairIssue = { ...issue, profile: config.repair_profile, role: "implementation" } as const;
	let launch = await workerLaunch(state, repairIssue, config, "implementer");
	const label = `auto-dag:${state.run_id}:health:${health.attempt}:coder`;
	const resource = await reconcileWorkerTab(state, {
		tab_id: health.coder_tab_id,
		pane_id: health.coder_pane,
		cwd: nonEmptyString(health.worktree, "PR-health repair worktree"),
		launch,
		label,
	}, options);
	if (health.coder_tab_id !== resource.tab_id || health.coder_pane !== resource.pane_id) {
		health = { ...health, coder_tab_id: resource.tab_id, coder_pane: resource.pane_id };
		state = await save({ ...state, health }, options);
	}
	const agent = nonEmptyString(health.coder_agent, "PR-health coder agent");
	launch = await workerLaunch(state, repairIssue, config, "implementer");
	const started = await startWorkerAgent(state, agent, nonEmptyString(health.coder_pane, "PR-health coder pane"), launch, options, {
		beforeStart: async () => {
			const latest = requiredHealth(state);
			if (!latest.instruction_pending) state = await save({ ...state, health: { ...latest, instruction_pending: true } }, options);
		},
	});
	health = requiredHealth(state);
	const needsInstruction = Boolean(health.instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = mode === "resume" && needsInstruction ? (hasFindings(health) ? "revision" : "initial") : mode;
	const fullPrompt = promptMode === "initial" || started !== "existing" || (mode === "resume" && Boolean(health.instruction_pending));
	const instruction = promptMode === "revision"
		? "Address the reviewer findings by amending the sole repair commit, then request review again."
		: promptMode === "resume"
			? "Resend your latest worker event through the worker tool."
			: "Repair the actionable PR feedback in this fresh child worktree. Commit exactly one change over the current PR head, then request review.";
	const amendments = gateCommandAmendments(state, issue.id);
	const gate = amendments.length ? { required_gate: { command: requiredGateCommand(state, issue), amendments } } : {};
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "pr_health", "implementer"),
		{ attempt: positiveInteger(health.attempt, "PR-health attempt"), review_round: (health.review_round ?? 0) + 1, role: "implementer" },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await revalidateResolvedProfile(config, config.repair_profile);
	await promptWorkerAgent(state, agent, fullPrompt ? {
		type: "auto_dag_pr_health_repair",
		run_id: state.run_id,
		delivery: workerDeliveryContext(state.graph),
		pr: state.pr,
		worktree: health.worktree,
		base: health.base,
		attempt: health.attempt,
		review_round: (health.review_round ?? 0) + 1,
		triage: { summary: health.summary, thread_ids: health.thread_ids, checks: health.checks },
		...gate,
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_pr_health_repair_update",
		run_id: state.run_id,
		issue_id: issue.id,
		attempt: health.attempt,
		review_round: (health.review_round ?? 0) + 1,
		review_findings: health.review_findings,
		...gate,
		instruction,
	}, options);
	if (needsInstruction) state = await save({ ...state, health: { ...requiredHealth(state), instruction_pending: undefined } }, options);
	return state;
}

async function requestHealthRepairReview(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrHealthOptions,
): Promise<RunState> {
	if (envelope.type !== "request_review" || envelope.role !== "implementer") throw new Error("Only the PR-health coder can request repair review");
	const health = requiredHealth(state);
	if (envelope.attempt !== health.attempt || envelope.review_round !== (health.review_round ?? 0) + 1) throw new Error("PR-health repair event is stale");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair review", options);
	}
	const commit = await verifyHealthRepairCommit(
		state,
		nonEmptyString(envelope.commit, "PR-health repair commit"),
		options,
	);
	if (Array.isArray(health.review_findings) && health.review_findings.length && health.commit === commit) {
		return await blockHealth(state, "PR-health repair revision must use a new commit", options);
	}
	state = await save({ ...state, health: { ...health, status: "reviewing", activity_started_at: timestamp(options), commit, review_round: (health.review_round ?? 0) + 1, instruction_pending: true } }, options);
	return await ensureHealthReviewer(state, config, options, "review");
}

async function submitHealthRepairReview(
	state: RunState,
	envelope: SubmitReviewEnvelope,
	config: ProjectConfig,
	options: PrHealthOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the same PR-health reviewer can submit repair review");
	const health = requiredHealth(state);
	const issue = finalCheck(state);
	if (envelope.review_id !== healthReviewId(state, health, issue.id)) throw new Error("PR-health review submission is stale");
	const commit = nonEmptyString(health.commit, "PR-health repair commit");
	const gate = requiredHealthGate(health, commit);
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "PR-health repair verdict");
	const findings = stringArray(envelope.payload.findings, "PR-health repair findings");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair approval", options);
	}
	await verifyHealthRepairCommit(state, commit, options);
	if (verdict === "blocked") return await blockHealth(state, findings.join("; "), options);
	if (verdict === "changes_requested") {
		state = await save({ ...state, health: { ...health, status: "repairing", activity_started_at: timestamp(options), review_findings: findings, instruction_pending: true } }, options);
		return await ensureHealthCoder(state, config, options, "revision");
	}
	if (gate.exit_code !== 0) return await blockHealth(state, `Required gate exited with code ${gate.exit_code}; approval requires exit code 0`, options);
	const fixed = findings;
	const triaged = new Set(health.thread_ids ?? []);
	if (fixed.some((id) => !triaged.has(id))) throw new Error("PR-health repair may resolve only triaged review threads");
	state = await save({
		...state,
		health: {
			...health,
			status: "applying",
			integration_intent: commit,
			fixed_thread_ids: fixed,
		},
	}, options);
	return await applyHealthRepair(state, options);
}

async function applyHealthRepair(state: RunState, options: PrHealthOptions): Promise<RunState> {
	const health = requiredHealth(state);
	const reviewed = nonEmptyString(health.commit, "PR-health repair commit");
	const commit = health.integration_intent ?? reviewed;
	if (health.integration_intent && health.integration_intent !== reviewed) throw new Error("PR-health integration intent does not match its reviewed repair");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before applying health repair", options);
	}
	await assertRunBoundary(state, options.runner, options.availableSkills?.());
	await verifyHealthRepairCommit(state, commit, options);
	if (!health.integration_intent) {
		state = await save({ ...state, health: { ...health, status: "applying", integration_intent: commit } }, options);
	}
	await commandOutput(options.runner, "git", ["cherry-pick", "-x", commit], state.main_worktree);
	const integrationHead = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
	state = await save({
		...state,
		integration_head: integrationHead,
		health: { ...requiredHealth(state), status: "pushing", integration_intent: commit },
	}, options);
	return await continueHealthPush(state, options);
}

async function continueHealthPush(state: RunState, options: PrHealthOptions): Promise<RunState> {
	const health = requiredHealth(state);
	if (health.status !== "pushing") throw new Error("PR-health repair is not ready to push");
	const expected = state.pr!;
	let identity = await viewOpenPullRequest(state.main_worktree, expected.number, options.runner);
	assertSamePullRequest(expected, identity, false);
	if (identity.head_oid !== state.integration_head) {
		if (identity.head_oid !== health.head) {
			return await blockHealth(state, "PR head changed while health repair was pending push", options);
		}
		await commandOutput(options.runner, "git", ["push", "origin", state.integration_branch], state.main_worktree);
		identity = await viewOpenPullRequest(state.main_worktree, expected.number, options.runner);
		assertSamePullRequest(expected, identity, false);
		if (identity.head_oid !== state.integration_head) throw new Error("Pushed repair did not update the same PR to the integration HEAD");
	}
	const fixed = health.fixed_thread_ids ?? [];
	await resolveThreads(state, fixed, options);
	state = await save({
		...state,
		pr: identity,
		health: {
			...health,
			status: "post_push_cleanup",
			integration_intent: undefined,
			resolved_thread_ids: fixed,
		},
	}, options);
	return await completeHealthRepair(state, options);
}

async function completeHealthRepair(state: RunState, options: PrHealthOptions): Promise<RunState> {
	let health = requiredHealth(state);
	for (const key of ["coder_tab_id", "reviewer_tab_id"] as const) {
		if (!health[key]) continue;
		await retireWorkerTab(state, health[key]!, options);
		health = { ...health, [key]: undefined };
		state = await save({ ...state, health }, options);
	}
	if (health.worktree) {
		await retireChildWorktree(options.runner, state.main_worktree, health.worktree, nonEmptyString(health.branch, "PR-health repair branch"), "PR-health repair");
		health = { ...health, worktree: undefined };
		state = await save({ ...state, health }, options);
	}
	if (health.branch) {
		const commit = nonEmptyString(health.commit, "PR-health repair commit");
		await deleteExpectedBranch(options.runner, state.main_worktree, health.branch, commit, "PR-health repair");
		health = { ...health, branch: undefined };
		state = await save({ ...state, health }, options);
	}
	return await save({ ...state, health: { ...health, status: "completed" } }, options);
}

async function recordLifecycleCleanupBlock(
	state: RunState,
	issueId: string,
	operation: "tab" | "worktree",
	reason: string,
	options: PrHealthOptions,
): Promise<RunState> {
	const blocks = [...(state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation), { issue_id: issueId, operation, reason }];
	return await save({ ...state, cleanup_blocks: blocks }, options);
}

function clearLifecycleCleanupBlock(state: RunState, issueId: string, operation: "tab" | "worktree"): RunState {
	const cleanupBlocks = (state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation);
	return { ...state, ...(cleanupBlocks.length ? { cleanup_blocks: cleanupBlocks } : { cleanup_blocks: undefined }) };
}

async function fastForwardToPrHead(state: RunState, options: PrHealthOptions): Promise<RunState> {
	const expected = state.pr!;
	const current = await viewOpenPullRequest(state.main_worktree, expected.number, options.runner);
	assertSamePullRequest(expected, current, false);
	if (!current.head_oid) throw new Error("Open integration PR is missing head identity");
	await commandOutput(options.runner, "git", ["fetch", "origin", state.integration_branch], state.main_worktree);
	const remote = await commandOutput(options.runner, "git", ["rev-parse", `origin/${state.integration_branch}`], state.main_worktree);
	if (remote !== current.head_oid) throw new Error("Remote integration branch does not match the open PR head identity");
	const health = state.health;
	if (health && ["triaging", "repairing", "reviewing"].includes(health.status) && health.head !== remote) {
		return await blockHealth(state, `PR head changed from ${health.head} to ${remote} during active health handling`, options);
	}
	const fastForwardArgs = ["merge-base", "--is-ancestor", state.integration_head, remote];
	const fastForward = await options.runner("git", fastForwardArgs, { cwd: state.main_worktree });
	if (fastForward.code === 1) throw new Error("Local integration branch cannot fast-forward to the remote PR head");
	if (fastForward.code !== 0) throw new Error(commandFailure("git", fastForwardArgs, fastForward));
	if (remote !== state.integration_head) {
		if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== state.integration_head) {
			throw new Error("Main integration HEAD changed before PR fast-forward");
		}
		state = await save({
			...state,
			health_fast_forward_intent: { expected_head: state.integration_head, remote_head: remote, pr: current },
		}, options);
		await commandOutput(options.runner, "git", ["merge", "--ff-only", `origin/${state.integration_branch}`], state.main_worktree);
		if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== remote) {
			throw new Error("Fast-forward did not reach the remote PR head");
		}
		state = await save({ ...state, integration_head: remote, pr: current, health_fast_forward_intent: undefined }, options);
	}
	return state;
}

async function recoverHealthFastForward(state: RunState, options: PrHealthOptions): Promise<RunState> {
	if (!state.health_fast_forward_intent) return state;
	try {
		const intent = healthFastForwardIntent(state);
		if (intent.expected_head !== state.integration_head) throw new Error("PR-health fast-forward intent does not match the recorded integration HEAD");
		if (intent.pr.head_oid !== intent.remote_head) throw new Error("PR-health fast-forward intent does not match its PR head");
		await assertAttachedBranch(options.runner, state.main_worktree, state.integration_branch, "Main integration");
		const head = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
		if (head !== intent.expected_head && head !== intent.remote_head) {
			throw new Error("PR-health fast-forward did not leave the exact intended integration HEAD");
		}
		if (head === intent.expected_head) await assertRunBoundary(state, options.runner, options.availableSkills?.());
		const fastForwardArgs = ["merge-base", "--is-ancestor", intent.expected_head, intent.remote_head];
		const fastForward = await options.runner("git", fastForwardArgs, { cwd: state.main_worktree });
		if (fastForward.code === 1) {
			throw new Error("PR-health fast-forward intent is not a fast-forward");
		}
		if (fastForward.code !== 0) throw new Error(commandFailure("git", fastForwardArgs, fastForward));
		const current = await viewOpenPullRequest(state.main_worktree, intent.pr.number, options.runner);
		assertSamePullRequest(intent.pr, current, true);
		if (head === intent.expected_head) {
			await commandOutput(options.runner, "git", ["merge", "--ff-only", intent.remote_head], state.main_worktree);
			if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== intent.remote_head) {
				throw new Error("PR-health fast-forward retry did not reach the intended integration HEAD");
			}
		}
		return await save({ ...state, integration_head: intent.remote_head, pr: current, health_fast_forward_intent: undefined }, options);
	} catch (error) {
		const reason = `PR-health fast-forward recovery failed: ${errorMessage(error)}`;
		await save({ ...state, phase: "blocked", block_reason: reason }, options);
		throw new Error(reason);
	}
}

async function activeHealthHeadMatches(state: RunState, health: PrHealthState, options: PrHealthOptions): Promise<boolean> {
	if (health.head !== state.integration_head) return false;
	const current = await viewOpenPullRequest(state.main_worktree, state.pr!.number, options.runner);
	assertSamePullRequest(state.pr!, current, false);
	return current.head_oid === health.head;
}

async function ensureHealthWorktree(state: RunState, options: PrHealthOptions): Promise<void> {
	const health = requiredHealth(state);
	await ensureChildWorktree(
		options.runner,
		state.main_worktree,
		nonEmptyString(health.worktree, "PR-health repair worktree"),
		nonEmptyString(health.branch, "PR-health repair branch"),
		nonEmptyString(health.base, "PR-health repair base"),
		"PR-health repair",
	);
}

async function verifyHealthRepairCommit(state: RunState, commit: string, options: PrHealthOptions): Promise<string> {
	const health = requiredHealth(state);
	return await verifyOneCommit(
		state,
		nonEmptyString(health.worktree, "PR-health repair worktree"),
		nonEmptyString(health.branch, "PR-health repair branch"),
		nonEmptyString(health.base, "PR-health repair base"),
		commit,
		"PR-health repair",
		options,
	);
}

async function verifyOneCommit(
	state: RunState,
	worktree: string,
	branch: string,
	base: string,
	commit: string,
	label: string,
	options: PrHealthOptions,
): Promise<string> {
	await assertAttachedBranch(options.runner, worktree, branch, `${label} child worktree`);
	return await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, label);
}

async function resolveThreads(state: RunState, ids: string[], options: PrHealthOptions): Promise<void> {
	if (!ids.length) return;
	const variables = ids.map((_, index) => `$threadId${index}:ID!`).join(",");
	const mutations = ids.map((_, index) => `thread${index}:resolveReviewThread(input:{threadId:$threadId${index}}){thread{id isResolved}}`).join(" ");
	const text = await commandOutput(options.runner, "gh", [
		"api", "graphql",
		"-f", `query=mutation(${variables}){${mutations}}`,
		...ids.flatMap((id, index) => ["-F", `threadId${index}=${id}`]),
	], state.main_worktree);
	const data = object(object(JSON.parse(text), "resolve review threads response").data, "resolve review threads data");
	ids.forEach((id, index) => {
		const thread = object(object(data[`thread${index}`], `resolve review thread ${index}`).thread, `resolved review thread ${index}`);
		if (thread.id !== id || thread.isResolved !== true) throw new Error(`Review thread was not resolved: ${id}`);
	});
}

function healthChecks(value: unknown): HealthCheckEvidence[] {
	return array(value, "PR-health checks").map((entry, index) => {
		const input = object(entry, `PR-health checks[${index}]`);
		for (const key of Object.keys(input)) if (!["name", "link", "output"].includes(key)) throw new Error(`Unknown PR-health check evidence setting: ${key}`);
		return {
			name: nonEmptyString(input.name, `PR-health checks[${index}].name`),
			...(input.link === undefined ? {} : { link: nonEmptyString(input.link, `PR-health checks[${index}].link`) }),
			...(input.output === undefined ? {} : { output: nonEmptyString(input.output, `PR-health checks[${index}].output`) }),
		};
	});
}

function hasFindings(value: unknown): boolean {
	return reviewFindings(value).length > 0;
}

function reviewFindings(value: unknown): string[] {
	if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).review_findings)) return [];
	return (value as Record<string, unknown>).review_findings as string[];
}

function requiredHealth(state: RunState): PrHealthState {
	if (!state.health) throw new Error("PR-health state is missing");
	return state.health;
}

function healthFastForwardIntent(state: RunState): HealthFastForwardIntent {
	const input = object(state.health_fast_forward_intent, "PR-health fast-forward intent");
	const pr = object(input.pr, "PR-health fast-forward PR");
	return {
		expected_head: nonEmptyString(input.expected_head, "PR-health fast-forward expected head"),
		remote_head: nonEmptyString(input.remote_head, "PR-health fast-forward remote head"),
		pr: {
			number: positiveInteger(pr.number, "PR-health fast-forward PR.number"),
			url: nonEmptyString(pr.url, "PR-health fast-forward PR.url"),
			head_ref: nonEmptyString(pr.head_ref, "PR-health fast-forward PR.head_ref"),
			base_ref: nonEmptyString(pr.base_ref, "PR-health fast-forward PR.base_ref"),
			head_oid: nonEmptyString(pr.head_oid, "PR-health fast-forward PR.head_oid"),
		},
	};
}

function finalCheck(state: RunState): LocalIssue {
	return executionIssues(state.graph).at(-1)!;
}

async function workerLaunch(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	role: WorkerRole,
): Promise<WorkerLaunch> {
	const profileId = role === "reviewer" ? config.reviewer_profile : nonEmptyString(issue.profile, `Local Issue ${issue.id} profile`);
	const profile = await revalidateResolvedProfile(config, profileId);
	return createWorkerLaunch({
		role,
		events: WORKER_ROLE_EVENTS[role],
		profile,
		run_id: state.run_id,
		issue_id: finalCheck(state).id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
		action_ticket: actionTicketPath(state.main_worktree, state.run_id, finalCheck(state).id, "pr_health", role),
		required_gate_timeout_ms: config.required_gate_timeout_ms,
	});
}

function matchesHealthBlock(health: PrHealthState, envelope: WorkerEnvelope, implementer: boolean): boolean {
	return envelope.attempt === health.attempt
		&& envelope.review_round === (implementer ? (health.review_round ?? 0) + 1 : health.review_round);
}

function healthWorktreePath(state: RunState, attempt: number): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, `pr-health-${attempt}`);
}

function healthBranch(state: RunState, attempt: number): string {
	return `pi-auto-dag/${state.run_id}/pr-health/${attempt}`;
}

function healthReviewId(state: RunState, health: PrHealthState, issueId: string): string {
	return reviewId({
		run_id: state.run_id,
		kind: "pr_health_repair",
		issue_id: issueId,
		commit: nonEmptyString(health.commit, "PR-health review commit"),
		attempt: positiveInteger(health.attempt, "PR-health review attempt"),
		review_round: positiveInteger(health.review_round, "PR-health review round"),
	});
}

function requiredHealthGate(health: PrHealthState, commit: string): RequiredGateEvidence {
	const evidence = recordedGateEvidence(health, commit);
	if (!evidence) throw new Error("PR-health required-gate evidence is missing");
	return evidence;
}

async function retryFailedHealthGate(
	state: RunState,
	config: ProjectConfig,
	options: PrHealthOptions,
): Promise<RunState> {
	const health = requiredHealth(state);
	if (!hasFailedHealthGate(health)) return state;
	const {
		summary: _summary,
		blocked_role: _blockedRole,
		review_command: _command,
		review_commit: _commit,
		review_exit_code: _exitCode,
		review_stdout: _stdout,
		review_stderr: _stderr,
		...retry
	} = health;
	state = await save({
		...state,
		health: { ...retry, status: "reviewing", activity_started_at: timestamp(options), instruction_pending: true },
	}, options);
	return await ensureHealthReviewer(state, config, options, "resume");
}

function hasFailedHealthGate(health: PrHealthState): boolean {
	return health.review_exit_code !== undefined && health.review_exit_code !== 0 && health.review_commit === health.commit;
}

async function blockHealth(state: RunState, reason: string, options: PrHealthOptions): Promise<RunState> {
	const health = requiredHealth(state);
	const blockedRole = health.status === "repairing" ? "implementer" : ["triaging", "reviewing"].includes(health.status) ? "reviewer" : undefined;
	return await save({
		...state,
		health: {
			...health,
			status: "blocked",
			summary: reason,
			activity_started_at: timestamp(options),
			...(blockedRole ? { blocked_role: blockedRole } : {}),
		},
	}, options);
}

async function save(state: RunState, options: PrHealthOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: PrHealthOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
