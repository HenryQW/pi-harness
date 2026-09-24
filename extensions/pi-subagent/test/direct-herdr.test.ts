import assert from "node:assert/strict";
import test from "node:test";
import { directSessionTokens, exactDirectAnswer } from "../src/direct-herdr.ts";

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
