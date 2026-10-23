import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { appendFile, mkdtemp, open, realpath, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectHerdr, createDirectSessionReader, exactDirectAnswer, exactDirectTerminalTurn } from "../src/direct-herdr.ts";

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
	assert.equal(exactDirectAnswer(session, prompt, true), "Done.");
	assert.equal(exactDirectTerminalTurn(session, prompt), true);
	assert.throws(() => exactDirectAnswer(session, `${prompt}\n`, true), /exact successful final answer/);
	for (const parentId of ["missing", "custom", "session"]) {
		const unrelated = lines([...entries.slice(0, -1), { ...entries[2], parentId }, final]);
		assert.throws(() => exactDirectAnswer(unrelated, prompt, true), /exact successful final answer/);
		assert.equal(exactDirectTerminalTurn(unrelated, prompt), false);
	}
});

test("write-access final turns require an explicit successful completion", () => {
	const session = (text: string) => lines([{ type: "message", id: "final", parentId: "user", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }]);
	assert.equal(exactDirectAnswer(session(JSON.stringify({ outcome: "succeeded", answer: "Scoped commit completed." })), prompt, true), "Scoped commit completed.");
	for (const outcome of ["failed", "blocked"]) {
		assert.throws(() => exactDirectAnswer(session(JSON.stringify({ outcome, answer: "Partial changes remain." })), prompt, true), /Direct task reported .*Partial changes remain/);
	}
	for (const text of ["Commit failed; partial changes remain.", "null", JSON.stringify({ answer: "Turn finished." }), JSON.stringify({ outcome: "succeeded", answer: "" })]) {
		assert.throws(() => exactDirectAnswer(session(text), prompt, true), /Pi write-access/);
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

async function sampleDirectSession(t: TestContext, session: string, turnPrompt = prompt) {
	const dir = await mkdtemp(join(tmpdir(), "pi-direct-sample-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	await writeFile(path, session);
	const reader = createDirectSessionReader(path, turnPrompt);
	return { ...await reader.usage(), activity: reader.activity };
}

test("direct usage sums input and output without cache, and total cost, for the exact turn", async (t) => {
	const usage = (input: number, cost?: unknown) => ({ input, output: 2, cacheRead: 300_000, cacheWrite: 40_000, ...(cost === undefined ? {} : { cost: { total: cost } }) });
	const session = lines([
		{ type: "message", id: "one", message: { role: "assistant", usage: usage(10, 0.25) } },
		{ type: "message", id: "two", message: { role: "assistant", usage: usage(20, 0.125) } },
		{ type: "message", id: "bad", message: { role: "assistant", usage: usage(0, "1") } },
	]) + '{"type":"message"';
	const sampled = await sampleDirectSession(t, session);
	assert.deepEqual([sampled.tokens, sampled.cost], [36, 0.375]);
	assert.equal((await sampleDirectSession(t, lines([{ type: "message", id: "one", message: { role: "assistant", usage: usage(10) } }]))).cost, undefined);
	assert.equal((await sampleDirectSession(t, session, "another prompt")).tokens, undefined);
	assert.equal((await sampleDirectSession(t, lines([]))).tokens, undefined);
});

test("direct activity matches parallel results by ID and uses only the latest recorded result duration", async (t) => {
	const calls = { type: "message", id: "calls", message: { role: "assistant", timestamp: 1, durationMs: 999,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs?: number) => ({ type: "message", id: toolCallId, message: {
		role: "toolResult", toolCallId, toolName: "ignored result name", timestamp: 10_000, durationMs,
	} });
	assert.deepEqual((await sampleDirectSession(t, lines([calls]))).activity, { pending: ["read", "bash"], latest: undefined });
	assert.deepEqual((await sampleDirectSession(t, lines([calls, result("b", 2400)]))).activity,
		{ pending: ["read"], latest: { name: "bash", durationMs: 2400 } });
	assert.deepEqual((await sampleDirectSession(t, lines([calls, result("b", 2400), result("a", 125), result("unknown", 9999)]))).activity,
		{ pending: [], latest: { name: "read", durationMs: 125 } });
});

test("direct activity waits for a full trailing result and omits absent or invalid timing", async (t) => {
	const call = { type: "message", id: "call", message: { role: "assistant", timestamp: 1,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs: unknown) => ({ type: "message", id: "result", message: {
		role: "toolResult", toolCallId, durationMs, timestamp: 9999,
	} });
	const prefix = lines([call, result("a", 250)]);
	const final = JSON.stringify(result("b", 800));
	assert.deepEqual((await sampleDirectSession(t, prefix + final.slice(0, -2))).activity,
		{ pending: ["bash"], latest: { name: "read", durationMs: 250 } });
	assert.deepEqual((await sampleDirectSession(t, prefix + final + "\n")).activity,
		{ pending: [], latest: { name: "bash", durationMs: 800 } });
	for (const durationMs of [undefined, -1, "800"]) {
		assert.deepEqual((await sampleDirectSession(t, prefix + JSON.stringify(result("b", durationMs)) + "\n")).activity,
			{ pending: [], latest: { name: "bash" } });
	}
});

test("direct activity stays inside the exact prompt boundary and resets on a new exact task", async (t) => {
	const call = (id: string, name: string) => ({ type: "message", id, message: { role: "assistant",
		content: [{ type: "toolCall", id, name }] } });
	const result = (toolCallId: string) => ({ type: "message", id: "result", message: { role: "toolResult", toolCallId, durationMs: 900 } });
	const user = (text: string) => ({ type: "message", id: "next", message: { role: "user", content: [{ type: "text", text }] } });
	const session = JSON.stringify(call("old", "old tool")) + "\n" + lines([
		result("old"), call("task", "task tool"), user(`${prompt} extra`), result("task"), call("other", "other tool"),
	]);
	assert.deepEqual((await sampleDirectSession(t, session)).activity, { pending: ["task tool"], latest: undefined });
	assert.equal((await sampleDirectSession(t, session, "different prompt")).activity, undefined);
	const next = session + [user(prompt), result("task"), call("new", "new tool")].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	assert.deepEqual((await sampleDirectSession(t, next)).activity, { pending: ["new tool"], latest: undefined });
});

test("direct session samples read and parse only appended complete lines for usage and text", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-direct-incremental-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	const assistant = (input: number, text: string) => ({ type: "message", message: { role: "assistant",
		usage: { input, output: 2 }, content: [{ type: "text", text }, { type: "toolCall", id: "a", name: "read" },
			{ type: "toolCall", id: "b", name: "bash" }] } });
	const entry = (message: unknown) => JSON.stringify({ type: "message", message }) + "\n";
	let complete = lines([assistant(10, "  first 😀 \t")]);
	await writeFile(path, complete);
	const reader = createDirectSessionReader(path, prompt);
	const file = await open(path, "r");
	const reads = t.mock.method(Object.getPrototypeOf(file) as Pick<typeof file, "read">, "read");
	await file.close();
	const parses = t.mock.method(JSON, "parse");
	const check = async (newLines: number, position?: number) => {
		const fullReader = createDirectSessionReader(path, prompt);
		const expected = await fullReader.usage();
		const expectedText = await fullReader.partialText(8);
		const readCount = reads.mock.callCount();
		const parseCount = parses.mock.callCount();
		const [text, tokens] = await Promise.all([reader.partialText(8), reader.usage().then(({ tokens }) => tokens)]);
		assert.equal(tokens, expected.tokens);
		assert.deepEqual(reader.activity, fullReader.activity);
		assert.equal(text, expectedText);
		assert.equal(parses.mock.callCount() - parseCount, newLines);
		assert.deepEqual(reads.mock.calls.slice(readCount).map((call) => call.arguments[0]?.position), position === undefined ? [] : [position]);
	};
	await check(3, 0);
	assert.equal(await reader.partialText(100), "first 😀");
	await check(0);

	const result = entry({ role: "toolResult", toolCallId: "b", durationMs: 250 });
	const tail = Buffer.from(JSON.stringify(assistant(20, " second 🚀  ")) + "\n");
	const split = tail.indexOf(Buffer.from("🚀")) + 1;
	let position = Buffer.byteLength(complete);
	await appendFile(path, Buffer.concat([Buffer.from(result), tail.subarray(0, split)]));
	complete += result;
	await check(1, position);
	position = Buffer.byteLength(complete);
	await appendFile(path, tail.subarray(split, -1));
	// Even valid JSON must wait for its newline before it advances the offset.
	await check(0, position);
	await appendFile(path, "\n");
	complete += tail.toString();
	await check(1, position);
	assert.equal(await reader.partialText(100), "first 😀 \t\n second 🚀");
	await check(0);

	const outside = entry({ role: "user", content: [{ type: "text", text: `${prompt} extra` }] })
		+ JSON.stringify(assistant(999, "unrelated")) + "\n";
	position = Buffer.byteLength(complete);
	await appendFile(path, outside);
	complete += outside;
	await check(2, position);
	const reset = entry({ role: "user", content: [{ type: "text", text: prompt }] })
		+ entry({ role: "toolResult", toolCallId: "b", durationMs: 999 })
		+ JSON.stringify(assistant(0, "new")) + "\n";
	position = Buffer.byteLength(complete);
	await appendFile(path, reset);
	complete += reset;
	await check(3, position);
	assert.equal((await reader.usage()).tokens, 2);
	assert.equal(await reader.partialText(100), "new");
	assert.deepEqual(reader.activity, { pending: ["read", "bash"], latest: undefined });

	position = Buffer.byteLength(complete);
	await appendFile(path, "malformed\n" + JSON.stringify(assistant(999, "ignored")) + "\n");
	await check(1, position);
	await appendFile(path, "\n");
	await check(1, position);
});

test("direct session samples reset after shrink, rewrite, replacement, and the size limit", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-direct-reset-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	const session = (input: number, text: string) => lines([{ type: "message", message: { role: "assistant",
		usage: { input, output: 1 }, content: [{ type: "text", text }, { type: "toolCall", id: "a", name: text }] } }]);
	await writeFile(path, session(10, "original long text"));
	const reader = createDirectSessionReader(path, prompt);
	const check = async (input: number, text: string) => {
		assert.equal((await reader.usage()).tokens, input + 1);
		assert.equal(await reader.partialText(100), text);
		assert.deepEqual(reader.activity, { pending: [text], latest: undefined });
	};
	await check(10, "original long text");
	await writeFile(path, session(2, "short"));
	await check(2, "short");
	await writeFile(path, session(3, "equal"));
	const time = new Date(Date.now() + 1000);
	await utimes(path, time, time);
	await check(3, "equal");
	const replacement = join(dir, "replacement.jsonl");
	await writeFile(replacement, session(4, "other"));
	await utimes(replacement, time, time);
	await rename(replacement, path);
	await check(4, "other");
	await truncate(path, 16 * 1024 * 1024 + 1);
	assert.equal((await reader.usage()).tokens, undefined);
	assert.equal(reader.activity, undefined);
	assert.equal(await reader.partialText(100), undefined);
	await writeFile(path, session(5, "after"));
	await check(5, "after");
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
