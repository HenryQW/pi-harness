import { isDeepStrictEqual } from "node:util";
import { createConfigStore } from "@henryqw/pi-config-store";
import { isRecord } from "./pr-execution.ts";

export type PrCheck = { command: string; args: string[] };
export type MergeMethod = "squash" | "merge" | "rebase";
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];
export type PrPolicy = { maxPublicationCycles: number; maxRepairAttempts: number; ciPollSeconds: number; ciWaitMinutes: number; mergeMethod: MergeMethod };
export const DEFAULT_PR_POLICY: PrPolicy = { maxPublicationCycles: 3, maxRepairAttempts: 3, ciPollSeconds: 30, ciWaitMinutes: 10, mergeMethod: "squash" };
type NumericPolicyKey = Exclude<keyof PrPolicy, "mergeMethod">;
const NUMERIC_KEYS: readonly NumericPolicyKey[] = ["maxPublicationCycles", "maxRepairAttempts", "ciPollSeconds", "ciWaitMinutes"];
/** `ciWaitMinutes: 0` disables waiting for running CI; every other limit must be positive. */
const ZERO_ALLOWED: ReadonlySet<NumericPolicyKey> = new Set(["ciWaitMinutes"]);
/** Node replaces a timer delay above 2^31-1 ms with 1 ms, which would turn a long poll into a tight loop. */
const MAX_CI_POLL_SECONDS = 2_147_483;

export function loadPrPolicy(agentDir?: string): PrPolicy {
	const config = createConfigStore({
		extensionId: "pi-pr", agentDir, defaults: () => ({ ...DEFAULT_PR_POLICY }),
		parse(value: unknown): PrPolicy {
			if (!isRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_PR_POLICY, key))) throw new Error(`Expected only ${Object.keys(DEFAULT_PR_POLICY).join(", ")}`);
			const policy = { ...DEFAULT_PR_POLICY };
			if (value.mergeMethod !== undefined) {
				if (!MERGE_METHODS.includes(value.mergeMethod as MergeMethod)) throw new Error(`mergeMethod must be one of ${MERGE_METHODS.join(", ")}`);
				policy.mergeMethod = value.mergeMethod as MergeMethod;
			}
			for (const key of NUMERIC_KEYS) {
				if (value[key] !== undefined) {
					const minimum = ZERO_ALLOWED.has(key) ? 0 : 1;
					if (!Number.isSafeInteger(value[key]) || (value[key] as number) < minimum) throw new Error(`${key} must be an integer of at least ${minimum}`);
					if (key === "ciPollSeconds" && (value[key] as number) > MAX_CI_POLL_SECONDS) throw new Error(`ciPollSeconds must be at most ${MAX_CI_POLL_SECONDS}`);
					policy[key] = value[key] as number;
				}
			}
			return policy;
		},
	});
	try { return config.loadSync().value; }
	catch (error) { throw new Error(`PR configuration is preserved at ${config.path}: ${error instanceof Error ? error.message : String(error)}`); }
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
