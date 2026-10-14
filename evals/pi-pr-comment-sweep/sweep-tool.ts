// Comment-sweep route tool for evals. The real `pi_pr_sweep` needs GitHub and a reserved /pr route.
// Replies come from the case's scripted spec, which setup writes outside the fixture repository (see specPath),
// keyed like stub queues (`<action>:<id>` before `<action>`; the last reply repeats). Where later judgment depends
// on earlier calls, the tool follows pr-comment-sweep.ts instead of the script:
// - A `runId` other than ROUTE_RUN_ID fails, and every action except `start` and `resume` needs the guard of the
//   last status reply, with the real messages of pr.ts and requireGuard.
// - The last status reply is the route state. Out-of-order `record`, `commit`, `validate`, and `publish`
//   calls fail with the real messages.
// - After `record`, each status carries the recorded plan, with `ledgerComplete` and `approved` true.
// - `validate` requires a clean worktree and saves its checks on the current HEAD; `commit` clears them.
// - `commit` stages the changed owned paths, creates a real commit in the fixture, and returns its HEAD.
// - `publish` of a changed HEAD requires a clean worktree and validation on that HEAD.
// - `{{head}}` in a reply becomes the current HEAD.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The spec lives in the trial directory, the parent of the fixture cwd, so tools in cwd cannot find it. */
export const specPath = (cwd: string) => join(dirname(cwd), "pi-eval-sweep.json");
/** The route run ID that /pr reserves for every case. */
export const ROUTE_RUN_ID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
export const ACTIONS = ["start", "resume", "show", "record", "adopt", "commit", "validate", "publish", "refresh", "resolve", "finalize"];

/** Scripted replies by queue key. A string is returned as is, `{ error }` is a tool error, and other values are JSON. */
export type SweepSpec = Record<string, unknown[]>;

type Plan = { ledger: unknown[]; ownedPaths: string[] };
type Validation = { head: string; checks: unknown[] };
type Status = {
	phase: string;
	guard: unknown;
	originalHead: string;
	plan: Plan | null;
	pendingScope: unknown;
	validation: Validation | null;
	attempts: { push: string };
};

// Flat object root equivalent to flatRoot(SweepActions) in extensions/pi-pr/extensions/pr.ts.
const OID = { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" };
const PATHS = { type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, maxItems: 128 };
const CHECKS = {
	type: "array",
	maxItems: 32,
	items: {
		type: "object",
		additionalProperties: false,
		required: ["command", "args"],
		properties: { command: { type: "string", minLength: 1, maxLength: 1024 }, args: { type: "array", items: { type: "string", maxLength: 4096 }, maxItems: 256 } },
	},
};
const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["runId", "action"],
	properties: {
		runId: { type: "string", minLength: 36, maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
		action: { type: "string", enum: ACTIONS },
		guard: {
			type: "object",
			additionalProperties: false,
			required: ["epoch", "runId", "generation", "fingerprint"],
			properties: {
				epoch: { type: "integer", minimum: 1 },
				runId: { type: "string", minLength: 1, maxLength: 128 },
				generation: { type: "integer", minimum: 1 },
				fingerprint: { type: "string", minLength: 64, maxLength: 64 },
			},
		},
		id: { type: "string", minLength: 1, maxLength: 1024 },
		ledger: {
			type: "array",
			maxItems: 1000,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "kind", "disposition", "note"],
				properties: {
					id: { type: "string", minLength: 1, maxLength: 1024 },
					kind: { type: "string", enum: ["conversation_comment", "review", "thread", "thread_comment"] },
					disposition: { type: "string", enum: ["addressed", "non-actionable", "blocked"] },
					note: { type: "string", maxLength: 2048 },
					commit: OID,
				},
			},
		},
		ownedPaths: PATHS,
		message: { type: "string", minLength: 1, maxLength: 256 },
		head: OID,
		outsidePaths: PATHS,
		checks: CHECKS,
	},
};

const isStatus = (value: unknown): value is Status => !!value && typeof value === "object" && "phase" in value && "guard" in value;
const lines = (text: string) => (text ? text.split("\n") : []);

