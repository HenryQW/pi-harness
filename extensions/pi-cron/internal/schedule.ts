export type Schedule =
	| { kind: "every"; everyMs: number }
	| { kind: "at"; hour: number; minute: number; timeZone: string };

type ClockSchedule = Extract<Schedule, { kind: "at" }>;

const MINUTE_MS = 60_000;
const UNIT_MS = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS } as const;
const MIN_EVERY_MS = MINUTE_MS;
const MAX_EVERY_MS = 7 * UNIT_MS.d;

/** Parse `15m`, `6h`, or `1d` into milliseconds within the supported range. */
export function parseEvery(spec: string): number | undefined {
	const match = /^(\d{1,6})([mhd])$/.exec(spec);
	if (!match) return;
	const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
	return ms >= MIN_EVERY_MS && ms <= MAX_EVERY_MS ? ms : undefined;
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const PART_TYPES = new Set(["year", "month", "day", "hour", "minute", "second"]);

function zonedParts(instant: number, timeZone: string): Parts {
	const parts: Partial<Parts> = {};
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone, hourCycle: "h23",
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
	});
	for (const { type, value } of formatter.formatToParts(new Date(instant))) {
		if (PART_TYPES.has(type)) parts[type as keyof Parts] = Number(value);
	}
	return parts as Parts;
}

const asUtc = (p: Parts): number => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

/** Instant for a wall-clock time in a zone; two passes absorb a DST offset change at the guess. */
function zonedToUtc(local: Parts, timeZone: string): number {
	const wanted = asUtc(local);
	let instant = wanted;
	for (let pass = 0; pass < 2; pass += 1) instant += wanted - asUtc(zonedParts(instant, timeZone));
	return instant;
}

/** The schedule's wall-clock time on the zone-local day of `instant`, shifted by whole days. */
function clockOccurrence(instant: number, schedule: ClockSchedule, dayShift: number): number {
	const day = zonedParts(instant, schedule.timeZone);
	const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + dayShift));
	return zonedToUtc({
		year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
		hour: schedule.hour, minute: schedule.minute, second: 0,
	}, schedule.timeZone);
}

/** Most recent scheduled occurrence at or before `now`. */
export function latestOccurrence(schedule: ClockSchedule, now: number): number {
	const today = clockOccurrence(now, schedule, 0);
	return today <= now ? today : clockOccurrence(now, schedule, -1);
}

/**
 * Occurrence that makes the job due, or undefined when nothing is due.
 * `anchor` is the later of the job's first sighting and its last start, so a
 * backlog collapses into one catch-up run and a new job waits for its next slot.
 */
export function dueAt(schedule: Schedule, now: number, anchor: number): number | undefined {
	if (schedule.kind === "every") {
		const next = anchor + schedule.everyMs;
		return next <= now ? next : undefined;
	}
	const latest = latestOccurrence(schedule, now);
	return latest > anchor ? latest : undefined;
}

/** Next planned occurrence for display; an overdue job reports its pending occurrence. */
export function nextRunAt(schedule: Schedule, now: number, anchor: number): number {
	const due = dueAt(schedule, now, anchor);
	if (due !== undefined) return due;
	if (schedule.kind === "every") return anchor + schedule.everyMs;
	const today = clockOccurrence(now, schedule, 0);
	return today > now ? today : clockOccurrence(now, schedule, 1);
}

export function formatInstant(instant: number, timeZone?: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		...(timeZone ? { timeZone } : {}), hourCycle: "h23",
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
	}).format(new Date(instant));
}
