import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	availableTaskModels,
	executeTaskRoutes,
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
const EXECUTION_ROUTES = [
	{ model: { provider: "test", id: "primary" }, thinkingLevel: "off" },
	{ model: { provider: "test", id: "fallback" }, thinkingLevel: "off" },
] as any;

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

test("preset picker applies supplied profiles and preserves omitted profiles and current task assignments", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const preset = {
			fast: { primary: { model: "provider/quick", thinkingLevel: "off" } },
			balanced: {
				primary: { model: "provider/steady", thinkingLevel: "medium" },
				fallback: { model: "provider/backup", thinkingLevel: "low" },
			},
			frontier: { primary: { model: "provider/deep", thinkingLevel: "high" } },
		};
		const fav = { primary: { model: "provider/favorite", thinkingLevel: "max" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const presetsFile = join(dir, "config", "pi-task-models", "presets.json");
		const contents = JSON.stringify({ zeta: preset, alpha: preset });
		writeFileSync(presetsFile, contents);
		writeFileSync(configFile(dir), JSON.stringify({ profiles: {
			...preset,
			frontier: { ...preset.frontier, fallback: preset.fast.primary },
		} }));
		const notices: Array<[string, string]> = [];
		await handler("preset", { ui: {
			select: async (title: string, options: string[]) => {
				assert.equal(title, "Task model preset");
				assert.deepEqual(options, ["alpha", "zeta"]);
				// Preserve unrelated changes made while the picker is open.
				writeFileSync(configFile(dir), JSON.stringify({
					profiles: { fav }, tasks: { "pi-example/review": "balanced" },
				}));
				return "alpha";
			},
			notify(message: string, level: string) { notices.push([message, level]); },
		} });
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { ...preset, fav }, tasks: { "pi-example/review": "balanced" },
		});
		assert.equal(readFileSync(presetsFile, "utf8"), contents);
		assert.deepEqual(notices, [["Applied task model preset: alpha.", "info"]]);

		const favorite = { primary: { model: "provider/new-favorite", thinkingLevel: "low" } };
		writeFileSync(presetsFile, JSON.stringify({ "favorite-only": { fav: favorite } }));
		await handler("preset", { ui: {
			select: async (_title: string, options: string[]) => {
				assert.deepEqual(options, ["favorite-only"]);
				return "favorite-only";
			},
			notify() {},
		} });
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { ...preset, fav: favorite }, tasks: { "pi-example/review": "balanced" },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset selection can create config; cancellation never writes", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models", "presets.json"), JSON.stringify({
			setup: { fast: profile, balanced: profile, frontier: profile },
		}));
		let selected: string | undefined;
		const ctx = { ui: { select: async () => selected, notify() {} } };
		await handler("preset", ctx);
		assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
		selected = "setup";
		await handler("preset", ctx);
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { fast: profile, balanced: profile, frontier: profile }, tasks: {},
		});
		const contents = readFileSync(configFile(dir), "utf8");
		selected = undefined;
		await handler("preset", ctx);
		assert.equal(readFileSync(configFile(dir), "utf8"), contents);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing, empty, or invalid presets leave active config and preset files untouched", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const active = JSON.stringify({ tasks: { "pi-example/review": "fast" } });
		writeFileSync(configFile(dir), active);
		const path = join(dir, "config", "pi-task-models", "presets.json");
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		for (const [contents, expected] of [
			[undefined, /Couldn't read task model presets.*presets\.json/],
			["{}", /No presets found/],
			["{ not json", /Invalid JSON\./],
			[JSON.stringify({ invalid: null }), /profiles must be an object/],
			[JSON.stringify({ invalid: { fast: profile, balanced: profile, frontier: {
				primary: { model: "provider/model", thinkingLevel: "wrong" },
			} } }), /frontier profile is invalid/],
			[JSON.stringify({ invalid: { unknown: profile } }), /Unknown profile: unknown/],
			[JSON.stringify({ invalid: { fav: { ...profile, fallback: profile.primary } } }), /fav profile has no fallback/],
		] as const) {
			if (contents !== undefined) writeFileSync(path, contents);
			const notices: string[] = [];
			await handler("preset", { ui: {
				select: async () => assert.fail("invalid or empty presets must not open a picker"),
				notify(message: string) { notices.push(message); },
			} });
			assert.match(notices[0], expected);
			assert.equal(readFileSync(configFile(dir), "utf8"), active);
			if (contents !== undefined) assert.equal(readFileSync(path, "utf8"), contents);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset application preserves config corrupted while the picker is open", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models", "presets.json"), JSON.stringify({
			setup: { fast: profile, balanced: profile, frontier: profile },
		}));
		const notices: Array<[string, string]> = [];
		await handler("preset", { ui: {
			select: async () => {
				writeFileSync(configFile(dir), "{ not json");
				return "setup";
			},
			notify(message: string, level: string) { notices.push([message, level]); },
		} });
		assert.equal(readFileSync(configFile(dir), "utf8"), "{ not json");
		assert.deepEqual(notices, [["Couldn't save task model config.", "error"]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Option+S saves all current profiles, merges names, confirms replacement, and round-trips", async () => {
	const dir = tempDir();
	try {
		initTheme("dark");
		const { handler } = controlPlane(eventBus(), dir);
		const profiles = {
			fast: {
				primary: { model: "provider/quick", thinkingLevel: "low" },
				fallback: { model: "provider/backup", thinkingLevel: "off" },
			},
			fav: { primary: { model: "provider/favorite", thinkingLevel: "high" } },
		};
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const active = JSON.stringify({ profiles, tasks: { "pi-example/review": "fav" } });
		writeFileSync(configFile(dir), active);
		const path = join(dir, "config", "pi-task-models", "presets.json");
		let name: string | undefined = "my-setup";
		let replace = false;
		let confirmations = 0;
		const notices: Array<[string, string]> = [];
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; });
				assert.match(component.render(80).join("\n"), /Option\+S/);
				component.handleInput("\x1bs");
				return result;
			},
			input: async () => name,
			confirm: async () => { confirmations++; return replace; },
			notify(message: string, level: string) { notices.push([message, level]); },
		} };
		await handler("", ctx);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "my-setup": profiles });
		assert.equal(confirmations, 0);
		assert.deepEqual(notices.pop(), ["Saved task model preset: my-setup.", "info"]);
		assert.equal(readFileSync(configFile(dir), "utf8"), active);

		name = "__proto__";
		await handler("", ctx);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["my-setup", "__proto__"]);
		const saved = readFileSync(path, "utf8");
		name = undefined;
		await handler("", ctx);
		name = "my-setup";
		await handler("", ctx);
		assert.equal(confirmations, 1);
		assert.equal(readFileSync(path, "utf8"), saved);

		const updated = { fast: { primary: { model: "provider/new", thinkingLevel: "off" } } };
		writeFileSync(configFile(dir), JSON.stringify({ profiles: updated }));
		replace = true;
		await handler("", ctx);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "my-setup": updated, ["__proto__"]: profiles });
		await handler("preset", { ui: { select: async () => "__proto__", notify() {} } });
		assert.deepEqual(loadTaskModelsConfig(dir).value.profiles, profiles);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset saving rejects invalid names, malformed existing files, and oversized output without overwriting", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), JSON.stringify({ profiles: { fast: {
			primary: { model: "provider/model", thinkingLevel: "off" },
		} } }));
		const path = join(dir, "config", "pi-task-models", "presets.json");
		let name = "new";
		const notices: string[] = [];
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; }).handleInput("\x1bs");
				return result;
			},
			input: async () => name,
			confirm: async () => assert.fail("must not offer to replace malformed presets"),
			notify(message: string) { notices.push(message); },
		} };
		for (const invalid of ["", " padded", "bad\nname"]) {
			name = invalid;
			await handler("", ctx);
			assert.match(notices.pop()!, /Preset names must be/);
			assert.throws(() => readFileSync(path), { code: "ENOENT" });
		}
		name = "new";
		for (const contents of ["{ not json", '{"invalid":{"unknown":{}}}']) {
			writeFileSync(path, contents);
			await handler("", ctx);
			assert.match(notices.pop()!, /Couldn't save task model presets/);
			assert.equal(readFileSync(path, "utf8"), contents);
		}
		const contents = JSON.stringify({ existing: { fast: { primary: {
			model: `provider/${"x".repeat(65_350)}`, thinkingLevel: "off",
		} } } });
		writeFileSync(path, contents);
		await handler("", ctx);
		assert.match(notices.pop()!, /Presets exceed 65536 bytes/);
		assert.equal(readFileSync(path, "utf8"), contents);
		writeFileSync(configFile(dir), "{}");
		await handler("", ctx);
		assert.match(notices.pop()!, /Configure a task model profile/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task model TUI delegates selection and cancellation to Pi's native list", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		let key = "\x1b";
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; }).handleInput(key);
				return result;
			},
			select: async (title: string) => { assert.equal(title, "Profile fast primary"); return undefined; },
			notify: () => assert.fail("unexpected notification"),
		}, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", input: ["text"] }] } };
		await handler("", ctx);
		key = "\r";
		await handler("", ctx);
		assert.throws(() => readFileSync(configFile(dir)), { code: "ENOENT" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uses scoped models and pinned thinking for picker and route resolution", () => {
	const allowed = { provider: "provider", id: "allowed", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", high: "high" } } as any;
	const excluded = { provider: "provider", id: "excluded", input: ["text"], reasoning: false } as any;
	const ctx = {
		model: allowed,
		scopedModels: [{ model: allowed, thinkingLevel: "high" as const }],
		modelRegistry: { getAvailable: () => [allowed, excluded] },
	};

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
		};
		const file = configFile(dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });

		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{
				taskRouteCode: "config-missing",
				message: /Task model config is missing\. Run \/task-models to configure task routes\./,
			},
		);

		writeFileSync(file, "{}");
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{ taskRouteCode: "profile-missing" },
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
			{
				taskRouteCode: "config-read",
				message: /Couldn't read task model config\. Run \/task-models\./,
			},
		);
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, { id: "bad task", label: "Bad", purpose: "Bad", defaultProfile: "fast" } as ModelTask, dir),
			/Model Task declaration is invalid/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("returns the first successful route", async () => {
	const attempts: string[] = [];
	const result = await executeTaskRoutes(
		EXECUTION_ROUTES,
		async (route) => {
			attempts.push(route.model.id);
			return route.model.id;
		},
		{ shouldFallback: () => true },
	);
	assert.equal(result, "primary");
	assert.deepEqual(attempts, ["primary"]);
});

