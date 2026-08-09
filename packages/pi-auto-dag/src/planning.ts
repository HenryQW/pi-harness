import { access, readFile } from "node:fs/promises";
import { Type } from "typebox";
import { defineTool, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./command.ts";
import { assertProfileDirectories, expandProfilePath, loadProjectConfig } from "./config.ts";
import { deliveryGraphPath, deriveDependencyWaves, hashDeliveryGraph, readDeliveryGraph, writeDeliveryGraph } from "./graph.ts";
import type { DeliveryGraph } from "./model.ts";
import { approvedGraphHash, clearPlanningReviewPass, planningReviewPath, requirePlanningReviewPass } from "./planning-review.ts";
import { readActiveRunId } from "./state.ts";

export const PLANNING_TOOLS = {
	validate: "auto_dag_validate",
	approve: "auto_dag_approve",
} as const;

export function registerPlanning(pi: ExtensionAPI): void {
	pi.registerCommand("plan-delivery", {
		description: "Plan and approve a local Delivery Graph without starting execution",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/plan-delivery requires interactive TUI mode.", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for current agent turn before planning delivery.", "warning");
				return;
			}
			if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
				ctx.ui.notify("/plan-delivery requires current Pi session inside Herdr.", "error");
				return;
			}
			const activeRun = await readActiveRunId(ctx.cwd);
			if (activeRun) {
				ctx.ui.notify(`Cannot plan while Auto DAG run is active: ${activeRun}`, "error");
				return;
			}
			let reviewerProfile: string;
			try {
				const config = await loadProjectConfig();
				await assertProfileDirectories(config);
				reviewerProfile = expandProfilePath(config.profiles.reviewer);
			} catch (error) {
				ctx.ui.notify(`Planning profiles unavailable: ${errorMessage(error)}`, "error");
				return;
			}
			const existing = await inspectExistingGraph(ctx.cwd);
			const mode = await planningMode(existing, ctx);
			if (!mode) return;
			const instructions = await readFile(new URL("../prompts/plan-delivery.md", import.meta.url), "utf8");
			pi.sendUserMessage([
				instructions.trim(),
				"",
				`Planning mode: ${mode}`,
				`Repository root: ${ctx.cwd}`,
				`Delivery Graph: ${deliveryGraphPath(ctx.cwd)}`,
				`Reviewer profile: ${reviewerProfile}`,
				args.trim() ? `Additional user context: ${args.trim()}` : "Additional user context: none",
			].join("\n"));
		},
	});

	pi.registerTool(defineTool({
		name: PLANNING_TOOLS.validate,
		label: "Validate Delivery Graph",
		description: "Deterministically validate authoritative Delivery Graph structure, profiles, references, cycles, commands, and derived waves. Does not approve or execute.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return graphResult(await readDeliveryGraph(ctx.cwd));
		},
	}));

	pi.registerTool(defineTool({
		name: PLANNING_TOOLS.approve,
		label: "Approve Delivery Graph",
		description: "Require matching reviewer PASS, interactively approve current draft by exact SHA-256, and atomically persist approval. Never starts Auto DAG.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("Delivery Graph approval requires interactive TUI mode");
			return withFileMutationQueue(deliveryGraphPath(ctx.cwd), () => withFileMutationQueue(planningReviewPath(ctx.cwd), async () => {
				const activeRun = await readActiveRunId(ctx.cwd);
				if (activeRun) throw new Error(`Cannot approve while Auto DAG run is active: ${activeRun}`);
				const draft = await readDeliveryGraph(ctx.cwd);
				if (draft.status !== "draft") throw new Error("Delivery Graph must have draft status before approval");
				await requirePlanningReviewPass(ctx.cwd, draft);
				const candidate = { ...draft, status: "approved" as const };
				const hash = approvedGraphHash(draft);
				const waves = deriveDependencyWaves(candidate);
				const approved = await ctx.ui.confirm("Approve Delivery Graph?", [
					`ID: ${candidate.id}`,
					`SHA-256: ${hash}`,
					`Waves: ${formatWaves(waves)} -> final-check`,
					"Approval will not start Auto DAG.",
				].join("\n"));
				if (!approved) return textResult("Delivery Graph approval cancelled.", { approved: false });
				const activeAfterConfirmation = await readActiveRunId(ctx.cwd);
				if (activeAfterConfirmation) throw new Error(`Cannot approve while Auto DAG run is active: ${activeAfterConfirmation}`);
				const current = await readDeliveryGraph(ctx.cwd);
				if (current.status !== "draft" || hashDeliveryGraph(current) !== hashDeliveryGraph(draft)) {
					throw new Error("Delivery Graph changed during approval; validate and review current draft again");
				}
				await requirePlanningReviewPass(ctx.cwd, current);
				await clearPlanningReviewPass(ctx.cwd);
				const finalCurrent = await readDeliveryGraph(ctx.cwd);
				if (finalCurrent.status !== "draft" || hashDeliveryGraph(finalCurrent) !== hashDeliveryGraph(draft)) {
					throw new Error("Delivery Graph changed during approval; validate and review current draft again");
				}
				await writeDeliveryGraph(ctx.cwd, candidate);
				const persisted = await readDeliveryGraph(ctx.cwd);
				if (persisted.status !== "approved" || hashDeliveryGraph(persisted) !== hash) {
					throw new Error("Persisted Delivery Graph does not match approved candidate");
				}
				return graphResult(persisted);
			}));
		},
	}));
}

type ExistingGraph = { graph?: DeliveryGraph; error?: string };

async function inspectExistingGraph(root: string): Promise<ExistingGraph | undefined> {
	try {
		await access(deliveryGraphPath(root));
	} catch {
		return undefined;
	}
	try {
		return { graph: await readDeliveryGraph(root) };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

async function planningMode(existing: ExistingGraph | undefined, ctx: ExtensionCommandContext): Promise<"new" | "resume" | "replace" | undefined> {
	if (!existing) return "new";
	if (existing.graph?.status === "draft") {
		const choice = await ctx.ui.select("Draft Delivery Graph exists", ["Resume", "Replace", "Cancel"]);
		return choice === "Resume" ? "resume" : choice === "Replace" ? "replace" : undefined;
	}
	const title = existing.error ? `Invalid Delivery Graph exists: ${existing.error}` : "Approved Delivery Graph exists";
	const choice = await ctx.ui.select(title, ["Replace", "Cancel"]);
	return choice === "Replace" ? "replace" : undefined;
}

function graphResult(graph: DeliveryGraph) {
	const hash = hashDeliveryGraph(graph);
	const waves = deriveDependencyWaves(graph);
	return textResult(
		`Delivery Graph ${graph.id} is valid (${graph.status}); SHA-256 ${hash}; waves ${formatWaves(waves)} -> final-check.`,
		{ graph, hash, waves },
	);
}

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatWaves(waves: string[][]): string {
	return waves.map((wave) => `[${wave.join(", ")}]`).join(" -> ");
}
