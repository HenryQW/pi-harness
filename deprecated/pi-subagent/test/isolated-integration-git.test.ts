import { describe } from "node:test";

// Each case owns its repository and worktrees.
describe("isolated integration Git", { concurrency: 2 }, async () => {
	await import("./isolated-integration-git-cases.ts");
});