export default function (pi: ExtensionAPI) {
	const cursors = new Map<string, number>();
	let recorded: Plan | undefined;
	// Undefined until the model validates or commits; then it replaces the scripted validation.
	let validation: Validation | null | undefined;
	let current: Status | undefined;
	pi.registerTool({
		name: "pi_pr_sweep",
		label: "Sweep PR Feedback",
		description: "Run one guarded action for the /pr feedback route.",
		parameters: PARAMETERS as never,
		executionMode: "sequential",
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as { runId: string; action: string; guard?: unknown; id?: string; ledger?: unknown[]; ownedPaths?: string[]; message?: string; checks?: unknown[] };
			const git = (...args: string[]) => execFileSync("git", args, { cwd: ctx.cwd, encoding: "utf8" }).trim();
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
			const dirty = () => git("status", "--porcelain", "--untracked-files=all") !== "";
			const guarded = !["start", "resume"].includes(params.action);
			// The real union schema rejects a guarded action without a guard before the run ID check.
			if (guarded && params.guard === undefined) throw new Error("Tool arguments do not match one action: must not have additional properties");
			if (params.runId !== ROUTE_RUN_ID) throw new Error("PR workflow runId is wrong or stale");
			if (guarded && !isDeepStrictEqual(params.guard, current?.guard)) {
				throw new Error("stale comment sweep run, generation, or feedback fingerprint");
			}
			const unpublished = current?.phase === "recorded" && !!current.plan && current.attempts.push === "none";
			if (params.action === "record" && !(current && ["triage", "refresh-pending"].includes(current.phase) && !current.plan)) {
				throw new Error("Comment sweep ledger was already recorded or is not ready");
			}
			if (params.action === "validate") {
				if (!unpublished) throw new Error("Scope repair requires recorded unpublished recovery with no unresolved mutation");
				if (current!.pendingScope) throw new Error("Review and adopt pending scope before validation");
				if (dirty()) throw new Error("Comment sweep requires a clean worktree");
			}
			if (params.action === "publish") {
				if (!unpublished) throw new Error("Comment sweep is not ready to publish");
				if (current!.pendingScope) throw new Error("Review and adopt pending scope before publication");
				if (dirty()) throw new Error("Comment sweep publish requires a clean worktree; use the commit action for owned fixes first");
				const head = git("rev-parse", "HEAD");
				const validated = validation === undefined ? current!.validation : validation;
				if (head !== current!.originalHead && validated?.head !== head) {
					throw new Error("Comment sweep requires validation on the exact clean HEAD before publication");
				}
			}
			if (params.action === "commit") {
				if (!unpublished) throw new Error("Comment sweep is not ready to commit");
				if (current!.pendingScope) throw new Error("Review and adopt pending scope before committing");
				const owned = current!.plan!.ownedPaths;
				const paths = [...new Set([...lines(git("diff", "--name-only", "HEAD")), ...lines(git("ls-files", "--others", "--exclude-standard"))])];
				if (paths.some((path) => !owned.includes(path))) throw new Error("Comment sweep found changes outside owned paths before staging");
				if (!paths.length) throw new Error("Comment sweep has no pending changes to commit; validate and publish the existing HEAD");
				validation = null;
				current!.validation = null;
				git("add", "-A", "--", ...paths);
				git("commit", "-q", "-m", params.message ?? "");
				return text(JSON.stringify({ head: git("rev-parse", "HEAD") }));
			}
			const spec: SweepSpec = JSON.parse(readFileSync(specPath(ctx.cwd), "utf8"));
			const byId = params.id === undefined ? undefined : `${params.action}:${params.id}`;
			const key = byId !== undefined && spec[byId] ? byId : params.action;
			const queue = spec[key];
			if (!queue?.length) throw new Error(`stub pi_pr_sweep: no scripted response for ${key}`);
			const index = cursors.get(key) ?? 0;
			cursors.set(key, index + 1);
			let reply = queue[Math.min(index, queue.length - 1)];
			if (reply && typeof reply === "object" && "error" in reply) throw new Error(String(reply.error));
			const head = git("rev-parse", "HEAD");
			if (isStatus(reply)) {
				if (params.action === "record") recorded = { ledger: params.ledger ?? [], ownedPaths: params.ownedPaths ?? [] };
				if (params.action === "validate") validation = { head, checks: params.checks ?? [] };
				reply = current = {
					...reply,
					...(recorded && { ledgerComplete: true, plan: recorded, approved: true }),
					...(validation !== undefined && { validation }),
				};
			}
			return text(typeof reply === "string" ? reply : JSON.stringify(reply).replaceAll("{{head}}", head));
		},
	});
}
