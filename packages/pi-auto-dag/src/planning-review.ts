import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashDeliveryGraph, readDeliveryGraph } from "./graph.ts";
import type { DeliveryGraph } from "./model.ts";
import { exactKeys, nonEmptyString, object, oneOf } from "./validate.ts";

export const PLANNING_REVIEW_TOOL = "auto_dag_submit_plan_review";

export interface PlanningReviewPass {
	verdict: "PASS";
	graph_id: string;
	graph_hash: string;
}

export function planningReviewPath(mainWorktree: string): string {
	return join(resolve(mainWorktree), ".context", "issues", "review.json");
}

export function approvedGraphHash(graph: DeliveryGraph): string {
	return hashDeliveryGraph({ ...graph, status: "approved" });
}

export async function writePlanningReviewPass(mainWorktree: string): Promise<PlanningReviewPass> {
	const graph = await readDeliveryGraph(mainWorktree);
	if (graph.status !== "draft") throw new Error("Planning reviewer can only pass a draft Delivery Graph");
	const pass: PlanningReviewPass = {
		verdict: "PASS",
		graph_id: graph.id,
		graph_hash: approvedGraphHash(graph),
	};
	const path = planningReviewPath(mainWorktree);
	await mkdir(join(resolve(mainWorktree), ".context", "issues"), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(pass, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
	return pass;
}

export async function requirePlanningReviewPass(mainWorktree: string, graph: DeliveryGraph): Promise<PlanningReviewPass> {
	let pass: PlanningReviewPass;
	try {
		pass = parsePlanningReviewPass(JSON.parse(await readFile(planningReviewPath(mainWorktree), "utf8")));
	} catch {
		throw new Error("Delivery Graph requires reviewer PASS for current candidate");
	}
	if (pass.graph_id !== graph.id || pass.graph_hash !== approvedGraphHash(graph)) {
		throw new Error("Delivery Graph requires reviewer PASS for current candidate");
	}
	return pass;
}

export async function clearPlanningReviewPass(mainWorktree: string): Promise<void> {
	await unlink(planningReviewPath(mainWorktree));
}

function parsePlanningReviewPass(value: unknown): PlanningReviewPass {
	const input = object(value, "Planning review PASS");
	exactKeys(input, ["verdict", "graph_id", "graph_hash"], "Planning review PASS");
	const graphHash = nonEmptyString(input.graph_hash, "Planning review PASS graph_hash");
	if (!/^[a-f0-9]{64}$/.test(graphHash)) throw new Error("Planning review PASS graph_hash must be SHA-256 hex");
	return {
		verdict: oneOf(input.verdict, ["PASS"] as const, "Planning review verdict"),
		graph_id: nonEmptyString(input.graph_id, "Planning review PASS graph_id"),
		graph_hash: graphHash,
	};
}
