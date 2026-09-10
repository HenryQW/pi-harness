import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	extensionConfigDir,
	readTextFileBounded,
	writePrivateTextFileAtomically,
} from "@henryqw/pi-config-store";
import {
	collectPullRequestFeedback,
	feedbackAuthorityFromCurrent,
	feedbackContentFingerprint,
	feedbackEntries,
	feedbackFingerprint,
	parseFeedbackSnapshot,
	showFeedbackItem,
	resolvePullRequestThread,
	FEEDBACK_MAX_RECORDS,
	type FeedbackItem,
	type FeedbackKind,
	type FeedbackSnapshot,
} from "./pr-feedback.ts";
import {
	loadCurrentPullRequest,
	type CurrentPullRequest,
	type PullRequestLoadContext,
} from "./pr-github.ts";
import {
	isAncestor,
	parseNulPaths,
	parseStatusSnapshot,
	readHead,
	readRemoteOid,
	requiredOid,
	requiredText,
	runChecked,
	spawnBounded,
	withWorktreeLock,
	type AttemptState,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";

export const PR_COMMENT_SWEEP_ACTIONS = [
	"start", "resume", "show", "record", "publish", "refresh", "resolve", "finalize",
] as const;
export type PrCommentSweepAction = (typeof PR_COMMENT_SWEEP_ACTIONS)[number];
export const SWEEP_RECOVERY_MAX_BYTES = 1024 * 1024;

const STATE_VERSION = 1;
const STATE_FILE = "state.json";
const GIT_OPERATION_STATES = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
const LEDGER_NOTE_MAX_BYTES = 2 * 1024;
const CHECK_MAX_COUNT = 32;
const CHECK_ARGUMENTS_MAX_BYTES = 32 * 1024;
const ATTEMPT_STATES = new Set<AttemptState>(["none", "attempting", "applied", "blocked", "unknown"]);
const DISPOSITIONS = ["addressed", "non-actionable", "blocked"] as const;

export type SweepDisposition = (typeof DISPOSITIONS)[number];
export type SweepLedgerEntry = {
	id: string;
	kind: FeedbackKind;
	disposition: SweepDisposition;
	note: string;
};
export type SweepRunGuard = {
	epoch: number;
	runId: string;
	generation: number;
	fingerprint: string;
};
export type SweepCheck = { command: string; args: string[] };
export type SweepFinalProjection = {
	generation: number;
	contentFingerprint: string;
	items: Array<{ id: string; kind: FeedbackKind }>;
	threads: Array<{ id: string; isResolved: boolean }>;
};
export type SweepStatus = {
	phase: SweepPhase;
	guard: SweepRunGuard;
	pullRequestUrl: string;
	originalHead: string;
	publicationHead: string | null;
	feedbackCount: number;
	feedback: Array<{ id: string; kind: FeedbackKind }>;
	ledgerComplete: boolean;
	projection: SweepFinalProjection | null;
	attempts: {
		push: AttemptState;
		resolutions: Array<{ threadId: string; state: AttemptState }>;
		finalize: AttemptState;
	};
};
export type SweepPhase = "triage" | "recorded" | "published" | "refresh-pending" | "refreshed" | "resolving" | "resolved";

type SweepAuthority = ReturnType<typeof authorityFromCurrent>;
type ResolutionAttempt = {
	generation: number;
	threadId: string;
	state: AttemptState;
	beforeFingerprint: string;
	afterFingerprint: string | null;
};
type SweepState = {
	version: 1;
	workflow: "pi-pr-comment-sweep";
	worktree: { id: string; root: string };
	epoch: number;
	runId: string;
	phase: SweepPhase;
	authority: SweepAuthority;
	original: { head: string; lease: string };
	feedback: {
		generation: number;
		fingerprint: string;
		contentFingerprint: string;
		snapshot: FeedbackSnapshot;
	};
	ledger: SweepLedgerEntry[] | null;
	ownedPaths: string[];
	publicationHead: string | null;
	projection: SweepFinalProjection | null;
	attempts: {
		push: { state: AttemptState; head: string | null };
		resolutions: ResolutionAttempt[];
		finalize: { state: AttemptState; checks: SweepCheck[] };
	};
};

type Load = typeof loadCurrentPullRequest;
export type PullRequestCommentSweepOptions = {
	cwd: string;
	authority?: CurrentPullRequest;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: Load;
	newRunId?: () => string;
	pause?: (milliseconds: number) => Promise<void>;
};
export type PrCommentSweepRequest =
	| { action: "start" }
	| { action: "resume" }
	| { action: "show"; guard: SweepRunGuard; id: string }
	| { action: "record"; guard: SweepRunGuard; ledger: SweepLedgerEntry[]; ownedPaths?: string[] }
	| { action: "publish"; guard: SweepRunGuard }
	| { action: "refresh"; guard: SweepRunGuard }
	| { action: "resolve"; guard: SweepRunGuard; threadIds: string[] }
	| { action: "finalize"; guard: SweepRunGuard; projection: SweepFinalProjection; checks: SweepCheck[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} has unsupported fields`);
	}
}

function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

function attemptState(value: unknown, label: string): AttemptState {
	if (typeof value !== "string" || !ATTEMPT_STATES.has(value as AttemptState)) throw new Error(`${label} is invalid`);
	return value as AttemptState;
}

function sha256(value: string, label: string): string {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 fingerprint`);
	return value;
}

function safeRunId(value: unknown): string {
	const id = requiredText(value, "sweep run ID");
	if (!/^[a-zA-Z0-9-]{16,128}$/.test(id)) throw new Error("sweep run ID is invalid");
	return id;
}

function authorityFromCurrent(pullRequest: CurrentPullRequest) {
	if (pullRequest.lifecycle !== "open" || pullRequest.target.provenance !== "configured") {
		throw new Error("Comment sweep requires a configured open pull request");
	}
	const feedback = feedbackAuthorityFromCurrent(pullRequest);
	const remoteOid = requiredOid(pullRequest.target.remoteOid, "remote lease OID");
	return {
		...feedback,
		headFetchSource: requiredText(pullRequest.headFetchSource, "head fetch source"),
		target: {
			branch: requiredText(pullRequest.target.branch, "target branch"),
			remote: requiredText(pullRequest.target.remote, "target remote"),
			ref: requiredText(pullRequest.target.ref, "target ref"),
			repository: requiredText(pullRequest.target.repository, "target repository"),
			host: requiredText(pullRequest.target.host, "target host").toLowerCase(),
			fetchSource: requiredText(pullRequest.target.fetchSource, "target fetch source"),
			remoteOid,
		},
	};
}

