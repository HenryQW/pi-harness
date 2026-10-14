// Comment-sweep route tool for evals. The real `pi_pr_sweep` needs GitHub and a reserved /pr route.
// Replies come from the case's scripted spec in `.git/pi-eval-sweep.json`, keyed like stub queues
// (`<action>:<id>` before `<action>`; the last reply repeats). Where later judgment depends on earlier calls,
// the tool follows pr-comment-sweep.ts instead of the script:
// - After `record`, each status carries the recorded plan, with `ledgerComplete` and `approved` true.
// - `validate` saves its checks on the current HEAD; later statuses with a validation carry them.
// - `commit` stages the changed owned paths, creates a real commit in the fixture, and returns its HEAD.
//   It fails like the real action without a plan, with pending scope, outside paths, or no changes.
// - `{{head}}` in a reply becomes the current HEAD.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const specFile = join(".git", "pi-eval-sweep.json");
export const ACTIONS = ["start", "resume", "show", "record", "adopt", "commit", "validate", "publish", "refresh", "resolve", "finalize"];

/** Scripted replies by queue key. A string is returned as is, `{ error }` is a tool error, and other values are JSON. */
export type SweepSpec = Record<string, unknown[]>;

type Plan = { ledger: unknown[]; ownedPaths: string[] };
type Status = { phase: string; guard: unknown; plan: Plan | null; pendingScope: unknown; validation: unknown };

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
	let validation: { head: string; checks: unknown[] } | undefined;
	let current: Status | undefined;
	pi.registerTool({
		name: "pi_pr_sweep",
		label: "Sweep PR Feedback",
		description: "Run one guarded action for the /pr feedback route.",
		parameters: PARAMETERS as never,
		executionMode: "sequential",
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as { action: string; id?: string; ledger?: unknown[]; ownedPaths?: string[]; message?: string; checks?: unknown[] };
			const git = (...args: string[]) => execFileSync("git", args, { cwd: ctx.cwd, encoding: "utf8" }).trim();
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
			if (params.action === "commit") {
				if (!current?.plan) throw new Error("Comment sweep is not ready to commit");
				if (current.pendingScope) throw new Error("Review and adopt pending scope before committing");
				const owned = current.plan.ownedPaths;
				const paths = [...new Set([...lines(git("diff", "--name-only", "HEAD")), ...lines(git("ls-files", "--others", "--exclude-standard"))])];
				if (paths.some((path) => !owned.includes(path))) throw new Error("Comment sweep found changes outside owned paths before staging");
				if (!paths.length) throw new Error("Comment sweep has no pending changes to commit; validate and publish the existing HEAD");
				git("add", "-A", "--", ...paths);
				git("commit", "-q", "-m", params.message ?? "");
				return text(JSON.stringify({ head: git("rev-parse", "HEAD") }));
			}
			const spec: SweepSpec = JSON.parse(readFileSync(join(ctx.cwd, specFile), "utf8"));
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
					...(validation && reply.validation !== null && { validation }),
				};
			}
			return text(typeof reply === "string" ? reply : JSON.stringify(reply).replaceAll("{{head}}", head));
		},
	});
}
