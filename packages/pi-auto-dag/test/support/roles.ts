import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "@henryqw/pi-subagent";
import type { RoleLaunchResolver } from "../../src/worker.ts";

export const TEST_ROLE_NAMES = ["coder", "backend", "frontend", "reviewer"] as const;

const codingTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];

export function testRoles(): Role[] {
	return TEST_ROLE_NAMES.map((name) => ({
		name,
		description: `${name} test Role`,
		tools: name === "reviewer" ? ["read", "bash", "grep", "find", "ls", "web_search"] : codingTools,
		extensions: [],
		skills: [],
		systemPrompt: `${name} test instructions.`,
	}));
}

export async function createTestRoles(agentDir: string): Promise<void> {
	const directory = join(agentDir, "config", "pi-subagent");
	await mkdir(directory, { recursive: true });
	await Promise.all(testRoles().map((role) => writeFile(join(directory, `${role.name}.md`), [
		"---",
		`name: ${role.name}`,
		`description: ${role.description}`,
		`tools: ${role.tools!.join(",")}`,
		"---",
		"",
		role.systemPrompt,
		"",
	].join("\n"))));
}

export function testRoleConfig(options: {
	maxParallel?: number;
	maxReviews?: number;
} = {}) {
	return {
		version: 4,
		implementation_roles: ["coder", "backend", "frontend"],
		reviewer_role: "reviewer",
		repair_role: "coder",
		...(options.maxParallel === undefined ? {} : { max_parallel_tasks: options.maxParallel }),
		...(options.maxReviews === undefined ? {} : { max_review_rounds: options.maxReviews }),
	};
}

export const testLaunchResolver: RoleLaunchResolver = (input) => ({
	env: { ...input.env },
	args: [
		"--no-session",
		"--no-extensions",
		"--no-skills",
		...(input.extensions ?? []).flatMap((extension) => ["--extension", extension]),
		"--tools",
		[...new Set([...(input.role.tools ?? []), ...(input.tools ?? [])])].join(","),
		"--model",
		input.taskId,
		"--append-system-prompt",
		input.role.systemPrompt,
	],
});
