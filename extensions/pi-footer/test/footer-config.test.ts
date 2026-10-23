import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createFooterConfigStore,
	FOOTER_COLOR_ROLES,
	paintFooter,
	parseFooterColor,
} from "../extensions/footer-config.ts";

function fakeTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}</>`,
		style: (text: string) => `<color>${text}</>`,
	};
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
		[1.5, /ANSI color index/],
		[256, /ANSI color index/],
		[-1, /ANSI color index/],
	];
	for (const [value, pattern] of invalid) {
		assert.throws(() => parseFooterColor(value, noReport), pattern, JSON.stringify(value));
	}
});

test("unknown keys and roles warn, and an invalid role keeps the other roles", (t) => {
	const contents = JSON.stringify({ extra: true, colors: { input: "#4ec9b0", nope: "accent", output: "not-a-color" } });
	const loaded = storeWith(t, contents).loadSync();
	assert.equal(loaded.status, "ok");
	if (loaded.status === "ok") assert.deepEqual(Object.keys(loaded.value.colors), ["input"]);
	assert.deepEqual(loaded.issues.map(({ kind, key }) => [kind, key]), [
		["unknown-key", "extra"],
		["unknown-key", "colors.nope"],
		["invalid-value", "colors.output"],
	]);
});

test("paintFooter: token uses theme.fg, concrete color uses theme.style, missing falls back", () => {
	const theme = fakeTheme();
	const tokenValue = parseFooterColor("success", noReport);
	const colorValue = parseFooterColor("#4ec9b0", noReport);

	assert.equal(paintFooter(theme as never, tokenValue, "dim", "x"), "<success>x</>");
	assert.equal(paintFooter(theme as never, colorValue, "dim", "x"), "<color>x</>");
	assert.equal(paintFooter(theme as never, undefined, "dim", "x"), "<dim>x</>");
});
