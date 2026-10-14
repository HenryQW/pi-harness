// Grader checks return a failure reason, or undefined when the check passes. Combine them with `check`.
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type { Grade, ToolCall, Trace } from "./types.ts";

type Reason = string | undefined;

/** Partial argument pattern. A RegExp tests a string value (other values as JSON); objects match recursively. */
export type ArgPattern = { [key: string]: unknown };

export function check(...results: Reason[]): Grade {
	const reasons = results.filter((reason): reason is string => reason !== undefined);
	return { pass: reasons.length === 0, reasons };
}

export function matches(value: unknown, pattern: unknown): boolean {
	if (pattern instanceof RegExp) return pattern.test(typeof value === "string" ? value : JSON.stringify(value));
	if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
		if (!value || typeof value !== "object") return false;
		return Object.entries(pattern).every(([key, expected]) => matches((value as Record<string, unknown>)[key], expected));
	}
	return isDeepStrictEqual(value, pattern);
}

export function callsTo(trace: Trace, name: string, pattern: ArgPattern = {}): ToolCall[] {
	return trace.calls.filter((call) => call.name === name && matches(call.args, pattern));
}

const describe = (name: string, pattern: ArgPattern) =>
	Object.keys(pattern).length ? `${name} ${JSON.stringify(pattern, (_key, value) => (value instanceof RegExp ? String(value) : value))}` : name;

/** Checks the number of calls to `name` that match `pattern`. */
export function calledTimes(trace: Trace, name: string, count: number | { min?: number; max?: number }, pattern: ArgPattern = {}): Reason {
	const actual = callsTo(trace, name, pattern).length;
	const { min, max } = typeof count === "number" ? { min: count, max: count } : count;
	if ((min === undefined || actual >= min) && (max === undefined || actual <= max)) return undefined;
	return `expected ${JSON.stringify(count)} call(s) to ${describe(name, pattern)}, got ${actual}`;
}

export function calledWith(trace: Trace, name: string, pattern: ArgPattern): Reason {
	return calledTimes(trace, name, { min: 1 }, pattern);
}

export function notCalled(trace: Trace, name: string, pattern: ArgPattern = {}): Reason {
	return calledTimes(trace, name, 0, pattern);
}

/** Fails when any built-in `bash` call runs a command that matches `command`. */
export function noBash(trace: Trace, command: RegExp): Reason {
	const hit = callsTo(trace, "bash", { command }).at(0);
	return hit && `unexpected bash command matching ${command}: ${String(hit.args.command).slice(0, 200)}`;
}

export function finalTextMatches(trace: Trace, pattern: RegExp): Reason {
	return pattern.test(trace.finalText) ? undefined : `final text does not match ${pattern}`;
}

/** Runs Git in `cwd` with the runner's hermetic environment and returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Commit subjects, newest first. */
export function gitSubjects(cwd: string, range = "HEAD"): string[] {
	const out = git(cwd, "log", "--format=%s", range);
	return out ? out.split("\n") : [];
}

/** `git status --porcelain` lines; empty when the worktree is clean. */
export function gitStatus(cwd: string): string[] {
	const out = git(cwd, "status", "--porcelain");
	return out ? out.split("\n") : [];
}
