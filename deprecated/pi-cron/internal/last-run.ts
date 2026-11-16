import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Escape terminal and bidirectional controls for display only; keep the saved summary unchanged. */
function displayText(text: string): string {
	return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Pre-wrap literal text so Text never applies its whitespace-changing word wrap. */
function wrapLiteral(text: string, width: number): string {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const lines: string[] = [];
	for (const source of text.split("\n")) {
		let line = "";
		let columns = 0;
		for (const { segment } of segmenter.segment(source)) {
			// A two-column grapheme cannot fit in one column. Show reversible escapes until resize.
			const parts = visibleWidth(segment) > width
				? Array.from(Array.from(segment, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`).join(""))
				: [segment];
			for (const part of parts) {
				const cells = visibleWidth(part);
				if (columns + cells > width) {
					lines.push(line);
					line = "";
					columns = 0;
				}
				line += part;
				columns += cells;
			}
		}
		lines.push(line);
	}
	return lines.join("\n");
}

export async function showLastRun(ctx: ExtensionContext, report: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(report, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const safeReport = displayText(report);
		const text = new Text("", 0, 0);
		const scroll = new ScrollView(text);
		let wrappedWidth = 0;
		const keys = (action: Parameters<typeof keybindings.getKeys>[0]) => keybindings.getKeys(action).join("/");
		const hint = `${keys("tui.select.cancel")} close · ${keys("tui.select.up")}/${keys("tui.select.down")} scroll · ${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")} page · home/end`;
		return {
			render(width: number): string[] {
				const rows = tui.terminal.rows;
				if (width < 1 || rows < 1) return [];
				// On short terminals, use every row for the scrollable report.
				const height = rows >= 3 ? rows - 2 : rows;
				if (width !== wrappedWidth) {
					text.setText(wrapLiteral(safeReport, width));
					wrappedWidth = width;
				}
				const lines = scroll.render(width);
				scroll.updateLayout(lines.length, height, () => tui.requestRender());
				const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + height);
				return (rows >= 3 ? [theme.fg("accent", "Last run"), ...visible, theme.fg("dim", hint)] : visible)
					.map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: () => scroll.invalidate(),
			handleInput(data: string): void {
				if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
					done();
					return;
				}
				if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
				else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
				else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
				else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
				else if (matchesKey(data, "home")) scroll.scrollToStart();
				else if (matchesKey(data, "end")) scroll.scrollToEnd();
				else return;
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}
