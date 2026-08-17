import assert from "node:assert/strict";
import test from "node:test";
import { parseBtwCommand } from "../internal/router.ts";

test("bare /btw opens an empty side pane", () => {
	assert.deepEqual(parseBtwCommand(""), { kind: "open" });
	assert.deepEqual(parseBtwCommand("   "), { kind: "open" });
});

test("only exact reserved first words route to subcommands", () => {
	assert.deepEqual(parseBtwCommand("config"), { kind: "config", args: "" });
	assert.deepEqual(parseBtwCommand("config auto-submit on"), {
		kind: "config",
		args: "auto-submit on",
	});
	assert.deepEqual(parseBtwCommand("merge"), { kind: "merge", text: "" });
	assert.deepEqual(parseBtwCommand("merge use the summary"), {
		kind: "merge",
		text: "use the summary",
	});
	assert.deepEqual(parseBtwCommand("help"), { kind: "help" });
});

test("unknown first words remain questions", () => {
	assert.deepEqual(parseBtwCommand("configuration options?"), {
		kind: "ask",
		question: "configuration options?",
	});
	assert.deepEqual(parseBtwCommand("what is a merge sort?"), {
		kind: "ask",
		question: "what is a merge sort?",
	});
});

test("/btw ask is the escape hatch for reserved words", () => {
	assert.deepEqual(parseBtwCommand("ask merge sort"), { kind: "ask", question: "merge sort" });
	assert.deepEqual(parseBtwCommand("ask config files"), { kind: "ask", question: "config files" });
	assert.deepEqual(parseBtwCommand("ask"), { kind: "open" });
});
