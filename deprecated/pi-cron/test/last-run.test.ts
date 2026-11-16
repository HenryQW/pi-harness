import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type Component, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { showLastRun } from "../internal/last-run.ts";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];

function viewer(report: string, bindings: KeybindingsConfig = {}) {
	let component!: Component;
	let closed = false;
	let renders = 0;
	const terminal = { rows: 8 };
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: Factory) => new Promise((resolve) => {
				const result = factory(
					{ terminal, requestRender: () => { renders++; } } as Parameters<Factory>[0],
					{ fg: (_color: string, text: string) => text } as Parameters<Factory>[1],
					new KeybindingsManager(TUI_KEYBINDINGS, bindings) as Parameters<Factory>[2],
					(value) => { closed = true; resolve(value); },
				);
				assert.ok(!(result instanceof Promise));
				component = result;
			}),
		},
	} as unknown as ExtensionContext;
	const completion = showLastRun(ctx, report);
	return {
		terminal, completion,
		render: (width = 80) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()),
		rows: (width: number) => component.render(width).map(stripVTControlCharacters),
		input: (key: string) => component.handleInput!(key),
		invalidate: () => component.invalidate(),
		closed: () => closed,
		renders: () => renders,
	};
}

test("the viewer scrolls by line and page, clamps at each end, and uses configured keys", async () => {
	const view = viewer(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"), { "tui.select.down": "j" });
	assert.equal(view.render()[1], "line 0");
	view.input("j");
	assert.equal(view.render()[1], "line 1");
	view.input("\x1b[A");
	assert.equal(view.render()[1], "line 0");
	view.input("\x1b[6~");
	assert.equal(view.render()[1], "line 6");
	view.input("\x1b[5~");
	assert.equal(view.render()[1], "line 0");
	view.input("\x1b[F");
	assert.equal(view.render().at(-2), "line 29");
	view.input("j");
	assert.equal(view.render().at(-2), "line 29");
	view.input("\x1b[H");
	view.input("\x1b[A");
	assert.equal(view.render()[1], "line 0");
	assert.ok(view.renders() > 0);
	view.input("\x1b");
	await view.completion;
});

test("the viewer shows literal text and escapes terminal and bidirectional controls", async () => {
	const view = viewer("**literal** `code` [link](https://example.test)\n\x1b[2J\x1b]8;;file:///tmp/secret\x07link\r\t\u009b31m\u202ereverse\u2066isolate\u2069\n界 👩‍💻");
	const text = view.render(160).join("\n");
	assert.match(text, /\*\*literal\*\* `code` \[link\]\(https:\/\/example.test\)/);
	assert.ok(text.includes("\\u001b[2J\\u001b]8;;file:///tmp/secret\\u0007link\\u000d\\u0009\\u009b31m\\u202ereverse\\u2066isolate\\u2069"));
	assert.ok(text.includes("界 👩‍💻"));
	assert.doesNotMatch(text, /[\x1b\x07\r\t\u009b\u202e\u2066\u2069]/);
	view.input("\r");
	await view.completion;
});

test("literal wrapping keeps indentation, spaces, blank lines, and Unicode graphemes", async () => {
	for (const [report, expected] of [
		["  abcd", ["  ab", "cd  "]],
		["ab   cd", ["ab  ", " cd "]],
		["ab    \n  cd\n", ["ab  ", "    ", "  cd", "    "]],
		[" 界e\u0301👩‍💻 ", [" 界e\u0301", "👩‍💻  "]],
	] as const) {
		const view = viewer(report);
		assert.deepEqual(view.rows(4).slice(1, -1), expected);
		view.input("\x1b");
		await view.completion;
	}
});

test("wide graphemes use lossless escapes at one column and return after resize", async () => {
	const view = viewer("界👩‍💻");
	view.terminal.rows = 40;
	assert.equal(view.rows(1).slice(1, -1).join(""), "\\u{754c}\\u{1f469}\\u{200d}\\u{1f4bb}");
	assert.deepEqual(view.rows(2).slice(1, -1), ["界", "👩‍💻"]);
	assert.deepEqual(view.rows(4).slice(1, -1), ["界👩‍💻"]);
	view.input("\x1b");
	await view.completion;
});

test("narrow and short resizes keep the report bounded and its end reachable", async () => {
	const view = viewer(`Session: /${"long-path/".repeat(30)}run.jsonl\n${"界 👩‍💻 text\n".repeat(20)}last line`);
	view.render();
	view.input("\x1b[F");
	for (const [width, rows] of [[1, 1], [2, 2], [12, 4], [80, 40], [20, 3]]) {
		view.terminal.rows = rows;
		view.invalidate();
		const lines = view.render(width);
		assert.ok(lines.length <= rows);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	view.input("\x1b[F");
	assert.equal(view.render(20)[1], "last line");
	view.terminal.rows = 1;
	view.render(20);
	view.input("\x1b[H");
	assert.ok(view.render(20)[0]!.startsWith("Session:"));
	view.input("\x1b[F");
	assert.equal(view.render(20)[0], "last line");
	view.input("\x03");
	await view.completion;
});

test("Escape, Control+C, and Enter close the viewer without a result", async () => {
	for (const key of ["\x1b", "\x03", "\r"]) {
		const view = viewer("job has not run yet.");
		view.input("x");
		assert.equal(view.closed(), false);
		view.input(key);
		assert.equal(await view.completion, undefined);
		assert.equal(view.closed(), true);
	}
});
