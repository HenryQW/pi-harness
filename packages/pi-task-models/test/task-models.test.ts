import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	activeTaskPackages,
	availableTaskModels,
	canonicalModelReference,
	dedupeAvailableModels,
	DEFAULT_TASK_ASSIGNMENTS,
	orderedProfileRoutes,
	readTaskModelsConfig,
	resolveAvailableModel,
	resolveConfiguredTaskRoute,
	resolveTaskModelRoute,
	supportedThinkingLevels,
	taskThinkingLevels,
	writeTaskModelsConfig,
} from "@henryqw/pi-task-models";
import { registerTaskModelsExtension } from "../extensions/task-models.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-task-models-"));
}

test("reads defaults, preserves malformed files, and writes config explicitly", () => {
	const dir = tempDir();
	try {
		assert.deepEqual(readTaskModelsConfig(dir), {
			profiles: {},
			tasks: {
				"pi-herdr-rename/rename": "fast",
				"pi-auto-compact/autoCompact": "fast",
				"pi-subagent/delegateTask": "balanced",
				"pi-auto-dag/implement": "balanced",
				"pi-auto-dag/review": "frontier",
			},
		});

		const file = join(dir, "config", "pi-task-models.json");
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(file, "{ not json\n", { encoding: "utf8" });
		assert.throws(() => readTaskModelsConfig(dir), /Unexpected token|JSON/);
		assert.equal(readFileSync(file, "utf8"), "{ not json\n");

		for (const invalid of [
			{ extra: true },
			{ profiles: { fast: { primary: { model: " provider/model", thinkingLevel: "low" } } } },
			{ profiles: { fast: { primary: { model: "provider/model", thinkingLevel: "low", extra: true } } } },
			{ tasks: { "bad task": "fast" } },
		]) {
			const text = `${JSON.stringify(invalid)}\n`;
			writeFileSync(file, text);
			assert.throws(() => readTaskModelsConfig(dir));
			assert.equal(readFileSync(file, "utf8"), text);
		}

		writeFileSync(file, `${JSON.stringify({ tasks: { "pi-new/customTask": "frontier" } })}\n`);
		assert.equal(readTaskModelsConfig(dir).tasks["pi-new/customTask"], "frontier");

		writeTaskModelsConfig(
			{
				profiles: {
					fast: {
						primary: { model: "openai-codex-2/gpt-5", thinkingLevel: "low" },
					},
				},
				tasks: {
					"pi-herdr-rename/rename": "fast",
				},
			},
			dir,
		);
		assert.match(readFileSync(file, "utf8"), /"openai-codex\/gpt-5"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("canonicalizes codex aliases, dedupes active models, and resolves thinking levels", () => {
	const canonical = { provider: "openai-codex", id: "gpt-5", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", max: "max" } } as any;
	const alias = { ...canonical, provider: "openai-codex-2" } as any;
	const other = { provider: "other", id: "model", input: ["text"], reasoning: false } as any;
	const models = dedupeAvailableModels([alias, canonical, other], "openai-codex-2");
	const withoutActiveCodex = dedupeAvailableModels([canonical, alias, other], "other");

	assert.equal(models[0].provider, "openai-codex-2");
	assert.equal(withoutActiveCodex[0].provider, "openai-codex-2");
	assert.equal(canonicalModelReference(alias), "openai-codex/gpt-5");
	assert.deepEqual(supportedThinkingLevels(other as never), ["off"]);
	assert.deepEqual(supportedThinkingLevels(canonical as never), ["off", "minimal", "low", "medium", "high", "max"]);
	assert.equal(resolveAvailableModel(models as never, "openai-codex/gpt-5", "openai-codex-2")?.provider, "openai-codex-2");
	assert.equal(resolveAvailableModel([canonical, alias] as never, "openai-codex/gpt-5", "other")?.provider, "openai-codex-2");
	assert.deepEqual(orderedProfileRoutes({ primary: { model: "a/b", thinkingLevel: "low" }, fallback: { model: "c/d", thinkingLevel: "high" } }), [
		{ model: "a/b", thinkingLevel: "low" },
		{ model: "c/d", thinkingLevel: "high" },
	]);
});

test("uses scoped models and pinned thinking for picker and route resolution", () => {
	const allowed = { provider: "provider", id: "allowed", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", high: "high" } } as any;
	const excluded = { provider: "provider", id: "excluded", input: ["text"], reasoning: false } as any;
	const ctx = {
		model: allowed,
		scopedModels: [{ model: allowed, thinkingLevel: "high" }],
		modelRegistry: { getAvailable: () => [allowed, excluded] },
	} as any;

	assert.deepEqual(availableTaskModels(ctx), [allowed]);
	assert.deepEqual(taskThinkingLevels(ctx, allowed), ["high"]);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/allowed", thinkingLevel: "high" })?.model, allowed);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/allowed", thinkingLevel: "low" }), undefined);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/excluded", thinkingLevel: "off" }), undefined);
});

test("resolves configured task routes through assignment, profile, and fallback", () => {
	const dir = tempDir();
	try {
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false } as any;
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: false } as any;
		const ctx = {
			model: primary,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [primary, fallback] },
		} as any;

		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, "pi-auto-dag/implement", dir),
			/Task pi-auto-dag\/implement profile balanced is not configured\. Run \/task-models\./,
		);
		const file = join(dir, "config", "pi-task-models.json");
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(file, JSON.stringify({
			profiles: {
				frontier: {
					primary: { model: "provider/primary", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
			tasks: { "pi-auto-dag/implement": "frontier" },
		}));
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, "pi-auto-dag/implement", dir), {
			model: primary,
			thinkingLevel: "off",
		});

		writeFileSync(file, JSON.stringify({
			profiles: {
				frontier: {
					primary: { model: "provider/unavailable", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
			tasks: { "pi-auto-dag/implement": "frontier" },
		}));
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, "pi-auto-dag/implement", dir), {
			model: fallback,
			thinkingLevel: "off",
		});
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, "pi-other/run", dir),
			/Task pi-other\/run is not assigned to a profile\. Run \/task-models\./,
		);

		writeFileSync(file, JSON.stringify({
			profiles: { frontier: { primary: { model: "provider/unavailable", thinkingLevel: "off" } } },
			tasks: { "pi-auto-dag/implement": "frontier" },
		}));
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, "pi-auto-dag/implement", dir),
			/Task pi-auto-dag\/implement profile frontier has no available route\. Run \/task-models\./,
		);
		writeFileSync(file, "{ not json\n");
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, "pi-auto-dag/implement", dir),
			/Couldn't read task model config\. Run \/task-models\./,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discovers active HenryQW task packages from Pi sourceInfo", () => {
	const active = activeTaskPackages({
		getCommands() {
			return [
				{ sourceInfo: { source: "npm:@henryqw/pi-herdr-rename", path: "/tmp/node_modules/@henryqw/pi-herdr-rename/extensions/rename.ts", scope: "user", origin: "package" } },
				{ sourceInfo: { source: "npm:@henryqw/pi-auto-dag", path: "/tmp/node_modules/@henryqw/pi-auto-dag/extensions/auto-dag.ts", scope: "user", origin: "package" } },
				{ sourceInfo: { source: "npm:@henryqw/pi-new", path: "/tmp/node_modules/@henryqw/pi-new/extensions/new.ts", scope: "user", origin: "package" } },
				{ sourceInfo: { source: "npm:evil-pi-herdr-rename-copy", path: "/tmp/evil-pi-herdr-rename-copy/extension.ts", scope: "user", origin: "package" } },
			] as never;
		},
		getAllTools() {
			return [
				{ sourceInfo: { source: "file:/tmp/packages/pi-auto-compact", path: "/tmp/packages/pi-auto-compact/extensions/auto-compact.ts", scope: "user", origin: "package" } },
				{ sourceInfo: { source: "npm:@henryqw/pi-subagent", path: "/tmp/node_modules/@henryqw/pi-subagent/extensions/subagent.ts", scope: "user", origin: "package" } },
			] as never;
		},
	}, {
		...DEFAULT_TASK_ASSIGNMENTS,
		"pi-new/customTask": "frontier",
	});

	assert.deepEqual(active.map((entry) => entry.task).sort(), [
		"pi-auto-compact/autoCompact",
		"pi-auto-dag/implement",
		"pi-auto-dag/review",
		"pi-herdr-rename/rename",
		"pi-new/customTask",
		"pi-subagent/delegateTask",
	]);
	assert.deepEqual(activeTaskPackages({
		getCommands: () => [{ sourceInfo: { source: "npm:evil-pi-herdr-rename-copy", path: "/tmp/evil-pi-herdr-rename-copy/extension.ts" } }] as never,
		getAllTools: () => [] as never,
	}), []);
});

