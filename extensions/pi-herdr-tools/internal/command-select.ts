import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, getSelectPageIndex, Input, matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Pi's string selector has no terminal window; keep the warning outside a bounded native list. */
export async function selectCommandOutput(ctx: ExtensionContext, title: string, options: string[], { searchable = false, searchText }: { searchable?: boolean; searchText?: string[] } = {}): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select(title, options);
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const header = new Text(theme.fg("accent", title), 0, 0);
		const items = options.map((value, index) => ({ value, label: value, search: searchText?.[index] ?? value }));
		const input = new Input({ prompt: "Search: ", placeholder: "Type to filter" });
		const hint = (action: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(action).join("/");
		let searchFocus = searchable, focused = false, pasting = false;
		let filtered = items, renderedItems = items;
		let list: SelectList | undefined, capacity = 0, index = 0, renderedIndex = 0, renderedRows = 0, renderedColumns = 0, fits = false;
		const filter = () => {
			const query = input.getValue().toLowerCase();
			filtered = items.filter(item => item.search.toLowerCase().includes(query));
			index = 0;
			list = undefined;
		};
		return {
			capturesViewportInput: true,
			get focused() { return focused; },
			set focused(value: boolean) { focused = value; input.focused = value && searchFocus; },
			render(width: number): string[] {
				const lines = header.render(width);
				renderedRows = tui.terminal.rows;
				renderedColumns = tui.terminal.columns;
				renderedIndex = index;
				renderedItems = filtered;
				const available = renderedRows - lines.length - 2 - Number(searchable); // Reserve the indicator, hints, and optional search input.
				fits = width >= 40 && available >= 1;
				if (!fits) return [truncateToWidth(`Enlarge terminal; ${hint("tui.select.cancel")} cancels.`, width)];
				if (!list || capacity !== available) {
					capacity = available;
					list = new SelectList(filtered, capacity, {
						selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
						description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => text,
					});
				}
				list.setSelectedIndex(index);
				const help = searchable
					? `${searchFocus ? "Search" : "List keys"} · Tab switch · Enter select · Esc cancel`
					: `${hint("tui.select.confirm")} select · ${hint("tui.select.cancel")} cancel · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} page`;
				return [...lines, ...(searchable ? input.render(width) : []), ...list.render(width), theme.fg("dim", truncateToWidth(help, width))];
			},
			handleInput(data: string): void {
				if (searchFocus && (pasting || data.includes("\x1b[200~"))) {
					pasting = !data.includes("\x1b[201~");
					const previous = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previous) filter();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || keys.matches(data, "app.clear") || (!searchFocus && keys.matches(data, "tui.select.cancel"))) { done(undefined); return; }
				// A resize must render the whole warning and current action before confirmation is possible.
				if (!fits || renderedRows !== tui.terminal.rows || renderedColumns !== tui.terminal.columns) return;
				if (searchable && matchesKey(data, "tab")) {
					searchFocus = !searchFocus;
					input.focused = focused && searchFocus;
					tui.requestRender();
					return;
				}
				const printable = searchFocus ? decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(data) ? data : undefined) : undefined;
				if (printable !== undefined) {
					// Input's global keybindings can also bind printable characters to cancel.
					input.handleInput(`\x1b[200~${printable}\x1b[201~`);
					filter();
					tui.requestRender();
					return;
				}
				if (keys.matches(data, "tui.select.confirm") || (searchFocus && matchesKey(data, "enter"))) {
					if (filtered[index] && filtered === renderedItems && index === renderedIndex) done(filtered[index].value);
					return;
				}
				const page = getSelectPageIndex(keys, data, index, filtered.length, capacity);
				const up = keys.matches(data, "tui.select.up") || (searchFocus && matchesKey(data, "up"));
				const down = keys.matches(data, "tui.select.down") || (searchFocus && matchesKey(data, "down"));
				if (up || down || page !== undefined) {
					if (filtered.length) index = page ?? (index + (up ? -1 : 1) + filtered.length) % filtered.length;
					tui.requestRender();
				} else if (searchFocus) {
					const previous = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previous) {
						filter();
					}
					tui.requestRender();
				}
			},
			invalidate() { header.invalidate(); input.invalidate(); list?.invalidate(); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}
