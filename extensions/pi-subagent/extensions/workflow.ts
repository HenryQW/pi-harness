import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { posix } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { DISPLAY_TEXT_CONTRACT } from "@henryqw/pi-subagent";
import { PROFILE_NAMES } from "@henryqw/pi-task-models";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { runGit } from "../dist/git-process.js";
import { ExecuteRequestSchema, parseExecuteRequest, type ExecuteRequest } from "../dist/schema.js";
import { WorkspaceRequestSchema, parseWorkspaceRequest, type WorkspaceRequest } from "../dist/workspace-schema.js";
import { RepositorySelectionSchema, parseRepositorySelection, type RepositorySelection } from "../dist/workspace-scope.js";

export const MAX_WORKFLOW_ENTRIES = 8;

const TASK_NAME_MAX_LENGTH = 29;
const TaskNameSchema = Type.String({
	minLength: 1,
	maxLength: TASK_NAME_MAX_LENGTH,
	description: `Short descriptive task name, about five words and fewer than ${TASK_NAME_MAX_LENGTH + 1} characters; C0/C1 control characters are rejected.`,
	pattern: DISPLAY_TEXT_CONTRACT.pattern,
});

const RoleSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Configured Subagent role name" });
const TaskSchema = Type.String({ minLength: 1, description: "Bounded task packet" });
const ModelSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Designated model as provider/modelId; replaces the selected route model" });
const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });
const DirectKindSchema = StringEnum(["text"] as const);
/** Main's honest per-task classification; only `write` reserves the checkout. Nothing enforces `read`. */
export const DIRECT_ACCESS = ["read", "write"] as const;
export type DirectAccess = (typeof DIRECT_ACCESS)[number];
const ACCESS_GUIDANCE = `Declare "write" when the task may change files, Git state, or external resources, otherwise "read". "read" is not enforced (no sandbox): it skips checkout admission and runs concurrently. Use mode isolated for checked writes.`;
const AccessSchema = StringEnum(DIRECT_ACCESS, { description: ACCESS_GUIDANCE });
const DryRunSchema = Type.Boolean({ description: "Optional. When true, run every launch validation and return the resolved plan without starting workers, saving state, or reserving the checkout." });
const ContinueFromSchema = Type.String({ pattern: "^D[1-9][0-9]*\\.[1-9][0-9]*$", description: "Optional direct worker reference such as D7.1. Continues that finished worker's Pi session in a new tab with this task; role must equal the recorded Role." });

const PathsSchema = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	maxItems: 32,
	description: "Write tasks only: repo-relative globs (Node path.matchesGlob syntax, such as src/**) the task may change. The result flags changed paths outside them. Report only; nothing enforces it.",
});

export const DelegationSchema = Type.Object({
	role: RoleSchema,
	name: TaskNameSchema,
	task: TaskSchema,
	access: AccessSchema,
	paths: Type.Optional(PathsSchema),
	continueFrom: Type.Optional(ContinueFromSchema),
	kind: Type.Optional(DirectKindSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
}, { additionalProperties: false });

export const DirectWorkflowSchema = Type.Object({
	mode: Type.Literal("direct"),
	repositories: Type.Optional(RepositorySelectionSchema),
	role: Type.Optional(RoleSchema),
	name: Type.Optional(TaskNameSchema),
	task: Type.Optional(TaskSchema),
	access: Type.Optional(AccessSchema),
	paths: Type.Optional(PathsSchema),
	continueFrom: Type.Optional(ContinueFromSchema),
	kind: Type.Optional(DirectKindSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	tasks: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
	chain: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
}, { additionalProperties: false, description: "Direct mode: exactly one compact single, tasks, or chain workflow" });

// Parse each mode with its strict schema; expose a plain object root to tool providers.
export const DelegateTaskParameters = Type.Object({
	...DirectWorkflowSchema.properties,
	mode: Type.Union([DirectWorkflowSchema.properties.mode, ExecuteRequestSchema.properties.mode]),
	id: Type.Optional(ExecuteRequestSchema.properties.id),
	goal: Type.Optional(ExecuteRequestSchema.properties.goal),
	tasks: Type.Optional(Type.Union([
		Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES }),
		ExecuteRequestSchema.properties.tasks,
		WorkspaceRequestSchema.properties.tasks,
	])),
	finalChecks: Type.Optional(Type.Union([ExecuteRequestSchema.properties.finalChecks, WorkspaceRequestSchema.properties.finalChecks])),
	finalJudgment: ExecuteRequestSchema.properties.finalJudgment,
	dryRun: Type.Optional(DryRunSchema),
}, { additionalProperties: false });

