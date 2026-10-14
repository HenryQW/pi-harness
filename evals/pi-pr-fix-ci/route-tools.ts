// Fix-CI route tools for evals. The full pi-pr extension needs GitHub and a reserved /pr route.
// `pi_git_commit` wraps pi-pr's real GitCommitter, so repair commits land in the fixture.
// `pi_pr_fix_ci` is a stub: `collect` returns the case's scripted result from `.git/pi-eval-collect.json`,
// and `publish` returns the real result shape for the local HEAD, without a push.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitCommitter } from "../../extensions/pi-pr/extensions/git-commit.ts";

export const collectFile = join(".git", "pi-eval-collect.json");
/** The reserved /pr run ID. The real route rejects any other ID. */
export const ROUTE_RUN_ID = "3f2b8c1e-7a4d-4e6f-9b2a-5c8d1e0f7a93";

type CommitParams = { action: "inspect"; target: string } | { action: "commit"; inspectionId: string; ownedPaths: string[]; message: string };

const uuid = { type: "string", minLength: 36, maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const literals = (...values: string[]) => ({ anyOf: values.map((value) => ({ const: value, type: "string" })) });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

export default function (pi: ExtensionAPI) {
	let committer: GitCommitter | undefined;
	// Parameters match pr.ts `flatRoot(CommitActions)` and `flatRoot(FixCiActions)`.
	pi.registerTool({
		name: "pi_git_commit",
		label: "Commit Scoped Work",
		description: "Inspect a local target and pending work, then commit reviewed paths. Never pushes. Read git-commit guidance first.",
		parameters: {
			type: "object",
			properties: {
				action: literals("inspect", "commit"),
				target: { type: "string", minLength: 1, maxLength: 1_024 },
				inspectionId: uuid,
				ownedPaths: { type: "array", items: { type: "string", minLength: 1, maxLength: 4_096 }, maxItems: 128 },
				message: { type: "string", minLength: 1, maxLength: 16_384 },
			},
			required: ["action"],
			additionalProperties: false,
		} as never,
		executionMode: "sequential",
		async execute(_id, raw, signal, _onUpdate, ctx) {
			const params = raw as CommitParams;
			committer ??= new GitCommitter({ cwd: ctx.cwd });
			return result(params.action === "inspect"
				? await committer.inspect(params.target, signal)
				: await committer.commit(params.inspectionId, params.ownedPaths, params.message, signal));
		},
	});
	pi.registerTool({
		name: "pi_pr_fix_ci",
		label: "Fix PR CI",
		description: "Run one guarded action for the /pr failed-CI route.",
		parameters: {
			type: "object",
			properties: { runId: uuid, action: literals("collect", "publish") },
			required: ["runId", "action"],
			additionalProperties: false,
		} as never,
		executionMode: "sequential",
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const { runId, action } = raw as { runId: string; action: "collect" | "publish" };
			if (runId !== ROUTE_RUN_ID) throw new Error("PR workflow runId is wrong or stale");
			return result(action === "collect"
				? JSON.parse(readFileSync(join(ctx.cwd, collectFile), "utf8"))
				: { kind: "published", head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, encoding: "utf8" }).trim(), attempt: "applied" });
		},
	});
}
