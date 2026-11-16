import assert from "node:assert/strict";
import test from "node:test";
import { dueAt, latestOccurrence, nextRunAt, parseEvery, type Schedule } from "../internal/schedule.ts";

const hk: Schedule = { kind: "at", hour: 7, minute: 30, timeZone: "Asia/Hong_Kong" };
const T = (iso: string) => Date.parse(iso);

test("parseEvery accepts minutes, hours, and days within 1m..7d", () => {
	assert.equal(parseEvery("15m"), 15 * 60_000);
	assert.equal(parseEvery("6h"), 6 * 3_600_000);
	assert.equal(parseEvery("7d"), 7 * 86_400_000);
	for (const bad of ["0m", "8d", "90s", "1.5h", "", "h"]) assert.equal(parseEvery(bad), undefined, bad);
});

test("interval jobs are due one interval after the anchor and collapse a backlog into one run", () => {
	const every: Schedule = { kind: "every", everyMs: 3_600_000 };
	const anchor = T("2026-10-03T00:00:00Z");
	assert.equal(dueAt(every, anchor + 3_599_999, anchor), undefined);
	assert.equal(dueAt(every, anchor + 3_600_000, anchor), anchor + 3_600_000);
	assert.equal(dueAt(every, anchor + 10 * 3_600_000, anchor), anchor + 3_600_000);
	assert.equal(nextRunAt(every, anchor + 60_000, anchor), anchor + 3_600_000);
});

test("07:30 Hong Kong resolves to 23:30 UTC of the previous calendar day", () => {
	assert.equal(latestOccurrence(hk, T("2026-10-03T00:00:00Z")), T("2026-10-02T23:30:00Z"));
	// 07:00 HKT is before today's slot, so the latest occurrence is yesterday's.
	assert.equal(latestOccurrence(hk, T("2026-10-02T23:00:00Z")), T("2026-10-01T23:30:00Z"));
	assert.equal(latestOccurrence(hk, T("2026-10-02T23:30:00Z")), T("2026-10-02T23:30:00Z"));
});

test("clock jobs are due once per slot and a new job waits for its next slot", () => {
	const slot = T("2026-10-02T23:30:00Z");
	const firstSeen = T("2026-10-02T04:00:00Z");
	assert.equal(dueAt(hk, slot - 1, firstSeen), undefined);
	assert.equal(dueAt(hk, slot, firstSeen), slot);
	assert.equal(dueAt(hk, slot + 5 * 3_600_000, firstSeen), slot, "missed slot still fires once");
	assert.equal(dueAt(hk, slot + 5 * 3_600_000, slot + 60_000), undefined, "ran after the slot");
	assert.equal(nextRunAt(hk, slot + 60_000, slot + 60_000), slot + 86_400_000);
	assert.equal(nextRunAt(hk, slot - 3_600_000, firstSeen), slot);
});

test("clock jobs follow a daylight-saving transition", () => {
	const ny: Schedule = { kind: "at", hour: 2, minute: 30, timeZone: "America/New_York" };
	// 2026-03-08 02:30 local does not exist; the skipped slot resolves one hour early (01:30 EST) and still fires once.
	assert.equal(latestOccurrence(ny, T("2026-03-08T12:00:00Z")), T("2026-03-08T06:30:00Z"));
	// Ordinary winter day: 02:30 EST is 07:30 UTC; ordinary summer day: 02:30 EDT is 06:30 UTC.
	assert.equal(latestOccurrence(ny, T("2026-01-10T12:00:00Z")), T("2026-01-10T07:30:00Z"));
	assert.equal(latestOccurrence(ny, T("2026-07-10T12:00:00Z")), T("2026-07-10T06:30:00Z"));
});
