import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	availableTaskModels,
	loadTaskModelsConfig,
	registerModelTask,
	resolveConfiguredTaskRoute,
	resolveConfiguredTaskRoutes,
	resolveTaskModelRoute,
	taskThinkingLevels,
	type ModelTask,
} from "@henryqw/pi-task-models";
import registerTaskModelsExtension from "../extensions/task-models.ts";

const EXAMPLE_TASK = {
	id: "pi-example/review",
	label: "Example review",
	purpose: "Review one requested change.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
const MODEL_TASK_REQUEST_EVENT = "@henryqw/pi-task-models:model-task-request";
const MODEL_TASK_RESPONSE_EVENT = "@henryqw/pi-task-models:model-task-response";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-task-models-"));
}

function configFile(dir: string): string {
	return join(dir, "config", "pi-task-models", "config.json");
}

function eventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
		const handlers = listeners.get(channel) ?? new Set();
		handlers.add(handler);
		listeners.set(channel, handlers);
		return () => handlers.delete(handler);
		},
		emit(channel: string, payload: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
		},
		listenerCount(channel: string) {
			return listeners.get(channel)?.size ?? 0;
		},
	};
}

function controlPlane(events: ReturnType<typeof eventBus>, agentDir: string) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	const pi = {
		events,
		on(name: string, listener: (event: unknown, ctx: any) => void) {
			assert.equal(name, "session_start");
			sessionStart = listener;
		},
		registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			handler = command.handler;
		},
	};
	registerTaskModelsExtension(pi as never, { agentDir });
	assert.ok(handler);
	return { pi, handler: handler!, sessionStart };
}

