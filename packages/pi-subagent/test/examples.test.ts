import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadRoles } from "../src/index.ts";

const samplesDir = fileURLToPath(new URL("../examples/roles/", import.meta.url));

const packageDir = fileURLToPath(new URL("../", import.meta.url));

test("bundled delegated-development Skill is valid and registered", async () => {
	const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));

	const skill = await readFile(
		join(packageDir, "skills", "delegated-development", "SKILL.md"),
		"utf8",
	);
	assert.match(skill, /^name: delegated-development$/m);
	assert.match(skill, /^description: .+/m);
});

test("copyable Role samples load from an isolated agent directory", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-examples-"));
	const rolesDir = join(agentDir, "config", "pi-subagent");
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(rolesDir, { recursive: true });
	await Promise.all([
		copyFile(join(samplesDir, "scout.md"), join(rolesDir, "scout.md")),
		copyFile(join(samplesDir, "implementer.md"), join(rolesDir, "implementer.md")),
		symlink(join(samplesDir, "reviewer.md"), join(rolesDir, "reviewer.md")),
		symlink(join(samplesDir, "synthesizer.md"), join(rolesDir, "synthesizer.md")),
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
