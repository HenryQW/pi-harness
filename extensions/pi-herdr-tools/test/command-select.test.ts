import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { selectCommandOutput } from "../internal/command-select.ts";

for (const title of ["Prune finished outputs · 0 selected", "Delete these 1000 saved outputs?\nDeletion cannot be undone. Another Pi session may still need this output."])
test(`bounded native list keeps its heading and action visible: ${title.split("\n")[0]}`, async () => {
	const options = ["Keep output", ...Array.from({ length: 1000 }, (_, index) => `output-${index} /saved/${index}/output.log`), "Delete output despite this risk"];
	let component!: Component, resolved = false;
	const terminal = { rows: 12, columns: 80 };
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j", "tui.select.pageDown": "n", "tui.select.cancel": "q" });
	const ctx = { mode: "tui", ui: { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			component = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, keys,
				(value: string | undefined) => { resolved = true; done(value); });
		});
	} } } as unknown as ExtensionContext;
	const result = selectCommandOutput(ctx, title, options);
	const render = () => {
		const lines = component.render(terminal.columns).map(stripTerminalSequences);
		assert.ok(lines.length <= terminal.rows);
		assert.ok(lines.every(line => visibleWidth(line) <= terminal.columns));
		return lines.join("\n");
	};
	assert.match(render(), /→ Keep output/);
	component.handleInput!("n");
	assert.match(render(), /→ output-/);
	component.handleInput!("j"); render();
	for (let i = 0; i < 1100; i++) component.handleInput!("n");
	const last = render();
	assert.ok(last.includes(title.split("\n")[0]!));
	if (title.includes("cannot be undone")) assert.ok(last.includes("Deletion cannot be undone."));
	assert.match(last, /→ Delete output despite this risk/);
	// A shrink before rendering must not authorize a now-hidden action.
	terminal.rows = 2;
	component.handleInput!("\r");
	assert.equal(resolved, false);
	assert.match(render(), /Enlarge terminal/);
	component.handleInput!("\r");
	assert.equal(resolved, false);
	terminal.rows = 12; terminal.columns = 20;
	assert.match(render(), /Enlarge terminal/);
	component.handleInput!("\r");
	assert.equal(resolved, false);
	terminal.columns = 80;
	assert.match(render(), /→ Delete output despite this risk/);
	component.handleInput!("k");
	component.handleInput!("\r"); // Do not select a new row before it is shown.
	assert.equal(resolved, false);
	assert.match(render(), /→ output-999/);
	component.handleInput!("q");
	assert.equal(await result, undefined);
});

test("search filters a long list, edits input, handles no matches, and selects only the visible original item", async () => {
	const options = Array.from({ length: 1000 }, (_, index) => `${index + 1}. job-${index} · printf '雪 ${index}'`);
	let component!: Component & Focusable, resolved = false;
	const terminal = { rows: 8, columns: 60 };
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p" });
	const ctx = { mode: "tui", ui: { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			component = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, keys,
				(value: string | undefined) => { resolved = true; done(value); });
		});
	} } } as unknown as ExtensionContext;
	const result = selectCommandOutput(ctx, "Background commands", options, { searchable: true });
	component.focused = true;
	const render = () => {
		const lines = component.render(terminal.columns);
		assert.ok(lines.length <= terminal.rows);
		assert.ok(lines.every(line => visibleWidth(line) <= terminal.columns));
		return lines.join("\n");
	};
	assert.match(render(), /Search:/);
	assert.ok(render().includes(CURSOR_MARKER), "The input must receive focus for the terminal cursor.");
	for (const character of "MISSING") component.handleInput!(character);
	assert.match(render(), /No matching commands/);
	component.handleInput!("\r");
	assert.equal(resolved, false);
	component.handleInput!("\x15"); // Control+U clears the query through native input editing.
	assert.match(render(), /→ 1\. job-0/);
	for (const character of "JOB-97x") component.handleInput!(character);
	component.handleInput!("\x7f");
	component.handleInput!("\r");
	assert.equal(resolved, false, "A new filter must render before selection.");
	assert.match(render(), /→ 98\. job-97/);
	component.handleInput!("\x0e"); // The configured Control+N selects the next match.
	component.handleInput!("\r");
	assert.equal(resolved, false, "A new selection must render before confirmation.");
	assert.match(render(), /→ 971\. job-970/);
	component.handleInput!("\x1b[6~");
	const paged = render();
	assert.match(paged, /→ 975\. job-974/);
	component.handleInput!("\r");
	assert.equal(await result, options[974]);
});

for (const cancel of ["\x1b", "\x03"])
test(`search cancellation preserves the list even after a terminal shrink: ${JSON.stringify(cancel)}`, async () => {
	let component!: Component;
	const terminal = { rows: 8, columns: 60 };
	const ctx = { mode: "tui", ui: { custom(factory: Function) {
		return new Promise<string | undefined>(done => {
			component = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), done);
		});
	} } } as unknown as ExtensionContext;
	const options = ["one", "two", "three"];
	const result = selectCommandOutput(ctx, "Background commands", options, { searchable: true });
	component.render(60);
	component.handleInput!("t");
	terminal.rows = 2;
	component.render(60);
	component.handleInput!(cancel);
	assert.equal(await result, undefined);
	assert.deepEqual(options, ["one", "two", "three"]);
});

test("search accepts printable selection bindings and Tab enables list shortcuts", async () => {
	let component!: Component;
	const terminal = { rows: 8, columns: 80 };
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j", "tui.select.pageDown": "n", "tui.select.cancel": "q" });
	const ctx = { mode: "tui", ui: { custom(factory: Function) {
		return new Promise<string | undefined>(done => { component = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, keys, done); });
	} } } as unknown as ExtensionContext;
	const result = selectCommandOutput(ctx, "Commands", ["jqkn first", "jqkn second"], { searchable: true });
	component.render(80);
	for (const character of "jqkn") component.handleInput!(character);
	assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /Search: jqkn/);
	component.handleInput!("\t");
	component.render(80);
	component.handleInput!("j");
	assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /→ jqkn second/);
	component.handleInput!("\r");
	assert.equal(await result, "jqkn second");
});

test("search accepts a bracketed paste split across input events", async () => {
	let component!: Component;
	const terminal = { rows: 8, columns: 80 };
	const ctx = { mode: "tui", ui: { custom(factory: Function) {
		return new Promise<string | undefined>(done => { component = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), done); });
	} } } as unknown as ExtensionContext;
	const result = selectCommandOutput(ctx, "Commands", ["first", "paste target"], { searchable: true });
	component.render(80);
	for (const part of ["\x1b[200~", "paste ", "target", "\x1b[201~"]) component.handleInput!(part);
	assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /→ paste target/);
	component.handleInput!("\r");
	assert.equal(await result, "paste target");
});