export type Delegation = Static<typeof DelegationSchema> & { kind: "text" };
export type WorkflowMode = "single" | "parallel" | "chain";
export type ParsedWorkflow = (
	| { mode: "single"; delegations: [Delegation] }
	| { mode: "parallel"; delegations: Delegation[] }
	| { mode: "chain"; delegations: Delegation[] }) & { repositories?: RepositorySelection };
export type ParsedDelegateTask = ({ mode: "direct"; workflow: ParsedWorkflow } | { mode: "isolated"; request: ExecuteRequest } | { mode: "workspace"; request: WorkspaceRequest }) & { dryRun: boolean };

type DirectInput = Static<typeof DirectWorkflowSchema>;
const DELEGATION_KEYS = ["role", "name", "task", "access", "paths", "continueFrom", "kind", "model", "modelClass"] as const;

function text(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${path} must be non-empty text without NUL.`);
	return normalized;
}

function normalizeTaskName(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${path} must be non-empty text.`);
	return normalized;
}

function normalizePaths(value: Static<typeof DelegationSchema>, path: string): string[] | undefined {
	if (value.paths === undefined) return;
	if (value.access !== "write") throw new Error(`${path}.paths requires access "write"; it declares where a write task may change files.`);
	return value.paths.map((glob, index) => {
		const normalized = text(glob, `${path}.paths[${index}]`);
		if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`${path}.paths[${index}] must be a repo-relative glob without .. segments.`);
		return normalized;
	});
}

function normalizeDelegation(value: Static<typeof DelegationSchema>, path: string): Delegation {
	const paths = normalizePaths(value, path);
	return {
		role: text(value.role, `${path}.role`),
		name: normalizeTaskName(value.name, `${path}.name`),
		task: text(value.task, `${path}.task`),
		access: value.access,
		...(paths === undefined ? {} : { paths }),
		...(value.continueFrom === undefined ? {} : { continueFrom: value.continueFrom }),
		kind: "text",
		...(value.model === undefined ? {} : { model: text(value.model, `${path}.model`) }),
		...(value.modelClass === undefined ? {} : { modelClass: value.modelClass }),
	};
}

function hasDelegation(value: DirectInput): value is DirectInput & Static<typeof DelegationSchema> {
	return Object.hasOwn(value, "role") && Object.hasOwn(value, "name") && Object.hasOwn(value, "task");
}

function requireAccess(value: unknown, path: string): void {
	if (!value || typeof value !== "object") return; // The schema rejects non-object tasks.
	const { access } = value as { access?: unknown };
	if (!DIRECT_ACCESS.some((candidate) => candidate === access)) {
		throw new Error(`${path}.access must be ${DIRECT_ACCESS.map((candidate) => JSON.stringify(candidate)).join(" or ")}${access === undefined ? " (missing)" : `, got ${JSON.stringify(access)}`}. ${ACCESS_GUIDANCE}`);
	}
}

function workflowMode(value: unknown): WorkflowMode | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const single = DELEGATION_KEYS.some((key) => Object.hasOwn(value, key));
	const parallel = Object.hasOwn(value, "tasks");
	const chain = Object.hasOwn(value, "chain");
	if (Number(single) + Number(parallel) + Number(chain) !== 1) throw new Error("direct workflow must select exactly one of single, tasks, or chain.");
	return single ? "single" : parallel ? "parallel" : "chain";
}

export function parseWorkflow(value: unknown): ParsedWorkflow {
	const mode = workflowMode(value);
	if (mode === "single") requireAccess(value, "workflow");
	else if (mode) {
		const items = (value as Record<string, unknown>)[mode === "parallel" ? "tasks" : "chain"];
		if (Array.isArray(items)) items.forEach((item, index) => requireAccess(item, `${mode === "parallel" ? "tasks" : "chain"}[${index}]`));
	}
	if (!Check(DirectWorkflowSchema, value)) {
		const issue = Errors(DirectWorkflowSchema, value)[0];
		throw new Error(`direct workflow must match the declared tool schema${issue ? ` at ${issue.instancePath || "/"}: ${issue.message}` : ""}. Direct mode returns task answers without checked integration; use mode isolated for changesets.`);
	}
	if (!mode) throw new Error("direct workflow must select exactly one of single, tasks, or chain.");
	const input = value as DirectInput;
	if (mode === "single" && !hasDelegation(input)) throw new Error("direct workflow requires role, name, task, and access.");
	const workflow: ParsedWorkflow = mode === "single" ? { mode, delegations: [normalizeDelegation(input as Static<typeof DelegationSchema>, "workflow")] }
		: mode === "parallel" ? { mode, delegations: input.tasks!.map((item, index) => normalizeDelegation(item, `tasks[${index}]`)) }
		: { mode, delegations: input.chain!.map((item, index) => normalizeDelegation(item, `chain[${index}]`)) };
	if (input.repositories) {
		workflow.repositories = parseRepositorySelection(input.repositories);
		if (workflow.delegations.some((task) => task.continueFrom || task.paths)) throw new Error("Selected direct repositories do not support continueFrom or paths; use the repository-labelled change report and explicit task scope.");
	}
	const continued = workflow.delegations.flatMap(({ continueFrom }) => continueFrom === undefined ? [] : [continueFrom]);
	if (new Set(continued).size !== continued.length) throw new Error("A direct request may continue each worker at most once.");
	return workflow;
}