test("executes approved fallback routes serially and returns first success", async () => {
	const primaryFailure = new Error("primary failed");
	const attempts: string[] = [];
	let releasePrimary = () => {};
	const primaryPending = new Promise<void>((resolve) => { releasePrimary = () => resolve(); });
	const result = executeTaskRoutes(
		EXECUTION_ROUTES,
		async (route) => {
			attempts.push(route.model.id);
			if (route.model.id === "primary") {
				await primaryPending;
				throw primaryFailure;
			}
			return route.model.id;
		},
		{ shouldFallback: (error) => error === primaryFailure },
	);
	assert.deepEqual(attempts, ["primary"]);
	releasePrimary();
	assert.equal(await result, "fallback");
	assert.deepEqual(attempts, ["primary", "fallback"]);
});

test("rethrows the exact final route error", async () => {
	const firstFailure = new Error("first failed");
	const finalFailure = new Error("final failed");
	let attempt = 0;
	let fallbackChecks = 0;
	await assert.rejects(
		executeTaskRoutes(
			EXECUTION_ROUTES,
			async () => { throw [firstFailure, finalFailure][attempt++]; },
			{ shouldFallback: () => { fallbackChecks++; return true; } },
		),
		(error) => error === finalFailure,
	);
	assert.equal(attempt, 2);
	assert.equal(fallbackChecks, 1);
});

