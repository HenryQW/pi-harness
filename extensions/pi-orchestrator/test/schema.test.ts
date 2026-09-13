import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	launchRecordFingerprint,
	MAX_TASKS,
	parseExecuteRequest,
	validateLaunchRecords,
	type ExecuteRequest,
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
	const promptHash = sha256(`${role} Role prompt`);
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: `${role}/fast`,
		role,
		modelClass: "fast",
		roleFingerprint: sha256(`${role} Role identity`),
		promptSha256: promptHash,
		promptArgIndex: 4,
		model: "provider/model",
		thinkingLevel: "high",
		args: ["--model", "provider/model", "--thinking", "high"],
		env: {},
		tools: ["read", role === "implementer" ? "edit" : "grep"],
		roleExtensions: [extensionPath],
		roleSkills: [skillPath],
		resources: [
			{ kind: "extension", path: extensionPath, sha256: "1".repeat(64) },
			{ kind: "skill", path: skillPath, sha256: "2".repeat(64) },
		],
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

test("launch records require complete prompt-free fingerprinted Role snapshots", () => {
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
	tamperedArg.args.push("--unsafe");
	assert.throws(() => validateLaunchRecords(definition, [tamperedArg, reviewer]), /fingerprint.*complete contents/i);

	const callerEnv = fingerprint({ ...implementer, env: { TOKEN: "secret" } });
	assert.throws(() => validateLaunchRecords(definition, [callerEnv, reviewer]), /must not pass caller Role environment/);

	const promptTransport = fingerprint({
		...implementer,
		args: [...implementer.args, "--append-system-prompt", "/tmp/private.prompt"],
		promptArgIndex: implementer.args.length,
	});
	assert.throws(() => validateLaunchRecords(definition, [promptTransport, reviewer]), /argv must omit Role prompt transport/i);

	const outOfBoundsPromptIndex = fingerprint({ ...implementer, promptArgIndex: implementer.args.length + 1 });
	assert.throws(() => validateLaunchRecords(definition, [outOfBoundsPromptIndex, reviewer]), /prompt argv index is out of bounds/i);

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
	assert.throws(() => validateLaunchRecords(definition, [mismatchedResources, reviewer]), /must match its exact selected resource paths/);

	const serialized = JSON.stringify(records);
	assert.doesNotMatch(serialized, /Role prompt|private\.prompt|append-system-prompt/);
});
