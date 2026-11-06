import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
