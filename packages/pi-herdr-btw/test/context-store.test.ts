import assert from "node:assert/strict";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ContextStore, MAX_PAYLOAD_FILE_BYTES } from "../internal/context-store.ts";
import { MERGE_PROTOCOL_VERSION, type MergeRequest } from "../internal/merge.ts";
import { fixturePayload as buildFixturePayload } from "./fixtures.ts";

async function createFixture(t: test.TestContext): Promise<{
	base: string;
	root: string;
	store: ContextStore;
}> {
	const base = await mkdtemp(join(tmpdir(), "pi-herdr-btw-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(base, { recursive: true, force: true });
	});
	const root = join(base, "store");
	return { base, root, store: new ContextStore(root) };
}

function fixturePayload(question = "draft") {
	return buildFixturePayload({ draftQuestion: question });
}

function fixtureRequest(payload: ReturnType<typeof fixturePayload>): MergeRequest {
	return {
		protocolVersion: MERGE_PROTOCOL_VERSION,
		requestId: "req-1",
		launchId: payload.launchId,
		parentSessionId: payload.parentSessionId,
		capability: payload.capability,
		createdAt: "2026-07-15T00:00:00.000Z",
		summary: "packaged side-thread transcript",
		prompt: "continue with the findings",
	};
}

test("ContextStore creates, reads, and removes a private launch payload", async (t) => {
	const { root, store } = await createFixture(t);
	const payload = fixturePayload("exact draft");
	const payloadPath = await store.create(payload);

	assert.deepEqual(await store.read(payloadPath), payload);
	if (process.platform !== "win32") {
		assert.equal((await lstat(root)).mode & 0o777, 0o700);
		assert.equal((await lstat(dirname(payloadPath))).mode & 0o777, 0o700);
		assert.equal((await lstat(payloadPath)).mode & 0o777, 0o600);
	}

	await store.remove(payloadPath);
	await assert.rejects(access(payloadPath), (error: unknown) => {
		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		return true;
	});
	await store.remove(payloadPath);
});

test("ContextStore rejects oversized payloads before creating a launch", async (t) => {
	const { root, store } = await createFixture(t);
	const oversized = fixturePayload();
	oversized.parentSystemPrompt = "x".repeat(MAX_PAYLOAD_FILE_BYTES);

	await assert.rejects(store.create(oversized), /oversized/);
	assert.deepEqual(await readdir(root), []);
});

test("ContextStore removes the launch directory when payload creation fails", async (t) => {
	const { root, store } = await createFixture(t);
	const unserializable = {
		...fixturePayload(),
		parentSystemPrompt: 1n,
	} as unknown as ReturnType<typeof fixturePayload>;

	await assert.rejects(store.create(unserializable), /BigInt/);
	assert.deepEqual(await readdir(root), []);
});

test("ContextStore repairs an existing owned root to private permissions", async (t) => {
	const { root, store } = await createFixture(t);
	await mkdir(root, { mode: 0o755 });
	await chmod(root, 0o755);
	await store.create(fixturePayload());
	if (process.platform !== "win32") {
		assert.equal((await lstat(root)).mode & 0o777, 0o700);
	}
});

test("ContextStore rejects payloads outside its private root", async (t) => {
	const { base, store } = await createFixture(t);
	const outsideDir = join(base, "launch-outside");
	await mkdir(outsideDir, { mode: 0o700 });
	const outsidePath = join(outsideDir, "payload.json");
	await writeFile(outsidePath, JSON.stringify(fixturePayload()), { mode: 0o600 });

	await assert.rejects(store.read(outsidePath), /outside the private root/);
	await assert.rejects(store.remove(outsidePath), /outside the private root/);
});

