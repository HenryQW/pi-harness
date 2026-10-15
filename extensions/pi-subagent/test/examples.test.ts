import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findRole, loadRoleCatalog, parseRoleName, registerRoleDefaultsReporting, type RoleName } from "../src/index.ts";
import { parseExecuteRequest } from "../src/schema.ts";

test("README isolated request passes production graph admission", async () => {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	const examples = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!));
	const isolated = examples.filter((example) => example.mode === "isolated");
	assert.ok(isolated.length > 0);
	for (const example of isolated) assert.doesNotThrow(() => parseExecuteRequest(example));
});


function roleError(agentDir: string): string {
	const { errors } = loadRoleCatalog(agentDir);
	assert.equal(errors.length, 1, JSON.stringify(errors));
	return errors[0]!.message;
}

async function isolatedAgentDir(t: import("node:test").TestContext): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-examples-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	return agentDir;
}

test("missing config directory still returns validated built-in implementer, reviewer, and scout roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const roles = loadRoleCatalog(agentDir).roles;
	const [implementer, reviewer, scout] = roles;

	assert.deepEqual(roles.map(({ name, tools, extensions, skills, mcps }) => ({ name, tools, extensions, skills, mcps })), [
		{ name: "implementer", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], extensions: [], skills: [], mcps: [] },
		{ name: "reviewer", tools: ["read", "grep", "find", "ls", "git_read"], extensions: [], skills: [], mcps: [] },
		{ name: "scout", tools: ["read", "grep", "find", "ls"], extensions: [], skills: [], mcps: [] },
	]);

	assert.deepEqual(roles.map(({ modelClass }) => modelClass), [undefined, undefined, undefined]);

	for (const contract of [
		/root cause with the smallest complete diff.*no speculative work/is,
		/Run focused checks required by the task/i,
		/Preserve required deliverables, unrelated and pre-existing files, and user data/i,
		/Never use `git clean` or blanket deletion/i,
		/credentials or the network.*broaden scope only when the task requires/is,
		/Direct delegation may write or commit only within Main's explicitly authorized scope.*Isolated delegation commits completed scoped changes/is,
		/Never push or open a pull request/is,
	]) assert.match(implementer!.systemPrompt, contract);

	for (const contract of [
		/Review the supplied candidate read-only/i,
		/evidence is insufficient, say so and stop/i,
		/actionable correctness risks introduced by the change.*not style preferences/is,
		/Run no tests or commands outside `git_read`.*Never edit, write, commit, push, mutate Git or manage worktrees/is,
		/`git_read` for bounded local Git inspection.*exact patch remains authoritative.*never substitute another branch or worktree/is,
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

	const roles = loadRoleCatalog(agentDir).roles;
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
		assert.match(roleError(agentDir), new RegExp(`role\\.md: ${field} must not contain C0/C1 control characters\\.`));
	}
	await writeFile(rolePath, "---\nname: role\ndescription: Visible role\ntools: []\nextensions: []\nskills: []\n---\nFirst line.\nSecond line.\n");
	assert.equal(loadRoleCatalog(agentDir).roles.find(({ name }) => name === "role")!.systemPrompt, "First line.\nSecond line.");
});

test("Role isolation is rejected because mode owns checkout policy", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "role.md"), "---\nname: role\ndescription: d\nisolation: worktree\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.match(roleError(agentDir), /Role isolation is retired.*mode "isolated"/i);
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
		assert.match(roleError(agentDir), new RegExp(`role\\.md: ${field} is required\\.`));
	}
	for (const [field, value] of [["tools", "read, grep"], ["extensions", "/role.ts"], ["skills", "review"]]) {
		const fields = ["tools: []", "extensions: []", "skills: []"]
			.map((entry) => entry.startsWith(`${field}:`) ? `${field}: ${value}` : entry);
		await writeFile(rolePath, `---\nname: role\ndescription: d\n${fields.join("\n")}\n---\nBody.\n`);
		assert.match(roleError(agentDir), new RegExp(`role\\.md: ${field} must be an array of strings\\.`));
	}
	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	const role = loadRoleCatalog(agentDir).roles.find((candidate) => candidate.name === "role")!;
	assert.deepEqual([role.tools, role.extensions, role.skills], [[], [], []]);
});

test("Role MCP allowlists default to deny, normalize names, and reject duplicates", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\nmcps: [real-browser, codegraph]\n---\nBody.\n");
	assert.deepEqual(loadRoleCatalog(agentDir).roles.find(({ name }) => name === "role")!.mcps, ["real-browser", "codegraph"]);

	await writeFile(rolePath, "---\nname: role\ndescription: d\ntools: []\nextensions: []\nskills: []\nmcps: [codegraph, codegraph]\n---\nBody.\n");
	assert.match(roleError(agentDir), /role\.md: mcps contains duplicate MCP server names\./);
});

