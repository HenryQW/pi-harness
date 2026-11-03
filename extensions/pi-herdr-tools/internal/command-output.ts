import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, truncateToWidth, visibleWidth, VStack } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const escapeControl = (character: string) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;

function literalLines(text: string, width: number): string {
	// Keep line feeds, but show terminal controls and directional controls as text.
	const safe = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, escapeControl);
	const lines: string[] = [];
	for (const source of safe.split("\n")) {
		let line = "", columns = 0;
		for (const { segment } of graphemes.segment(source)) {
			// A two-column character cannot fit in a one-column terminal.
			const parts = visibleWidth(segment) > width ? [...segment.split("").map(escapeControl).join("")] : [segment];
			for (const part of parts) {
				const size = visibleWidth(part);
				if (columns + size > width) { lines.push(line); line = ""; columns = 0; }
				line += part; columns += size;
			}
		}
		lines.push(line);
	}
	return lines.join("\n");
}

export async function showCommandOutput(ctx: ExtensionContext, metadata: string, output: string): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		const body = new Text("", 0, 0);
		const scroll = new ScrollView(body);
		const title = new Text("", 0, 0);
		const footer = new Text("", 0, 0);
		const content = `${metadata}\n\nLast 8192 output bytes (snapshot):\n${output === "" ? "(No output.)" : output}`;
		let cachedWidth: number | undefined;
		const hint = (action: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(action).join("/");
		const help = `${hint("tui.select.cancel")} close · ${hint("tui.select.up")}/${hint("tui.select.down")} scroll · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} page`;
		const viewport = {
			render(width: number): string[] {
				if (cachedWidth !== width) {
					// Text's word wrap drops spaces. Supply lines that already fit.
					body.setText(theme.fg("toolOutput", literalLines(content, width)));
					cachedWidth = width;
				}
				const lines = scroll.render(width);
				const rows = Math.max(1, tui.terminal.rows);
				// Overlays use render(), not the fullscreen layout engine.
				scroll.updateLayout(lines.length, rows >= 3 ? rows - 2 : 1, () => tui.requestRender());
				return lines.slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
			},
			invalidate() { cachedWidth = undefined; scroll.invalidate(); },
		};
		const layout = new VStack();
		return {
			render(width: number): string[] {
				layout.clear();
				if (tui.terminal.rows >= 3) {
					title.setText(theme.fg("accent", truncateToWidth("Command output", width)));
					layout.addChild(title);
				}
				layout.addChild(viewport);
				if (tui.terminal.rows >= 2) {
					footer.setText(theme.fg("dim", truncateToWidth(help, width)));
					layout.addChild(footer);
				}
				return layout.render(width);
			},
			handleInput(data: string): void {
				if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm") || keys.matches(data, "app.clear")) { done(); return; }
				if (keys.matches(data, "tui.select.up")) scroll.scrollBy(-1);
				else if (keys.matches(data, "tui.select.down")) scroll.scrollBy(1);
				else if (keys.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
				else if (keys.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
			},
			invalidate() { cachedWidth = undefined; layout.invalidate(); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}
