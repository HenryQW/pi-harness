import { isDeepStrictEqual } from "node:util";
import { createConfigStore } from "@henryqw/pi-config-store";
import { isRecord } from "./pr-execution.ts";

export type PrCheck = { command: string; args: string[] };
export type PrPolicy = { maxPublicationCycles: number; maxRepairAttempts: number };
export const DEFAULT_PR_POLICY: PrPolicy = { maxPublicationCycles: 3, maxRepairAttempts: 3 };

export function loadPrPolicy(agentDir?: string): PrPolicy {
	const config = createConfigStore({
		extensionId: "pi-pr", agentDir, defaults: () => ({ ...DEFAULT_PR_POLICY }),
		parse(value: unknown): PrPolicy {
			if (!isRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_PR_POLICY, key))) throw new Error("Expected only maxPublicationCycles and maxRepairAttempts");
			const policy = { ...DEFAULT_PR_POLICY };
			for (const key of Object.keys(policy) as Array<keyof PrPolicy>) {
				if (value[key] !== undefined) {
					if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) throw new Error(`${key} must be a positive integer`);
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

	private readonly policy: PrPolicy;

	constructor(policy: PrPolicy = DEFAULT_PR_POLICY) {
		this.policy = policy;
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
