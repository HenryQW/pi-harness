import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

export const MAX_RENDERED_RESULT_LINES = 3;

export function renderToolLines(lines: readonly string[], theme: Theme): Component {
	return {
		invalidate() {},
		render: (width) => {
			const shown = lines.length > MAX_RENDERED_RESULT_LINES
				? [...lines.slice(0, MAX_RENDERED_RESULT_LINES - 1), theme.fg("muted", `… ${lines.length - MAX_RENDERED_RESULT_LINES + 1} more`)]
				: lines;
			return shown.map((line) => truncateToWidth(line.replace(/[\r\n]+/g, " "), width));
		},
	};
}