test("task-models hides task assignment when no supported task package is active", async () => {
	const dir = tempDir();
	try {
		let handler: ((args: string[], ctx: never) => Promise<void>) | undefined;
		registerTaskModelsExtension({
			registerCommand(_name: string, options: { handler: (args: string[], ctx: unknown) => Promise<void> }) {
				handler = options.handler;
			},
			getCommands: () => [] as never,
			getAllTools: () => [] as never,
		} as never, { agentDir: dir });
		assert.ok(handler);
		await handler!([], {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					assert.deepEqual(options, ["fast · not configured", "balanced · not configured", "frontier · not configured"]);
					return undefined;
				},
				notify() {},
			} as never,
		} as never);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task-models shows unique full IDs for matching task names", async () => {
	const dir = tempDir();
	try {
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models.json"), JSON.stringify({
			tasks: { "pi-a/summarize": "balanced", "pi-b/summarize": "balanced" },
		}));
		let handler: ((args: string[], ctx: never) => Promise<void>) | undefined;
		registerTaskModelsExtension({
			registerCommand(_name: string, options: { handler: (args: string[], ctx: unknown) => Promise<void> }) {
				handler = options.handler;
			},
			getCommands: () => ["pi-a", "pi-b"].map((name) => ({
				sourceInfo: { source: `npm:@henryqw/${name}`, path: `/node_modules/@henryqw/${name}/extension.ts` },
			})) as never,
			getAllTools: () => [] as never,
		} as never, { agentDir: dir });
		await handler!([], {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					assert.ok(options.includes("pi-a/summarize · balanced"));
					assert.ok(options.includes("pi-b/summarize · balanced"));
					return undefined;
				},
				notify() {},
			},
		} as never);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task-models configures primary and fallback atomically in one profile flow", async () => {
	const dir = tempDir();
	try {
		const calls: string[] = [];
		let handler: ((args: string[], ctx: never) => Promise<void>) | undefined;
		registerTaskModelsExtension({
			registerCommand(name: string, options: { handler: (args: string[], ctx: unknown) => Promise<void> }) {
				calls.push(name);
				handler = options.handler;
			},
			getCommands() {
				return [{ sourceInfo: { source: "npm:@henryqw/pi-herdr-rename", path: "/x/node_modules/@henryqw/pi-herdr-rename/extensions/rename.ts", scope: "user", origin: "package" } }] as never;
			},
			getAllTools() {
				return [] as never;
			},
		} as never, { agentDir: dir });

		assert.deepEqual(calls, ["task-models"]);
		assert.ok(handler);

		const canonical = { provider: "openai-codex", id: "gpt-5", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low" } };
		const alias = { ...canonical, provider: "openai-codex-2" };
		const fallback = { provider: "other", id: "fallback", input: ["text"], reasoning: false };
		const excluded = { provider: "other", id: "excluded", input: ["text"], reasoning: false };
		let selections = [
			"fast · not configured",
			"openai-codex-2/gpt-5",
			"low",
			"other/fallback",
			"off",
		];
		const notifications: string[] = [];
		const ctx = {
			ui: {
				select: async (label: string, options: readonly string[]) => {
					assert.equal(options.includes("other/excluded"), false);
					if (label === "Profile fast fallback" && selections.length === 2) {
						assert.throws(() => readFileSync(join(dir, "config", "pi-task-models.json"), "utf8"), { code: "ENOENT" });
					}
					const choice = selections.shift();
					assert.ok(choice);
					assert.ok(options.includes(choice));
					return choice;
				},
				notify(message: string) { notifications.push(message); },
			} as never,
			modelRegistry: { getAvailable: () => [canonical, alias, fallback, excluded] as never } as never,
			model: alias as never,
			scopedModels: [
				{ model: alias, thinkingLevel: "low" },
				{ model: fallback, thinkingLevel: "off" },
			] as never,
		} as never;
		await handler!([], ctx);

		assert.deepEqual(readTaskModelsConfig(dir).profiles.fast, {
			primary: { model: "openai-codex/gpt-5", thinkingLevel: "low" },
			fallback: { model: "other/fallback", thinkingLevel: "off" },
		});
		assert.deepEqual(selections, []);

		const file = join(dir, "config", "pi-task-models.json");
		chmodSync(file, 0o444);
		selections = [
			"fast · openai-codex/gpt-5 (low) → other/fallback (off)",
			"openai-codex-2/gpt-5",
			"low",
			"None",
		];
		await handler!([], ctx);
		assert.ok(notifications.includes("Couldn't save task model config."));
		chmodSync(file, 0o644);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
