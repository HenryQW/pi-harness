import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_PROFILE_IDS = ["coder", "backend", "frontend", "reviewer"] as const;
const resolver = fileURLToPath(new URL("./fake-profile-resolver.mjs", import.meta.url));

export async function createTestProfiles(root: string): Promise<void> {
	await mkdir(join(root, "shared-skills", ".agents", "skills"), { recursive: true });
	await Promise.all(TEST_PROFILE_IDS.map(async (id) => {
		await mkdir(join(root, "profiles", id, ".agents", "skills"), { recursive: true });
	}));
}

export function testProfileConfig(root: string, options: { maxParallel?: number; maxReviews?: number } = {}) {
	return {
		version: 2,
		profile_resolver: [process.execPath, resolver, root],
		implementation_profiles: ["coder", "backend", "frontend"],
		reviewer_profile: "reviewer",
		repair_profile: "coder",
		...(options.maxParallel === undefined ? {} : { max_parallel_tasks: options.maxParallel }),
		...(options.maxReviews === undefined ? {} : { max_review_rounds: options.maxReviews }),
	};
}
