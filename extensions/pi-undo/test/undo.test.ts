import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import undoExtension from "../extensions/undo.ts";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Navigation = [id: string, options: { summarize: boolean }];

function command(): Command {
	let handler: Command | undefined;
	undoExtension({
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "undo") handler = options.handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	return handler;
}

function context(
	entries: unknown[],
	events: string[],
	navigations: Navigation[] = [],
	notifications: string[] = [],
): ExtensionCommandContext {
	return {
		abort() { events.push("abort"); },
		waitForIdle: async () => { events.push("idle"); },
		sessionManager: {
			getBranch() {
				events.push("branch");
				return entries;
			},
		},
		navigateTree: async (id: string, options: { summarize: boolean }) => {
			events.push("navigate");
			navigations.push([id, options]);
			return { cancelled: false };
		},
		ui: {
			notify(message: string) {
				events.push("notify");
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
}

test("/undo aborts, waits, and targets the latest actual user turn", async () => {
	const events: string[] = [];
	const navigations: Navigation[] = [];
	await command()("", context([
		{ id: "first", type: "message", message: { role: "user" } },
		{ id: "second", type: "message", message: { role: "user" } },
		{ id: "continuation", type: "custom_message", customType: "extension/continuation", content: "Continue.", display: false },
		{ id: "assistant", type: "message", message: { role: "assistant" } },
	], events, navigations));

	assert.deepEqual(events, ["abort", "idle", "branch", "navigate"]);
	assert.deepEqual(navigations, [["second", { summarize: false }]]);
});

test("/undo reports empty history after stopping work", async () => {
	const events: string[] = [];
	const notifications: string[] = [];
	await command()("", context([], events, [], notifications));

	assert.deepEqual(events, ["abort", "idle", "branch", "notify"]);
	assert.deepEqual(notifications, ["Nothing to undo."]);
});

test("/undo rejects arguments before changing the session", async () => {
	const events: string[] = [];
	await assert.rejects(command()("again", context([], events)), /Usage: \/undo/);
	assert.deepEqual(events, []);
});
