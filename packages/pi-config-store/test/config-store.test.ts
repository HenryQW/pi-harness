import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createConfigStore,
	extensionConfigDir,
	extensionConfigPath,
	field,
	parsers,
	readTextFileBounded,
	readTextFileBoundedSync,
	registerConfigReporting,
	required,
	writePrivateTextFileAtomically,
	type ConfigLoad,
} from "../src/index.ts";

function createStore(agentDir: string) {
	return createConfigStore({
		extensionId: "pi-test-store",
		agentDir,
		fields: { count: field(parsers.integer({ min: 0 }), 0) },
	});
}

function createRichStore(agentDir: string) {
	return createConfigStore({
		extensionId: "pi-test-store",
		agentDir,
		fields: {
			mode: field(parsers.oneOf(["fast", "slow"] as const), "fast"),
			overrides: field(parsers.record(parsers.boolean(), { key: parsers.absolutePath() }), {}),
			dirs: field(parsers.array(parsers.absolutePath(), { unique: (dir) => dir }), []),
			limits: field(parsers.object({ idle: field(parsers.number({ greaterThan: 0 }), 10) }), { idle: 10 }),
			directory: field(parsers.absolutePath(), "/default", { onInvalid: "disable" }),
		},
	});
}

async function writeConfig(path: string, contents: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-config-store-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

const boundedReaders = [
	async (path: string, maxBytes: number) => readTextFileBoundedSync(path, maxBytes),
	(path: string, maxBytes: number) => readTextFileBounded(path, maxBytes),
];

test("bounded text reads enforce byte limits and strict UTF-8", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "input.txt");
		await writeFile(path, "é");
		for (const read of boundedReaders) {
			assert.equal(await read(path, 2), "é");
			for (const maxBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				await assert.rejects(read(path, maxBytes), /positive safe integer/);
			}
		}

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(readTextFileBounded(path, 2, { signal: controller.signal }), { name: "AbortError" });

		await writeFile(path, "éx");
		for (const read of boundedReaders) await assert.rejects(read(path, 2), /exceeds 2 bytes/);

		await writeFile(path, Buffer.from([0x80]));
		for (const read of boundedReaders) await assert.rejects(read(path, 1), TypeError);
		await rm(path);
	});
});

test("bounded text reads propagate missing files", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "missing.txt");
		for (const read of boundedReaders) {
			await assert.rejects(read(path, 1), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		}
	});
});

test("private text writes replace atomically with private modes", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "state", "usage.txt");
		await writePrivateTextFileAtomically(path, "first");
		await writePrivateTextFileAtomically(path, "second é");
		assert.equal(await readFile(path, "utf8"), "second é");
		assert.equal((await readdir(dirname(path))).some((entry) => entry.endsWith(".tmp")), false);
		if (process.platform !== "win32") {
			assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
			assert.equal((await stat(path)).mode & 0o777, 0o600);
		}
	});
});

test("private text writes clean temporary files after failure", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "state", "usage.txt");
		await mkdir(path, { recursive: true });
		await assert.rejects(writePrivateTextFileAtomically(path, "blocked"));
		assert.equal((await readdir(dirname(path))).some((entry) => entry.endsWith(".tmp")), false);
	});
});

test("already-aborted private text writes have no filesystem side effects", async () => {
	await withAgentDir(async (agentDir) => {
		const path = join(agentDir, "not-created", "usage.txt");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(writePrivateTextFileAtomically(path, "blocked", { signal: controller.signal }), { name: "AbortError" });
		await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
	});
});

test("config paths reject traversal and have no filesystem side effects", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-config-store-path-"));
	try {
		assert.equal(extensionConfigDir("pi-test-store", agentDir), join(agentDir, "config", "pi-test-store"));
		assert.equal(extensionConfigPath("pi-test-store", agentDir), join(agentDir, "config", "pi-test-store", "config.json"));
		for (const extensionId of ["", ".", "..", "../escape", "/tmp", "pi/test", "pi\\test", "Pi-test", "pi_test", "pi.test"]) {
			assert.throws(() => extensionConfigPath(extensionId, agentDir), /extensionId/);
		}
		assert.deepEqual(await readdir(agentDir), []);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("missing optional config returns defaults without writing", async () => {
	await withAgentDir(async (agentDir) => {
		assert.deepEqual(createStore(agentDir).loadSync(), { status: "ok", source: "missing", value: { count: 0 }, issues: [] });
		assert.deepEqual(await readdir(agentDir), []);
	});
});

test("unknown keys and invalid optional values are reported and replaced by defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createRichStore(agentDir);
		await writeConfig(store.path, JSON.stringify({ mode: "warp", modee: "slow", limits: { idle: 5, extra: 1 } }));
		const before = await readFile(store.path);
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.deepEqual(loaded.status === "ok" && loaded.value, { mode: "fast", overrides: {}, dirs: [], limits: { idle: 5 }, directory: "/default" });
		assert.deepEqual(loaded.issues, [
			{ kind: "unknown-key", key: "modee", message: "unknown key" },
			{ kind: "invalid-value", key: "mode", message: "must be one of fast, slow" },
			{ kind: "unknown-key", key: "limits.extra", message: "unknown key" },
		]);
		assert.deepEqual(await readFile(store.path), before);
	});
});