test("loads defaults without writing or legacy fallback and preserves invalid files", () => {
	const dir = tempDir();
	try {
		const file = configFile(dir);
		assert.deepEqual(loadTaskModelsConfig(dir), { source: "missing", value: { profiles: {}, tasks: {} } });
		assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" });

		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models.json"), JSON.stringify({ tasks: { "pi-new/customTask": "frontier" } }));
		assert.deepEqual(loadTaskModelsConfig(dir), { source: "missing", value: { profiles: {}, tasks: {} } });
		assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" });

		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(file, "{ not json\n", { encoding: "utf8" });
		assert.throws(() => loadTaskModelsConfig(dir), /Unexpected token|JSON/);
		assert.equal(readFileSync(file, "utf8"), "{ not json\n");

		for (const invalid of [
			{ extra: true },
			{ profiles: { fast: { primary: { model: " provider/model", thinkingLevel: "low" } } } },
			{ profiles: { fast: { primary: { model: "provider/model", thinkingLevel: "low", extra: true } } } },
			{ tasks: { "bad task": "fast" } },
		]) {
			const text = `${JSON.stringify(invalid)}\n`;
			writeFileSync(file, text);
			assert.throws(() => loadTaskModelsConfig(dir));
			assert.equal(readFileSync(file, "utf8"), text);
		}

		writeFileSync(file, `${JSON.stringify({ tasks: { "pi-new/customTask": "frontier" } })}\n`);
		assert.deepEqual(loadTaskModelsConfig(dir), {
			source: "file",
			value: { profiles: {}, tasks: { "pi-new/customTask": "frontier" } },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("warns once at session start when config is missing", () => {
	const dir = tempDir();
	try {
		const { sessionStart } = controlPlane(eventBus(), dir);
		assert.ok(sessionStart);
		const notices: Array<[string, string]> = [];
		sessionStart({}, {
			ui: { notify(message: string, level: string) { notices.push([message, level]); } },
		});
		assert.deepEqual(notices, [[
			`Task model config is missing at ${configFile(dir)}; run /task-models to configure task routes.`,
			"warning",
		]]);
		assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

test("resolves declaration defaults, explicit overrides, and fallbacks", () => {
	const dir = tempDir();
	try {
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false } as any;
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: false } as any;
		const ctx = {
			model: primary,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [primary, fallback] },
		} as any;
		const file = configFile(dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });

		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			/Task pi-example\/review profile fast is not configured\. Run \/task-models\./,
		);

		writeFileSync(file, JSON.stringify({
			profiles: {
				fast: { primary: { model: "provider/primary", thinkingLevel: "off" } },
				frontier: {
					primary: { model: "provider/primary", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
		}));
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir), {
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
			tasks: { [EXAMPLE_TASK.id]: "frontier" },
		}));
		assert.deepEqual(resolveConfiguredTaskRoutes(ctx, EXAMPLE_TASK, dir), [
			{ model: fallback, thinkingLevel: "off" },
		]);
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir), {
			model: fallback,
			thinkingLevel: "off",
		});

		writeFileSync(file, "{ not json\n");
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			/Couldn't read task model config\. Run \/task-models\./,
		);
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, { id: "bad task", label: "Bad", purpose: "Bad", defaultProfile: "fast" } as ModelTask, dir),
			/Model Task declaration is invalid/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("registers model tasks idempotently and discovers them in either load order", async () => {
	for (const consumerFirst of [true, false]) {
		const dir = tempDir();
		try {
			const events = eventBus();
			let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
			const pi = {
				events,
				on() {},
				registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
					handler = command.handler;
				},
			};
			const register = () => registerModelTask(pi as never, EXAMPLE_TASK);
			if (consumerFirst) register();
			registerTaskModelsExtension(pi as never, { agentDir: dir });
			if (!consumerFirst) register();
			register();
			assert.equal(events.listenerCount(MODEL_TASK_REQUEST_EVENT), 1, "registration is idempotent");

			const responses: unknown[] = [];
			const offResponses = events.on(MODEL_TASK_RESPONSE_EVENT, (payload) => responses.push(payload));
			events.emit(MODEL_TASK_REQUEST_EVENT, { requestId: "ignored", extra: true });
			assert.deepEqual(responses, [], "malformed requests are ignored at the consumer boundary");
			offResponses();

			// A malformed response from another extension must not enter the control plane.
			events.on(MODEL_TASK_REQUEST_EVENT, (request) => {
				events.emit(MODEL_TASK_RESPONSE_EVENT, {
					requestId: (request as { requestId?: unknown }).requestId,
					task: { id: "bad task" },
				});
			});
			mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
			writeFileSync(configFile(dir), JSON.stringify({
				profiles: {},
				tasks: { "pi-hidden/disabled": "balanced" },
			}));
			assert.ok(handler);
			await handler!("", {
				ui: {
					select: async (_label: string, options: readonly string[]) => {
						assert.deepEqual(options, [
							"fast · not configured",
							"balanced · not configured",
							"frontier · not configured",
							"fav · not configured",
							"Example review · pi-example/review · fast",
						]);
						return undefined;
					},
					notify() {},
				},
			});
			assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, { "pi-hidden/disabled": "balanced" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("task-models stores only non-default active task assignments", async () => {
	const dir = tempDir();
	try {
		const events = eventBus();
		const { pi, handler } = controlPlane(events, dir);
		registerModelTask(pi as never, EXAMPLE_TASK);
		const selections = [
			"Example review · pi-example/review · fast",
			"frontier",
			"Example review · pi-example/review · frontier",
			"fast",
		];
		await handler("", {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					const selection = selections.shift();
					assert.ok(selection);
					assert.ok(options.includes(selection));
					return selection;
				},
				notify() {},
			},
		});
		assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, { [EXAMPLE_TASK.id]: "frontier" });

		await handler("", {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					const selection = selections.shift();
					assert.ok(selection);
					assert.ok(options.includes(selection));
					return selection;
				},
				notify() {},
			},
		});
		assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadTaskModelsConfig rejects fallback on fav profile", () => {
	const dir = tempDir();
	try {
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const file = configFile(dir);
		writeFileSync(file, JSON.stringify({
			profiles: { fav: { primary: { model: "p/m", thinkingLevel: "off" }, fallback: { model: "p/f", thinkingLevel: "off" } } },
		}));
		const invalid = readFileSync(file, "utf8");
		assert.throws(() => loadTaskModelsConfig(dir), /fav profile has no fallback/);
		assert.equal(readFileSync(file, "utf8"), invalid);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task-models configures primary and fallback atomically in one profile flow", async () => {
	const dir = tempDir();
	try {
		const events = eventBus();
		const { handler } = controlPlane(events, dir);
		const canonical = { provider: "openai-codex", id: "gpt-5", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low" } };
		const alias = { ...canonical, provider: "openai-codex-2" };
		const fallback = { provider: "other", id: "fallback", input: ["text"], reasoning: false };
		const excluded = { provider: "other", id: "excluded", input: ["text"], reasoning: false };
		let selections = ["fast · not configured", "openai-codex-2/gpt-5", "low", "other/fallback", "off"];
		const ctx = {
			ui: {
				select: async (label: string, options: readonly string[]) => {
					assert.equal(options.includes("other/excluded"), false);
					if (label === "Profile fast fallback" && selections.length === 2) {
						assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
					}
					if (label === "Profile fast fallback" && selections.length === 1) {
						// Replace the home after loading so the async save fails deterministically.
						rmSync(join(dir, "config", "pi-task-models"), { recursive: true, force: true });
						writeFileSync(join(dir, "config", "pi-task-models"), "blocked");
					}
					const choice = selections.shift();
					assert.ok(choice);
					assert.ok(options.includes(choice));
					return choice;
				},
				notify(_message: string) {},
			},
			modelRegistry: { getAvailable: () => [canonical, alias, fallback, excluded] },
			model: alias,
			scopedModels: [
				{ model: alias, thinkingLevel: "low" },
				{ model: fallback, thinkingLevel: "off" },
			],
		};
		await handler("", ctx);
		assert.deepEqual(loadTaskModelsConfig(dir).value.profiles.fast, {
			primary: { model: "openai-codex/gpt-5", thinkingLevel: "low" },
			fallback: { model: "other/fallback", thinkingLevel: "off" },
		});
		assert.match(readFileSync(configFile(dir), "utf8"), /"openai-codex\/gpt-5"/);
		assert.deepEqual(selections, []);

		selections = ["fast · openai-codex/gpt-5 (low) → other/fallback (off)", "openai-codex-2/gpt-5", "low", "None"];
		const notifications: string[] = [];
		ctx.ui.notify = (message: string) => { notifications.push(message); };
		await handler("", ctx);
		assert.ok(notifications.includes("Couldn't save task model config."));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
