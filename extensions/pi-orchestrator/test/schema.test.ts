import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	launchRecordFingerprint,
	MAX_TASKS,
	parseExecuteRequest,
	validateLaunchRecords,
	type ExecuteRequest,
	type LaunchPromptFile,
	type NormalizedLaunchRecord,
	type Role,
	type TaskRequest,
} from "../src/schema.ts";

function task(id: string, dependsOn: string[] = []): TaskRequest {
	return {
		id,
		modelClass: "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn,
		checks: [{ command: `check-${id}`, args: [] }],
	};
}

function request(tasks: TaskRequest[]): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 10_000,
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
	};
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function launch(role: Role): NormalizedLaunchRecord {
	const extensionPath = `/roles/${role}.ts`;
	const skillPath = `/skills/${role}.md`;
	const rawArgs = ["--model", "provider/model", "--thinking", "high"];
	const rawValue = "Implement the exact task.";
	const prompt: LaunchPromptFile = {
		rawValue,
		path: "/private/implementer.prompt",
		mode: 0o600,
		sha256: sha256(rawValue),
		finalArgs: [...rawArgs, "--prompt-file", "/private/implementer.prompt"],
	};
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: `${role}/fast`,
		role,
		modelClass: "fast",
		model: "provider/model",
		thinkingLevel: "high",
		rawArgs,
		env: {},
		tools: ["read", role === "implementer" ? "edit" : "grep"],
		roleExtensions: [extensionPath],
		roleSkills: [skillPath],
		resources: [
			{ kind: "extension", path: extensionPath, sha256: "1".repeat(64) },
			{ kind: "skill", path: skillPath, sha256: "2".repeat(64) },
		],
		...(role === "implementer" ? { prompt } : {}),
	};
	return { ...value, fingerprint: launchRecordFingerprint(value) };
}

function fingerprint(record: NormalizedLaunchRecord): NormalizedLaunchRecord {
	const { fingerprint: _old, ...value } = record;
	return { ...value, fingerprint: launchRecordFingerprint(value) };
}

test("the strict graph rejects excess, unknown, duplicate, self, and cyclic dependencies", () => {
	const invalidGraphs: TaskRequest[][] = [
		Array.from({ length: MAX_TASKS + 1 }, (_, index) => task(`task-${index}`)),
		[task("task-a", ["missing"])],
		[task("task-a", ["task-b", "task-b"]), task("task-b")],
		[task("task-a", ["task-a"])],
		[task("task-a", ["task-b"]), task("task-b", ["task-a"])],
	];
	for (const tasks of invalidGraphs) assert.throws(() => parseExecuteRequest(request(tasks)));

	assert.throws(() => parseExecuteRequest({
		...request([task("task-a")]),
		tasks: [{ ...task("task-a"), role: "custom" }],
	}), /strict v1 schema/);
});

test("launch records require complete fingerprinted Role resources and private prompt constraints", () => {
	const definition = request([{
		...task("task-a"),
		judgment: { criterion: "Review exactly.", modelClass: "fast" },
	}]);
	const implementer = launch("implementer");
	const reviewer = launch("reviewer");
	const records = validateLaunchRecords(definition, [implementer, reviewer]);
	assert.deepEqual(records[implementer.key], implementer);
	assert.deepEqual(records[reviewer.key], reviewer);

	const tamperedArg = structuredClone(implementer);
	tamperedArg.rawArgs.push("--unsafe");
	assert.throws(() => validateLaunchRecords(definition, [tamperedArg, reviewer]), /fingerprint.*complete contents/i);

	const callerEnv = fingerprint({ ...implementer, env: { TOKEN: "secret" } });
	assert.throws(() => validateLaunchRecords(definition, [callerEnv, reviewer]), /must not pass caller Role environment/);

	const missingPrompt = fingerprint({ ...implementer, prompt: undefined });
	assert.throws(() => validateLaunchRecords(definition, [missingPrompt, reviewer]), /lacks its private prompt file/);

	const reviewerPrompt = fingerprint({ ...reviewer, prompt: structuredClone(implementer.prompt) });
	assert.throws(() => validateLaunchRecords(definition, [implementer, reviewerPrompt]), /Reviewer.*must not use a private/i);

	const relativePath = fingerprint({
		...implementer,
		roleExtensions: ["roles/implementer.ts"],
		resources: implementer.resources.map((resource) => resource.kind === "extension"
			? { ...resource, path: "roles/implementer.ts" }
			: resource),
	});
	assert.throws(() => validateLaunchRecords(definition, [relativePath, reviewer]), /canonical absolute path/);

	const mismatchedResources = fingerprint({
		...implementer,
		resources: implementer.resources.map((resource, index) => index === 0
			? { ...resource, path: "/roles/other.ts" }
			: resource),
	});
	assert.throws(() => validateLaunchRecords(definition, [mismatchedResources, reviewer]), /must match its exact Role extension and Skill paths/);

	const wrongPromptHash = fingerprint({
		...implementer,
		prompt: { ...implementer.prompt!, sha256: "3".repeat(64) },
	});
	assert.throws(() => validateLaunchRecords(definition, [wrongPromptHash, reviewer]), /prompt hash.*raw prompt/i);

	const exposedPrompt = fingerprint({
		...implementer,
		prompt: { ...implementer.prompt!, finalArgs: [implementer.prompt!.rawValue, implementer.prompt!.path] },
	});
	assert.throws(() => validateLaunchRecords(definition, [exposedPrompt, reviewer]), /final argv.*raw prompt/i);

	const unreferencedPrompt = fingerprint({
		...implementer,
		prompt: { ...implementer.prompt!, finalArgs: ["--prompt-file", "/private/other.prompt"] },
	});
	assert.throws(() => validateLaunchRecords(definition, [unreferencedPrompt, reviewer]), /final argv.*private prompt path/i);
});
