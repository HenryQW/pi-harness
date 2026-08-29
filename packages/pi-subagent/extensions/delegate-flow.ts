import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROFILE_NAMES } from "@henryqw/pi-task-models";
import {
	addUsage,
	capEphemeralSubagentOutput as capOutput,
	createChildWorktree,
	EphemeralSubagentError,
	inspectIndexFlags,
	inspectWorktreeDirty,
	prepareExactReviewEvidence,
	WorktreeSetupError,
	type EphemeralSubagentActivityEvent,
	type EphemeralSubagentExecutor,
	type EphemeralSubagentResult,
	type ResolvedRoleLaunch,
	type Role,
	type WorktreeInfo,
} from "@henryqw/pi-subagent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { runDelegation } from "./delegation.ts";
import { renderToolLines } from "./tool-render.ts";

const MAX_UNITS = 8;
const GIT_TIMEOUT_MS = 30_000;
const TRUNCATED_OUTPUT = /\n\n\[Output truncated: \d+ bytes omitted\]$/;

const ValidationSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	args: Type.Array(Type.String()),
}, { additionalProperties: false });

const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });

const UnitSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	validation: Type.Array(ValidationSchema, { minItems: 1 }),
	modelClass: Type.Optional(ModelClassSchema),
	review: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const DelegateFlowSchema = Type.Object({
	units: Type.Array(UnitSchema, { minItems: 1, maxItems: MAX_UNITS }),
}, { additionalProperties: false });

export const DelegateFlowContinueSchema = Type.Object({
	guidance: Type.String({ minLength: 1 }),
	modelClass: Type.Optional(ModelClassSchema),
}, { additionalProperties: false });

type FlowRequest = Static<typeof DelegateFlowSchema>;
type FlowUnitRequest = Static<typeof UnitSchema>;
type FlowModelClass = FlowUnitRequest["modelClass"];
type FlowClassification = "setup" | "implementer" | "validation" | "reviewer_findings" | "main" | "infrastructure" | "integration";
type FlowPhase = "running" | "blocked";
type WidgetStatus = "success" | "failure" | "aborted";

type ChildSettlement =
	| { result: EphemeralSubagentResult }
	| { error: unknown };

type UnitState = {
	request: FlowUnitRequest;
	modelClass: FlowModelClass;
	worktree: WorktreeInfo;
	base: string;
	implementation?: ChildSettlement;
	repairUsed: boolean;
	worktreeRetained: boolean;
	branchRetained: boolean;
};

type MainState = {
	root: string;
	branchRef: string;
	expectedHead: string;
};

type BlockedState = {
	unit: UnitState;
	classification: Exclude<FlowClassification, "setup" | "main" | "infrastructure" | "integration">;
	diagnostic: string;
};

type SetupRecovery = {
	id: string;
	path: string;
	branch: string;
	base: string;
	diagnostic: string;
};

type FlowState = {
	phase: FlowPhase;
	generation: number;
	sessionController: AbortController;
	implementer: Role;
	reviewer?: Role;
	main?: MainState;
	units: UnitState[];
	setupRecoveries: SetupRecovery[];
	index: number;
	blocked?: BlockedState;
	completed: Array<{ id: string; noOp: boolean }>;
	warnings: string[];
};

type UsageMeter = { usage?: Usage };
type FlowProgress = { line: string };

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

export interface DelegateFlowRuntime {
	executor: EphemeralSubagentExecutor;
	maxRuntimeMs: number;
	getSessionGeneration: () => number;
	loadRoles: () => Role[];
	resolveLaunch: (role: Role, modelClass: FlowModelClass, ctx: ExtensionContext) => ResolvedRoleLaunch;
	startWidget: (
		id: string,
		role: string,
		model: string,
		thinkingLevel: string | undefined,
		task: string,
		ctx: ExtensionContext,
	) => void;
	updateWidgetTokens: (id: string, tokens: number) => void;
	updateWidgetActivity: (id: string, event: EphemeralSubagentActivityEvent) => void;
	finishWidget: (id: string, status: WidgetStatus) => void;
}