function parseAuthority(value: unknown): SweepAuthority {
	if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.head) || !isRecord(value.target)) {
		throw new Error("sweep authority is invalid");
	}
	exactKeys(value, ["id", "number", "url", "host", "base", "head", "headFetchSource", "target"], "sweep authority");
	exactKeys(value.target, ["branch", "remote", "ref", "repository", "host", "fetchSource", "remoteOid"], "sweep target authority");
	const snapshot = parseFeedbackSnapshot({ pullRequest: {
		id: value.id,
		number: value.number,
		url: value.url,
		host: value.host,
		base: value.base,
		head: value.head,
	}, conversationComments: [], reviews: [], reviewThreads: [] });
	return {
		...snapshot.pullRequest,
		headFetchSource: requiredText(value.headFetchSource, "head fetch source"),
		target: {
			branch: requiredText(value.target.branch, "target branch"),
			remote: requiredText(value.target.remote, "target remote"),
			ref: requiredText(value.target.ref, "target ref"),
			repository: requiredText(value.target.repository, "target repository"),
			host: requiredText(value.target.host, "target host").toLowerCase(),
			fetchSource: requiredText(value.target.fetchSource, "target fetch source"),
			remoteOid: requiredOid(value.target.remoteOid, "remote lease OID"),
		},
	};
}

function sameLinkage(expected: SweepAuthority, current: SweepAuthority, remoteHead: string): boolean {
	return expected.id === current.id && expected.number === current.number && expected.url === current.url &&
		expected.host === current.host && expected.base.repository === current.base.repository &&
		expected.base.ref === current.base.ref && expected.base.oid === current.base.oid &&
		expected.head.repository === current.head.repository && expected.head.ref === current.head.ref &&
		expected.headFetchSource === current.headFetchSource && expected.target.branch === current.target.branch &&
		expected.target.remote === current.target.remote && expected.target.ref === current.target.ref &&
		expected.target.repository === current.target.repository && expected.target.host === current.target.host &&
		expected.target.fetchSource === current.target.fetchSource && current.head.oid === remoteHead &&
		current.target.remoteOid === remoteHead;
}

function feedbackMatchesAuthority(snapshot: FeedbackSnapshot, authority: SweepAuthority, head: string): boolean {
	const current = snapshot.pullRequest;
	return current.id === authority.id && current.number === authority.number && current.url === authority.url &&
		current.host === authority.host && current.base.repository === authority.base.repository &&
		current.base.ref === authority.base.ref && current.base.oid === authority.base.oid &&
		current.head.repository === authority.head.repository && current.head.ref === authority.head.ref &&
		current.head.oid === head;
}

function parseOwnedPaths(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) throw new Error("ownedPaths must be an array of paths");
	const encoded = value.length ? `${value.join("\0")}\0` : "";
	return parseNulPaths(encoded, "Sweep owned paths");
}

function parseLedgerEntry(value: unknown, label: string): SweepLedgerEntry {
	if (!isRecord(value)) throw new Error(`${label} is invalid`);
	exactKeys(value, ["id", "kind", "disposition", "note"], label);
	const id = requiredText(value.id, `${label} ID`);
	if (!["conversation_comment", "review", "thread", "thread_comment"].includes(String(value.kind))) {
		throw new Error(`${label} kind is invalid`);
	}
	if (!DISPOSITIONS.includes(value.disposition as SweepDisposition)) throw new Error(`${label} disposition is invalid`);
	if (typeof value.note !== "string" || value.note.includes("\0") || Buffer.byteLength(value.note, "utf8") > LEDGER_NOTE_MAX_BYTES) {
		throw new Error(`${label} note exceeds ${LEDGER_NOTE_MAX_BYTES} bytes or contains NUL`);
	}
	return { id, kind: value.kind as FeedbackKind, disposition: value.disposition as SweepDisposition, note: value.note };
}

function exactLedger(value: unknown, snapshot: FeedbackSnapshot): SweepLedgerEntry[] {
	if (!Array.isArray(value) || value.length > FEEDBACK_MAX_RECORDS) throw new Error("sweep ledger is invalid");
	const parsed = value.map((entry, index) => parseLedgerEntry(entry, `sweep ledger entry ${index + 1}`));
	const supplied = new Map<string, SweepLedgerEntry>();
	for (const entry of parsed) {
		if (supplied.has(entry.id)) throw new Error(`sweep ledger covers feedback more than once: ${entry.id}`);
		supplied.set(entry.id, entry);
	}
	const expected = feedbackEntries(snapshot);
	if (supplied.size !== expected.length) throw new Error("sweep ledger must cover every feedback item exactly once");
	return expected.map((entry) => {
		const record = supplied.get(entry.id);
		if (!record || record.kind !== entry.kind) throw new Error(`sweep ledger does not exactly cover ${entry.kind}:${entry.id}`);
		return record;
	});
}

function parseCheck(value: unknown, label: string): SweepCheck {
	if (!isRecord(value)) throw new Error(`${label} is invalid`);
	exactKeys(value, ["command", "args"], label);
	const command = requiredText(value.command, `${label} command`);
	if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
		throw new Error(`${label} args are invalid`);
	}
	return { command, args: [...value.args] as string[] };
}

function parseChecks(value: unknown): SweepCheck[] {
	if (!Array.isArray(value) || value.length > CHECK_MAX_COUNT) throw new Error(`checks must contain at most ${CHECK_MAX_COUNT} commands`);
	const checks = value.map((check, index) => parseCheck(check, `check ${index + 1}`));
	if (Buffer.byteLength(JSON.stringify(checks), "utf8") > CHECK_ARGUMENTS_MAX_BYTES) {
		throw new Error(`check arguments exceed ${CHECK_ARGUMENTS_MAX_BYTES} bytes`);
	}
	return checks;
}

