import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectPageIndex, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Pi's string selector has no terminal window; keep the warning outside a bounded native list. */
export async function selectCommandOutput(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select(title, options);
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const header = new Text(theme.fg("accent", title), 0, 0);
		const items = options.map(value => ({ value, label: value }));
		const hint = (action: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(action).join("/");
		const help = `${hint("tui.select.confirm")} select · ${hint("tui.select.cancel")} cancel · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} page`;
		let list: SelectList, capacity = 0, index = 0, renderedIndex = 0, renderedRows = 0, renderedColumns = 0, fits = false;
		return {
			capturesViewportInput: true,
			render(width: number): string[] {
				const lines = header.render(width);
				renderedRows = tui.terminal.rows;
				renderedColumns = tui.terminal.columns;
				renderedIndex = index;
				const available = renderedRows - lines.length - 2; // Scroll indicator and key hints each need one row.
				fits = width >= 40 && available >= 1;
				if (!fits) return [truncateToWidth(`Enlarge terminal; ${hint("tui.select.cancel")} cancels.`, width)];
				if (capacity !== available) {
					capacity = available;
					list = new SelectList(items, capacity, {
						selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
						description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => text,
					});
				}
				list.setSelectedIndex(index);
				return [...lines, ...list.render(width), theme.fg("dim", truncateToWidth(help, width))];
			},
			handleInput(data: string): void {
				if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.clear")) { done(undefined); return; }
				// A resize must render the whole warning and current action before confirmation is possible.
				if (!fits || renderedRows !== tui.terminal.rows || renderedColumns !== tui.terminal.columns) return;
				if (keys.matches(data, "tui.select.confirm")) { if (index === renderedIndex) done(options[index]); return; }
				const page = getSelectPageIndex(keys, data, index, items.length, capacity);
				const up = keys.matches(data, "tui.select.up"), down = keys.matches(data, "tui.select.down");
				if (up || down || page !== undefined) {
					index = page ?? (index + (up ? -1 : 1) + items.length) % items.length;
					tui.requestRender();
				}
			},
			invalidate() { header.invalidate(); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}
