import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createFooterConfigStore,
	FOOTER_COLOR_ROLES,
	type FooterColorConfig,
	paintFooter,
	parseFooterColor,
} from "../extensions/footer-config.ts";

type FakeTheme = {
	fgCalls: [string, string][];
	styleCalls: [string, unknown][];
	fg(token: string, text: string): string;
	style(text: string, options: { fg: unknown }): string;
};

function fakeTheme(): FakeTheme {
	const theme: FakeTheme = {
		fgCalls: [],
		styleCalls: [],
		fg(token, text) {
			theme.fgCalls.push([token, text]);
			return `<${token}>${text}</>`;
		},
		style(text, options) {
			theme.styleCalls.push([text, options]);
			return `<color>${text}</>`;
		},
	};
	return theme;
}

function storeWith(t: { after(fn: () => void): void }, contents?: string) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-footer-config-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const store = createFooterConfigStore(agentDir);
	if (contents !== undefined) {
		mkdirSync(dirname(store.path), { recursive: true });
		writeFileSync(store.path, contents);
	}
	return store;
}

const noReport = () => {};

test("missing file returns empty colors and does not create the file", (t) => {
	const store = storeWith(t);
	assert.deepEqual(store.loadSync(), { status: "ok", source: "missing", value: { colors: {} }, issues: [] });
	assert.equal(existsSync(dirname(store.path)), false);
});

test("full config accepts every color role", (t) => {
	const colors: Record<string, unknown> = {
		repository: "muted",
		branch: "accent",
		gitStatus: "warning",
		input: "#4ec9b0",
		output: 39,
		cache: "#c586c0",
		throughput: 220,
		cost: "#ce9178",
		context: "#89d185",
		model: "text",
		runtime: "muted",
		codegraphActive: "accent",
		separator: "dim",
	};
	const loaded = storeWith(t, JSON.stringify({ colors })).loadSync();
	assert.equal(loaded.status, "ok");
	assert.deepEqual(loaded.issues, []);
	if (loaded.status === "ok") assert.deepEqual(Object.keys(loaded.value.colors).sort(), [...FOOTER_COLOR_ROLES].sort());
});

test("accepts theme tokens, hex, oklch, okhsl and ANSI boundaries", () => {
	for (const token of ["accent", "dim", "muted", "text", "success", "warning", "error", "thinkingText"]) {
		assert.equal(parseFooterColor(token, noReport).kind, "token", token);
	}
	for (const value of ["#0af", "#00aaff", "oklch(62% 0.1 200)", "okhsl(250 60% 55%)", 0, 255]) {
		assert.equal(parseFooterColor(value, noReport).kind, "color", String(value));
	}
});

test("rejects invalid color values", () => {
	const invalid: [unknown, RegExp][] = [
		["", /expected a theme token/],
		["not-a-color", /invalid color/],
		[1.5, /ANSI index/],
		[256, /ANSI index/],
		[-1, /ANSI index/],
	];
	for (const [value, pattern] of invalid) {
		assert.throws(() => parseFooterColor(value, noReport), pattern, JSON.stringify(value));
	}
});

test("unknown keys and roles warn, and an invalid role keeps the other roles", (t) => {
	const contents = JSON.stringify({ extra: true, colors: { input: "#4ec9b0", nope: "accent", output: "not-a-color" } });
	const store = storeWith(t, contents);
	const loaded = store.loadSync();
	assert.equal(loaded.status, "ok");
	if (loaded.status === "ok") assert.deepEqual(Object.keys(loaded.value.colors), ["input"]);
	assert.deepEqual(loaded.issues.map(({ kind, key }) => [kind, key]), [
		["unknown-key", "extra"],
		["unknown-key", "colors.nope"],
		["invalid-value", "colors.output"],
	]);
	assert.equal(readFileSync(store.path, "utf8"), contents);
});

test("malformed file warns, uses built-in colors, and stays unchanged", (t) => {
	const store = storeWith(t, "{ broken json");
	const loaded = store.loadSync();
	assert.equal(loaded.status, "ok");
	if (loaded.status === "ok") assert.deepEqual(loaded.value.colors, {});
	assert.equal(loaded.issues[0]?.kind, "invalid-json");
	assert.equal(readFileSync(store.path, "utf8"), "{ broken json");
});

test("paintFooter: token uses theme.fg, concrete color uses theme.style, missing falls back", () => {
	const theme = fakeTheme();
	const tokenValue = parseFooterColor("success", noReport);
	const colorValue = parseFooterColor("#4ec9b0", noReport);
	const fallbackValue: FooterColorConfig["input"] = undefined;

	assert.equal(paintFooter(theme as never, tokenValue, "dim", "x"), "<success>x</>");
	assert.equal(paintFooter(theme as never, colorValue, "dim", "x"), "<color>x</>");
	assert.equal(paintFooter(theme as never, fallbackValue, "dim", "x"), "<dim>x</>");

	assert.deepEqual(theme.fgCalls, [
		["success", "x"],
		["dim", "x"],
	]);
	assert.equal(theme.styleCalls.length, 1);
});

test("concrete ANSI value produces a Color object", () => {
	const value = parseFooterColor(39, noReport);
	assert.equal(value.kind, "color");
	if (value.kind === "color") assert.equal(value.color.kind, "indexed");
});
