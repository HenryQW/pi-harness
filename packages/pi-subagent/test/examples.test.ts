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
	assert.match(skill, /git rev-parse --verify -q HEAD\^\{commit\}/);
	assert.match(skill, /refuse review or merge unless/i);
	assert.match(skill, /never review dirty or uncommitted work/i);
	assert.match(skill, /git diff --binary "\$base" "\$tip"/);
	assert.match(skill, /merge that exact commit \(not the branch name\)/i);
});

async function isolatedAgentDir(t: import("node:test").TestContext): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-examples-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	return agentDir;
}

test("missing config directory still returns validated built-in implementer and reviewer roles", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const [implementer, reviewer] = loadRoles(agentDir);

	assert.equal(implementer!.name, "implementer");
	assert.equal(implementer!.isolation, "worktree");
	assert.match(implementer!.systemPrompt, /Commit completed scoped changes locally/i);
	assert.match(implementer!.systemPrompt, /base commit, tip commit, changed files/i);
	assert.match(implementer!.systemPrompt, /[Nn]ever push or open pull requests without explicit authorization/i);
	assert.match(implementer!.systemPrompt, /[Nn]ever invoke external LLM APIs/i);

	assert.equal(reviewer!.name, "reviewer");
	assert.deepEqual(reviewer!.tools, ["read", "grep", "find", "ls"]);
	assert.match(reviewer!.systemPrompt, /Refuse review unless.*base commit, branch, tip commit, and complete exact base-to-tip patch/i);
	assert.match(reviewer!.systemPrompt, /[Nn]ever edit files, commit, push/i);
	assert.match(reviewer!.systemPrompt, /[Nn]ever invoke external LLM APIs/i);
});

test("a same-named user role overrides a built-in while other roles are added", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "my-implementer.md"), `---
name: implementer
description: Custom implementation policy
tools: [read]
---
Custom body.
`);
	await copyFile(join(samplesDir, "scout.md"), join(rolesDir, "scout.md"));

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
});

test("duplicate names among user role files remain an error", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "a.md"), "---\nname: dup\ndescription: d\n---\nBody.\n");
	await writeFile(join(rolesDir, "b.md"), "---\nname: dup\ndescription: d\n---\nBody.\n");

	assert.throws(() => loadRoles(agentDir), /Duplicate Subagent role: dup\./);
});

test("copyable Role samples load from an isolated agent directory", async (t) => {
	const agentDir = await isolatedAgentDir(t);
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await Promise.all([
		copyFile(join(samplesDir, "scout.md"), join(rolesDir, "scout.md")),
		copyFile(join(samplesDir, "synthesizer.md"), join(rolesDir, "synthesizer.md")),
	]);

	assert.deepEqual(loadRoles(agentDir).map(({ name, tools, isolation, extensions, skills }) => ({
		name, tools, isolation, extensions, skills,
	})), [
		{ name: "implementer", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], isolation: "worktree", extensions: [], skills: [] },
		{ name: "reviewer", tools: ["read", "grep", "find", "ls"], isolation: undefined, extensions: [], skills: [] },
		{ name: "scout", tools: ["read", "grep", "find", "ls"], isolation: undefined, extensions: [], skills: [] },
		{ name: "synthesizer", tools: ["read"], isolation: undefined, extensions: [], skills: [] },
	]);
});
