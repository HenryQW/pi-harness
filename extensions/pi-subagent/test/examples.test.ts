import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadRoles } from "../src/index.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));

test("bundled pi-subagent-delegated-development Skill is valid and registered", async () => {
	const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));

	const skill = await readFile(
		join(packageDir, "skills", "pi-subagent-delegated-development", "SKILL.md"),
		"utf8",
	);
	for (const contract of [
		/^name: pi-subagent-delegated-development$/m,
		/^description: .+/m,
		/trivial, single-owner, mechanically verifiable edit in Main/i,
		/literal UI or copy defect.*search the exact quoted text first.*producer and nearby regression assertions/is,
		/repository policy overrides.*compatibility is disallowed.*forbid legacy readers.*fallbacks/is,
		/neighboring behavior.*stay unchanged.*exact test name or error.*known CI evidence/is,
		/FLOW unit must fit one Implementer launch.*cohesion does not justify combining separately verifiable milestones/is,
		/known regression.*exact test-name filter.*node --test --test-name-pattern "exact test name"/is,
		/broad or cross-unit check once in Main.*Do not duplicate checks.*no post-merge validation/is,
		/runtime owns.*worktrees.*Git identity.*rebasing.*declared validation.*exact read-only review.*fast-forward integration.*cleanup/is,
		/without `review`.*exact validated tip.*with `review`.*`PASS`/is,
		/Trust the structured Flow outcome.*Never edit child worktrees.*Do not repeat Flow validation/is,
		/do not re-read implementation, tests, manifests, or commit stats/i,
		/delegate_flow_continue` once.*guidance specific to the failure/is,
		/Omit `modelClass`.*supply it only to replace both defaults/is,
		/terminal failure.*exact retained paths.*Do not retry Flow.*`git worktree list`/is,
		/cleanup warning from a successful Flow as-is/i,
		/caller-managed review only when the caller or repository policy explicitly requires judgment/is,
		/role: "reviewer".*same-named user Role remains effective/is,
		/Reviewer cannot see an isolated candidate.*use Flow/is,
		/Empty output fails.*second empty result blocks/is,
		/findings.*repair them together.*validate once.*re-review once.*Only `PASS` completes/is,
	]) assert.match(skill, contract);
	assert.doesNotMatch(skill, /git rev-parse|git diff|sha-?256|cherry-pick|advisory|reconsideration|public review/i);
});

async function isolatedAgentDir(t: import("node:test").TestContext): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-examples-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	return agentDir;
}

test("missing config directory still returns validated built-in implementer, reviewer, and scout roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const roles = loadRoles(agentDir);
	const [implementer, reviewer, scout] = roles;

	assert.deepEqual(roles.map(({ name, description, tools, isolation, extensions, skills }) => ({
		name, description, tools, isolation, extensions, skills,
	})), [
		{
			name: "implementer",
			description: "Implements and validates one bounded change, requesting worktree isolation",
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			isolation: "worktree",
			extensions: [],
			skills: [],
		},
		{
			name: "reviewer",
			description: "Reviews one bounded change for correctness without changing files",
			tools: ["read", "grep", "find", "ls"],
			isolation: undefined,
			extensions: [],
			skills: [],
		},
		{
			name: "scout",
			description: "Maps relevant code and evidence for one bounded task without changing files",
			tools: ["read", "grep", "find", "ls"],
			isolation: undefined,
			extensions: [],
			skills: [],
		},
	]);

	assert.deepEqual(roles.map(({ modelClass }) => modelClass), [undefined, undefined, undefined]);

	for (const contract of [
		/bounded outcome, not a preassigned file list.*assigned cwd/is,
		/repository instructions and domain context.*relevant flow, callers, and tests/is,
		/root cause with the smallest complete diff.*no speculative work.*complete or blocked/is,
		/Run focused checks required by the task/i,
		/remove only task-created, non-deliverable temporary, generated, or ignored files/is,
		/Preserve required deliverables, unrelated and pre-existing files, and user data/i,
		/Never use `git clean` or blanket deletion.*exact path as a blocker/is,
		/credentials or the network.*extra artifacts.*broaden scope only when the task requires/is,
		/external LLM APIs.*SDKs.*agent harnesses.*model CLIs/i,
		/Commit completed scoped changes.*Do not create or manage another worktree/is,
		/assigned worktree and branch intact.*Never push or open a pull request/is,
		/outcome, commit, checks, and remaining risks/i,
	]) assert.match(implementer!.systemPrompt, contract);

	for (const contract of [
		/Review the supplied candidate read-only/i,
		/supplied requirements and named files or evidence.*do not prepare Git or broaden discovery/is,
		/evidence is insufficient, say so and stop/i,
		/actionable correctness risks introduced by the change.*not style preferences.*unrelated pre-existing issues/is,
		/Run no commands or tests.*Never edit, write, commit, push, manage Git or worktrees/is,
		/external LLM APIs.*SDKs.*agent harnesses.*model CLIs/i,
		/Output exactly `PASS` when there are no findings/i,
		/findings only, ordered by severity.*file:line evidence.*smallest valid fix/is,
		/Any finding blocks approval.*never combine `PASS` with findings/is,
		/Stop when the supplied evidence is covered/i,
	]) assert.match(reviewer!.systemPrompt, contract);
	assert.doesNotMatch(reviewer!.systemPrompt, /\bbash\b/i);

	assert.match(scout!.systemPrompt, /Answer only the bounded discovery questions/i);
	assert.match(scout!.systemPrompt, /Read applicable repository instructions and domain context first/i);
	assert.match(scout!.systemPrompt, /Trace the relevant execution\/data flow, callers, tests, and constraints only far enough to answer/i);
	assert.match(scout!.systemPrompt, /Separate observed facts, supported inferences, and unknowns/i);
	assert.match(scout!.systemPrompt, /Stop when answered; if blocked, state what is missing/i);
	assert.match(scout!.systemPrompt, /Do not design, recommend, implement, edit, or run shell commands/i);
	assert.match(scout!.systemPrompt, /Return concisely:/i);
	assert.match(scout!.systemPrompt, /map of relevant files and symbols and how they connect/i);
	assert.match(scout!.systemPrompt, /path:line evidence/i);
	assert.match(scout!.systemPrompt, /uncertainties or missing context/i);
});

test("same-named user roles override built-ins", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "my-implementer.md"), `---
name: implementer
description: Custom implementation policy
tools: [read]
extensions: []
skills: []
---
Custom body.
`);
	await writeFile(join(rolesDir, "scout.md"), `---
name: scout
description: Custom discovery policy
tools: [read]
extensions: []
skills: []
---
Custom scout body.
`);

	const roles = loadRoles(agentDir);
	assert.deepEqual(roles.map(({ name }) => name), ["implementer", "reviewer", "scout"]);
	assert.deepEqual(roles.find(({ name }) => name === "implementer"), {
		name: "implementer",
		description: "Custom implementation policy",
		tools: ["read"],
		isolation: undefined,
		extensions: [],
		skills: [],
		systemPrompt: "Custom body.",
	});
	assert.deepEqual(roles.find(({ name }) => name === "scout"), {
		name: "scout",
		description: "Custom discovery policy",
		tools: ["read"],
		isolation: undefined,
		extensions: [],
		skills: [],
		systemPrompt: "Custom scout body.",
	});
});

test("Role display fields reject C0/C1 controls while system prompts stay multiline", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	for (const [field, value] of [
		["name", '"bad\\u001bname"'],
		["name", '"\\nrole"'],
		["description", '"bad\\u009bdescription"'],
		["description", '"Visible role\\t"'],
	] as const) {
		const name = field === "name" ? value : "role";
		const description = field === "description" ? value : "Visible role";
		await writeFile(rolePath, `---\nname: ${name}\ndescription: ${description}\ntools: []\nextensions: []\nskills: []\n---\nFirst line.\nSecond line.\n`);
		assert.throws(() => loadRoles(agentDir), new RegExp(`role\\.md: ${field} must not contain C0/C1 control characters\\.`));
	}
	await writeFile(rolePath, "---\nname: role\ndescription: Visible role\ntools: []\nextensions: []\nskills: []\n---\nFirst line.\nSecond line.\n");
	assert.equal(loadRoles(agentDir).find(({ name }) => name === "role")!.systemPrompt, "First line.\nSecond line.");
});

test("Role capability lists are required arrays", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	for (const field of ["tools", "extensions", "skills"]) {
		const fields = ["tools: []", "extensions: []", "skills: []"]
			.filter((value) => !value.startsWith(`${field}:`));
		await writeFile(rolePath, `---\nname: role\ndescription: d\n${fields.join("\n")}\n---\nBody.\n`);
		assert.throws(() => loadRoles(agentDir), new RegExp(`role\\.md: ${field} is required\\.`));
	}
	for (const [field, value] of [["tools", "read, grep"], ["extensions", "/role.ts"], ["skills", "review"]]) {
		const fields = ["tools: []", "extensions: []", "skills: []"]
			.map((entry) => entry.startsWith(`${field}:`) ? `${field}: ${value}` : entry);
		await writeFile(rolePath, `---\nname: role\ndescription: d\n${fields.join("\n")}\n---\nBody.\n`);
		assert.throws(() => loadRoles(agentDir), new RegExp(`role\\.md: ${field} must be an array of strings\\.`));
	}
	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	const role = loadRoles(agentDir).find((candidate) => candidate.name === "role")!;
	assert.deepEqual([role.tools, role.extensions, role.skills], [[], [], []]);
});

test("Role modelClass accepts shared profiles and rejects invalid values", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(rolePath, "---\nname: role\ndescription: d\nmodelClass: frontier\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.equal(loadRoles(agentDir).find(({ name }) => name === "role")!.modelClass, "frontier");

	await writeFile(rolePath, "---\nname: role\ndescription: d\nmodelClass: slow\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.throws(() => loadRoles(agentDir), /role\.md: modelClass must be one of fast, balanced, frontier, fav\./);
});

test("duplicate names among user role files remain an error", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	const role = "---\nname: dup\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n";
	await writeFile(join(rolesDir, "a.md"), role);
	await writeFile(join(rolesDir, "b.md"), role);

	assert.throws(() => loadRoles(agentDir), /Duplicate Subagent role: dup\./);
});
