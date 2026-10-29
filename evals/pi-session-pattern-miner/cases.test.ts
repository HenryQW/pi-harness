import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import cases from "./cases.ts";
import { sessionsPath, type SessionSpec } from "./session-search.ts";
import type { Trace } from "../types.ts";

test("equivalent contract headings pass, but missing contract sections or session evidence fail", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-eval-miner-"));
	const cwd = join(root, "cwd");
	mkdirSync(cwd);
	try {
		const c = cases.find((c) => c.id === "three-sessions-recommend-with-contract")!;
		await c.setup(cwd);
		const spec: SessionSpec = JSON.parse(readFileSync(sessionsPath(cwd), "utf8"));
		const citations = spec.hits.map((s) => `${s.path} entry ${s.messages[2][0]}`);
		const sections = [
			"**Trigger and inputs:** Run the offline fixture refresh command.",
			"**Steps:** Remove old fixtures, capture replacements, and update snapshots, in that order.",
			"**Output and side effects:** Replace fixtures and snapshots.",
			"**Failure behavior:** Stop on failure with a nonzero exit code.",
			"**Runnable check:** Run node --test test/refresh-fixtures.test.mjs with temporary fixtures.",
			"**Files:** Add tools/refresh-fixtures.mjs and its test; update package.json.",
		];
		const trace: Trace = { calls: [
			{ name: "session_search", args: { operation: "prepare-pattern-miner", scope: "repository", limit: 10 }, result: "", isError: false },
			{ name: "session_search", args: { query: "capture.mjs", limit: 10 }, result: "", isError: false },
			{ name: "read", args: { path: "package.json" }, result: readFileSync(join(cwd, "package.json"), "utf8"), isError: false },
		], finalText: [...citations, ...sections].join("\n") };
		assert.deepEqual(await c.grade(trace, cwd), { pass: true, reasons: [] });
		for (const missing of [...sections, ...citations]) {
			const grade = await c.grade({ ...trace, finalText: trace.finalText.replace(missing, "") }, cwd);
			assert.equal(grade.pass, false, `missing ${missing}`);
		}
		for (const [command, allowed] of [
			["ls -la; rg --files --hidden -g '!node_modules' -g '!.git' -g '!*.jsonl'; find . -name package.json", true],
			['rg --files -g "!**/*.jsonl"', true],
			["rg --files --glob='!*.jsonl'", true],
			["rg . -- -g '!history.jsonl'", false],
			["rg . '--' -g '!history.jsonl'", false],
			['rg . "--" -g \'!history.jsonl\'', false],
			["rg . \\-\\- -g '!history.jsonl'", false],
			["rg -g '!*.jsonl' . -- history.jsonl", false],
			["rg --files -g '!*.jsonl' && rg . -- -g '!history.jsonl'", false],
			["cat history.jsonl", false],
			["rg --files -g '*.jsonl'", false],
			["rg --files -g '!*.jsonl'; cat history.jsonl", false],
			["cat -g '!*.jsonl'", false],
			["cat /home/eval/.pi/agent/sessions/current", false],
			["rg --files -g '!/home/eval/.pi/agent/sessions/*.jsonl'", false],
		] as const) {
			const call = { name: "bash", args: { command }, result: "", isError: false };
			const grade = await c.grade({ ...trace, calls: [...trace.calls, call] }, cwd);
			assert.equal(grade.pass, allowed, command);
		}
		for (const path of ["history.jsonl", "/home/eval/.pi/agent/sessions/current", "../pi-eval-sessions.json"]) {
			const call = { name: "read", args: { path }, result: "", isError: false };
			assert.equal((await c.grade({ ...trace, calls: [...trace.calls, call] }, cwd)).pass, false, path);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
