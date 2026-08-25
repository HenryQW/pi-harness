import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContextInjection, collectSkillPaths, findFiles, scanDirContext } from "../extensions/add-dir-helpers.ts";

test("registers external skills without duplicating Pi's skill prompt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	try {
		const skill = join(dir, ".pi", "skills", "demo", "SKILL.md");
		await mkdir(join(skill, ".."), { recursive: true });
		await writeFile(join(dir, "AGENTS.md"), "Follow external instructions.\n");
		await writeFile(skill, "---\ndescription: Native Pi skill\n---\n");

		const added = [{ absolutePath: dir, label: "external" }];
		assert.deepEqual(collectSkillPaths(added), [skill]);
		assert.deepEqual([...scanDirContext(dir).skills], ["demo"]);
		const injection = buildContextInjection(added);
		assert.match(injection, /Follow external instructions/);
		assert.doesNotMatch(injection, /Native Pi skill|Skills from/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("returns no results when an external directory disappears", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-"));
	await rm(dir, { recursive: true, force: true });
	assert.deepEqual(await findFiles(dir, "*.ts", 1), []);
});