test("ContextStore rejects symlink payloads", async (t) => {
	if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
	const { base, store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	const targetPath = join(base, "target.json");
	await writeFile(targetPath, JSON.stringify(fixturePayload()), { mode: 0o600 });
	await import("node:fs/promises").then(({ rm }) => rm(payloadPath));
	await symlink(targetPath, payloadPath);

	await assert.rejects(store.read(payloadPath), /unsafe \/btw context payload/);
});

test("ContextStore rejects payload files with group or other permissions", async (t) => {
	if (process.platform === "win32") t.skip("POSIX mode checks do not apply on Windows");
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	await chmod(payloadPath, 0o644);
	await assert.rejects(store.read(payloadPath), /group or other permissions/);
});

test("ContextStore removes stale launches and preserves fresh launches", async (t) => {
	const { store } = await createFixture(t);
	const stalePath = await store.create(fixturePayload("stale"));
	const freshPath = await store.create(fixturePayload("fresh"));
	const now = Date.now();
	await utimes(dirname(stalePath), new Date(now - 10_000), new Date(now - 10_000));
	await utimes(dirname(freshPath), new Date(now), new Date(now));

	await store.removeStale(5_000, now);
	await assert.rejects(access(stalePath));
	await access(freshPath);
});

test("ContextStore touch keeps a live launch out of stale cleanup", async (t) => {
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload("live"));
	const now = Date.now();
	await utimes(dirname(payloadPath), new Date(now - 10_000), new Date(now - 10_000));

	await store.touch(payloadPath);
	await store.removeStale(5_000, now);
	await access(payloadPath);
});

test("ContextStore round-trips merge requests with private mode", async (t) => {
	const { store } = await createFixture(t);
	const payload = fixturePayload();
	const payloadPath = await store.create(payload);
	const request = fixtureRequest(payload);

	assert.equal(await store.readMergeRequest(payloadPath), undefined);
	await store.writeMergeRequest(payloadPath, request);
	assert.deepEqual(await store.readMergeRequest(payloadPath), request);
	if (process.platform !== "win32") {
		const requestPath = join(dirname(payloadPath), "merge-request.json");
		assert.equal((await lstat(requestPath)).mode & 0o777, 0o600);
	}
});

test("ContextStore rejects invalid and oversized mailbox writes", async (t) => {
	const { store } = await createFixture(t);
	const payload = fixturePayload();
	const payloadPath = await store.create(payload);

	await assert.rejects(
		store.writeMergeRequest(payloadPath, { ...fixtureRequest(payload), capability: "short" }),
		/Invalid \/btw merge request/,
	);

	const oversized = join(dirname(payloadPath), "merge-request.json");
	await writeFile(oversized, `{"padding":"${"x".repeat(130 * 1024)}"}`, { mode: 0o600 });
	await assert.rejects(store.readMergeRequest(payloadPath), /oversized/);
});

test("ContextStore keeps launches with pending merge requests", async (t) => {
	const { store } = await createFixture(t);
	const payload = fixturePayload();
	const payloadPath = await store.create(payload);
	const request = fixtureRequest(payload);

	// no merge at all -> removed
	assert.equal(await store.removeIfNoPendingMerge(payloadPath), true);
	await assert.rejects(access(payloadPath));

	const secondPath = await store.create(payload);
	await store.writeMergeRequest(secondPath, request);
	assert.equal(await store.removeIfNoPendingMerge(secondPath), false);
	await access(secondPath);
});

test("ContextStore retains a launch when its merge request cannot be read", async (t) => {
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	await writeFile(join(dirname(payloadPath), "merge-request.json"), "{", { mode: 0o600 });

	await assert.rejects(store.removeIfNoPendingMerge(payloadPath), SyntaxError);
	await access(payloadPath);
});

test("ContextStore lists launch payload paths inside the private root", async (t) => {
	const { store } = await createFixture(t);
	const first = await store.create(fixturePayload("one"));
	const second = await store.create(fixturePayload("two"));
	const listed = await store.listLaunchPayloadPaths();
	assert.deepEqual(new Set(listed), new Set([first, second]));
});

test("ContextStore rejects invalid payload contents", async (t) => {
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	await writeFile(payloadPath, '{"version":99}\n', { mode: 0o600 });
	await chmod(payloadPath, 0o600);
	await assert.rejects(store.read(payloadPath), /Invalid or unsupported/);
});
