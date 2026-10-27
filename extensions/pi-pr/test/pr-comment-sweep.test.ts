import { describe } from "node:test";

// Each case owns its repository, remote, and agent directory.
describe("pull request feedback sweep", { concurrency: 4 }, async () => {
	await import("./pr-comment-sweep-cases.ts");
});
