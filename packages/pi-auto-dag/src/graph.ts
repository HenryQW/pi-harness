import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	GRAPH_VERSION,
	IMPLEMENTATION_PROFILES,
	ISSUE_ROLES,
	type DeliveryGraph,
	type ImplementationProfile,
	type LocalIssue,
} from "./model.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, stringArray } from "./validate.ts";

const ID = /^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$/;

export function parseDeliveryGraph(value: unknown): DeliveryGraph {
	const input = object(value, "Delivery Graph");
	exactKeys(input, ["version", "status", "id", "title", "goal", "constraints", "issues"], "Delivery Graph");
	if (input.version !== GRAPH_VERSION) throw new Error(`Unsupported Delivery Graph version: ${String(input.version)}`);
	const status = oneOf(input.status, ["draft", "approved"] as const, "Delivery Graph status");
	const graph: DeliveryGraph = {
		version: GRAPH_VERSION,
		status,
		id: parseId(input.id, "Delivery Graph id"),
		title: nonEmptyString(input.title, "Delivery Graph title"),
		goal: nonEmptyString(input.goal, "Delivery Graph goal"),
		constraints: stringArray(input.constraints, "Delivery Graph constraints"),
		issues: array(input.issues, "Delivery Graph issues").map((issue, index) => parseIssue(issue, index)),
	};
	validateGraph(graph);
	return {
		...graph,
		constraints: [...graph.constraints],
		issues: graph.issues
			.map((issue) => ({ ...issue, acceptance: [...issue.acceptance], blocked_by: [...issue.blocked_by].sort() }))
			.sort((left, right) => left.id.localeCompare(right.id)),
	};
}

/** There is intentionally no graph-path option: the integration worktree is the sole authority. */
export async function readDeliveryGraph(mainWorktree: string): Promise<DeliveryGraph> {
	const path = join(mainWorktree, ".context", "issues", "graph.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error(`Delivery Graph is missing from the main integration worktree: ${path}`);
	}
	try {
		return parseDeliveryGraph(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Delivery Graph is not valid JSON: ${error.message}`);
		throw error;
	}
}

export function hashDeliveryGraph(graph: DeliveryGraph): string {
	return createHash("sha256").update(JSON.stringify(graph)).digest("hex");
}

/** Dependency waves are derived from `blocked_by`; their lexical order is deterministic. */
export function deriveDependencyWaves(graph: DeliveryGraph): string[][] {
	const pending = new Map(graph.issues.map((issue) => [issue.id, new Set(issue.blocked_by)]));
	const completed = new Set<string>();
	const waves: string[][] = [];
	while (completed.size < pending.size) {
		const wave = [...pending]
			.filter(([id, blockedBy]) => !completed.has(id) && [...blockedBy].every((id) => completed.has(id)))
			.map(([id]) => id)
			.sort();
		if (!wave.length) throw new Error("Delivery Graph contains a dependency cycle");
		waves.push(wave);
		for (const id of wave) completed.add(id);
	}
	return waves;
}

function parseIssue(value: unknown, index: number): LocalIssue {
	const label = `Delivery Graph issues[${index}]`;
	const input = object(value, label);
	exactKeys(input, ["id", "title", "role", "profile", "purpose", "acceptance", "testing", "blocked_by"], label);
	const role = oneOf(input.role, ISSUE_ROLES, `${label}.role`);
	const profile = parseProfile(input.profile, role, label);
	const testing = nonEmptyString(input.testing, `${label}.testing`);
	return {
		id: parseId(input.id, `${label}.id`),
		title: nonEmptyString(input.title, `${label}.title`),
		role,
		profile,
		purpose: nonEmptyString(input.purpose, `${label}.purpose`),
		acceptance: stringArray(input.acceptance, `${label}.acceptance`),
		testing,
		blocked_by: stringArray(input.blocked_by, `${label}.blocked_by`),
	};
}

function parseProfile(value: unknown, role: LocalIssue["role"], label: string): ImplementationProfile | null {
	if (role === "final_check") {
		if (value !== null) throw new Error(`${label}.profile must be null for final_check`);
		return null;
	}
	if (typeof value !== "string" || !IMPLEMENTATION_PROFILES.includes(value as ImplementationProfile)) {
		throw new Error(`${label}.profile must be coder, backend, or frontend; graph paths are not allowed`);
	}
	return value as ImplementationProfile;
}

function parseId(value: unknown, label: string): string {
	const id = nonEmptyString(value, label);
	if (!ID.test(id)) throw new Error(`${label} must be a path-safe lowercase-hyphen ID`);
	return id;
}

function validateGraph(graph: DeliveryGraph): void {
	if (!graph.issues.length) throw new Error("Delivery Graph must contain Local Issues");
	const byId = new Map<string, LocalIssue>();
	for (const issue of graph.issues) {
		if (byId.has(issue.id)) throw new Error(`Duplicate Local Issue ID: ${issue.id}`);
		byId.set(issue.id, issue);
	}

	for (const issue of graph.issues) {
		const dependencies = new Set<string>();
		for (const dependency of issue.blocked_by) {
			if (dependency === issue.id) throw new Error(`Local Issue ${issue.id} cannot block itself`);
			if (!byId.has(dependency)) throw new Error(`Local Issue ${issue.id} has unknown dependency: ${dependency}`);
			if (dependencies.has(dependency)) throw new Error(`Local Issue ${issue.id} repeats dependency: ${dependency}`);
			dependencies.add(dependency);
		}
	}

	const finalChecks = graph.issues.filter((issue) => issue.role === "final_check");
	if (finalChecks.length !== 1) throw new Error("Delivery Graph must contain exactly one final_check Local Issue");
	const finalCheck = finalChecks[0];
	const implementations = graph.issues.filter((issue) => issue.role === "implementation");
	if (!implementations.length) throw new Error("Delivery Graph must contain an implementation Local Issue");
	const expectedDependencies = implementations.map((issue) => issue.id).sort();
	if (JSON.stringify([...finalCheck.blocked_by].sort()) !== JSON.stringify(expectedDependencies)) {
		throw new Error("final_check must be blocked by every implementation Local Issue");
	}
	if (graph.issues.some((issue) => issue.blocked_by.includes(finalCheck.id))) {
		throw new Error("No Local Issue may depend on final_check");
	}

	deriveDependencyWaves(graph);
}
