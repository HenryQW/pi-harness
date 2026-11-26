import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import modelPicker from "../extensions/model-picker.ts";

const opus = { provider: "magpie", id: "vps/claude/opus-5.5", name: "Claude Opus 5.5" };
const frontier = { provider: "magpie", id: "vps/group/frontier", name: "Frontier" };
const otherProvider = { provider: "other", id: opus.id, name: opus.name };

async function runPicker({ args = "", available = [opus, frontier, otherProvider], choice }: {
	args?: string;
	available?: (typeof opus)[];
	choice?: string;
} = {}) {
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	let options: string[] | undefined;
	const selections: unknown[] = [];
	const notices: string[] = [];
	modelPicker({
		registerCommand(name: string, config: { handler: typeof command }) {
			assert.equal(name, "magpie-model");
			command = config.handler;
		},
		async setModel(model: unknown) { selections.push(model); return true; },
	} as unknown as ExtensionAPI);
	let refreshed = false;
	await command(args, {
		hasUI: true,
		mode: "rpc",
		modelRegistry: {
			async refresh() { refreshed = true; },
			getError: () => undefined,
			getAvailable: () => refreshed ? available : [],
		},
		ui: {
			async select(_title: string, labels: string[]) { options = labels; return choice; },
			notify(message: string) { notices.push(message); },
		},
	} as unknown as ExtensionContext);
	return { options, selections, notices };
}

test("shows short labels and selects the original group route", async () => {
	const result = await runPicker({ choice: "group/frontier [magpie]" });
	assert.deepEqual(result.options, ["claude/opus-5.5 [magpie]", "group/frontier [magpie]"]);
	assert.deepEqual(result.selections, [frontier]);
});

test("searches the full key across available Magpie routes", async () => {
	const args = `MAGPIE/${opus.id}`;
	const match = await runPicker({ args, choice: "claude/opus-5.5 [magpie]" });
	assert.deepEqual(match.options, ["claude/opus-5.5 [magpie]"]);
	assert.deepEqual(match.selections, [opus]);
	const excluded = await runPicker({ args, available: [frontier] });
	assert.equal(excluded.options, undefined);
	assert.deepEqual(excluded.selections, []);
	assert.match(excluded.notices[0]!, /No Magpie models match/);
});

test("keeps full labels for routes that would have the same short name", async () => {
	const direct = { ...opus, id: "claude/opus-5.5" };
	const result = await runPicker({ available: [opus, direct], choice: `${opus.id} [magpie]` });
	assert.deepEqual(result.options, [`${opus.id} [magpie]`, `${direct.id} [magpie]`]);
	assert.deepEqual(result.selections, [opus]);
});