function text(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${field} must be non-empty text without NUL bytes.`);
	return normalized;
}

function argument(value: string, field: string): string {
	if (value.includes("\0")) throw new Error(`${field} must not contain NUL bytes.`);
	return value;
}

export function parseDelegateFlow(value: unknown): FlowRequest {
	if (!Check(DelegateFlowSchema, value)) throw new Error("delegate_flow must match the declared tool schema.");
	const ids = new Set<string>();
	return {
		units: value.units.map((unit, unitIndex) => {
			const id = text(unit.id, `units[${unitIndex}].id`);
			if (ids.has(id)) throw new Error(`delegate_flow unit IDs must be unique; duplicate ${JSON.stringify(id)}.`);
			ids.add(id);
			return {
				id,
				task: text(unit.task, `units[${unitIndex}].task`),
				validation: unit.validation.map((validation, validationIndex) => ({
					command: text(validation.command, `units[${unitIndex}].validation[${validationIndex}].command`),
					args: validation.args.map((value, argumentIndex) => argument(value, `units[${unitIndex}].validation[${validationIndex}].args[${argumentIndex}]`)),
				})),
				...(unit.modelClass === undefined ? {} : { modelClass: unit.modelClass }),
				...(unit.review === undefined ? {} : { review: text(unit.review, `units[${unitIndex}].review`) }),
			};
		}),
	};
}

export function parseDelegateFlowContinue(value: unknown): Static<typeof DelegateFlowContinueSchema> {
	if (!Check(DelegateFlowContinueSchema, value)) throw new Error("delegate_flow_continue must match the declared tool schema.");
	return {
		guidance: text(value.guidance, "guidance"),
		...(value.modelClass === undefined ? {} : { modelClass: value.modelClass }),
	};
}

function unitCount(count: number): string {
	return `${count} unit${count === 1 ? "" : "s"}`;
}

function flowCallLabel(args: { units?: unknown }): string {
	const count = Array.isArray(args.units) ? args.units.length : 0;
	return `delegate_flow · parallel→serial · ${unitCount(count)}`;
}

function isFlowProgress(value: unknown): value is FlowProgress {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& typeof (value as { line?: unknown }).line === "string";
}

function flowResultLines(text: string): string[] {
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	const diagnosticHeader = lines.findIndex((line) => line.trim() === "Diagnostic:");
	const diagnostic = diagnosticHeader === -1 ? undefined : lines[diagnosticHeader + 1];
	const recoveryHeader = lines.findIndex((line) => line.trim() === "Retained Flow state:" || line.trim() === "Attempted allocations preserved without cleanup:");
	const recovery = recoveryHeader === -1 || !lines[recoveryHeader + 1]?.trim().startsWith("- unit=")
		? undefined
		: lines[recoveryHeader + 1];
	if (diagnostic === undefined) {
		if (recovery === undefined) return lines;
		const recoveryIndex = lines.indexOf(recovery);
		return [lines[0]!, recovery, ...lines.filter((_, index) => index !== 0 && index !== recoveryIndex)];
	}
	const leading = lines.slice(0, Math.min(1, diagnosticHeader));
	if (recovery !== undefined) return [...leading, `Diagnostic: ${diagnostic}`, recovery];
	// Promote the first diagnostic ahead of the result cap.
	return [
		...leading,
		`Diagnostic: ${diagnostic}`,
		...lines.slice(leading.length, diagnosticHeader),
		...lines.slice(diagnosticHeader + 2),
	];
}

function errorText(error: unknown): string {
	return capOutput(error instanceof Error ? error.message : String(error));
}

function commandFailure(label: string, result: CommandResult): string {
	return capOutput([
		`${label} failed with exit ${result.code}${result.killed ? " (killed)" : ""}.`,
		result.stdout ? `stdout:\n${result.stdout}` : "",
		result.stderr ? `stderr:\n${result.stderr}` : "",
	].filter(Boolean).join("\n"));
}

function implementerTask(unit: FlowUnitRequest): string {
	return [
		`Flow Unit ${JSON.stringify(unit.id)} requirements:`,
		unit.task,
		...(unit.review === undefined ? [] : [
			"",
			"Review criterion to satisfy; the Reviewer alone decides approval:",
			unit.review,
		]),
		"",
		"Authoritative Flow validation (do not duplicate this final gate):",
		...unit.validation.map((validation) => `- ${JSON.stringify(validation)}`),
	].join("\n");
}

function repairTask(unit: FlowUnitRequest, blocked: BlockedState, guidance: string): string {
	return [
		`Repair Flow Unit ${JSON.stringify(unit.id)} in its existing Unit Worktree.`,
		"",
		"Original requirements:",
		unit.task,
		...(unit.review === undefined ? [] : [
			"",
			"Review criterion to satisfy; the Reviewer alone decides approval:",
			unit.review,
		]),
		"",
		"Authoritative Flow validation (do not duplicate this final gate):",
		...unit.validation.map((validation) => `- ${JSON.stringify(validation)}`),
		"",
		`Previous ${blocked.classification} block:`,
		blocked.diagnostic,
		"",
		"Main guidance:",
		guidance,
	].join("\n");
}

function reviewerTask(unit: FlowUnitRequest, review: string, packet: { base: string; tip: string; patchPath: string }): string {
	return [
		`Review Flow Unit ${JSON.stringify(unit.id)} for this explicit judgment criterion:`,
		review,
		"",
		"Original requirements (context only):",
		unit.task,
		"",
		"Declared validation already passed and is authoritative for objective verification:",
		...unit.validation.map((validation) => `- ${JSON.stringify(validation)}`),
		"",
		`Review Packet: ${JSON.stringify(packet)}`,
		"Review only the criterion above. Read the exact patch as authoritative and emit exactly PASS only when there are zero findings.",
	].join("\n");
}

/** Registers the two memory-only Flow tools on the package's sole manifest entrypoint. */
export function registerDelegateFlow(pi: ExtensionAPI, runtime: DelegateFlowRuntime): () => void {
	let active: FlowState | undefined;

	const assertCurrent = (flow: FlowState): void => {
		if (flow.generation !== runtime.getSessionGeneration()) {
			throw new Error("Flow session changed while work was in flight; stale work was retained without review or integration.");
		}
	};

	const bindSignal = (flow: FlowState, signal: AbortSignal | undefined): AbortSignal =>
		signal ? AbortSignal.any([signal, flow.sessionController.signal]) : flow.sessionController.signal;

	const invalidateActive = (): void => {
		active?.sessionController.abort(new Error("Flow session ended."));
		active = undefined;
	};

	const execute = async (
		command: string,
		args: string[],
		cwd: string,
		signal?: AbortSignal,
		timeout?: number,
	): Promise<CommandResult> => {
		signal?.throwIfAborted();
		return await pi.exec(command, args, { cwd, signal, ...(timeout === undefined ? {} : { timeout }) });
	};

	const git = (args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> =>
		execute("git", ["--no-pager", ...args], cwd, signal, GIT_TIMEOUT_MS);

	const requireGit = async (args: string[], cwd: string, signal?: AbortSignal): Promise<string> => {
		const result = await git(args, cwd, signal);
		if (signal?.aborted) signal.throwIfAborted();
		if (result.code !== 0 || result.killed) throw new Error(commandFailure(`git ${args.join(" ")}`, result));
		return result.stdout;
	};

	const oneLine = (value: string, field: string): string => {
		const result = value.replace(/\r?\n$/, "");
		if (!result || /[\r\n\0]/.test(result)) throw new Error(`Git returned malformed ${field}.`);
		return result;
	};

	const oid = (value: string, field: string): string => {
		const result = oneLine(value, field);
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result)) throw new Error(`Git returned invalid ${field}.`);
		return result;
	};

	const inspectMainClean = async (root: string, signal?: AbortSignal): Promise<string | undefined> => {
		const refreshed = await git(["update-index", "--really-refresh"], root, signal);
		if (signal?.aborted) signal.throwIfAborted();
		if ((refreshed.code !== 0 && refreshed.code !== 1) || refreshed.killed) {
			throw new Error(commandFailure("git update-index --really-refresh", refreshed));
		}
		const status = await requireGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], root, signal);
		const flags = await inspectIndexFlags(root, git, signal);
		if (flags.failure) throw new Error(`Git index inspection failed: ${flags.failure}`);
		if (flags.hidden) return "assume-unchanged or skip-worktree index entries remain";
		if (refreshed.code === 1 || status) return status || capOutput(refreshed.stdout || refreshed.stderr || "index refresh reported tracked changes");
		return;
	};

	const snapshotMain = async (cwd: string, signal?: AbortSignal): Promise<MainState> => {
		const root = oneLine(await requireGit(["rev-parse", "--show-toplevel"], cwd, signal), "Main root");
		const branchRef = oneLine(await requireGit(["symbolic-ref", "--quiet", "HEAD"], root, signal), "Main branch");
		const expectedHead = oid(await requireGit(["rev-parse", "--verify", "HEAD^{commit}"], root, signal), "Main HEAD");
		const dirty = await inspectMainClean(root, signal);
		if (dirty) throw new Error(`delegate_flow requires clean Git Main:\n${capOutput(dirty)}`);
		return { root, branchRef, expectedHead };
	};

	const checkMain = async (main: MainState, signal?: AbortSignal): Promise<void> => {
		const branchRef = oneLine(await requireGit(["symbolic-ref", "--quiet", "HEAD"], main.root, signal), "Main branch");
		const head = oid(await requireGit(["rev-parse", "--verify", "HEAD^{commit}"], main.root, signal), "Main HEAD");
		const dirty = await inspectMainClean(main.root, signal);
		if (branchRef !== main.branchRef || head !== main.expectedHead || dirty) {
			throw new Error(capOutput([
				"Git Main changed outside the active Flow.",
				`Expected branch=${JSON.stringify(main.branchRef)} HEAD=${main.expectedHead} clean=true.`,
				`Actual branch=${JSON.stringify(branchRef)} HEAD=${head} clean=${!dirty}.`,
				dirty ? `Status:\n${dirty}` : "",
			].filter(Boolean).join("\n")));
		}
	};

	const addMeterUsage = (meter: UsageMeter, usage: Usage | undefined) => {
		meter.usage = addUsage(meter.usage, usage);
	};

	const runChild = async (
		flow: FlowState,
		role: Role,
		modelClass: FlowModelClass,
		task: string,
		widgetTask: string,
		cwd: string,
		widgetId: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		meter: UsageMeter,
	): Promise<ChildSettlement> => {
		let started = false;
		try {
			assertCurrent(flow);
			const result = await runDelegation(runtime.executor, {
				signal,
				onTokens: (tokens) => runtime.updateWidgetTokens(widgetId, tokens),
				onActivity: (event) => runtime.updateWidgetActivity(widgetId, event),
				prepare: async () => {
					assertCurrent(flow);
					const launch = runtime.resolveLaunch(role, modelClass, ctx);
					if (launch.missingSkills.length) {
						ctx.ui.notify(`Subagent role ${role.name} skipped unavailable Pi skills: ${launch.missingSkills.join(", ")}.`, "warning");
					}
					runtime.startWidget(widgetId, role.name, launch.model.id, launch.thinkingLevel, widgetTask, ctx);
					started = true;
					return { launch, task, cwd };
				},
			});
			assertCurrent(flow);
			addMeterUsage(meter, result.usage);
			if (started) {
				try {
					runtime.finishWidget(widgetId, result.outcome === "success" ? "success" : "failure");
				} catch (error) {
					return { error };
				}
			}
			return { result };
		} catch (error) {
			if (error instanceof EphemeralSubagentError) addMeterUsage(meter, error.usage);
			if (started) {
				try {
					runtime.finishWidget(widgetId, error instanceof EphemeralSubagentError && error.code === "aborted" ? "aborted" : "failure");
				} catch (finishError) {
					return { error: finishError };
				}
			}
			return { error };
		}
	};

	const settlementFailure = (settlement: ChildSettlement): string | undefined => {
		if ("error" in settlement) return errorText(settlement.error);
		if (settlement.result.outcome === "success") return;
		return capOutput(
			settlement.result.errorMessage
			|| settlement.result.stderr.trim()
			|| settlement.result.output
			|| `Subagent exited with code ${settlement.result.exitCode}.`,
		);
	};

	const cleanupUnit = async (
		unit: UnitState,
		main: MainState,
		expectedTip: string,
		signal?: AbortSignal,
	): Promise<string | undefined> => {
		try {
			const branchResult = await git(["symbolic-ref", "--quiet", "HEAD"], unit.worktree.path, signal);
			const tipResult = await git(["rev-parse", "--verify", "HEAD^{commit}"], unit.worktree.path, signal);
			const branch = branchResult.code === 0 && !branchResult.killed ? oneLine(branchResult.stdout, "Unit cleanup branch") : "detached or unreadable";
			const tip = tipResult.code === 0 && !tipResult.killed ? oid(tipResult.stdout, "Unit cleanup HEAD") : "unreadable";
			if (branch !== `refs/heads/${unit.worktree.branch}` || tip !== expectedTip) {
				return `Unit Worktree no longer matches approved state: expected branch=${JSON.stringify(`refs/heads/${unit.worktree.branch}`)} HEAD=${expectedTip}; actual branch=${JSON.stringify(branch)} HEAD=${tip}.`;
			}
			const inspection = await inspectWorktreeDirty(unit.worktree.path, async (args, cwd) => git(args, cwd, signal));
			if (inspection.failure) return `Worktree cleanup inspection failed: ${inspection.failure}`;
			if (inspection.dirty) return "Unit Worktree contains uncommitted or ignored work.";
			const removed = await git(["worktree", "remove", unit.worktree.path], main.root, signal);
			if (removed.code !== 0 || removed.killed) {
				return commandFailure(`git worktree remove ${JSON.stringify(unit.worktree.path)}`, removed);
			}
			unit.worktreeRetained = false;
			const deleted = await git(["branch", "-d", unit.worktree.branch], main.root, signal);
			if (deleted.code !== 0 || deleted.killed) {
				return commandFailure(`git branch -d ${JSON.stringify(unit.worktree.branch)}`, deleted);
			}
			unit.branchRetained = false;
			return;
		} catch (error) {
			return errorText(error);
		}
	};

	const retained = (flow: FlowState) => flow.units
		.filter((unit) => unit.worktreeRetained || unit.branchRetained)
		.map((unit) => ({
			id: unit.request.id,
			path: unit.worktree.path,
			branch: unit.worktree.branch,
			base: unit.base,
			worktreeRetained: unit.worktreeRetained,
			branchRetained: unit.branchRetained,
		}));

	const response = (
		flow: FlowState,
		outcome: "completed" | "blocked" | "failed",
		meter: UsageMeter,
		failure?: { classification: FlowClassification; diagnostic: string },
	) => {
		const retainedUnits = retained(flow);
		const blocked = outcome === "blocked" ? flow.blocked : undefined;
		const details = {
			outcome,
			completed: flow.completed,
			...(flow.setupRecoveries.length ? { setupRecoveries: flow.setupRecoveries } : {}),
			...(blocked === undefined ? {} : { blocked: {
				id: blocked.unit.request.id,
				classification: blocked.classification,
				diagnostic: blocked.diagnostic,
				repairAvailable: !blocked.unit.repairUsed,
				path: blocked.unit.worktree.path,
				branch: blocked.unit.worktree.branch,
			} }),
			...(failure === undefined ? {} : { failure }),
			retained: retainedUnits,
			warnings: flow.warnings,
		};
		const lines = [
			`Flow ${outcome}.`,
			flow.completed.length ? `Completed units: ${flow.completed.map(({ id, noOp }) => `${JSON.stringify(id)}${noOp ? " (no-op)" : ""}`).join(", ")}` : "Completed units: none.",
			...(flow.setupRecoveries.length ? [
				"Attempted allocations preserved without cleanup:",
				...flow.setupRecoveries.map((recovery) => `- unit=${JSON.stringify(recovery.id)} path=${JSON.stringify(recovery.path)} branch=${JSON.stringify(recovery.branch)} base=${recovery.base}`),
			] : []),
			...(retainedUnits.length ? [
				"Retained Flow state:",
				...retainedUnits.map((unit) => `- unit=${JSON.stringify(unit.id)} path=${JSON.stringify(unit.path)} branch=${JSON.stringify(unit.branch)} base=${unit.base} worktree=${unit.worktreeRetained} branch_ref=${unit.branchRetained}`),
			] : []),
			...(blocked ? [
				`Blocked unit: ${JSON.stringify(blocked.unit.request.id)}.`,
				`Classification: ${blocked.classification}.`,
				`Repair available: ${!blocked.unit.repairUsed}.`,
				`Diagnostic:\n${blocked.diagnostic}`,
				"Call delegate_flow_continue with explicit repair guidance.",
			] : []),
			...(failure ? [`Classification: ${failure.classification}.`, `Diagnostic:\n${failure.diagnostic}`] : []),
			...(flow.warnings.length ? ["Warnings:", ...flow.warnings.map((warning) => `- ${warning}`)] : []),
		];
		return {
			content: [{ type: "text" as const, text: capOutput(lines.join("\n")) }],
			details,
			...(meter.usage === undefined ? {} : { usage: meter.usage }),
		};
	};

	const terminal = (
		flow: FlowState,
		classification: FlowClassification,
		diagnostic: string,
		meter: UsageMeter,
	) => {
		if (active === flow) active = undefined;
		return response(flow, "failed", meter, { classification, diagnostic: capOutput(diagnostic) });
	};

	const block = (
		flow: FlowState,
		unit: UnitState,
		classification: BlockedState["classification"],
		diagnostic: string,
		meter: UsageMeter,
	) => {
		const bounded = capOutput(diagnostic);
		if (unit.repairUsed) return terminal(flow, classification, bounded, meter);
		flow.phase = "blocked";
		flow.blocked = { unit, classification, diagnostic: bounded };
		return response(flow, "blocked", meter);
	};

	const inspectUnit = async (
		unit: UnitState,
		allowNoOp: boolean,
		signal?: AbortSignal,
	): Promise<{ tip?: string; block?: string }> => {
		const branch = await git(["symbolic-ref", "--quiet", "HEAD"], unit.worktree.cwd, signal);
		if (signal?.aborted) signal.throwIfAborted();
		if (branch.code !== 0 || branch.killed) {
			return { block: `Implementer moved Unit ${JSON.stringify(unit.request.id)} off its Flow-owned branch.` };
		}
		if (oneLine(branch.stdout, "Unit branch") !== `refs/heads/${unit.worktree.branch}`) {
			return { block: `Implementer moved Unit ${JSON.stringify(unit.request.id)} off its Flow-owned branch.` };
		}
		const tipResult = await git(["rev-parse", "--verify", "HEAD^{commit}"], unit.worktree.cwd, signal);
		if (signal?.aborted) signal.throwIfAborted();
		if (tipResult.code !== 0 || tipResult.killed) return { block: `Unit ${JSON.stringify(unit.request.id)} has no readable committed HEAD.` };
		const tip = oid(tipResult.stdout, "Unit HEAD");
		const branchTip = oid(await requireGit(["rev-parse", "--verify", `refs/heads/${unit.worktree.branch}^{commit}`], unit.worktree.cwd, signal), "Unit branch tip");
		if (tip !== branchTip) return { block: `Unit ${JSON.stringify(unit.request.id)} branch no longer names its checked-out HEAD.` };
		const status = await requireGit(["status", "--porcelain=v1", "--untracked-files=all"], unit.worktree.cwd, signal);
		if (status) return { block: `Unit Worktree is dirty:\n${capOutput(status)}` };
		const flags = await inspectIndexFlags(unit.worktree.cwd, git, signal);
		if (flags.failure) throw new Error(`Unit index inspection failed: ${flags.failure}`);
		if (flags.hidden) return { block: "Unit Worktree has assume-unchanged or skip-worktree index entries." };
		const ancestor = await git(["merge-base", "--is-ancestor", unit.base, tip], unit.worktree.cwd, signal);
		if (signal?.aborted) signal.throwIfAborted();
		if (ancestor.code === 1) return { block: `Unit HEAD does not descend from its Flow-owned base ${unit.base}.` };
		if (ancestor.code !== 0 || ancestor.killed) throw new Error(commandFailure("git merge-base --is-ancestor", ancestor));
		const countText = oneLine(await requireGit(["rev-list", "--count", `${unit.base}..${tip}`], unit.worktree.cwd, signal), "Unit commit count");
		const count = Number.parseInt(countText, 10);
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Git returned an invalid Unit commit count.");
		if (!allowNoOp && count === 0) return { block: `Unit ${JSON.stringify(unit.request.id)} has no committed change.` };
		return { tip };
	};

	const validateUnit = async (
		unit: UnitState,
		tip: string,
		signal?: AbortSignal,
	): Promise<string | undefined> => {
		for (const [index, validation] of unit.request.validation.entries()) {
			const result = await execute(validation.command, validation.args, unit.worktree.cwd, signal, runtime.maxRuntimeMs);
			if (signal?.aborted) signal.throwIfAborted();
			if (result.code !== 0 || result.killed) return commandFailure(`Validation ${index + 1}`, result);
		}
		const inspected = await inspectUnit(unit, true, signal);
		if (inspected.block || inspected.tip !== tip) {
			return capOutput([
				"Validation changed the Flow-owned committed Unit state.",
				`Expected branch=${JSON.stringify(unit.worktree.branch)} HEAD=${tip} clean=true.`,
				inspected.block ?? `Actual HEAD=${inspected.tip}.`,
			].join("\n"));
		}
		return;
	};

	const processFlow = async (
		flow: FlowState,
		toolCallId: string,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		meter: UsageMeter,
		emitProgress: (line: string) => void,
	) => {
		assertCurrent(flow);
		const main = flow.main!;
		while (flow.index < flow.units.length) {
			assertCurrent(flow);
			const unit = flow.units[flow.index]!;
			try {
				await checkMain(main, signal);
			} catch (error) {
				return terminal(flow, "main", errorText(error), meter);
			}
			assertCurrent(flow);

			const implementationFailure = settlementFailure(unit.implementation!);
			if (implementationFailure) return block(flow, unit, "implementer", implementationFailure, meter);
			emitProgress(`verify/integrate · unit ${flow.index + 1}/${flow.units.length}`);

			let inspected = await inspectUnit(unit, false, signal);
			assertCurrent(flow);
			if (inspected.block) return block(flow, unit, "implementer", inspected.block, meter);
			let tip = inspected.tip!;

			if (unit.base !== main.expectedHead) {
				const rebaseInspection = await inspectWorktreeDirty(unit.worktree.path, async (args, cwd) => git(args, cwd, signal));
				assertCurrent(flow);
				if (rebaseInspection.failure) {
					return terminal(flow, "infrastructure", `Pre-rebase Unit Worktree inspection failed: ${rebaseInspection.failure}`, meter);
				}
				if (rebaseInspection.dirty) {
					return block(flow, unit, "implementer", "Unit Worktree contains uncommitted or ignored work; rebase was refused.", meter);
				}
				const rebased = await git(["rebase", main.expectedHead], unit.worktree.cwd, signal);
				if (signal?.aborted) {
					const aborted = await git(["rebase", "--abort"], unit.worktree.cwd);
					if (aborted.code !== 0 || aborted.killed) {
						return terminal(flow, "infrastructure", [
							`Flow cancelled: ${errorText(signal.reason)}`,
							commandFailure("git rebase --abort", aborted),
						].join("\n"), meter);
					}
					signal.throwIfAborted();
				}
				assertCurrent(flow);
				if (rebased.code !== 0 || rebased.killed) {
					const aborted = await git(["rebase", "--abort"], unit.worktree.cwd);
					const diagnostic = [
						`Rebase failed; git rebase --abort ${aborted.code === 0 && !aborted.killed ? "restored the Unit Worktree for recovery." : "also failed; inspect the retained Unit Worktree."}`,
						commandFailure(`git rebase ${main.expectedHead}`, rebased),
						...(aborted.code === 0 && !aborted.killed ? [] : [commandFailure("git rebase --abort", aborted)]),
					].join("\n");
					return terminal(flow, "infrastructure", diagnostic, meter);
				}
				unit.base = main.expectedHead;
				inspected = await inspectUnit(unit, true, signal);
				assertCurrent(flow);
				if (inspected.block) return terminal(flow, "infrastructure", inspected.block, meter);
				tip = inspected.tip!;
			}

			const validationFailure = await validateUnit(unit, tip, signal);
			assertCurrent(flow);
			if (validationFailure) return block(flow, unit, "validation", validationFailure, meter);
			if (unit.base === tip) {
				try {
					await checkMain(main, signal);
				} catch (error) {
					return terminal(flow, "main", errorText(error), meter);
				}
				assertCurrent(flow);
				flow.completed.push({ id: unit.request.id, noOp: true });
				const cleanupWarning = await cleanupUnit(unit, main, tip, flow.sessionController.signal);
				assertCurrent(flow);
				if (cleanupWarning) flow.warnings.push(`Unit ${JSON.stringify(unit.request.id)} completed as a no-op, but cleanup refused: ${cleanupWarning}`);
				flow.index += 1;
				continue;
			}

			let approvedTip = tip;
			const reviewCriterion = unit.request.review;
			if (reviewCriterion !== undefined) {
				const reviewer = flow.reviewer;
				if (!reviewer) return terminal(flow, "infrastructure", "Flow Reviewer was not resolved for a unit that requires review.", meter);
				emitProgress(`review · unit ${flow.index + 1}/${flow.units.length}`);
				let evidence;
				try {
					evidence = await prepareExactReviewEvidence({ base: main.expectedHead, tip, worktree: unit.worktree.path }, signal);
				} catch (error) {
					return terminal(flow, "infrastructure", errorText(error), meter);
				}

				let review: ChildSettlement;
				let cleanupError: unknown;
				try {
					assertCurrent(flow);
					review = await runChild(
						flow,
						reviewer,
						unit.modelClass,
						reviewerTask(unit.request, reviewCriterion, { base: evidence.base, tip: evidence.tip, patchPath: evidence.patchPath }),
						unit.request.task,
						unit.worktree.cwd,
						`${toolCallId}:flow:${flow.index}:review`,
						signal,
						ctx,
						meter,
					);
				} finally {
					try {
						await evidence.cleanup();
					} catch (error) {
						cleanupError = error;
					}
				}
				if (cleanupError !== undefined) return terminal(flow, "infrastructure", errorText(cleanupError), meter);
				assertCurrent(flow);
				if ("error" in review) return terminal(flow, "infrastructure", errorText(review.error), meter);
				if (review.result.outcome !== "success") {
					return terminal(flow, "infrastructure", settlementFailure(review)!, meter);
				}
				if (TRUNCATED_OUTPUT.test(review.result.output)) {
					return terminal(flow, "infrastructure", "Reviewer transport output was truncated; approval is invalid.", meter);
				}
				if (review.result.output.trim() !== "PASS") {
					return block(flow, unit, "reviewer_findings", review.result.output || "Reviewer returned no PASS approval.", meter);
				}
				approvedTip = evidence.tip;
			}

			try {
				await checkMain(main, signal);
			} catch (error) {
				return terminal(flow, "main", errorText(error), meter);
			}
			assertCurrent(flow);
			const merged = await git(["merge", "--no-overwrite-ignore", "--ff-only", approvedTip], main.root, signal);
			assertCurrent(flow);
			if (merged.code !== 0 || merged.killed) {
				const diagnostic = commandFailure(`git merge --no-overwrite-ignore --ff-only ${approvedTip}`, merged);
				const previousHead = main.expectedHead;
				main.expectedHead = approvedTip;
				try {
					await checkMain(main);
				} catch (error) {
					main.expectedHead = previousHead;
					return terminal(flow, "integration", capOutput([
						diagnostic,
						"Merge reported failure and Main did not reconcile to the approved clean state.",
						errorText(error),
					].join("\n")), meter);
				}
				flow.warnings.push(capOutput(`Unit ${JSON.stringify(unit.request.id)} integrated after merge reported failure: ${diagnostic}`));
			} else main.expectedHead = approvedTip;
			flow.completed.push({ id: unit.request.id, noOp: false });
			try {
				await checkMain(main);
			} catch (error) {
				return terminal(flow, "integration", errorText(error), meter);
			}
			assertCurrent(flow);
			const cleanupWarning = await cleanupUnit(unit, main, approvedTip, flow.sessionController.signal);
			assertCurrent(flow);
			if (cleanupWarning) flow.warnings.push(`Unit ${JSON.stringify(unit.request.id)} integrated, but cleanup refused: ${cleanupWarning}`);
			flow.index += 1;
		}
		assertCurrent(flow);
		if (active === flow) active = undefined;
		return response(flow, "completed", meter);
	};

	pi.registerTool({
		name: "delegate_flow",
		label: "Delegate Flow",
		description: "Run 1–8 independent Implementers in isolated Unit Worktrees, validate and serially fast-forward each tip, with exact review only for units that declare a judgment criterion.",
		promptSnippet: "Run a deterministic parallel-implementation, serial-verification Flow",
		promptGuidelines: [
			"Use delegate_flow only for cohesive units expected to commute: split independent outcomes into units, sequence dependent work outside delegate_flow, and never divide one invariant across multiple units. Combine work that overlaps files, APIs, schemas, generated output, package metadata, lockfiles, or invariants.",
			"Each delegate_flow unit must own one concrete outcome with one focused validation story: include explicit bounded requirements and its authoritative direct command/argument validation gate. If the affected flow or scope is not yet known, perform bounded read-only discovery first. Add review only for an explicit judgment that validation cannot establish.",
			"If a Flow blocks, inspect its classification and call delegate_flow_continue once with explicit repair guidance; modelClass may replace that one repair's current class.",
		],
		parameters: DelegateFlowSchema,
		renderCall(args, theme, _context) {
			return renderToolLines([theme.fg("toolTitle", flowCallLabel(args))], theme);
		},
		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return renderToolLines(isFlowProgress(result.details) ? [theme.fg("muted", result.details.line)] : [], theme);
			const text = result.content.find((part) => part.type === "text")?.text ?? "(no output)";
			return renderToolLines(flowResultLines(text), theme);
		},
		prepareArguments: parseDelegateFlow,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const request = parseDelegateFlow(params);
			if (active) throw new Error("delegate_flow rejected because another Flow is active.");
			const roles = runtime.loadRoles();
			const implementer = roles.find(({ name }) => name === "implementer");
			const needsReviewer = request.units.some(({ review }) => review !== undefined);
			const reviewer = needsReviewer ? roles.find(({ name }) => name === "reviewer") : undefined;
			if (!implementer) throw new Error("delegate_flow requires an implementer Role.");
			if (needsReviewer && !reviewer) throw new Error("delegate_flow requires a reviewer Role when a unit declares review.");
			const emitProgress = (line: string) => {
				const progress: FlowProgress = { line };
				onUpdate?.({ content: [{ type: "text", text: progress.line }], details: progress });
			};
			const flow: FlowState = {
				phase: "running",
				generation: runtime.getSessionGeneration(),
				sessionController: new AbortController(),
				implementer,
				...(reviewer === undefined ? {} : { reviewer }),
				units: [],
				setupRecoveries: [],
				index: 0,
				completed: [],
				warnings: [],
			};
			active = flow;
			emitProgress(`setup · ${unitCount(request.units.length)}`);
			const operationSignal = bindSignal(flow, signal);
			const meter: UsageMeter = {};
			let setupComplete = false;
			try {
				flow.main = await snapshotMain(ctx.cwd, operationSignal);
				assertCurrent(flow);
				for (const [index, unit] of request.units.entries()) {
					let worktree: WorktreeInfo | undefined;
					try {
						worktree = await createChildWorktree(ctx.cwd, `${toolCallId}:flow:${index}:${unit.id}`, undefined, operationSignal);
					} catch (error) {
						if (!(error instanceof WorktreeSetupError)) throw error;
						flow.setupRecoveries.push({
							id: unit.id,
							path: error.worktree.path,
							branch: error.worktree.branch,
							base: error.worktree.baseCommit,
							diagnostic: errorText(error),
						});
						throw error;
					}
					if (!worktree) throw new Error("Flow Unit Worktrees require a Git repository with a committed HEAD; generic cwd fallback is disabled.");
					flow.units.push({
						request: unit,
						modelClass: unit.modelClass,
						worktree,
						base: worktree.baseCommit,
						repairUsed: false,
						worktreeRetained: true,
						branchRetained: true,
					});
					assertCurrent(flow);
					if (worktree.baseCommit !== flow.main.expectedHead) throw new Error("Git Main changed while Flow Unit Worktrees were being created.");
				}
				await checkMain(flow.main, operationSignal);
				assertCurrent(flow);
				setupComplete = true;
				let completedImplementers = 0;
				const settlements = await Promise.all(flow.units.map((unit, index) => runChild(
					flow,
					flow.implementer,
					unit.modelClass,
					implementerTask(unit.request),
					unit.request.task,
					unit.worktree.cwd,
					`${toolCallId}:flow:${index}:implement`,
					operationSignal,
					ctx,
					meter,
				).then((settlement) => {
					completedImplementers += 1;
					emitProgress(`implement · ${completedImplementers}/${flow.units.length} complete`);
					return settlement;
				})));
				for (const [index, settlement] of settlements.entries()) flow.units[index]!.implementation = settlement;
				assertCurrent(flow);
				if (operationSignal.aborted) operationSignal.throwIfAborted();
				return await processFlow(flow, toolCallId, operationSignal, ctx, meter, emitProgress);
			} catch (error) {
				if (!setupComplete) {
					for (const unit of [...flow.units].reverse()) {
						const warning = flow.main
							? await cleanupUnit(unit, flow.main, unit.base, flow.sessionController.signal)
							: "Main identity was unavailable for cleanup.";
						if (warning) flow.warnings.push(`Partial setup cleanup refused for ${JSON.stringify(unit.request.id)}: ${warning}`);
					}
				}
				return terminal(flow, setupComplete ? "infrastructure" : "setup", errorText(error), meter);
			}
		},
	});

	pi.registerTool({
		name: "delegate_flow_continue",
		label: "Continue Delegate Flow",
		description: "Repair the one blocked Flow Unit in its existing Unit Worktree, optionally replace its model class, then resume declared-order validation, conditional exact review, and integration.",
		promptSnippet: "Repair and continue the blocked deterministic Flow",
		promptGuidelines: ["Call delegate_flow_continue only after delegate_flow reports a repairable block, with explicit guidance addressing that block."],
		parameters: DelegateFlowContinueSchema,
		renderCall(_args, theme, _context) {
			return renderToolLines([theme.fg("toolTitle", "delegate_flow_continue · repair continuation")], theme);
		},
		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return renderToolLines(isFlowProgress(result.details) ? [theme.fg("muted", result.details.line)] : [], theme);
			const text = result.content.find((part) => part.type === "text")?.text ?? "(no output)";
			return renderToolLines(flowResultLines(text), theme);
		},
		prepareArguments: parseDelegateFlowContinue,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { guidance, modelClass } = parseDelegateFlowContinue(params);
			const flow = active;
			if (!flow) throw new Error("delegate_flow_continue requires an active blocked Flow.");
			assertCurrent(flow);
			if (flow.phase !== "blocked" || !flow.blocked) throw new Error("delegate_flow_continue rejected because the active Flow is not blocked.");
			const blocked = flow.blocked;
			const unit = blocked.unit;
			if (unit.repairUsed) throw new Error("delegate_flow_continue repair was already used for this Unit.");
			flow.phase = "running";
			flow.blocked = undefined;
			unit.repairUsed = true;
			if (modelClass !== undefined) unit.modelClass = modelClass;
			const operationSignal = bindSignal(flow, signal);
			const meter: UsageMeter = {};
			const emitProgress = (line: string) => {
				const progress: FlowProgress = { line };
				onUpdate?.({ content: [{ type: "text", text: progress.line }], details: progress });
			};
			try {
				emitProgress(`repair · unit ${flow.index + 1}/${flow.units.length}`);
				unit.implementation = await runChild(
					flow,
					flow.implementer,
					unit.modelClass,
					repairTask(unit.request, blocked, guidance),
					unit.request.task,
					unit.worktree.cwd,
					`${toolCallId}:flow:${flow.index}:repair`,
					operationSignal,
					ctx,
					meter,
				);
				assertCurrent(flow);
				if (operationSignal.aborted) operationSignal.throwIfAborted();
				return await processFlow(flow, toolCallId, operationSignal, ctx, meter, emitProgress);
			} catch (error) {
				return terminal(flow, "infrastructure", errorText(error), meter);
			}
		},
	});

	return invalidateActive;
}