function buildProjection(generation: number, snapshot: FeedbackSnapshot, ledger: SweepLedgerEntry[]): SweepFinalProjection {
	const dispositions = new Map(ledger.map((entry) => [entry.id, entry]));
	return {
		generation,
		contentFingerprint: feedbackContentFingerprint(snapshot),
		items: feedbackEntries(snapshot).map(({ id, kind }) => ({ id, kind })).sort((left, right) =>
			left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)),
		threads: snapshot.reviewThreads.map((thread) => ({
			id: thread.id,
			isResolved: thread.isResolved || dispositions.get(thread.id)?.disposition === "addressed",
		})).sort((left, right) => left.id.localeCompare(right.id)),
	};
}

function parseProjection(value: unknown): SweepFinalProjection {
	if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.threads)) throw new Error("final projection is invalid");
	exactKeys(value, ["generation", "contentFingerprint", "items", "threads"], "final projection");
	const items = value.items.map((item, index) => {
		if (!isRecord(item)) throw new Error(`final projection item ${index + 1} is invalid`);
		exactKeys(item, ["id", "kind"], `final projection item ${index + 1}`);
		if (!["conversation_comment", "review", "thread", "thread_comment"].includes(String(item.kind))) {
			throw new Error(`final projection item ${index + 1} kind is invalid`);
		}
		return { id: requiredText(item.id, `final projection item ${index + 1} ID`), kind: item.kind as FeedbackKind };
	});
	const threads = value.threads.map((thread, index) => {
		if (!isRecord(thread) || typeof thread.isResolved !== "boolean") throw new Error(`final projection thread ${index + 1} is invalid`);
		exactKeys(thread, ["id", "isResolved"], `final projection thread ${index + 1}`);
		return { id: requiredText(thread.id, `final projection thread ${index + 1} ID`), isResolved: thread.isResolved };
	});
	if (new Set(items.map(({ id }) => id)).size !== items.length || new Set(threads.map(({ id }) => id)).size !== threads.length) {
		throw new Error("final projection contains duplicate IDs");
	}
	return {
		generation: integer(value.generation, "final projection generation"),
		contentFingerprint: sha256(requiredText(value.contentFingerprint, "final projection content fingerprint"), "final projection content fingerprint"),
		items,
		threads,
	};
}