/** A direct request is a writer request when any task declares write access. */
export const writesCheckout = (workflow: ParsedWorkflow): boolean => workflow.delegations.some(({ access }) => access === "write");

/** `dryRun` is a tool-call option, not part of the direct workflow or the durable isolated request. */
export function parseDelegateTask(value: unknown): ParsedDelegateTask {
	let dryRun = false;
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "dryRun")) {
		const { dryRun: option, ...rest } = value as Record<string, unknown>;
		if (typeof option !== "boolean") throw new Error(`delegate_task dryRun must be a boolean, got ${JSON.stringify(option)}.`);
		dryRun = option;
		value = rest;
	}
	if (value && typeof value === "object" && !Array.isArray(value) && (value as { mode?: unknown }).mode === "isolated") {
		if (Object.hasOwn(value, "repositories")) return { mode: "workspace", request: parseWorkspaceRequest(value), dryRun };
		return { mode: "isolated", request: parseExecuteRequest(value), dryRun };
	}
	return { mode: "direct", workflow: parseWorkflow(value), dryRun };
}

/** Main's checkout state: HEAD plus porcelain status and content identity of each dirty path. */
export type CheckoutSnapshot = { head?: string; entries: Map<string, string>; fingerprint: string };

export type ChangeReport = {
	/** Set when HEAD moved to a commit that does not descend from the launch HEAD. */
	headMove?: string;
	commits: Array<{ oid: string; subject: string }>;
	omittedCommits: number;
	paths: Array<{ path: string; outside?: true }>;
	omittedPaths: number;
};

export type CheckoutNote =
	| { kind: "repositories"; notes: Record<string, CheckoutNote | undefined> }
	| { kind: "changes"; report: ChangeReport }
	| { kind: "stale" }
	| { kind: "unavailable"; check: "change report" | "stale-read check"; reason: string };

export const CHANGE_REPORT_LIMITS = { commits: 10, paths: 20, subject: 120, reason: 500 } as const;

