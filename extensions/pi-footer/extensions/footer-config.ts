import { createConfigStore, field, type FieldParser, parsers } from "@henryqw/pi-config-store";
import { parseColor, type Color } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Color roles for footer-owned content; external extension statuses and the thinking gradient are not covered. */
export const FOOTER_COLOR_ROLES = [
	"repository",
	"branch",
	"gitStatus",
	"input",
	"output",
	"cache",
	"throughput",
	"cost",
	"context",
	"model",
	"runtime",
	"codegraphActive",
	"separator",
] as const;

export type FooterColorRole = (typeof FOOTER_COLOR_ROLES)[number];

/** Theme foreground tokens accepted as config values. */
const THEME_TOKENS: ReadonlySet<ThemeColor> = new Set<ThemeColor>([
	"accent",
	"dim",
	"muted",
	"text",
	"success",
	"warning",
	"error",
	"thinkingText",
]);

export type FooterColorValue = { kind: "token"; token: ThemeColor } | { kind: "color"; color: Color };

export type FooterColorConfig = Partial<Record<FooterColorRole, FooterColorValue>>;

/** Parses one role's color; a throw drops only that role. */
export const parseFooterColor: FieldParser<FooterColorValue> = (raw) => {
	if (typeof raw === "number") {
		if (!Number.isInteger(raw) || raw < 0 || raw > 255) throw new Error("ANSI index must be an integer from 0 to 255");
		return { kind: "color", color: parseColor(raw) };
	}
	if (typeof raw !== "string" || !raw.trim()) throw new Error("expected a theme token or a color value");
	if (THEME_TOKENS.has(raw as ThemeColor)) return { kind: "token", token: raw as ThemeColor };
	try {
		return { kind: "color", color: parseColor(raw) };
	} catch {
		throw new Error(`invalid color "${raw}"`);
	}
};

/** A missing file, role, or invalid role keeps the built-in color for that role. */
export function createFooterConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-footer",
		agentDir,
		fields: {
			colors: field(parsers.record(parseFooterColor, { key: parsers.oneOf(FOOTER_COLOR_ROLES) }), {}),
		},
	});
}

/** An explicit config wins; otherwise fall back to the caller's semantic token. */
export function paintFooter(theme: Theme, value: FooterColorValue | undefined, fallback: ThemeColor, text: string): string {
	if (value === undefined) return theme.fg(fallback, text);
	return value.kind === "token" ? theme.fg(value.token, text) : theme.style(text, { fg: value.color });
}
