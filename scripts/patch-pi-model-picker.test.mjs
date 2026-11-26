import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./patch-pi-model-picker.mjs", import.meta.url));
const picker = 'function render(item) {const theme={fg:(_,text)=>text},getDistinctModelName=({name})=>name,isSelected=false,cursor="",currentMarker="",defaultBadge="",modelText=isSelected?theme.fg("accent",item.id):item.id,name=getDistinctModelName({id:item.id,name:item.model.name}),nameText=name?theme.fg("muted",` (${name})`):"",providerBadge=theme.fg("muted",`[${item.provider}]`),line=`${cursor}${currentMarker}${modelText}${nameText} ${providerBadge}${defaultBadge}`;return line;}\nfunction description(selected){return `Model Name: ${selected.model.name}`;}\n';

function fixture(t, source) {
	const install = mkdtempSync(join(tmpdir(), "pi-picker-fixture-"));
	t.after(() => rmSync(install, { recursive: true, force: true }));
	const modules = join(install, "releases", "1.6.1", "node_modules");
	const bundle = join(modules, "@earendil-works", "pi-coding-agent", "dist", "bundle");
	mkdirSync(join(bundle, "chunks"), { recursive: true });
	mkdirSync(join(modules, ".bin"));
	writeFileSync(join(install, "current-version"), "1.6.1\n");
	writeFileSync(join(bundle, "cli.js"), 'createRequire(import.meta.url)("./cli-runtime.js");');
	writeFileSync(join(bundle, "cli-runtime.js"), 'import{configureHttpDispatcher,main}from"./chunks/chunk-PICKER.js";');
	symlinkSync(join(bundle, "cli.js"), join(modules, ".bin", "pi"));
	const chunks = join(bundle, "chunks");
	const path = join(chunks, "chunk-PICKER.js");
	writeFileSync(path, source);
	return {
		install, chunks, path, backup: `${path}.picker-labels-original`,
		run: () => spawnSync(process.execPath, [script, install], { encoding: "utf8" }),
	};
}

test("shortens relay labels, saves the original bundle, and supports reapplying", (t) => {
	const { path, backup, run } = fixture(t, picker);
	const first = run();
	assert.equal(first.status, 0, first.stderr);
	assert.equal(readFileSync(backup, "utf8"), picker);
	const patched = readFileSync(path, "utf8");
	const render = runInNewContext(`${patched}\nrender;`);
	assert.equal(render({ id: "vps/claude/opus-5.5", provider: "magpie", model: { name: "Claude Opus 5.5 · VPS › Claude Code" } }), "claude/opus-5.5");
	assert.equal(render({ id: "vps/group/frontier", provider: "magpie", model: {} }), "group/frontier");
	assert.equal(render({ id: "vps/claude/opus-5.5", provider: "custom", model: {} }), "vps/claude/opus-5.5 [custom]");
	const second = run();
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /already patched/);
	assert.equal(readFileSync(path, "utf8"), patched);
	assert.equal(readFileSync(backup, "utf8"), picker);
});

test("refuses changed picker code even when a stale chunk still matches", (t) => {
	const changed = picker.replace("modelText=isSelected", "modelText = isSelected");
	const { chunks, path, backup, run } = fixture(t, changed);
	const stale = join(chunks, "chunk-STALE.js");
	writeFileSync(stale, picker);
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Picker rendering changed/);
	assert.equal(readFileSync(path, "utf8"), changed);
	assert.equal(readFileSync(stale, "utf8"), picker);
	assert.equal(existsSync(backup), false);
});

test("refuses a linked chunk directory", (t) => {
	const { install, chunks, path, backup, run } = fixture(t, picker);
	const moved = join(install, "other-chunks");
	renameSync(chunks, moved);
	symlinkSync(moved, chunks);
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /outside its expected path/);
	assert.equal(readFileSync(path, "utf8"), picker);
	assert.equal(existsSync(backup), false);
});

test("requires a verified original when the patch is present", (t) => {
	const { path, backup, run } = fixture(t, picker);
	const first = run();
	assert.equal(first.status, 0, first.stderr);
	const patched = readFileSync(path, "utf8");
	rmSync(backup);
	const missing = run();
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Missing or invalid Pi picker backup/);
	const saved = `${backup}.saved`;
	writeFileSync(saved, picker);
	symlinkSync(saved, backup);
	const linked = run();
	assert.equal(linked.status, 1);
	assert.match(linked.stderr, /Missing or invalid Pi picker backup/);
	assert.equal(readFileSync(path, "utf8"), patched);
});
