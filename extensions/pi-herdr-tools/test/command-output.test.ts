import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { showCommandOutput } from "../internal/command-output.ts";

function viewer(metadata: string, output: string, rows = 100, bindings = {}) {
	let component!: Component;
	let renderRequests = 0, color = 31;
	const tui = { terminal: { rows }, requestRender() { renderRequests++; } };
	const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.clear": { defaultKeys: "ctrl+c" } }, bindings);
	const ctx = { ui: { custom(factory: Function) {
		return new Promise<void>((done) => {
			component = factory(tui, { fg: (_token: string, value: string) => `\x1b[${color}m${value}\x1b[39m` }, keys, done);
		});
	} } } as unknown as ExtensionContext;
	const closed = showCommandOutput(ctx, metadata, output);
	return { component, tui, closed, requests: () => renderRequests, setColor(value: number) { color = value; },
		lines(width: number) {
			const lines = component.render(width);
			assert.ok(lines.length <= tui.terminal.rows);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			return lines.map(stripTerminalSequences);
		},
		key(data: string) { component.handleInput!(data); },
	};
}

const snapshot = "Last 8192 output bytes (snapshot):";
test("output stays literal, with spaces, blank lines, Unicode, and a final line feed", async () => {
	const output = "# not Markdown\n**literal**\n  a   b  \n\n \n\n雪😀\n";
	const view = viewer("status", output);
	const expected = ["status", "", snapshot, ...output.split("\n")].map((line) => line + " ".repeat(100 - visibleWidth(line)));
	assert.deepEqual(view.lines(100).slice(1, -1), expected);
	view.key("\r"); await view.closed;
});

test("wrapping does not drop spaces or cut long tokens", async () => {
	const ascii = "aa   bb   cc  \n" + "x".repeat(81);
	const view = viewer("status", ascii + "\nabcd雪e\u0301😀");
	const expected = ["status", "", snapshot, ...ascii.split("\n")].flatMap((line) => line.match(/.{1,7}/g) ?? [""]);
	expected.push("abcd雪e\u0301", "😀");
	assert.deepEqual(view.lines(7).slice(1, -1), expected.map((line) => line + " ".repeat(7 - visibleWidth(line))));
	view.key("\x1b"); await view.closed;
});

test("terminal, clipboard, cursor, and directional controls are visible escapes", async () => {
	const output = "\x1b]52;c;secret\x07\x1b[2J\r\t\b\x00\x7f\x9b31m\u202e\u2066";
	const view = viewer("status", output);
	const escaped = "\\u001b]52;c;secret\\u0007\\u001b[2J\\u000d\\u0009\\u0008\\u0000\\u007f\\u009b31m\\u202e\\u2066";
	assert.equal(view.lines(160)[4], escaped.padEnd(160));
	view.key("\x03"); await view.closed;
});

test("only empty output gets the empty marker", async () => {
	for (const output of ["", " \n\n"]) {
		const view = viewer("status", output);
		const body = view.lines(100).slice(1, -1);
		assert.deepEqual(body.slice(3), (output === "" ? ["(No output.)"] : output.split("\n")).map((line) => line.padEnd(100)));
		view.key("\x1b"); await view.closed;
	}
});

test("configured keys scroll by line and page, with resize clamping and theme invalidation", async () => {
	const view = viewer("status", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"), 6,
		{ "tui.select.up": "k", "tui.select.down": "j", "tui.select.pageUp": "p", "tui.select.pageDown": "n", "tui.select.cancel": "q" });
	const first = view.lines(40);
	assert.ok(first.at(-1)!.includes("q close"));
	view.key("j");
	assert.equal(view.lines(40)[1], first[2]);
	view.key("k");
	assert.deepEqual(view.lines(40), first);
	view.key("n");
	assert.equal(view.lines(40)[1]!.trimEnd(), "line 1");
	view.key("p");
	assert.deepEqual(view.lines(40), first);
	assert.ok(view.requests() > 0);
	for (let i = 0; i < 30; i++) view.key("n");
	view.tui.terminal.rows = 2;
	view.lines(3);
	view.tui.terminal.rows = 100;
	assert.equal(view.lines(40)[1]!.trimEnd(), "status");
	view.setColor(32);
	view.component.invalidate();
	assert.ok(view.component.render(40).every((line) => !line.includes("\x1b[31m")));
	view.key("q"); await view.closed;
});

test("a one-cell terminal can reach all output, including escaped wide characters", async () => {
	const view = viewer("", "雪😀", 1);
	let text = "";
	const expected = `  ${snapshot}\\u96ea\\ud83d\\ude00`;
	for (let i = 0; i < expected.length; i++) {
		text += view.lines(1)[0];
		view.key("\x1b[B");
	}
	assert.equal(text, expected);
	view.key("\x1b"); await view.closed;
});
