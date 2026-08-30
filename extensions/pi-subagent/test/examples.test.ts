import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadRoles } from "../src/index.ts";

const samplesDir = fileURLToPath(new URL("../examples/roles/", import.meta.url));

const packageDir = fileURLToPath(new URL("../", import.meta.url));

test("bundled pi-subagent-delegated-development Skill is valid and registered", async () => {
	const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));

	const skill = await readFile(
		join(packageDir, "skills", "pi-subagent-delegated-development", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /^name: pi-subagent-delegated-development$/m);
	assert.match(skill, /^description: .+/m);
	assert.match(skill, /Main, the planner\/orchestrator/i);
	assert.match(skill, /call `delegate_flow`/i);
	assert.match(skill, /independent units expected to commute/i);
	assert.match(skill, /runtime owns.*worktrees.*Git identity.*rebasing.*committed-state inspection.*declared validation.*conditional exact read-only review.*fast-forward integration.*cleanup/is);
	assert.match(skill, /validation is the authority for objective verification/i);
	assert.match(skill, /Add non-empty `review` only for an explicit judgment/i);
	assert.doesNotMatch(skill, /acceptance criteria/i);
	assert.match(skill, /without `review`.*exact validated tip/is);
	assert.match(skill, /with `review`.*exact `\{base, tip, patchPath\}` protocol.*exactly `PASS`/is);
	assert.match(skill, /delegate_flow_continue\(\{ guidance:/);
	assert.match(skill, /one explicit continuation and no more/i);
	assert.match(skill, /direct `model` replaces only the selected route's model.*route keeps its thinking level/is);
	assert.match(skill, /terminal failure.*retained path/is);
	assert.match(skill, /Dependent work remains outside Flow/i);
	assert.doesNotMatch(skill, /git rev-parse|git diff|sha-?256|cherry-pick|candidate|advisory|reconsideration|public review/i);
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

	assert.match(implementer!.systemPrompt, /bounded outcome, not a preassigned file list/i);
	assert.match(implementer!.systemPrompt, /assigned cwd/i);
	assert.match(implementer!.systemPrompt, /repository instructions and domain context/i);
	assert.match(implementer!.systemPrompt, /relevant flow, callers, and tests/i);
	assert.match(implementer!.systemPrompt, /preserve unrelated work/i);
	assert.match(implementer!.systemPrompt, /root cause with the smallest complete diff/i);
	assert.match(implementer!.systemPrompt, /speculative work/i);
	assert.match(implementer!.systemPrompt, /Stop when the outcome is complete or blocked/i);
	assert.match(implementer!.systemPrompt, /ordinary delegation, run focused validation.*establish correctness/i);
	assert.match(implementer!.systemPrompt, /Flow, the declared validation gate is authoritative/i);
	assert.match(implementer!.systemPrompt, /narrow development checks.*do not duplicate that final gate/i);
	assert.match(implementer!.systemPrompt, /credentials.*network.*generate artifacts.*broaden scope/i);
	assert.match(implementer!.systemPrompt, /external LLM APIs.*SDKs.*agent harnesses.*model CLIs/i);
	assert.match(implementer!.systemPrompt, /Commit completed scoped changes locally/i);
	assert.match(implementer!.systemPrompt, /assigned worktree and branch intact/i);
	assert.match(implementer!.systemPrompt, /Never push or open a pull request without explicit authorization/i);
	assert.match(implementer!.systemPrompt, /outcome, commit, checks run, and remaining risks/i);
	assert.match(implementer!.systemPrompt, /Do not repeat Flow's Git-derived evidence/i);

	assert.match(reviewer!.systemPrompt, /exactly two modes/i);
	assert.match(reviewer!.systemPrompt, /ordinary delegation: use supplied requirements and named files\/evidence only/i);
	assert.match(reviewer!.systemPrompt, /Do not prepare Git.*require a commit\/Review Packet.*broaden discovery/i);
	assert.match(reviewer!.systemPrompt, /If evidence is insufficient, say so and stop/i);
	assert.match(reviewer!.systemPrompt, /Flow exact review: only with an explicit judgment criterion.*same assigned Unit Worktree.*exact Review Packet `\{base, tip, patchPath\}`/i);
	assert.match(reviewer!.systemPrompt, /exact patch at `patchPath` as authoritative.*read only referenced files\/context/i);
	assert.match(reviewer!.systemPrompt, /Declared validation is authoritative for objective verification/i);
	assert.match(reviewer!.systemPrompt, /Judge only the explicit criterion/i);
	assert.match(reviewer!.systemPrompt, /actionable correctness risks introduced by the change/i);
	assert.match(reviewer!.systemPrompt, /style preferences.*speculative hypotheticals.*unrelated pre-existing issues/i);
	assert.match(reviewer!.systemPrompt, /Use only `read`, `grep`, `find`, and `ls`/i);
	assert.doesNotMatch(reviewer!.systemPrompt, /\bbash\b/i);
	assert.match(reviewer!.systemPrompt, /run no commands\/tests and never edit, write, commit, push, or manage Git\/worktrees/i);
	assert.match(reviewer!.systemPrompt, /Never invoke external LLM APIs.*SDKs.*agent harnesses.*model CLIs/i);
	assert.match(reviewer!.systemPrompt, /Output exactly `PASS` when there are no findings/i);
	assert.match(reviewer!.systemPrompt, /Otherwise output findings only, ordered by severity, with file:line evidence, impact, and smallest valid fix/i);
	assert.match(reviewer!.systemPrompt, /Any finding blocks approval.*never combine `PASS` with findings/i);
	assert.match(reviewer!.systemPrompt, /Stop when supplied evidence is covered.*in Flow, stop after its criterion/i);

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

test("duplicate names among user role files remain an error", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	const role = "---\nname: dup\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n";
	await writeFile(join(rolesDir, "a.md"), role);
	await writeFile(join(rolesDir, "b.md"), role);

	assert.throws(() => loadRoles(agentDir), /Duplicate Subagent role: dup\./);
});

test("the optional synthesizer sample loads alongside built-in roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await copyFile(join(samplesDir, "synthesizer.md"), join(rolesDir, "synthesizer.md"));

	assert.deepEqual(loadRoles(agentDir).map(({ name, tools, isolation, extensions, skills }) => ({
		name, tools, isolation, extensions, skills,
	})), [
		{ name: "implementer", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], isolation: "worktree", extensions: [], skills: [] },
		{ name: "reviewer", tools: ["read", "grep", "find", "ls"], isolation: undefined, extensions: [], skills: [] },
		{ name: "scout", tools: ["read", "grep", "find", "ls"], isolation: undefined, extensions: [], skills: [] },
		{ name: "synthesizer", tools: ["read"], isolation: undefined, extensions: [], skills: [] },
	]);
});