test("Role modelClass accepts shared profiles and rejects invalid values", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	const rolePath = join(rolesDir, "role.md");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(rolePath, "---\nname: role\ndescription: d\nmodelClass: frontier\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.equal(loadRoleCatalog(agentDir).roles.find(({ name }) => name === "role")!.modelClass, "frontier");

	await writeFile(rolePath, "---\nname: role\ndescription: d\nmodelClass: slow\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	assert.match(roleError(agentDir), /role\.md: modelClass must be one of fast, balanced, frontier, fav\./);
});

test("duplicate names among user role files remain an error", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	const role = "---\nname: dup\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n";
	await writeFile(join(rolesDir, "a.md"), role);
	await writeFile(join(rolesDir, "b.md"), role);

	const catalog = loadRoleCatalog(agentDir);
	assert.deepEqual(catalog.errors.map(({ file, name }) => [file, name]), [[join(rolesDir, "a.md"), "dup"], [join(rolesDir, "b.md"), "dup"]]);
	assert.match(catalog.errors[0]!.message, /Duplicate Subagent role: dup/);
	assert.deepEqual(catalog.roles.map(({ name }) => name), ["implementer", "reviewer", "scout"]);
	assert.throws(() => findRole(catalog, "dup"), /Subagent role dup is unavailable: .*a\.md: Duplicate/);
});

test("unknown Role frontmatter keys are rejected per file without hiding valid Roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "good.md"), "---\nname: good\ndescription: d\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	await writeFile(join(rolesDir, "scout.md"), "---\nname: scout\ndescription: d\ntools: []\nextensions: []\nskills: []\nreadOnly: true\n---\nBody.\n");
	await writeFile(join(rolesDir, "garbled.md"), "not frontmatter");
	const catalog = loadRoleCatalog(agentDir);
	assert.deepEqual(catalog.roles.map(({ name }) => name), ["implementer", "reviewer", "good"], "an invalid override blocks the built-in it claims");
	assert.deepEqual(catalog.errors.map(({ name }) => name), ["garbled", "scout"]);
	assert.equal(catalog.errors[1]!.message, `${join(rolesDir, "scout.md")}: unknown Role frontmatter key "readOnly"; expected name, description, modelClass, tools, extensions, skills, mcps.`);
	assert.deepEqual([...catalog.sources], [["implementer", "built-in"], ["reviewer", "built-in"], ["good", "user"]]);
	assert.throws(() => findRole(catalog, "scout"), /scout\.md: unknown Role frontmatter key "readOnly"/);
	assert.throws(() => findRole(catalog, "missing"), /Unknown Subagent role: missing\. Available roles: implementer, reviewer, good\. 2 invalid Role file\(s\)/);
});

test("roleDefaults merge into every Role first and deduplicate", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "config.json"), JSON.stringify({ maxSubagents: 2, roleDefaults: { extensions: ["/provider.ts"], tools: ["read", "codegraph_explore"], skills: ["house-style"] } }));
	await writeFile(join(rolesDir, "scout.md"), "---\nname: scout\ndescription: d\ntools: [grep, read]\nextensions: [/provider.ts, /other.ts]\nskills: []\n---\nBody.\n");
	const catalog = loadRoleCatalog(agentDir);
	assert.deepEqual(catalog.sources.get("scout"), "user override");
	assert.deepEqual(catalog.roles.map(({ name, tools, extensions, skills }) => ({ name, tools, extensions, skills })), [
		{ name: "implementer", tools: ["read", "codegraph_explore", "bash", "edit", "write", "grep", "find", "ls"], extensions: ["/provider.ts"], skills: ["house-style"] },
		{ name: "reviewer", tools: ["read", "codegraph_explore", "grep", "find", "ls", "git_read"], extensions: ["/provider.ts"], skills: ["house-style"] },
		{ name: "scout", tools: ["read", "codegraph_explore", "grep"], extensions: ["/provider.ts", "/other.ts"], skills: ["house-style"] },
	]);
	await writeFile(join(rolesDir, "config.json"), JSON.stringify({ roleDefaults: { extensions: ["relative.ts"], skills: ["house-style"], mcps: [] } }));
	assert.deepEqual(loadRoleCatalog(agentDir).roles.find(({ name }) => name === "implementer")!.skills, ["house-style"], "invalid roleDefaults keys are dropped");
	// The extension blocks delegation for a bad limit; the Role catalog of other consumers stays available.
	await writeFile(join(rolesDir, "config.json"), JSON.stringify({ maxTokens: "many", roleDefaults: { skills: ["house-style"] } }));
	assert.deepEqual(loadRoleCatalog(agentDir).roles.find(({ name }) => name === "implementer")!.skills, ["house-style"]);
	await writeFile(join(rolesDir, "config.json"), "{ not json");
	assert.throws(() => loadRoleCatalog(agentDir), /config\.json: invalid JSON/);

	// Catalog consumers report roleDefaults issues, but not the execution-limit issues that the extension owns.
	const path = join(rolesDir, "config.json");
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const report = registerRoleDefaultsReporting({ on: (_event: string, handler: typeof sessionStart) => { sessionStart = handler; } } as never, agentDir);
	const notices: Array<[string, string]> = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notices.push([message, level]) } } as never;
	await writeFile(path, JSON.stringify({ maxTokens: "many", roleDefaults: { mcps: [] } }));
	sessionStart!({}, ctx);
	report(ctx);
	assert.deepEqual(notices, [[`pi-subagent config issues (${path}): roleDefaults.mcps: unknown key; defaults replace invalid settings.`, "warning"]]);
	await writeFile(path, JSON.stringify({ roleDefaults: { mcps: [], tools: "read" } }));
	report(ctx);
	assert.deepEqual(notices.at(-1), [`pi-subagent config issues (${path}): roleDefaults.tools: roleDefaults: tools must be an array of strings.; defaults replace invalid settings.`, "warning"]);
});
