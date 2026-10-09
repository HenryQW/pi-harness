import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectHerdr, directSessionTokens, directSessionUsage, exactDirectAnswer, exactDirectTerminalTurn } from "../src/direct-herdr.ts";

const prompt = "inspect\n\nTurn identity: unique";
const lines = (messages: unknown[]) => [
	{ type: "session", id: "session" },
	{ type: "message", id: "user", parentId: "session", message: { role: "user", content: [{ type: "text", text: prompt }] } },
	...messages,
].map((line) => JSON.stringify(line)).join("\n") + "\n";

test("native Pi session records exact bounded final assistant text, not interim output", () => {
	const session = lines([
		{ type: "message", id: "tool", parentId: "user", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "interim" }] } },
		{ type: "message", id: "final", parentId: "tool", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "exact answer" }] } },
	]);
	assert.equal(exactDirectAnswer(session, prompt), "exact answer");
	assert.throws(() => exactDirectAnswer(session, "other prompt"), /exact successful final answer/);
	assert.throws(() => exactDirectAnswer(session, prompt, 5), /exceeds the 5-byte workflow limit/);
});

test("direct completion follows exact ancestry through non-message session entries", () => {
	const entries = [
		{ type: "model_change", id: "model", parentId: "user", provider: "test", modelId: "test" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
		{ type: "custom", id: "custom", parentId: "thinking", customType: "test", data: {} },
	];
	const final = { type: "message", id: "final", parentId: "custom", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ outcome: "succeeded", answer: "Done." }) }],
	} };
	const session = lines([...entries, final]);
	assert.equal(exactDirectAnswer(session, prompt, 1024, true), "Done.");
	assert.equal(exactDirectTerminalTurn(session, prompt), true);
	assert.throws(() => exactDirectAnswer(session, `${prompt}\n`, 1024, true), /exact successful final answer/);
	for (const parentId of ["missing", "custom", "session"]) {
		const unrelated = lines([...entries.slice(0, -1), { ...entries[2], parentId }, final]);
		assert.throws(() => exactDirectAnswer(unrelated, prompt, 1024, true), /exact successful final answer/);
		assert.equal(exactDirectTerminalTurn(unrelated, prompt), false);
	}
});

test("potential-writer final turns require an explicit successful completion", () => {
	const session = (text: string) => lines([{ type: "message", id: "final", parentId: "user", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }]);
	assert.equal(exactDirectAnswer(session(JSON.stringify({ outcome: "succeeded", answer: "Scoped commit completed." })), prompt, 1024, true), "Scoped commit completed.");
	for (const outcome of ["failed", "blocked"]) {
		assert.throws(() => exactDirectAnswer(session(JSON.stringify({ outcome, answer: "Partial changes remain." })), prompt, 1024, true), /Direct task reported .*Partial changes remain/);
	}
	for (const text of ["Commit failed; partial changes remain.", "null", JSON.stringify({ answer: "Turn finished." }), JSON.stringify({ outcome: "succeeded", answer: "" })]) {
		assert.throws(() => exactDirectAnswer(session(text), prompt, 1024, true), /Pi potential-writer/);
	}
});

test("exact terminal turn evidence includes failed and aborted assistant turns but not interim output", () => {
	for (const stopReason of ["stop", "error", "aborted"]) {
		const session = lines([{ type: "message", id: "final", parentId: "user", message: { role: "assistant", stopReason, content: [] } }]);
		assert.equal(exactDirectTerminalTurn(session, prompt), true);
		assert.equal(exactDirectTerminalTurn(session, "different prompt"), false);
	}
	assert.equal(exactDirectTerminalTurn(lines([{ type: "message", id: "tool", parentId: "user", message: { role: "assistant", stopReason: "toolUse", content: [] } }]), prompt), false);
});

test("direct usage counts only completed Pi usage records for the exact turn", () => {
	const usage = (input: number) => ({ input, output: 2, cacheRead: 3, cacheWrite: 4 });
	const session = lines([
		{ type: "message", id: "one", message: { role: "assistant", usage: usage(10) } },
		{ type: "message", id: "two", message: { role: "assistant", usage: usage(20) } },
	]) + '{"type":"message"';
	assert.equal(directSessionTokens(session, prompt), 48);
	assert.equal(directSessionTokens(session, "another prompt"), undefined);
	assert.equal(directSessionTokens(lines([]), prompt), undefined);
});