test("bad nested entries are dropped individually", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createRichStore(agentDir);
		await writeConfig(store.path, JSON.stringify({
			overrides: { "/ok": true, relative: true, "/bad": "yes" },
			dirs: ["/a", 3, "/a", "/b"],
			limits: { idle: -1 },
		}));
		const loaded = store.loadSync();
		assert.equal(loaded.status, "ok");
		assert.deepEqual(loaded.status === "ok" && [loaded.value.overrides, loaded.value.dirs, loaded.value.limits], [{ "/ok": true }, ["/a", "/b"], { idle: 10 }]);
		assert.deepEqual(loaded.issues.map(({ kind, key }) => [kind, key]), [
			["unknown-key", "overrides.relative"],
			["invalid-value", 'overrides["/bad"]'],
			["invalid-value", "dirs[1]"],
			["invalid-value", "dirs[2]"],
			["invalid-value", "limits.idle"],
		]);
	});
});

test("unsafe and required fields disable the config instead of defaulting", async () => {
	await withAgentDir(async (agentDir) => {
		const unsafe = createRichStore(agentDir);
		await writeConfig(unsafe.path, JSON.stringify({ directory: "relative" }));
		assert.deepEqual(unsafe.loadSync(), {
			status: "disabled",
			source: "file",
			issues: [{ kind: "invalid-value", key: "directory", message: "must be an absolute path without control characters" }],
		});

		const strict = createConfigStore({
			extensionId: "pi-required-store",
			agentDir,
			fields: { token: required(parsers.string({ trim: true })), retries: field(parsers.integer({ min: 0 }), 1) },
		});
		const missingIssue = { kind: "missing-required", key: "token", message: "required" };
		assert.deepEqual(strict.loadSync(), { status: "disabled", source: "missing", issues: [missingIssue] });
		await writeConfig(strict.path, JSON.stringify({ retries: 2 }));
		assert.deepEqual(strict.loadSync(), { status: "disabled", source: "file", issues: [missingIssue] });
		await writeFile(strict.path, JSON.stringify({ token: " abc " }));
		assert.deepEqual(strict.loadSync(), { status: "ok", source: "file", value: { token: "abc", retries: 1 }, issues: [] });
		await writeFile(strict.path, "[]");
		assert.equal(strict.loadSync().status, "disabled");
	});
});

test("cross-field checks fall back to all defaults", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createConfigStore({
			extensionId: "pi-test-store",
			agentDir,
			fields: { idle: field(parsers.number(), 10), max: field(parsers.number(), 30) },
			check: ({ idle, max }) => {
				if (max <= idle) throw new Error("max must be greater than idle");
			},
		});
		await writeConfig(store.path, JSON.stringify({ idle: 40 }));
		assert.deepEqual(store.loadSync(), {
			status: "ok",
			source: "file",
			value: { idle: 10, max: 30 },
			issues: [{ kind: "invalid-config", key: "", message: "max must be greater than idle" }],
		});
	});
});

test("entry maps load from a custom file name", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createConfigStore({
			extensionId: "pi-test-store",
			agentDir,
			fileName: "presets.json",
			entries: parsers.record(parsers.object({ model: required(parsers.string()) })),
		});
		assert.equal(store.path, join(agentDir, "config", "pi-test-store", "presets.json"));
		await writeConfig(store.path, JSON.stringify({ work: { model: "a/b" }, broken: {} }));
		const loaded = store.loadSync();
		assert.deepEqual(loaded.status === "ok" && loaded.value, { work: { model: "a/b" } });
		assert.deepEqual(loaded.issues, [{ kind: "invalid-value", key: "broken", message: "model: required" }]);
		assert.throws(() => createConfigStore({ extensionId: "pi-test-store", agentDir, fileName: "../x.json", fields: {} }), /fileName/);
	});
});

test("unreadable files become issues without throwing or writing", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		const cases: [string | Buffer, string][] = [
			["{ broken", "invalid-json"],
			[Buffer.from([0x7b, 0x80, 0x7d]), "invalid-utf8"],
			[Buffer.alloc(64 * 1024 + 1, 0x20), "too-large"],
			["[1]", "invalid-root"],
		];
		for (const [contents, kind] of cases) {
			await writeConfig(store.path, contents);
			const before = await readFile(store.path);
			const loaded = store.loadSync();
			assert.equal(loaded.status, "ok");
			assert.deepEqual(loaded.status === "ok" && loaded.value, { count: 0 });
			assert.deepEqual(loaded.issues.map((issue) => issue.kind), [kind]);
			assert.deepEqual(await readFile(store.path), before);
		}
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			await chmod(store.path, 0o000);
			assert.deepEqual(store.loadSync().issues.map((issue) => issue.kind), ["unreadable"]);
			await chmod(store.path, 0o600);
		}
		await rm(store.path);
		await mkdir(store.path);
		assert.deepEqual(store.loadSync().issues.map((issue) => issue.kind), ["unreadable"]);
		assert.deepEqual(createRichStore(agentDir).loadSync().status, "disabled");
	});
});

