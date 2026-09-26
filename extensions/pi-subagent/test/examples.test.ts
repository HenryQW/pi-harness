import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRoles, parseRoleName, type RoleName } from "../src/index.ts";


async function isolatedAgentDir(t: import("node:test").TestContext): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-examples-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	return agentDir;
}

test("missing config directory still returns validated built-in implementer, reviewer, and scout roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const roles = loadRoles(agentDir);
	const [implementer, reviewer, scout] = roles;

	assert.deepEqual(roles.map(({ name, tools, extensions, skills, mcps }) => ({ name, tools, extensions, skills, mcps })), [
		{ name: "implementer", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], extensions: [], skills: [], mcps: [] },
		{ name: "reviewer", tools: ["read", "grep", "find", "ls"], extensions: [], skills: [], mcps: [] },
		{ name: "scout", tools: ["read", "grep", "find", "ls"], extensions: [], skills: [], mcps: [] },
	]);

	assert.deepEqual(roles.map(({ modelClass }) => modelClass), [undefined, undefined, undefined]);

	for (const contract of [
		/root cause with the smallest complete diff.*no speculative work/is,
		/Run focused checks required by the task/i,
		/Preserve required deliverables, unrelated and pre-existing files, and user data/i,
		/Never use `git clean` or blanket deletion/i,
		/credentials or the network.*broaden scope only when the task requires/is,
		/Direct delegation leaves changes uncommitted.*isolated delegation commits completed scoped changes/is,
		/Never push or open a pull request/is,
	]) assert.match(implementer!.systemPrompt, contract);

	for (const contract of [
		/Review the supplied candidate read-only/i,
		/evidence is insufficient, say so and stop/i,
		/actionable correctness risks introduced by the change.*not style preferences/is,
		/Run no commands or tests.*Never edit, write, commit, push, manage Git or worktrees/is,
		/Output exactly `PASS` when there are no findings/i,
		/Any finding blocks approval.*never combine `PASS` with findings/is,
	]) assert.match(reviewer!.systemPrompt, contract);
	assert.doesNotMatch(reviewer!.systemPrompt, /\bbash\b/i);

	assert.match(scout!.systemPrompt, /Answer only the bounded discovery questions/i);
	assert.match(scout!.systemPrompt, /Do not design, recommend, implement, edit, or run shell commands/i);
	assert.match(scout!.systemPrompt, /path:line evidence/i);
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
		extensions: [],
		skills: [],
		mcps: [],
		systemPrompt: "Custom body.",
	});
	assert.deepEqual(roles.find(({ name }) => name === "scout"), {
		name: "scout",
		description: "Custom discovery policy",
		tools: ["read"],
		extensions: [],
		skills: [],
		mcps: [],
		systemPrompt: "Custom scout body.",
	});
});

test("parseRoleName accepts arbitrary names and rejects invalid display text", () => {
	const name: RoleName = parseRoleName("  custom role/v2  ");
	assert.equal(name, "custom role/v2");

	for (const value of [undefined, "   "]) {
		assert.throws(() => parseRoleName(value), /Role: name must be non-empty text\./);
	}
	for (const value of ["control\nname", "control\u009bname"]) {
		assert.throws(() => parseRoleName(value), /Role: name must not contain C0\/C1 control characters\./);
	}
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

test("Role isolation is rejected because mode owns checkout policy", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "role.md"), "---\nname: role\ndescription: d\nisolation: worktree\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.throws(() => loadRoles(agentDir), /Role isolation is retired.*mode "isolated"/i);
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

test("Role MCP allowlists default to deny, normalize names, and reject duplicates", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\nmcps: [real-browser, codegraph]\n---\nBody.\n");
	assert.deepEqual(loadRoles(agentDir).find(({ name }) => name === "role")!.mcps, ["real-browser", "codegraph"]);

	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\nmcps: [codegraph, codegraph]\n---\nBody.\n");
	assert.throws(() => loadRoles(agentDir), /role\.md: mcps contains duplicate MCP server names\./);
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