test("direct activity matches parallel results by ID and uses only the latest recorded result duration", () => {
	const calls = { type: "message", id: "calls", message: { role: "assistant", timestamp: 1, durationMs: 999,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs?: number) => ({ type: "message", id: toolCallId, message: {
		role: "toolResult", toolCallId, toolName: "ignored result name", timestamp: 10_000, durationMs,
	} });
	assert.deepEqual(directSessionUsage(lines([calls]), prompt).activity, { pending: ["read", "bash"], latest: undefined });
	assert.deepEqual(directSessionUsage(lines([calls, result("b", 2400)]), prompt).activity,
		{ pending: ["read"], latest: { name: "bash", durationMs: 2400 } });
	assert.deepEqual(directSessionUsage(lines([calls, result("b", 2400), result("a", 125), result("unknown", 9999)]), prompt).activity,
		{ pending: [], latest: { name: "read", durationMs: 125 } });
});

test("direct activity waits for a full trailing result and omits absent or invalid timing", () => {
	const call = { type: "message", id: "call", message: { role: "assistant", timestamp: 1,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs: unknown) => ({ type: "message", id: "result", message: {
		role: "toolResult", toolCallId, durationMs, timestamp: 9999,
	} });
	const prefix = lines([call, result("a", 250)]);
	const final = JSON.stringify(result("b", 800));
	assert.deepEqual(directSessionUsage(prefix + final.slice(0, -2), prompt).activity,
		{ pending: ["bash"], latest: { name: "read", durationMs: 250 } });
	assert.deepEqual(directSessionUsage(prefix + final + "\n", prompt).activity,
		{ pending: [], latest: { name: "bash", durationMs: 800 } });
	for (const durationMs of [undefined, -1, "800"]) {
		assert.deepEqual(directSessionUsage(prefix + JSON.stringify(result("b", durationMs)), prompt).activity,
			{ pending: [], latest: { name: "bash" } });
	}
});

test("direct activity stays inside the exact prompt boundary and resets on a new exact task", () => {
	const call = (id: string, name: string) => ({ type: "message", id, message: { role: "assistant",
		content: [{ type: "toolCall", id, name }] } });
	const result = (toolCallId: string) => ({ type: "message", id: "result", message: { role: "toolResult", toolCallId, durationMs: 900 } });
	const user = (text: string) => ({ type: "message", id: "next", message: { role: "user", content: [{ type: "text", text }] } });
	const session = JSON.stringify(call("old", "old tool")) + "\n" + lines([
		result("old"), call("task", "task tool"), user(`${prompt} extra`), result("task"), call("other", "other tool"),
	]);
	assert.deepEqual(directSessionUsage(session, prompt).activity, { pending: ["task tool"], latest: undefined });
	assert.equal(directSessionUsage(session, "different prompt").activity, undefined);
	const next = session + [user(prompt), result("task"), call("new", "new tool")].map((entry) => JSON.stringify(entry)).join("\n");
	assert.deepEqual(directSessionUsage(next, prompt).activity, { pending: ["new tool"], latest: undefined });
});

test("native Pi session errors and unrelated turns cannot masquerade as successful results", () => {
	for (const message of [
		{ type: "message", id: "error", parentId: "user", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "model failed" }] } },
		{ type: "message", id: "orphan", parentId: "session", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "unrelated" }] } },
	]) assert.throws(() => exactDirectAnswer(lines([message]), prompt), /exact successful final answer/);
	assert.throws(() => exactDirectAnswer(lines([
		{ type: "message", id: "second-user", parentId: "user", message: { role: "user", content: [{ type: "text", text: "hijack" }] } },
		{ type: "message", id: "final", parentId: "second-user", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "wrong turn" }] } },
	]), prompt), /unexpected user turn/);
});


test("stop accepts native unnamed unrelated agents without authorizing mutations", async (t) => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-direct-native-list-")));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const leasePath = join(cwd, "process.lease");
	await writeFile(leasePath, "", { mode: 0o600 });
	const previous = { ...process.env };
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "owned-workspace", HERDR_PANE_ID: "caller" });
	t.after(() => { for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID"]) {
		if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	} });
	const tab = { name: "owned", tabId: "owned-tab", paneId: "owned-pane", leasePath, sessionFile: join(cwd, "session.jsonl") };
	for (const paneId of ["unrelated-pane", "owned-pane"]) {
		const exec: ExtensionAPI["exec"] = async (command, args) => {
			if (command === "lsof") return { code: 1, stdout: "", stderr: "", killed: false };
			assert.equal(args[1], "list", "the native-shape probe forbids all mutation calls");
			const result = args[0] === "agent" ? { type: "agent_list", agents: [{ agent: "pi", pane_id: paneId, tab_id: "unrelated-tab" }] }
				: { type: "pane_list", panes: [] };
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false };
		};
		const stopping = createDirectHerdr({ exec }, cwd, 1000).stop(tab);
		if (paneId === "owned-pane") await assert.rejects(stopping, /one exact owned agent/);
		else await stopping;
	}
});