test("rejects an empty route list", async () => {
	let attempted = false;
	await assert.rejects(
		executeTaskRoutes([], async () => {
			attempted = true;
			return undefined;
		}, { shouldFallback: () => true }),
		/Task route list must not be empty/,
	);
	assert.equal(attempted, false);
});

test("stops before or after cancellation and on non-fallback errors", async () => {
	const beforeAttempt = new AbortController();
	const beforeAttemptError = new Error("cancelled before attempt");
	beforeAttempt.abort(beforeAttemptError);
	let beforeAttemptCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			beforeAttemptCalls++;
			return "unexpected";
		}, { shouldFallback: () => true, signal: beforeAttempt.signal }),
		(error) => error === beforeAttemptError,
	);
	assert.equal(beforeAttemptCalls, 0);

	const afterFailure = new AbortController();
	const afterFailureError = new Error("cancelled after failure");
	let afterFailureCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			afterFailureCalls++;
			afterFailure.abort();
			throw afterFailureError;
		}, {
			shouldFallback: () => { throw new Error("should not evaluate fallback after cancellation"); },
			signal: afterFailure.signal,
		}),
		(error) => error === afterFailureError,
	);
	assert.equal(afterFailureCalls, 1);

	const nonFallbackError = new Error("do not fall back");
	let nonFallbackCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			nonFallbackCalls++;
			throw nonFallbackError;
		}, { shouldFallback: () => false }),
		(error) => error === nonFallbackError,
	);
	assert.equal(nonFallbackCalls, 1);
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