async function contentIdentity(path: string): Promise<string> {
	const stats = await lstat(path).catch(() => undefined);
	if (!stats) return "absent";
	if (stats.isSymbolicLink()) return `link ${await readlink(path)}`;
	if (!stats.isFile()) return "other";
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

// Background snapshots must not take index.lock while Main or a worker writes.
async function git(cwd: string, args: string[], codes = [0]) {
	const result = await runGit(["--no-optional-locks", ...args], cwd);
	if (!codes.includes(result.code)) throw new Error(`git ${args[0]} exited ${result.code}: ${result.stderr.trim() || "no diagnostic"}`);
	return result;
}

/** Snapshot the checkout that contains `cwd`; undefined outside a Git repository. Other Git failures throw. */
export async function snapshotCheckout(cwd: string): Promise<CheckoutSnapshot | undefined> {
	const top = await runGit(["--no-optional-locks", "rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0 && /not a git repository/i.test(top.stderr)) return undefined;
	const root = top.stdout.trim();
	if (top.code !== 0 || !root) throw new Error(`git rev-parse exited ${top.code}: ${top.stderr.trim() || "no diagnostic"}`);
	const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).stdout.trim() || undefined;
	// Porcelain paths are repository-relative; an index or worktree rename or copy lists its source after the destination.
	const fields = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0");
	const entries = new Map<string, string>();
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		const status = field.slice(0, 2);
		entries.set(field.slice(3), status);
		if (/[RC]/.test(status)) entries.set(fields[++index]!, status);
	}
	// Status alone misses a further edit to a path that was already dirty.
	for (const [path, status] of entries) entries.set(path, `${status} ${await contentIdentity(posix.join(root, path))}`);
	const fingerprint = createHash("sha256").update(JSON.stringify([head ?? null, [...entries].sort()])).digest("hex");
	return { ...(head === undefined ? {} : { head }), entries, fingerprint };
}

/** Commits and changed paths between two snapshots of the same checkout. */
export async function reportCheckoutChanges(cwd: string, before: CheckoutSnapshot, after: CheckoutSnapshot, declared?: readonly string[]): Promise<ChangeReport> {
	const changed = new Set([...before.entries.keys(), ...after.entries.keys()].filter((path) => before.entries.get(path) !== after.entries.get(path)));
	const report: ChangeReport = { commits: [], omittedCommits: 0, paths: [], omittedPaths: 0 };
	const short = (oid: string) => oid.slice(0, 12);
	if (before.head !== after.head && after.head === undefined) report.headMove = `HEAD moved from ${short(before.head!)} to an unborn branch`;
	else if (before.head !== after.head) {
		const range = before.head === undefined ? [after.head!] : [`${before.head}..${after.head}`];
		const total = Number((await git(cwd, ["rev-list", "--count", ...range, "--"])).stdout.trim());
		const log = (await git(cwd, ["log", "--no-show-signature", `--max-count=${CHANGE_REPORT_LIMITS.commits}`, "--format=%h%x00%s", ...range, "--"])).stdout;
		report.commits = log.split("\n").filter(Boolean).map((line) => {
			const [oid, subject = ""] = line.split("\0");
			return { oid: oid!, subject: Array.from(subject).slice(0, CHANGE_REPORT_LIMITS.subject).join("") };
		});
		report.omittedCommits = Math.max(0, total - report.commits.length);
		const names = before.head === undefined
			? await git(cwd, ["ls-tree", "-r", "--name-only", "-z", "--full-tree", after.head!])
			: await git(cwd, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", before.head, after.head!, "--"]);
		for (const path of names.stdout.split("\0")) if (path) changed.add(path);
		if (before.head !== undefined && (await git(cwd, ["merge-base", "--is-ancestor", before.head, after.head!], [0, 1])).code === 1) {
			report.headMove = `HEAD moved from ${short(before.head)} to ${short(after.head!)}, which does not descend from it`;
		}
	}
	const outside = (path: string) => declared !== undefined && !declared.some((glob) => posix.matchesGlob(path, glob));
	// Outside paths come first so the cap never hides them.
	const paths = [...changed].sort().map((path) => outside(path) ? { path, outside: true as const } : { path })
		.sort((left, right) => Number(Boolean(right.outside)) - Number(Boolean(left.outside)));
	report.paths = paths.slice(0, CHANGE_REPORT_LIMITS.paths);
	report.omittedPaths = paths.length - report.paths.length;
	return report;
}

/** Compare a task's launch snapshot with the checkout at its terminal outcome. Failures become a note, never a task failure. */
export async function checkoutNote(cwd: string, before: CheckoutSnapshot | Error | undefined, write: boolean, declared?: readonly string[]): Promise<CheckoutNote | undefined> {
	try {
		if (before instanceof Error) throw before;
		if (before === undefined) return;
		const after = await snapshotCheckout(cwd);
		if (after === undefined) throw new Error("the checkout is no longer a Git repository");
		if (write) return { kind: "changes", report: await reportCheckoutChanges(cwd, before, after, declared) };
		return after.fingerprint === before.fingerprint ? undefined : { kind: "stale" };
	} catch (error) {
		return { kind: "unavailable", check: write ? "change report" : "stale-read check", reason: Array.from(error instanceof Error ? error.message : String(error)).slice(0, CHANGE_REPORT_LIMITS.reason).join("") };
	}
}

export type WorkflowEntry = { id: string; index: number; delegation: Delegation };
export function identifyWorkflowEntries(toolCallId: string, workflow: ParsedWorkflow): WorkflowEntry[] {
	return workflow.delegations.map((delegation, index) => ({ id: `${toolCallId}:${workflow.mode}:${index}`, index, delegation }));
}

export type DelegationRunner = (entry: WorkflowEntry) => string | Promise<string>;

async function runEntry(entry: WorkflowEntry, run: DelegationRunner): Promise<string | undefined> {
	try {
		return await run(entry);
	} catch {
		return undefined;
	}
}

export async function runForegroundWorkflow(
	mode: WorkflowMode,
	entries: readonly WorkflowEntry[],
	run: DelegationRunner,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (mode === "single" || mode === "parallel") {
		await Promise.all(entries.map((entry) => runEntry(entry, run)));
		signal?.throwIfAborted();
		return;
	}
	let previous = "";
	for (const entry of entries) {
		const selected = {
			...entry,
			delegation: { ...entry.delegation, task: entry.delegation.task.replaceAll("{previous}", () => previous) },
		};
		const output = await runEntry(selected, run);
		signal?.throwIfAborted();
		if (output === undefined) break;
		previous = output;
	}
}
