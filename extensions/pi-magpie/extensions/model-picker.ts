import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SelectList, Text } from "@earendil-works/pi-tui";

export default function modelPicker(pi: ExtensionAPI) {
	pi.registerCommand("magpie-model", {
		description: "Select a Magpie model by its short name",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const query = args.trim().toLowerCase();
			await ctx.modelRegistry.refresh({ providers: ["magpie"], allowNetwork: false });
			const configError = ctx.modelRegistry.getError();
			if (configError) ctx.ui.notify(configError, "warning");
			const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === "magpie");
			const shortId = (id: string) => id.replace(/^vps\//, "");
			const items = models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query)).map((model) => {
				const id = shortId(model.id);
				const label = models.some((other) => other.id !== model.id && other.id === id) ? model.id : id;
				return { value: model.id, label: `${label} [magpie]`, model };
			});
			if (!items.length) {
				ctx.ui.notify("No Magpie models match. Use /model to see all providers.", "warning");
				return;
			}
			let selected: string | undefined;
			if (ctx.mode === "tui") {
				selected = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
					const title = new Text(theme.fg("accent", "Select a Magpie model"), 0, 0);
					let capacity = 0;
					let list: SelectList | undefined;
					return {
						render(width) {
							const heading = title.render(width);
							const rows = Math.max(1, tui.terminal.rows - heading.length - 2);
							if (!list || capacity !== rows) {
								const current = list?.getSelectedItem()?.value ?? (ctx.model?.provider === "magpie" ? ctx.model.id : undefined);
								capacity = rows;
								list = new SelectList(items, rows, {
									selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
									description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => text,
								});
								list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === current)));
								list.onSelect = (item) => done(item.value);
								list.onCancel = () => done(undefined);
							}
							return [...heading, ...list.render(width)];
						},
						handleInput(data) { list?.handleInput(data); tui.requestRender(); },
						invalidate() { title.invalidate(); list?.invalidate(); },
					};
				}, { overlay: true, overlayOptions: { maxHeight: "100%" } });
			} else {
				const label = await ctx.ui.select("Select a Magpie model", items.map((item) => item.label));
				selected = items.find((item) => item.label === label)?.value;
			}
			const item = items.find(({ value }) => value === selected);
			if (!item) return;
			if (await pi.setModel(item.model)) ctx.ui.notify(`Model: ${item.label}`, "info");
			else ctx.ui.notify("Magpie authentication is unavailable.", "error");
		},
	});
}
