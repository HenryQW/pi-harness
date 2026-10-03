import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { StateStore } from "../internal/state.ts";

const schedule = { kind: "every", everyMs: 60_000 } as const;
const options = { owner: "original", staleMs: 100_000, force: true };

async function store(t: TestContext): Promise<StateStore> {
	const directory = await mkdtemp(join(tmpdir(), "pi-cron-state-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return new StateStore(join(directory, "state.json"));
}

test("a stale owner's completion cannot clear or overwrite a replacement claim", async (t) => {
	const state = await store(t);
	const original = (await state.claim("job", schedule, 1, options))!;
	const replacement = (await state.claim("job", schedule, 100_002, { ...options, owner: "replacement" }))!;
	const contents = await readFile(state.path, "utf8");
	const result = { finishedAt: 100_003, outcome: "success", summary: "done" } as const;
	assert.equal(await state.finish("job", original, result), false);
	assert.equal(await readFile(state.path, "utf8"), contents);
	assert.equal(await state.finish("job", { ...replacement, startedAt: 100_001 }, result), false);
	assert.equal(await state.finish("job", replacement, result), true);
	assert.equal(state.loadSync().jobs.job!.lastOutcome, "success");
});

test("shorter admission limits cannot expire a claim taken with a longer runtime", async (t) => {
	const state = await store(t);
	const original = (await state.claim("job", schedule, 1, options))!;
	assert.equal(original.expiresAt, 100_001);
	const shortened = { owner: "other", staleMs: 5, force: false };
	assert.equal(await state.claim("job", schedule, 60_001, shortened), undefined, "interval is due but the original deadline has not passed");
	const replacement = (await state.claim("job", schedule, original.expiresAt, shortened))!;
	assert.equal(replacement.owner, "other");
	assert.equal(replacement.expiresAt, 100_006);
});

test("not-due and held claims do not replace state; first sighting still records a baseline", async (t) => {
	const state = await store(t);
	assert.equal(await state.claim("constructor", schedule, 1, { ...options, force: false }), undefined);
	const baseline = await stat(state.path, { bigint: true });
	assert.equal(await state.claim("constructor", schedule, 2, { ...options, force: false }), undefined);
	assert.equal((await stat(state.path, { bigint: true })).mtimeNs, baseline.mtimeNs);
	await state.claim("constructor", schedule, 60_001, options);
	const active = await stat(state.path, { bigint: true });
	assert.equal(await state.claim("constructor", schedule, 60_002, options), undefined);
	assert.equal((await stat(state.path, { bigint: true })).mtimeNs, active.mtimeNs);
});

test("malformed nested state is reported without replacing the original file", async (t) => {
	const state = await store(t);
	const invalidRecords = [
		null, { firstSeenAt: "yesterday" }, { firstSeenAt: 1, lastStartedAt: -1 },
		{ firstSeenAt: 1, lastFinishedAt: 8.64e15 + 1 }, { firstSeenAt: 1, lastOutcome: "maybe" },
		{ firstSeenAt: 1, lastOutcome: "success" }, { firstSeenAt: 1, lastSummary: 1 },
		{ firstSeenAt: 1, lastSession: "relative.jsonl" }, { firstSeenAt: 1, extra: true },
		{ firstSeenAt: 1, running: { startedAt: "now", owner: "one", expiresAt: 3 } },
		{ firstSeenAt: 1, running: { startedAt: 1, owner: "", expiresAt: 3 } },
		{ firstSeenAt: 1, running: { startedAt: 1, owner: "one", expiresAt: 3, extra: true } },
		{ firstSeenAt: 1, running: { startedAt: 1, owner: "one" } },
		{ firstSeenAt: 1, running: { startedAt: 1, owner: "one", expiresAt: "later" } },
		{ firstSeenAt: 1, running: { startedAt: 1, owner: "one", expiresAt: 1 } },
	];
	for (const record of invalidRecords) {
		const contents = JSON.stringify({ version: 1, jobs: { job: record } });
		await writeFile(state.path, contents);
		await assert.rejects(state.claim("job", schedule, 2, options), /pi-cron state.*invalid/);
		assert.equal(await readFile(state.path, "utf8"), contents);
	}
	await writeFile(state.path, JSON.stringify({ version: 1, jobs: { "../job": { firstSeenAt: 1 } } }));
	assert.throws(() => state.loadSync(), /invalid job id/);
});

test("oversized writes fail before replacing readable state", async (t) => {
	const state = await store(t);
	const claim = (await state.claim("job", schedule, 1, options))!;
	const contents = await readFile(state.path, "utf8");
	await assert.rejects(state.finish("job", claim, { finishedAt: 2, outcome: "failure", summary: "x".repeat(1024 * 1024) }), /state exceeds.*Existing state was preserved/);
	assert.equal(await readFile(state.path, "utf8"), contents);
	assert.equal(await state.finish("job", claim, { finishedAt: 3, outcome: "success", summary: "short" }), true);
});
