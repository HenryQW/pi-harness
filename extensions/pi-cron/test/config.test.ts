import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { cronConfigStore, effectiveLimits, jobEnabled, jobNotify, jobSchedule } from "../internal/config.ts";

const digest = {
	id: "digest",
	at: "07:30",
	timezone: "Asia/Hong_Kong",
	role: "digest",
	modelClass: "balanced",
	cwd: "/Users/me/Digest",
	env: { MINIFLUX_URL: "https://reader.example.org" },
	promptFile: "/Users/me/Digest/preferences.md",
};

const agentDir = mkdtempSync(join(tmpdir(), "pi-cron-config-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
const store = cronConfigStore(agentDir);
mkdirSync(dirname(store.path), { recursive: true });

function load(value: unknown) {
	writeFileSync(store.path, JSON.stringify(value));
	const loaded = store.loadSync();
	assert(loaded.status === "ok");
	return loaded;
}

test("a valid config round-trips its shape and derives schedule, defaults, and limits", () => {
	const { value: config, issues } = load({ jobs: [digest, { id: "sweep", every: "6h", role: "scout", cwd: "/tmp", prompt: "x", enabled: false, notify: "none" }] });
	assert.deepEqual(issues, []);
	assert.deepEqual(config.jobs[0], digest);
	assert.deepEqual(jobSchedule(config.jobs[0]!), { kind: "at", hour: 7, minute: 30, timeZone: "Asia/Hong_Kong" });
	assert.deepEqual(jobSchedule(config.jobs[1]!), { kind: "every", everyMs: 6 * 3_600_000 });
	assert.equal(jobEnabled(config.jobs[0]!), true);
	assert.equal(jobEnabled(config.jobs[1]!), false);
	assert.equal(jobNotify(config.jobs[0]!), "notify");
	assert.equal(jobNotify(config.jobs[1]!), "none");
	assert.deepEqual(effectiveLimits(config), { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 });
	assert.deepEqual(effectiveLimits(load({ jobs: [], limits: { maxTurns: 5 } }).value), { maxTurns: 5, idleMinutes: 10, maxMinutes: 30 });
});

test("timeout minutes cannot exceed the executor timer range", () => {
	const maxMinutes = (2_147_483_647 - 1) / 60_000;
	assert.equal(load({ jobs: [], limits: { maxMinutes } }).value.limits!.maxMinutes, maxMinutes);
	for (const field of ["idleMinutes", "maxMinutes"]) {
		const loaded = load({ jobs: [], limits: { [field]: maxMinutes + 1 } });
		assert.deepEqual(loaded.issues.map((issue) => `${issue.key}: ${issue.message}`), [`limits.${field}: must be positive minutes within the 2147483647 ms timer limit`]);
		assert.deepEqual(effectiveLimits(loaded.value), { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 });
	}
});

test("explicit model routes canonicalize numbered Codex aliases", () => {
	const [job] = load({ jobs: [{ ...digest, modelClass: undefined, model: "openai-codex-2/gpt-5", thinking: "high" }] }).value.jobs;
	assert.equal(job!.model, "openai-codex/gpt-5");
});

test("a bad job is dropped and reported while the other jobs load", () => {
	const valid = { id: "valid", every: "1h", role: "scout", cwd: "/tmp", prompt: "x" };
	const cases: Array<[unknown, RegExp]> = [
		[{ ...digest, foo: 1 }, /Job digest has unknown keys: foo/],
		[{ ...digest, every: "1h" }, /exactly one of every or at/],
		[{ ...digest, at: undefined, timezone: undefined, every: "30s" }, /every must be like/],
		[{ ...digest, at: "7:30" }, /at must be HH:MM/],
		[{ ...digest, timezone: "Mars/Olympus" }, /IANA time zone/],
		[{ ...digest, at: undefined, every: "1h" }, /timezone requires at/],
		[{ ...digest, model: "x/y", thinking: "low" }, /both modelClass and model/],
		[{ ...digest, modelClass: undefined, model: "x/y" }, /model and thinking must be set together/],
		[{ ...digest, modelClass: "huge" }, /modelClass must be one of/],
		[{ ...digest, cwd: "Digest" }, /cwd must be an absolute path/],
		[{ ...digest, env: { "1BAD": "x" } }, /invalid variable name/],
		[{ ...digest, prompt: "x" }, /exactly one of prompt or promptFile/],
		[{ ...digest, notify: "email" }, /notify must be one of/],
		[{ ...digest, id: "Digest!" }, /id must match/],
		[valid, /duplicates "valid"/],
	];
	for (const [job, pattern] of cases) {
		const { value, issues } = load({ jobs: [valid, job] });
		assert.deepEqual(value.jobs, [valid], JSON.stringify(job));
		assert.equal(issues.length, 1, JSON.stringify(issues));
		assert.equal(issues[0]!.key, "jobs[1]");
		assert.match(issues[0]!.message, pattern);
	}
});

test("unknown keys and invalid limits warn and use defaults", () => {
	const loaded = load({ jobs: [], limitz: {}, limits: { maxTurns: 0, idleMinutes: 5, extra: 1 } });
	assert.deepEqual(loaded.issues.map(({ kind, key }) => `${kind} ${key}`), ["unknown-key limitz", "unknown-key limits.extra", "invalid-value limits.maxTurns"]);
	assert.deepEqual(effectiveLimits(loaded.value), { maxTurns: 50, idleMinutes: 5, maxMinutes: 30 });

	const pair = load({ jobs: [], limits: { maxTurns: 3, idleMinutes: 30, maxMinutes: 10 } });
	assert.deepEqual(pair.issues.map(({ key, message }) => `${key}: ${message}`), ["limits: maxMinutes must be greater than idleMinutes"]);
	assert.deepEqual(effectiveLimits(pair.value), { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 });
});
