import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	DeliveryFinalCheck,
	DeliveryGraph,
	DeliveryIssue,
	LocalIssue,
} from "./model.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, stringArray } from "./validate.ts";

const ID = /^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$/;
export const FINAL_CHECK_ID = "final-check";

export function deliveryGraphPath(mainWorktree: string): string {
	return join(resolve(mainWorktree), ".context", "issues", "graph.json");
}

export function parseDeliveryGraph(value: unknown): DeliveryGraph {
	const input = object(value, "Delivery Graph");
	exactKeys(input, ["status", "id", "goal", "constraints", "non_goals", "issues", "final_check"], "Delivery Graph");
	const graph: DeliveryGraph = {
		status: oneOf(input.status, ["draft", "approved"] as const, "Delivery Graph status"),
		id: parseId(input.id, "Delivery Graph id"),
		goal: nonEmptyString(input.goal, "Delivery Graph goal"),
		constraints: stringArray(input.constraints, "Delivery Graph constraints"),
		non_goals: stringArray(input.non_goals, "Delivery Graph non_goals"),
		issues: array(input.issues, "Delivery Graph issues").map(parseIssue),
		final_check: parseFinalCheck(input.final_check),
	};
	validateGraph(graph);
	return {
		...graph,
		constraints: [...graph.constraints],
		non_goals: [...graph.non_goals],
		issues: graph.issues
			.map((issue) => ({ ...issue, acceptance: [...issue.acceptance], depends_on: [...issue.depends_on].sort() }))
			.sort((left, right) => left.id.localeCompare(right.id)),
		final_check: { ...graph.final_check, acceptance: [...graph.final_check.acceptance] },
	};
}

/** There is intentionally no graph-path option: integration worktree is sole authority. */
export async function readDeliveryGraph(mainWorktree: string): Promise<DeliveryGraph> {
	const path = deliveryGraphPath(mainWorktree);
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

/** Atomically replace authoritative graph with canonical validated JSON. */
export async function writeDeliveryGraph(mainWorktree: string, value: unknown): Promise<DeliveryGraph> {
	const graph = parseDeliveryGraph(value);
	const path = deliveryGraphPath(mainWorktree);
	await mkdir(join(resolve(mainWorktree), ".context", "issues"), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
	return graph;
}

export function hashDeliveryGraph(graph: DeliveryGraph): string {
	return createHash("sha256").update(JSON.stringify(parseDeliveryGraph(graph))).digest("hex");
}

/** Implementation dependency waves; structural final check always follows all waves. */
export function deriveDependencyWaves(graph: DeliveryGraph): string[][] {
	const pending = new Map(graph.issues.map((issue) => [issue.id, new Set(issue.depends_on)]));
	const completed = new Set<string>();
	const waves: string[][] = [];
	while (completed.size < pending.size) {
		const wave = [...pending]
			.filter(([id, dependencies]) => !completed.has(id) && [...dependencies].every((id) => completed.has(id)))
			.map(([id]) => id)
			.sort();
		if (!wave.length) throw new Error("Delivery Graph contains a dependency cycle");
		waves.push(wave);
		for (const id of wave) completed.add(id);
	}
	return waves;
}

/** Adapt planning contract to existing execution lifecycle without persisted fake issue fields. */
export function executionIssues(graph: DeliveryGraph): LocalIssue[] {
	return [
		...graph.issues.map((issue): LocalIssue => ({
			id: issue.id,
			title: issue.title,
			role: "implementation",
			profile: issue.profile,
			purpose: issue.objective,
			acceptance: [...issue.acceptance],
			testing: issue.testing,
			blocked_by: [...issue.depends_on],
		})),
		{
			id: FINAL_CHECK_ID,
			title: "Final check",
			role: "final_check",
			profile: null,
			purpose: "Verify integrated delivery.",
			acceptance: [...graph.final_check.acceptance],
			testing: graph.final_check.testing,
			blocked_by: graph.issues.map((issue) => issue.id),
		},
	];
}

function parseIssue(value: unknown, index: number): DeliveryIssue {
	const label = `Delivery Graph issues[${index}]`;
	const input = object(value, label);
	exactKeys(input, ["id", "title", "profile", "objective", "acceptance", "testing", "depends_on"], label);
	return {
		id: parseId(input.id, `${label}.id`),
		title: nonEmptyString(input.title, `${label}.title`),
		profile: nonEmptyString(input.profile, `${label}.profile`),
		objective: nonEmptyString(input.objective, `${label}.objective`),
		acceptance: nonEmptyCriteria(input.acceptance, `${label}.acceptance`),
		testing: nonEmptyString(input.testing, `${label}.testing`),
		depends_on: stringArray(input.depends_on, `${label}.depends_on`),
	};
}

function parseFinalCheck(value: unknown): DeliveryFinalCheck {
	const label = "Delivery Graph final_check";
	const input = object(value, label);
	exactKeys(input, ["acceptance", "testing"], label);
	return {
		acceptance: nonEmptyCriteria(input.acceptance, `${label}.acceptance`),
		testing: nonEmptyString(input.testing, `${label}.testing`),
	};
}

function nonEmptyCriteria(value: unknown, label: string): string[] {
	const criteria = stringArray(value, label);
	if (!criteria.length) throw new Error(`${label} must contain at least one criterion`);
	return criteria;
}

function parseId(value: unknown, label: string): string {
	const id = nonEmptyString(value, label);
	if (!ID.test(id)) throw new Error(`${label} must be a path-safe lowercase-hyphen ID`);
	return id;
}

export function assertDeliveryGraphProfiles(graph: DeliveryGraph, implementationProfiles: readonly string[]): void {
	const allowed = new Set(implementationProfiles);
	for (const issue of graph.issues) {
		if (!allowed.has(issue.profile)) {
			throw new Error(`Delivery Graph issues profile must be one of: ${implementationProfiles.join(", ")}; received ${issue.profile}`);
		}
	}
}

function validateGraph(graph: DeliveryGraph): void {
	if (!graph.issues.length) throw new Error("Delivery Graph must contain an implementation issue");
	const byId = new Map<string, DeliveryIssue>();
	for (const issue of graph.issues) {
		if (issue.id === FINAL_CHECK_ID) throw new Error(`Local Issue ID is reserved: ${FINAL_CHECK_ID}`);
		if (byId.has(issue.id)) throw new Error(`Duplicate Local Issue ID: ${issue.id}`);
		byId.set(issue.id, issue);
	}
	for (const issue of graph.issues) {
		const dependencies = new Set<string>();
		for (const dependency of issue.depends_on) {
			if (dependency === issue.id) throw new Error(`Local Issue ${issue.id} cannot depend on itself`);
			if (!byId.has(dependency)) throw new Error(`Local Issue ${issue.id} has unknown dependency: ${dependency}`);
			if (dependencies.has(dependency)) throw new Error(`Local Issue ${issue.id} repeats dependency: ${dependency}`);
			dependencies.add(dependency);
		}
	}
	deriveDependencyWaves(graph);
}