function sameProjection(left: SweepFinalProjection, right: SweepFinalProjection): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function projectionMatches(snapshot: FeedbackSnapshot, projection: SweepFinalProjection): boolean {
	if (feedbackContentFingerprint(snapshot) !== projection.contentFingerprint) return false;
	const items = feedbackEntries(snapshot).map(({ id, kind }) => ({ id, kind })).sort((left, right) =>
		left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
	const threads = snapshot.reviewThreads.map(({ id, isResolved }) => ({ id, isResolved })).sort((left, right) => left.id.localeCompare(right.id));
	return JSON.stringify(items) === JSON.stringify(projection.items) && JSON.stringify(threads) === JSON.stringify(projection.threads);
}

function resolutionAttempt(value: unknown, index: number): ResolutionAttempt {
	if (!isRecord(value)) throw new Error(`resolution attempt ${index + 1} is invalid`);
	exactKeys(value, ["generation", "threadId", "state", "beforeFingerprint", "afterFingerprint"], `resolution attempt ${index + 1}`);
	return {
		generation: integer(value.generation, `resolution attempt ${index + 1} generation`),
		threadId: requiredText(value.threadId, `resolution attempt ${index + 1} thread ID`),
		state: attemptState(value.state, `resolution attempt ${index + 1} state`),
		beforeFingerprint: sha256(requiredText(value.beforeFingerprint, `resolution attempt ${index + 1} before fingerprint`), `resolution attempt ${index + 1} before fingerprint`),
		afterFingerprint: value.afterFingerprint === null
			? null
			: sha256(requiredText(value.afterFingerprint, `resolution attempt ${index + 1} after fingerprint`), `resolution attempt ${index + 1} after fingerprint`),
	};
}

function parseState(value: unknown, expectedRoot: string, expectedId: string): SweepState {
	if (!isRecord(value) || !isRecord(value.worktree) || !isRecord(value.original) || !isRecord(value.feedback) ||
		!isRecord(value.attempts) || !isRecord(value.attempts.push) || !isRecord(value.attempts.finalize)) {
		throw new Error("sweep recovery state is invalid");
	}
	exactKeys(value, [
		"version", "workflow", "worktree", "epoch", "runId", "phase", "authority", "original", "feedback",
		"ledger", "ownedPaths", "publicationHead", "projection", "attempts",
	], "sweep recovery state");
	if (value.version !== STATE_VERSION || value.workflow !== "pi-pr-comment-sweep") throw new Error("unsupported sweep recovery state version");
	if (!(["triage", "recorded", "published", "refresh-pending", "refreshed", "resolving", "resolved"] as unknown[]).includes(value.phase)) {
		throw new Error("sweep recovery phase is invalid");
	}
	exactKeys(value.worktree, ["id", "root"], "sweep worktree");
	const root = requiredText(value.worktree.root, "sweep worktree root");
	const id = requiredText(value.worktree.id, "sweep worktree ID");
	if (root !== expectedRoot || id !== expectedId) throw new Error("sweep recovery state belongs to another worktree");
	const authority = parseAuthority(value.authority);
	exactKeys(value.original, ["head", "lease"], "sweep original authority");
	const original = {
		head: requiredOid(value.original.head, "original head"),
		lease: requiredOid(value.original.lease, "original lease"),
	};
	if (original.head !== authority.head.oid || original.lease !== authority.target.remoteOid || original.head !== original.lease) {
		throw new Error("sweep original authority is inconsistent");
	}
	exactKeys(value.feedback, ["generation", "fingerprint", "contentFingerprint", "snapshot"], "sweep feedback");
	const snapshot = parseFeedbackSnapshot(value.feedback.snapshot);
	const feedback = {
		generation: integer(value.feedback.generation, "feedback generation"),
		fingerprint: sha256(requiredText(value.feedback.fingerprint, "feedback fingerprint"), "feedback fingerprint"),
		contentFingerprint: sha256(requiredText(value.feedback.contentFingerprint, "feedback content fingerprint"), "feedback content fingerprint"),
		snapshot,
	};
	if (feedback.fingerprint !== feedbackFingerprint(snapshot) || feedback.contentFingerprint !== feedbackContentFingerprint(snapshot)) {
		throw new Error("sweep feedback fingerprints do not match the complete snapshot");
	}
	const ledger = value.ledger === null ? null : exactLedger(value.ledger, snapshot);
	const ownedPaths = parseOwnedPaths(value.ownedPaths);
	const publicationHead = value.publicationHead === null ? null : requiredOid(value.publicationHead, "publication head");
	const projection = value.projection === null ? null : parseProjection(value.projection);
	if (projection && (projection.generation !== feedback.generation || projection.contentFingerprint !== feedback.contentFingerprint)) {
		throw new Error("final projection is not bound to the current feedback generation");
	}
	exactKeys(value.attempts, ["push", "resolutions", "finalize"], "sweep attempts");
	exactKeys(value.attempts.push, ["state", "head"], "push attempt");
	const push = {
		state: attemptState(value.attempts.push.state, "push attempt state"),
		head: value.attempts.push.head === null ? null : requiredOid(value.attempts.push.head, "push attempt head"),
	};
	if (!Array.isArray(value.attempts.resolutions) || value.attempts.resolutions.length > FEEDBACK_MAX_RECORDS) {
		throw new Error("resolution attempts are invalid");
	}
	const resolutions = value.attempts.resolutions.map(resolutionAttempt);
	if (new Set(resolutions.map(({ generation, threadId }) => `${generation}\0${threadId}`)).size !== resolutions.length) {
		throw new Error("resolution attempts contain duplicate thread IDs");
	}
	exactKeys(value.attempts.finalize, ["state", "checks"], "finalize attempt");
	const finalize = {
		state: attemptState(value.attempts.finalize.state, "finalize attempt state"),
		checks: parseChecks(value.attempts.finalize.checks),
	};
	const state: SweepState = {
		version: 1,
		workflow: "pi-pr-comment-sweep",
		worktree: { id, root },
		epoch: integer(value.epoch, "sweep epoch"),
		runId: safeRunId(value.runId),
		phase: value.phase as SweepPhase,
		authority,
		original,
		feedback,
		ledger,
		ownedPaths,
		publicationHead,
		projection,
		attempts: { push, resolutions, finalize },
	};
	const isPublished = ["published", "refresh-pending", "refreshed", "resolving", "resolved"].includes(state.phase);
	const hasFreshSnapshot = ["refresh-pending", "refreshed", "resolving", "resolved"].includes(state.phase);
	const hasFinalProjection = ["refreshed", "resolving", "resolved"].includes(state.phase);
	const feedbackHead = hasFreshSnapshot ? publicationHead : original.head;
	if (!feedbackHead || !feedbackMatchesAuthority(snapshot, authority, feedbackHead)) {
		throw new Error("feedback snapshot authority is inconsistent");
	}
	if (["triage", "refresh-pending"].includes(state.phase) !== (ledger === null)) {
		throw new Error("sweep phase and ledger coverage are inconsistent");
	}
	if (isPublished !== (push.state === "applied")) throw new Error("sweep phase and push attempt are inconsistent");
	if (push.state === "none") {
		if (push.head !== null || publicationHead !== null) throw new Error("empty push attempt has publication data");
	} else if (push.head === null || publicationHead !== push.head) {
		throw new Error("push attempt head does not match publication head");
	}
	if (hasFinalProjection !== (projection !== null)) throw new Error("sweep phase and final projection are inconsistent");
	if (projection && (!ledger || !sameProjection(projection, buildProjection(feedback.generation, snapshot, ledger)))) {
		throw new Error("final projection does not match feedback and ledger coverage");
	}
	return state;
}

function guardFor(state: SweepState): SweepRunGuard {
	return {
		epoch: state.epoch,
		runId: state.runId,
		generation: state.feedback.generation,
		fingerprint: state.feedback.fingerprint,
	};
}

function requireGuard(state: SweepState, guard: SweepRunGuard): void {
	if (!guard || guard.epoch !== state.epoch || guard.runId !== state.runId ||
		guard.generation !== state.feedback.generation || guard.fingerprint !== state.feedback.fingerprint) {
		throw new Error("stale comment sweep run, generation, or feedback fingerprint");
	}
}

function status(state: SweepState): SweepStatus {
	const feedback = feedbackEntries(state.feedback.snapshot).map(({ id, kind }) => ({ id, kind }));
	return {
		phase: state.phase,
		guard: guardFor(state),
		pullRequestUrl: state.authority.url,
		originalHead: state.original.head,
		publicationHead: state.publicationHead,
		feedbackCount: feedback.length,
		feedback,
		ledgerComplete: state.ledger !== null,
		projection: state.projection ? structuredClone(state.projection) : null,
		attempts: {
			push: state.attempts.push.state,
			resolutions: state.attempts.resolutions.map(({ threadId, state }) => ({ threadId, state })),
			finalize: state.attempts.finalize.state,
		},
	};
}

function oneLine(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
	if (lines.length !== 1 || !lines[0]) throw new Error(`${label} returned invalid output`);
	return lines[0];
}

function onlyResolutionChanged(before: FeedbackSnapshot, after: FeedbackSnapshot, threadId: string): boolean {
	if (feedbackContentFingerprint(before) !== feedbackContentFingerprint(after)) return false;
	const beforeStates = before.reviewThreads.map(({ id, isResolved }) => ({ id, isResolved })).sort((left, right) => left.id.localeCompare(right.id));
	const afterStates = after.reviewThreads.map(({ id, isResolved }) => ({ id, isResolved })).sort((left, right) => left.id.localeCompare(right.id));
	if (beforeStates.length !== afterStates.length) return false;
	let changed = 0;
	for (let index = 0; index < beforeStates.length; index += 1) {
		const left = beforeStates[index]!;
		const right = afterStates[index]!;
		if (left.id !== right.id) return false;
		if (left.isResolved !== right.isResolved) {
			if (left.id !== threadId || left.isResolved || !right.isResolved) return false;
			changed += 1;
		}
	}
	return changed === 1;
}

export class PullRequestCommentSweep {
	private readonly cwd: string;
	private readonly suppliedAuthority?: SweepAuthority;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;
	private readonly newRunId: () => string;
	private readonly pause?: (milliseconds: number) => Promise<void>;

	constructor(options: PullRequestCommentSweepOptions) {
		this.cwd = requiredText(options.cwd, "cwd");
		this.suppliedAuthority = options.authority ? authorityFromCurrent(options.authority) : undefined;
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
		this.newRunId = options.newRunId ?? randomUUID;
		this.pause = options.pause;
	}

	private options(extra: Partial<ExecOptions> = {}): ExecOptions {
		return { cwd: this.cwd, signal: this.signal, ...extra };
	}

	private pi(): Pick<ExtensionAPI, "exec"> {
		return {
			exec: (command, args, options) => this.exec(command, args, {
				cwd: options?.cwd ?? this.cwd,
				signal: options?.signal ?? this.signal,
				timeoutMs: options?.timeout,
			}),
		} as Pick<ExtensionAPI, "exec">;
	}

	private context(): PullRequestLoadContext {
		return { cwd: this.cwd, signal: this.signal ?? new AbortController().signal };
	}

	private async location(): Promise<{ root: string; id: string; path: string }> {
		const top = oneLine((await runChecked(this.exec, "git", ["rev-parse", "--show-toplevel"], this.options())).stdout, "Git worktree root");
		const root = await realpath(top);
		const id = createHash("sha256").update(root).digest("hex");
		return { root, id, path: join(extensionConfigDir("pi-pr", this.agentDir), "sweep", id, STATE_FILE) };
	}

	async recoveryPath(): Promise<string> {
		return (await this.location()).path;
	}

	private async loadState(location: Awaited<ReturnType<PullRequestCommentSweep["location"]>>): Promise<SweepState> {
		const raw = await readTextFileBounded(location.path, SWEEP_RECOVERY_MAX_BYTES, { signal: this.signal });
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error(`Malformed comment sweep recovery is preserved at ${location.path}`);
		}
		try {
			return parseState(value, location.root, location.id);
		} catch (error) {
			throw new Error(`Invalid comment sweep recovery is preserved at ${location.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async loadIfPresent(location: Awaited<ReturnType<PullRequestCommentSweep["location"]>>): Promise<SweepState | undefined> {
		try {
			return await this.loadState(location);
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async save(location: Awaited<ReturnType<PullRequestCommentSweep["location"]>>, state: SweepState): Promise<void> {
		const checked = parseState(state, location.root, location.id);
		const contents = `${JSON.stringify(checked)}\n`;
		if (Buffer.byteLength(contents, "utf8") > SWEEP_RECOVERY_MAX_BYTES) {
			throw new Error(`Comment sweep recovery exceeds ${SWEEP_RECOVERY_MAX_BYTES} bytes`);
		}
		await writePrivateTextFileAtomically(location.path, contents, { signal: this.signal });
	}

	private async currentAuthority(expected: SweepAuthority, remoteHead: string): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current") throw new Error("Comment sweep cancelled: current pull request authority is unavailable");
		const current = authorityFromCurrent(discovery.pullRequest);
		if (!sameLinkage(expected, current, remoteHead)) throw new Error("Comment sweep cancelled: canonical pull request authority changed");
		const remote = await readRemoteOid(this.exec, this.options(), expected.target.fetchSource, expected.target.ref);
		if (remote !== remoteHead) throw new Error("Comment sweep cancelled: remote lease changed");
		return discovery.pullRequest;
	}

	private async requireNoGitOperation(): Promise<void> {
		const paths = await runChecked(this.exec, "git", [
			"rev-parse", ...GIT_OPERATION_STATES.flatMap((state) => ["--git-path", state]),
		], this.options());
		const normalized = paths.stdout.replace(/\r\n/g, "\n");
		const values = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
		if (values.length !== GIT_OPERATION_STATES.length || values.some((path) => !path)) {
			throw new Error("Git operation state path resolution returned invalid output");
		}
		for (const [index, path] of values.entries()) {
			try {
				await lstat(resolve(this.cwd, path));
				throw new Error(`${GIT_OPERATION_STATES[index]} is in progress`);
			} catch (error) {
				if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
		}
	}

	private async localPaths(): Promise<string[]> {
		await this.requireNoGitOperation();
		const output = await runChecked(this.exec, "git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.options());
		return [...parseStatusSnapshot(output.stdout).keys()];
	}

	private async requireOwnedLocalState(state: SweepState, expectedHead?: string): Promise<string> {
		const head = await readHead(this.exec, this.options());
		if (expectedHead !== undefined && head !== expectedHead) throw new Error("Comment sweep cancelled: local HEAD changed");
		const dirty = await this.localPaths();
		const owned = new Set(state.ownedPaths);
		const outside = dirty.filter((path) => !owned.has(path));
		if (outside.length) throw new Error(`Comment sweep found changes outside owned paths: ${outside.join(", ")}`);
		if (!(await isAncestor(this.exec, this.options(), state.original.head, head))) {
			throw new Error("Comment sweep local HEAD no longer descends from the original head");
		}
		if (head !== state.original.head) {
			const changed = parseNulPaths((await runChecked(this.exec, "git", [
				"diff", "--name-only", "--no-renames", "-z", `${state.original.head}..${head}`,
			], this.options())).stdout, "Sweep committed paths");
			const committedOutside = changed.filter((path) => !owned.has(path));
			if (committedOutside.length) throw new Error(`Comment sweep commit changed outside owned paths: ${committedOutside.join(", ")}`);
		}
		return head;
	}

	private async requireCleanPublication(state: SweepState, expectedHead: string): Promise<void> {
		if ((await this.localPaths()).length) throw new Error("Comment sweep requires a clean worktree");
		await this.requireOwnedLocalState(state, expectedHead);
	}

	private async collect(authority: SweepAuthority, head: string): Promise<FeedbackSnapshot> {
		const snapshot = await collectPullRequestFeedback({
			id: authority.id,
			number: authority.number,
			url: authority.url,
			host: authority.host,
			base: authority.base,
			head: { ...authority.head, oid: head },
		}, { exec: this.exec, cwd: this.cwd, signal: this.signal, pause: this.pause });
		if (!feedbackMatchesAuthority(snapshot, authority, head)) throw new Error("Complete feedback snapshot authority changed");
		return snapshot;
	}

	private setFeedback(state: SweepState, snapshot: FeedbackSnapshot, generation = state.feedback.generation): void {
		state.feedback = {
			generation,
			fingerprint: feedbackFingerprint(snapshot),
			contentFingerprint: feedbackContentFingerprint(snapshot),
			snapshot,
		};
	}

	async start(): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			if (await this.loadIfPresent(location)) throw new Error("A recoverable comment sweep already exists; use resume");
			if (!this.suppliedAuthority) throw new Error("Comment sweep start requires route authority");
			const authority = this.suppliedAuthority;
			if (authority.head.oid !== authority.target.remoteOid) throw new Error("Comment sweep requires PR head and remote lease to match");
			if ((await this.localPaths()).length || await readHead(this.exec, this.options()) !== authority.head.oid) {
				throw new Error("Comment sweep start requires a clean worktree at the PR head");
			}
			await this.currentAuthority(authority, authority.head.oid);
			const snapshot = await this.collect(authority, authority.head.oid);
			await this.currentAuthority(authority, authority.head.oid);
			if ((await this.localPaths()).length || await readHead(this.exec, this.options()) !== authority.head.oid) {
				throw new Error("Comment sweep authority changed during feedback fetch");
			}
			const state: SweepState = {
				version: 1,
				workflow: "pi-pr-comment-sweep",
				worktree: { id: location.id, root: location.root },
				epoch: 1,
				runId: safeRunId(this.newRunId()),
				phase: "triage",
				authority,
				original: { head: authority.head.oid, lease: authority.target.remoteOid },
				feedback: {
					generation: 1,
					fingerprint: feedbackFingerprint(snapshot),
					contentFingerprint: feedbackContentFingerprint(snapshot),
					snapshot,
				},
				ledger: null,
				ownedPaths: [],
				publicationHead: null,
				projection: null,
				attempts: {
					push: { state: "none", head: null },
					resolutions: [],
					finalize: { state: "none", checks: [] },
				},
			};
			await this.save(location, state);
			return status(state);
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async reconcile(state: SweepState): Promise<void> {
		let remote = await readRemoteOid(this.exec, this.options(), state.authority.target.fetchSource, state.authority.target.ref);
		if (remote === null) throw new Error("Comment sweep remote ref disappeared");
		if (state.attempts.push.state === "attempting" || state.attempts.push.state === "unknown") {
			const attemptedHead = state.attempts.push.head;
			if (!attemptedHead) throw new Error("Attempted push has no captured head");
			await this.currentAuthority(state.authority, remote);
			if (remote === attemptedHead) {
				state.attempts.push.state = "applied";
				state.phase = "published";
			} else if (remote === state.original.lease) {
				state.attempts.push.state = "blocked";
			} else {
				throw new Error("Attempted push cannot be reconciled to its original lease or captured head");
			}
		}
		const expectedRemote = state.attempts.push.state === "applied" && state.publicationHead
			? state.publicationHead
			: state.original.lease;
		remote = await readRemoteOid(this.exec, this.options(), state.authority.target.fetchSource, state.authority.target.ref);
		if (remote !== expectedRemote) throw new Error("Comment sweep remote authority cannot be reconciled");
		await this.currentAuthority(state.authority, expectedRemote);

		const pending = state.attempts.resolutions.filter(({ state: attempt }) => attempt === "attempting" || attempt === "unknown");
		if (pending.length > 1) throw new Error("Multiple unresolved mutation attempts cannot be reconciled");
		if (pending.length === 1) {
			const attempt = pending[0]!;
			if (!state.publicationHead || attempt.generation !== state.feedback.generation || attempt.beforeFingerprint !== state.feedback.fingerprint) {
				throw new Error("Resolution attempt is not bound to the current feedback generation");
			}
			const current = await this.collect(state.authority, state.publicationHead);
			const thread = current.reviewThreads.find(({ id }) => id === attempt.threadId);
			if (!thread || feedbackContentFingerprint(current) !== state.feedback.contentFingerprint) {
				throw new Error("Resolution attempt feedback generation changed during recovery");
			}
			if (thread.isResolved && onlyResolutionChanged(state.feedback.snapshot, current, attempt.threadId)) {
				attempt.state = "applied";
				attempt.afterFingerprint = feedbackFingerprint(current);
				this.setFeedback(state, current);
			} else if (!thread.isResolved && feedbackFingerprint(current) === state.feedback.fingerprint) {
				attempt.state = "blocked";
			} else {
				throw new Error("Resolution attempt outcome is not exactly reconcilable");
			}
		}
		if (state.attempts.finalize.state === "attempting") state.attempts.finalize.state = "unknown";
		if (state.projection && projectionMatches(state.feedback.snapshot, state.projection)) state.phase = "resolved";
	}

	async resume(): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			if (!this.suppliedAuthority) throw new Error("Comment sweep resume requires route authority");
			const suppliedAuthority = this.suppliedAuthority;
			const location = await this.location();
			const state = await this.loadState(location);
			const permittedHeads = new Set<string>();
			if (state.attempts.push.state !== "applied") permittedHeads.add(state.original.lease);
			if (
				(state.attempts.push.state === "attempting" || state.attempts.push.state === "unknown" || state.attempts.push.state === "applied") &&
				state.publicationHead
			) permittedHeads.add(state.publicationHead);
			if (![...permittedHeads].some((head) => sameLinkage(state.authority, suppliedAuthority, head))) {
				throw new Error("Comment sweep recovery does not match supplied route authority");
			}
			await this.reconcile(state);
			state.attempts.resolutions = state.attempts.resolutions.filter(({ state: attempt }) => attempt !== "blocked");
			if (state.attempts.push.state === "blocked") {
				state.attempts.push = { state: "none", head: null };
				state.publicationHead = null;
			}
			if (state.attempts.finalize.state === "blocked") state.attempts.finalize = { state: "none", checks: [] };
			const published = state.attempts.push.state === "applied";
			const expectedRemote = published ? state.publicationHead! : state.original.lease;
			await this.currentAuthority(state.authority, expectedRemote);
			await this.requireOwnedLocalState(state, published ? expectedRemote : undefined);
			state.epoch += 1;
			state.runId = safeRunId(this.newRunId());
			await this.save(location, state);
			return status(state);
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async show(guard: SweepRunGuard, id: string): Promise<FeedbackItem> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			return structuredClone(showFeedbackItem(state.feedback.snapshot, id));
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async record(guard: SweepRunGuard, ledgerInput: SweepLedgerEntry[], ownedPathsInput?: string[]): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			if (state.phase === "triage" && state.ledger === null) {
				if (ownedPathsInput === undefined) throw new Error("Initial comment sweep ledger requires ownedPaths");
				state.ledger = exactLedger(ledgerInput, state.feedback.snapshot);
				state.ownedPaths = parseOwnedPaths(ownedPathsInput);
				state.phase = "recorded";
			} else if (state.phase === "refresh-pending" && state.ledger === null) {
				if (ownedPathsInput !== undefined) throw new Error("Refreshed comment sweep ledger cannot change ownedPaths");
				state.ledger = exactLedger(ledgerInput, state.feedback.snapshot);
				state.projection = buildProjection(state.feedback.generation, state.feedback.snapshot, state.ledger);
				state.phase = "refreshed";
			} else {
				throw new Error("Comment sweep ledger was already recorded or is not ready");
			}
			await this.save(location, state);
			return status(state);
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async publish(guard: SweepRunGuard): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			if (state.phase !== "recorded" || !state.ledger || state.attempts.push.state !== "none") {
				throw new Error("Comment sweep is not ready to publish");
			}
			const head = await this.requireOwnedLocalState(state);
			if ((await this.localPaths()).length) throw new Error("Comment sweep publish requires a clean worktree");
			await this.currentAuthority(state.authority, state.original.lease);
			if (head === state.original.head) {
				state.publicationHead = head;
				state.attempts.push = { state: "applied", head };
				state.phase = "published";
				await this.save(location, state);
				return status(state);
			}
			if (!(await isAncestor(this.exec, this.options(), state.original.lease, head))) {
				throw new Error("Comment sweep push would not fast-forward the original lease");
			}
			await this.currentAuthority(state.authority, state.original.lease);
			if (await readHead(this.exec, this.options()) !== head || (await this.localPaths()).length) {
				throw new Error("Comment sweep local HEAD or worktree changed before push");
			}
			state.publicationHead = head;
			state.attempts.push = { state: "attempting", head };
			await this.save(location, state);
			try {
				await runChecked(this.exec, "git", [
					"push", "--porcelain", `--force-with-lease=refs/heads/${state.authority.target.ref}:${state.original.lease}`,
					"--recurse-submodules=no", "--", state.authority.target.fetchSource,
					`${head}:refs/heads/${state.authority.target.ref}`,
				], this.options());
				if (await readRemoteOid(this.exec, this.options(), state.authority.target.fetchSource, state.authority.target.ref) !== head) {
					throw new Error("Published remote ref did not match captured HEAD");
				}
				await this.currentAuthority(state.authority, head);
				state.attempts.push.state = "applied";
				state.phase = "published";
				await this.save(location, state);
				return status(state);
			} catch (error) {
				state.attempts.push.state = "unknown";
				await this.save(location, state);
				throw error;
			}
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async refresh(guard: SweepRunGuard): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			if (!["published", "refresh-pending", "refreshed", "resolving", "resolved"].includes(state.phase) || !state.publicationHead || state.attempts.push.state !== "applied") {
				throw new Error("Comment sweep is not ready to refresh");
			}
			if (state.attempts.resolutions.some(({ state: attempt }) => attempt !== "applied")) {
				throw new Error("Comment sweep has an unreconciled thread mutation; use resume");
			}
			if (state.attempts.finalize.state !== "none" && state.attempts.finalize.state !== "applied") {
				throw new Error("Comment sweep has an unreconciled finalization attempt; use resume");
			}
			await this.requireCleanPublication(state, state.publicationHead);
			await this.currentAuthority(state.authority, state.publicationHead);
			const snapshot = await this.collect(state.authority, state.publicationHead);
			await this.currentAuthority(state.authority, state.publicationHead);
			await this.requireCleanPublication(state, state.publicationHead);
			this.setFeedback(state, snapshot, state.feedback.generation + 1);
			state.ledger = null;
			state.projection = null;
			state.attempts.resolutions = [];
			state.attempts.finalize = { state: "none", checks: [] };
			state.phase = "refresh-pending";
			await this.save(location, state);
			return status(state);
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async resolve(guard: SweepRunGuard, threadIdsInput: string[]): Promise<SweepStatus> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			if (!["refreshed", "resolving"].includes(state.phase) || !state.publicationHead || !state.ledger || !state.projection) {
				throw new Error("Comment sweep is not ready to resolve threads");
			}
			if (state.attempts.resolutions.some(({ state: attempt }) => attempt !== "applied")) {
				throw new Error("Comment sweep has an unreconciled thread mutation; use resume");
			}
			if (!Array.isArray(threadIdsInput) || threadIdsInput.length > FEEDBACK_MAX_RECORDS) throw new Error("threadIds must be a bounded array");
			const threadIds = threadIdsInput.map((id, index) => requiredText(id, `thread ID ${index + 1}`));
			if (new Set(threadIds).size !== threadIds.length) throw new Error("threadIds contain duplicates");
			const ledger = new Map(state.ledger.map((entry) => [entry.id, entry]));
			for (const threadId of threadIds) {
				const thread = state.feedback.snapshot.reviewThreads.find(({ id }) => id === threadId);
				if (!thread || thread.isResolved || ledger.get(threadId)?.kind !== "thread" || ledger.get(threadId)?.disposition !== "addressed") {
					throw new Error(`Only addressed unresolved review thread IDs may be resolved: ${threadId}`);
				}
				if (state.attempts.resolutions.some((attempt) => attempt.generation === state.feedback.generation && attempt.threadId === threadId)) {
					throw new Error(`Review thread mutation was already attempted: ${threadId}`);
				}
			}
			for (const threadId of threadIds) {
				await this.requireCleanPublication(state, state.publicationHead);
				await this.currentAuthority(state.authority, state.publicationHead);
				const before = await this.collect(state.authority, state.publicationHead);
				if (feedbackFingerprint(before) !== state.feedback.fingerprint || feedbackContentFingerprint(before) !== state.feedback.contentFingerprint) {
					throw new Error("Complete feedback generation or fingerprint changed before thread resolution");
				}
				await this.currentAuthority(state.authority, state.publicationHead);
				await this.requireCleanPublication(state, state.publicationHead);
				const thread = before.reviewThreads.find(({ id }) => id === threadId);
				if (!thread || thread.isResolved) throw new Error(`Review thread is no longer unresolved: ${threadId}`);
				const attempt: ResolutionAttempt = {
					generation: state.feedback.generation,
					threadId,
					state: "attempting",
					beforeFingerprint: state.feedback.fingerprint,
					afterFingerprint: null,
				};
				state.attempts.resolutions.push(attempt);
				state.phase = "resolving";
				await this.save(location, state);
				let after: FeedbackSnapshot;
				try {
					await resolvePullRequestThread(state.feedback.snapshot.pullRequest, threadId, {
						exec: this.exec, cwd: this.cwd, signal: this.signal, pause: this.pause,
					});
					after = await this.collect(state.authority, state.publicationHead);
					await this.currentAuthority(state.authority, state.publicationHead);
					await this.requireCleanPublication(state, state.publicationHead);
					if (!onlyResolutionChanged(before, after, threadId)) {
						throw new Error(`Thread resolution did not produce the exact verified transition: ${threadId}`);
					}
				} catch (error) {
					attempt.state = "unknown";
					await this.save(location, state);
					throw error;
				}
				attempt.state = "applied";
				attempt.afterFingerprint = feedbackFingerprint(after);
				this.setFeedback(state, after);
				await this.save(location, state);
			}
			if (projectionMatches(state.feedback.snapshot, state.projection)) state.phase = "resolved";
			await this.save(location, state);
			return status(state);
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	private async freshProjection(state: SweepState): Promise<void> {
		if (!state.publicationHead || !state.projection) throw new Error("Final projection is unavailable");
		await this.requireCleanPublication(state, state.publicationHead);
		await this.currentAuthority(state.authority, state.publicationHead);
		const snapshot = await this.collect(state.authority, state.publicationHead);
		await this.currentAuthority(state.authority, state.publicationHead);
		await this.requireCleanPublication(state, state.publicationHead);
		if (!projectionMatches(snapshot, state.projection)) throw new Error("Fresh complete feedback does not match the declared final projection");
		this.setFeedback(state, snapshot);
		state.phase = "resolved";
	}

	async finalize(
		guard: SweepRunGuard,
		projectionInput: SweepFinalProjection,
		checksInput: SweepCheck[],
	): Promise<{ kind: "finalized"; pullRequestUrl: string; head: string; checks: number }> {
		return await withWorktreeLock(this.cwd, async () => {
			const location = await this.location();
			const state = await this.loadState(location);
			requireGuard(state, guard);
			if (!["refreshed", "resolving", "resolved"].includes(state.phase) || !state.projection || !state.publicationHead) {
				throw new Error("Comment sweep is not ready to finalize");
			}
			const projection = parseProjection(projectionInput);
			if (!sameProjection(projection, state.projection)) throw new Error("Final projection does not match the declared refreshed projection");
			const checks = parseChecks(checksInput);
			if (state.attempts.resolutions.some(({ state: attempt }) => attempt !== "applied")) {
				throw new Error("Comment sweep has unresolved or unknown mutation attempts");
			}
			if (state.attempts.finalize.state !== "none" && state.attempts.finalize.state !== "applied") {
				throw new Error("Comment sweep has an unreconciled finalization attempt; use resume");
			}
			await this.freshProjection(state);
			const alreadyChecked = state.attempts.finalize.state === "applied" &&
				JSON.stringify(state.attempts.finalize.checks) === JSON.stringify(checks);
			if (!alreadyChecked) {
				state.attempts.finalize = { state: "attempting", checks };
				await this.save(location, state);
				for (const check of checks) {
					let result;
					try {
						result = await this.exec(check.command, check.args, this.options());
					} catch (error) {
						state.attempts.finalize.state = "unknown";
						await this.save(location, state);
						throw error;
					}
					if (result.killed) {
						state.attempts.finalize.state = "unknown";
						await this.save(location, state);
						throw new Error(`Finalization check was killed: ${check.command}`);
					}
					if (result.code !== 0) {
						state.attempts.finalize.state = "blocked";
						await this.save(location, state);
						const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
						throw new Error(`${check.command} failed: ${detail}`);
					}
				}
				state.attempts.finalize.state = "applied";
				await this.save(location, state);
			}
			await this.freshProjection(state);
			await this.save(location, state);
			await rm(location.path);
			return { kind: "finalized", pullRequestUrl: state.authority.url, head: state.publicationHead, checks: checks.length };
		}, { agentDir: this.agentDir, signal: this.signal });
	}

	async action(request: PrCommentSweepRequest): Promise<SweepStatus | FeedbackItem | { kind: "finalized"; pullRequestUrl: string; head: string; checks: number }> {
		switch (request.action) {
			case "start": return await this.start();
			case "resume": return await this.resume();
			case "show": return await this.show(request.guard, request.id);
			case "record": return await this.record(request.guard, request.ledger, request.ownedPaths);
			case "publish": return await this.publish(request.guard);
			case "refresh": return await this.refresh(request.guard);
			case "resolve": return await this.resolve(request.guard, request.threadIds);
			case "finalize": return await this.finalize(request.guard, request.projection, request.checks);
		}
	}
}
