import assert from "node:assert/strict";
import test from "node:test";
import { effectiveLimits, jobEnabled, jobNotify, jobSchedule, parseCronConfig } from "../internal/config.ts";

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

test("a valid config round-trips its shape and derives schedule, defaults, and limits", () => {
	const config = parseCronConfig({ jobs: [digest, { id: "sweep", every: "6h", role: "scout", cwd: "/tmp", prompt: "x", enabled: false, notify: "none" }] });
	assert.deepEqual(config.jobs[0], digest);
	assert.deepEqual(jobSchedule(config.jobs[0]!), { kind: "at", hour: 7, minute: 30, timeZone: "Asia/Hong_Kong" });
	assert.deepEqual(jobSchedule(config.jobs[1]!), { kind: "every", everyMs: 6 * 3_600_000 });
	assert.equal(jobEnabled(config.jobs[0]!), true);
	assert.equal(jobEnabled(config.jobs[1]!), false);
	assert.equal(jobNotify(config.jobs[0]!), "notify");
	assert.equal(jobNotify(config.jobs[1]!), "none");
	assert.deepEqual(effectiveLimits(config), { maxTurns: 50, idleMinutes: 10, maxMinutes: 30 });
	assert.deepEqual(effectiveLimits(parseCronConfig({ jobs: [], limits: { maxTurns: 5 } })), { maxTurns: 5, idleMinutes: 10, maxMinutes: 30 });
});

test("explicit model routes canonicalize numbered Codex aliases", () => {
	const [job] = parseCronConfig({ jobs: [{ ...digest, modelClass: undefined, model: "openai-codex-2/gpt-5", thinking: "high" }] }).jobs;
	assert.equal(job!.model, "openai-codex/gpt-5");
});

test("invalid configs are rejected with the offending field", () => {
	const cases: Array<[unknown, RegExp]> = [
		[{ jobs: [digest], extra: 1 }, /unknown keys: extra/],
		[{ jobs: [{ ...digest, foo: 1 }] }, /Job digest has unknown keys: foo/],
		[{ jobs: [{ ...digest, every: "1h" }] }, /exactly one of every or at/],
		[{ jobs: [{ ...digest, at: undefined, timezone: undefined, every: "30s" }] }, /every must be like/],
		[{ jobs: [{ ...digest, at: "7:30" }] }, /at must be HH:MM/],
		[{ jobs: [{ ...digest, timezone: "Mars/Olympus" }] }, /IANA time zone/],
		[{ jobs: [{ ...digest, at: undefined, every: "1h" }] }, /timezone requires at/],
		[{ jobs: [{ ...digest, model: "x/y", thinking: "low" }] }, /both modelClass and model/],
		[{ jobs: [{ ...digest, modelClass: undefined, model: "x/y" }] }, /model and thinking must be set together/],
		[{ jobs: [{ ...digest, modelClass: "huge" }] }, /modelClass must be one of/],
		[{ jobs: [{ ...digest, cwd: "Digest" }] }, /cwd must be an absolute path/],
		[{ jobs: [{ ...digest, env: { "1BAD": "x" } }] }, /invalid variable name/],
		[{ jobs: [{ ...digest, prompt: "x" }] }, /exactly one of prompt or promptFile/],
		[{ jobs: [{ ...digest, notify: "email" }] }, /notify must be one of/],
		[{ jobs: [{ ...digest, id: "Digest!" }] }, /id must match/],
		[{ jobs: [digest, digest] }, /Duplicate job id/],
		[{ jobs: [], limits: { idleMinutes: 30, maxMinutes: 10 } }, /maxMinutes must be greater/],
		[{ jobs: [], limits: { maxTurns: 0 } }, /maxTurns must be a safe integer/],
	];
	for (const [value, pattern] of cases) assert.throws(() => parseCronConfig(value), pattern, JSON.stringify(value));
});
