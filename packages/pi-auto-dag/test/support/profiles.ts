import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEST_PROFILE_IDS = ["coder", "backend", "frontend", "reviewer"] as const;
export const TEST_SKILL_NAMES = ["coding", "shared"] as const;

export async function createTestProfiles(root: string): Promise<void> {
	await Promise.all(TEST_PROFILE_IDS.map(async (id) => {
		await mkdir(join(root, "profiles", id), { recursive: true });
	}));
}

export async function createTestSkills(root: string): Promise<void> {
	await Promise.all(TEST_SKILL_NAMES.map(async (name) => {
		const directory = join(root, "skills", name);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n`);
	}));
}

export function testSkills(root: string) {
	return TEST_SKILL_NAMES.map((name) => ({ name, filePath: join(root, "skills", name, "SKILL.md") }));
}

export function testProfileConfig(root: string, options: {
	maxParallel?: number;
	maxReviews?: number;
	profileSkills?: Partial<Record<(typeof TEST_PROFILE_IDS)[number], string[]>>;
} = {}) {
	const coding = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];
	return {
		version: 3,
		profiles: Object.fromEntries(TEST_PROFILE_IDS.map((id) => [id, {
			description: `${id} test profile`,
			agent_dir: join(root, "profiles", id),
			skills: options.profileSkills?.[id] ?? [],
			tools: id === "reviewer" ? ["read", "bash", "grep", "find", "ls", "web_search"] : coding,
		}])),
		implementation_profiles: ["coder", "backend", "frontend"],
		reviewer_profile: "reviewer",
		repair_profile: "coder",
		...(options.maxParallel === undefined ? {} : { max_parallel_tasks: options.maxParallel }),
		...(options.maxReviews === undefined ? {} : { max_review_rounds: options.maxReviews }),
	};
}
