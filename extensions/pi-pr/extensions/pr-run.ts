import { isDeepStrictEqual } from "node:util";
import { createConfigStore, field, parsers } from "@henryqw/pi-config-store";

export type PrCheck = { command: string; args: string[] };
export type MergeMethod = "squash" | "merge" | "rebase";
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];
export type PrPolicy = { maxPublicationCycles: number; maxRepairAttempts: number; ciPollSeconds: number; ciWaitMinutes: number; checkTimeoutMinutes: number; mergeMethod: MergeMethod; codexReview: boolean };
export const DEFAULT_PR_POLICY: PrPolicy = { maxPublicationCycles: 3, maxRepairAttempts: 3, ciPollSeconds: 30, ciWaitMinutes: 10, checkTimeoutMinutes: 10, mergeMethod: "squash", codexReview: false };
/** Node replaces a timer delay above 2^31-1 ms with 1 ms, which would turn a long poll into a tight loop. */
const MAX_CI_POLL_SECONDS = 2_147_483;
const MAX_CHECK_TIMEOUT_MINUTES = 35_791;

/** An unknown key or invalid value is an issue, and that key uses its default; no key disables `/pr`. */
export function createPrPolicyStore(agentDir?: string) {
	const defaults = DEFAULT_PR_POLICY;
	return createConfigStore({
		extensionId: "pi-pr",
		agentDir,
		fields: {
			maxPublicationCycles: field(parsers.integer({ min: 1 }), defaults.maxPublicationCycles),
			maxRepairAttempts: field(parsers.integer({ min: 1 }), defaults.maxRepairAttempts),
			ciPollSeconds: field(parsers.integer({ min: 1, max: MAX_CI_POLL_SECONDS }), defaults.ciPollSeconds),
			// `0` disables waiting for running CI.
			ciWaitMinutes: field(parsers.integer({ min: 0 }), defaults.ciWaitMinutes),
			checkTimeoutMinutes: field(parsers.integer({ min: 1, max: MAX_CHECK_TIMEOUT_MINUTES }), defaults.checkTimeoutMinutes),
			mergeMethod: field(parsers.oneOf(MERGE_METHODS), defaults.mergeMethod),
			codexReview: field(parsers.boolean(), defaults.codexReview),
		},
	});
}

/** Time limit for each caller-supplied validation check; Git and gh helpers keep their shorter limits. */
export function checkTimeoutMs(run?: PrRun): number {
	return (run?.policy ?? DEFAULT_PR_POLICY).checkTimeoutMinutes * 60_000;
}

/** One explicit /pr invocation; helper resumes never replenish these limits. */
export class PrRun {
	private readonly completed = new Map<string, Set<string | null>>();
	private readonly checks = new Map<string, PrCheck[]>();
	private readonly executed = new Map<string, PrCheck[][]>();
	private lastRemote: string | null | undefined;
	private publications = 0;
	private repairs = 0;
	private ciWaitedMs = 0;

	readonly policy: PrPolicy;

	constructor(policy: Partial<PrPolicy> = {}) {
		this.policy = { ...DEFAULT_PR_POLICY, ...policy };
	}

	/** Reserve one CI poll interval from the invocation's wait budget; null once the budget is spent. */
	consumeCiWait(): number | null {
		const remaining = this.policy.ciWaitMinutes * 60_000 - this.ciWaitedMs;
		if (remaining <= 0) return null;
		const interval = Math.min(this.policy.ciPollSeconds * 1_000, remaining);
		this.ciWaitedMs += interval;
		return interval;
	}

	observeRemote(head: string | null): void {
		if (this.lastRemote !== undefined && this.lastRemote !== head) this.publications += 1;
		this.lastRemote = head;
	}

	beforePush(original: string | null, head: string): void {
		this.observeRemote(original);
		if (original !== head && this.publications >= this.policy.maxPublicationCycles) throw new Error(`Publication budget stop: limit ${this.policy.maxPublicationCycles} reached; run /pr again`);
	}

	complete(route: string, entryHead: string | null): void {
		const heads = this.completed.get(route) ?? new Set<string | null>();
		heads.add(entryHead);
		this.completed.set(route, heads);
	}

	hasCompleted(route: string, head: string | null): boolean {
		return this.completed.get(route)?.has(head) ?? false;
	}

	requireFreshChecks(route: string, head: string, checks: PrCheck[]): void {
		if (this.repairs >= this.policy.maxRepairAttempts) throw new Error(`Repair budget stop: limit ${this.policy.maxRepairAttempts} reached; run /pr again`);
		const frozen = this.checks.get(route);
		if (frozen && !isDeepStrictEqual(frozen, checks)) throw new Error("Validation checks are frozen for this /pr; failing checks cannot be dropped");
		if (this.hasExecuted(head, checks)) throw new Error("No progress: checks already executed on this HEAD in this /pr; repair the code or run /pr again");
	}

	beginChecks(route: string, head: string, checks: PrCheck[]): void {
		this.requireFreshChecks(route, head, checks);
		this.checks.set(route, structuredClone(checks));
		const sets = this.executed.get(head) ?? [];
		sets.push(structuredClone(checks));
		this.executed.set(head, sets);
	}

	hasExecuted(head: string, checks: PrCheck[]): boolean {
		return this.executed.get(head)?.some((set) => isDeepStrictEqual(set, checks)) ?? false;
	}

	checksFailed(): void { this.repairs += 1; }
}
