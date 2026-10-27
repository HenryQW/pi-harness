import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateMutation } from "../extensions/memory.ts";
import { reviewGroup, reviewInboxStore, type InboxItem } from "../src/inbox.ts";

const exec = promisify(execFile);

// All Git paths below are disposable fixtures. No commit or checkout is used.
test("canonical common Git directory groups linked worktrees; non-Git starting directories stay separate", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-groups-"));
	try {
		const repo = join(root, "repo");
		const linked = join(root, "linked");
		await exec("git", ["init", repo]);
		await exec("git", ["-C", repo, "worktree", "add", "--orphan", "-b", "linked", linked]);
		await mkdir(join(repo, "nested"));
		await symlink(repo, join(root, "alias"));
		const group = await reviewGroup(repo);
		assert.equal(group, `git:${await realpath(join(repo, ".git"))}`);
		assert.equal(await reviewGroup(linked), group);
		assert.equal(await reviewGroup(join(repo, "nested")), group);
		assert.equal(await reviewGroup(join(root, "alias")), group);
		const bare = join(root, "bare repository ");
		await exec("git", ["init", "--bare", bare]);
		assert.equal(await reviewGroup(bare), `git:${await realpath(bare)}`);
		await mkdir(join(root, "non-git"));
		assert.equal(await reviewGroup(root), `cwd:${await realpath(root)}`);
		assert.notEqual(await reviewGroup(join(root, "non-git")), await reviewGroup(root));
		await assert.rejects(reviewGroup(join(root, "missing")), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("group lookup ignores inherited Git repository selection for Git and non-Git directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-inherited-git-"));
	const inherited = { ...process.env };
	try {
		const current = join(root, "current");
		const other = join(root, "other");
		await exec("git", ["init", current]);
		await exec("git", ["init", other]);
		Object.assign(process.env, {
			GIT_DIR: join(other, ".git"), GIT_COMMON_DIR: join(other, ".git"), GIT_WORK_TREE: other,
			GIT_INDEX_FILE: join(other, ".git", "index"), GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"),
			GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: other,
		});
		assert.equal(await reviewGroup(current), `git:${await realpath(join(current, ".git"))}`);
		assert.equal(await reviewGroup(root), `cwd:${await realpath(root)}`);
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in inherited)) delete process.env[name];
		Object.assign(process.env, inherited);
		await rm(root, { recursive: true, force: true });
	}
});

test("inbox diagnostics omit private parser excerpts and untrusted keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-private-errors-"));
	try {
		const store = reviewInboxStore(validateMutation, root);
		await mkdir(join(root, "config", "pi-memory"), { recursive: true });
		const marker = "PRIVATE_CANDIDATE_SENTINEL";
		for (const raw of [`${marker} is not JSON`, JSON.stringify({ [marker]: [], items: [] })]) {
			await writeFile(store.path, raw);
			const loaded = store.loadSync();
			assert.ok(loaded.issues.length);
			assert.ok(!JSON.stringify(loaded.issues).includes(marker));
			await assert.rejects(store.update(() => ({ items: [] })), (error: Error) => {
				assert.ok(!error.message.includes(marker));
				assert.ok(error.message.includes(store.path));
				return true;
			});
			assert.equal(await readFile(store.path, "utf8"), raw);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("independent processes preserve concurrent inbox appends and removals with private permissions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-inbox-"));
	try {
		const store = reviewInboxStore(validateMutation, root);
		const item = (id: string): InboxItem => ({ id, directory: root, group: `cwd:${root}`, mutation: { target: "memory", action: "add", content: id } });
		await store.update(() => ({ items: [item("discard"), item("keep")] }));
		const code = `
			import { reviewInboxStore } from ${JSON.stringify(new URL("../src/inbox.ts", import.meta.url).href)};
			import { validateMutation } from ${JSON.stringify(new URL("../extensions/memory.ts", import.meta.url).href)};
			const [root, id] = process.argv.slice(1);
			await reviewInboxStore(validateMutation, root).update(({ items }) => ({ items: [
				...items.filter((item) => item.id !== "discard"),
				{ id, directory: root, group: "cwd:" + root + "/" + id, mutation: { target: "memory", action: "add", content: id } }
			] }));`;
		await Promise.all(Array.from({ length: 6 }, (_, index) => exec(process.execPath, ["--input-type=module", "-e", code, root, String(index)])));
		const loaded = reviewInboxStore(validateMutation, root).loadSync();
		assert.equal(loaded.status, "ok");
		if (loaded.status !== "ok") return;
		assert.deepEqual(loaded.value.items.map((entry) => entry.id).sort(), ["0", "1", "2", "3", "4", "5", "keep"]);
		if (process.platform !== "win32") {
			assert.equal((await stat(store.path)).mode & 0o777, 0o600);
			assert.equal((await stat(join(root, "config", "pi-memory"))).mode & 0o777, 0o700);
		}
		const original = await readFile(store.path, "utf8");
		await assert.rejects(store.update(({ items }) => ({ items: [...items, item("x".repeat(70_000))] })), /Cannot update review inbox/);
		assert.equal(await readFile(store.path, "utf8"), original);
		await writeFile(store.path, JSON.stringify({ items: [...loaded.value.items, { broken: true }] }));
		const damaged = await readFile(store.path, "utf8");
		await assert.rejects(store.update(() => ({ items: [] })), /Cannot update review inbox/);
		assert.equal(await readFile(store.path, "utf8"), damaged);
	} finally { await rm(root, { recursive: true, force: true }); }
});