test("update refuses files with issues; save validates and replaces them", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		for (const contents of ["{ broken", '{"count":1,"extra":true}']) {
			await writeConfig(store.path, contents);
			await assert.rejects(store.update(({ count }) => ({ count: count + 1 })), (error: Error) =>
				error.message.includes(store.path) && /has issues/.test(error.message));
			assert.equal(await readFile(store.path, "utf8"), contents);
		}
		await assert.rejects(store.save({ count: -1 }), /count: must be an integer >= 0/);
		await assert.rejects(store.save({ count: 1, extra: true } as never), /extra: unknown key/);
		assert.equal(await readFile(store.path, "utf8"), '{"count":1,"extra":true}');
		await store.save({ count: 3 });
		assert.deepEqual(store.loadSync(), { status: "ok", source: "file", value: { count: 3 }, issues: [] });
		assert.deepEqual(await store.update(({ count }) => ({ count: count + 1 })), { count: 4 });
		await assert.rejects(store.update(() => ({ count: -1 })), /count/);
		assert.deepEqual(store.loadSync(), { status: "ok", source: "file", value: { count: 4 }, issues: [] });
	});
});

test("launch reporting shows one deduplicated notification per file", async () => {
	await withAgentDir(async (agentDir) => {
		const warned = createStore(agentDir);
		const disabled = createRichStore(join(agentDir, "other"));
		await writeConfig(warned.path, '{"count":-1}');
		await writeConfig(disabled.path, '{"directory":"relative"}');

		let sessionStart: ((event: unknown, ctx: never) => void) | undefined;
		const pi = { on: (event: string, handler: typeof sessionStart) => { if (event === "session_start") sessionStart = handler; } };
		const reporter = registerConfigReporting(pi as never, [warned, disabled]);
		const notices: [string, string][] = [];
		const ui = { hasUI: true, ui: { notify: (message: string, type: string) => notices.push([message, type]) } };

		sessionStart!({}, ui as never);
		assert.deepEqual(notices, [
			[`pi-test-store config issues (${warned.path}): count: must be an integer >= 0; defaults replace invalid settings.`, "warning"],
			[`pi-test-store disabled (${disabled.path}): directory: must be an absolute path without control characters`, "error"],
		]);

		await writeFile(warned.path, '{"count":-1,"typo":1}');
		reporter.report(ui as never, warned, warned.loadSync());
		reporter.report(ui as never, warned, warned.loadSync());
		assert.deepEqual(notices.slice(2), [[`pi-test-store config issues (${warned.path}): typo: unknown key; defaults replace invalid settings.`, "warning"]]);

		const written: string[] = [];
		const write = process.stderr.write;
		process.stderr.write = ((text: string) => written.push(text) > 0) as typeof process.stderr.write;
		try {
			sessionStart!({}, { hasUI: false, ui: { notify: () => assert.fail("notify without UI") } } as never);
		} finally {
			process.stderr.write = write;
		}
		assert.equal(written.length, 2);
		assert.match(written[1]!, /^pi-test-store disabled .*\n$/);
		const ok: ConfigLoad<unknown> = { status: "ok", source: "missing", value: {}, issues: [] };
		reporter.report(ui as never, warned, ok);
		assert.equal(notices.length, 3);
	});
});

test("concurrent updates do not lose changes", async () => {
	await withAgentDir(async (agentDir) => {
		const first = createStore(agentDir);
		const second = createStore(agentDir);
		await Promise.all(Array.from({ length: 12 }, (_, index) =>
			(index % 2 === 0 ? first : second).update(({ count }) => ({ count: count + 1 }))));
		assert.deepEqual(first.loadSync(), { status: "ok", source: "file", value: { count: 12 }, issues: [] });
	});
});

test("save is atomic and cleans failed temporary files", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		assert.deepEqual(store.loadSync(), { status: "ok", source: "file", value: { count: 1 }, issues: [] });
		assert.equal((await readdir(dirname(store.path))).some((entry) => entry.endsWith(".tmp")), false);

		await rm(store.path);
		await mkdir(store.path);
		await assert.rejects(store.save({ count: 2 }));
		assert.equal((await readdir(dirname(store.path))).some((entry) => entry.endsWith(".tmp")), false);
	});
});

test("saved config uses private modes where supported", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		if (process.platform !== "win32") {
			assert.equal((await stat(dirname(store.path))).mode & 0o777, 0o700);
			assert.equal((await stat(store.path)).mode & 0o777, 0o600);
		}
	});
});

test("remove preserves sibling files", async () => {
	await withAgentDir(async (agentDir) => {
		const store = createStore(agentDir);
		await store.save({ count: 1 });
		const sibling = join(dirname(store.path), "usage.json");
		await writeFile(sibling, "keep");
		await store.remove();
		await assert.rejects(readFile(store.path), { code: "ENOENT" });
		assert.equal(await readFile(sibling, "utf8"), "keep");
	});
});
