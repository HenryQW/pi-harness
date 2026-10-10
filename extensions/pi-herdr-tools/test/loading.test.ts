import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	SessionManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const askQuestionRoot = fileURLToPath(new URL("../../pi-ask-question/", import.meta.url));

test("package loading registers all Herdr commands through one extension", async (t) => {
	const isolated = await mkdtemp(join(tmpdir(), "pi-herdr-tools-loading-"));
	t.after(() => rm(isolated, { recursive: true, force: true }));
	const loaded = await discoverAndLoadExtensions([packageRoot], isolated, isolated);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual(
		loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
		["btw", "clone-tab", "clone-worktree", "done", "rename"],
	);
});

type Kind = "select" | "confirm" | "input" | "editor" | "custom";
type Pending = { kind: Kind; resolve(value?: unknown): void; reject(error: Error): void };

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Herdr consumer stub with the installed integration's clamped blocked count. */
function herdrConsumer() {
	const events: unknown[] = [];
	const counts: number[] = [];
	let count = 0;
	const bus = createEventBus();
	bus.on("herdr:blocked", (data) => {
		events.push(data);
		count = (data as { active?: boolean }).active ? count + 1 : Math.max(0, count - 1);
		counts.push(count);
	});
	return { bus, events, counts, count: () => count };
}

/** Load extensions into a native runner whose UI prompts stay open until the test settles them. */
async function nativeSession(t: TestContext, mode: "tui" | "rpc" | "json" | "print", options: {
	consumer?: ReturnType<typeof herdrConsumer>; paths?: string[]; selectAnswer?: (choices: string[]) => unknown;
} = {}) {
	const isolated = await mkdtemp(join(tmpdir(), "pi-herdr-tools-dialog-"));
	t.after(() => rm(isolated, { recursive: true, force: true }));
	const consumer = options.consumer ?? herdrConsumer();
	const loaded = await discoverAndLoadExtensions([...(options.paths ?? []), packageRoot], isolated, isolated, consumer.bus);
	assert.deepEqual(loaded.errors, []);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, isolated, SessionManager.inMemory(isolated), undefined as never);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	const pending: Pending[] = [];
	const open = (kind: Kind) => (...args: unknown[]) => new Promise((resolve, reject) => {
		pending.push({ kind, resolve, reject });
		if (kind === "select" && options.selectAnswer) resolve(options.selectAnswer(args[1] as string[]));
	});
	runner.setUIContext({
		select: open("select"), confirm: open("confirm"), input: open("input"), editor: open("editor"), custom: open("custom"),
		setWidget() {}, setStatus() {},
	} as unknown as ExtensionUIContext, mode);
	return { ...consumer, runner, ui: runner.getUIContext(), pending, errors, isolated, loaded };
}

const active = { active: true, label: "Input required" };
const inactive = { active: false };
const prompts: Record<Kind, (ui: ExtensionUIContext) => Promise<unknown>> = {
	select: (ui) => ui.select("Pick", ["a"]),
	confirm: (ui) => ui.confirm("Sure?", "Secret dialog body"),
	input: (ui) => ui.input("Name", "placeholder"),
	editor: (ui) => ui.editor("Edit", "draft"),
	custom: (ui) => ui.custom(() => ({ render: () => [], invalidate() {} }) as never),
};

test("TUI dialogs of every kind block Herdr only while open, without titles or content", async (t) => {
	const session = await nativeSession(t, "tui");
	for (const kind of Object.keys(prompts) as Kind[]) {
		for (const outcome of ["answer", "cancel", "reject"] as const) {
			const before = session.events.length;
			const result = prompts[kind](session.ui);
			await settle();
			assert.equal(session.count(), 1, `${kind} ${outcome} blocks while open`);
			const prompt = session.pending.shift()!;
			if (outcome === "reject") prompt.reject(new Error("dialog failed"));
			else prompt.resolve(outcome === "cancel" ? undefined : "value");
			if (outcome === "reject") await assert.rejects(result, /dialog failed/);
			else await result;
			await settle();
			assert.equal(session.count(), 0, `${kind} ${outcome} releases`);
			assert.deepEqual(session.events.slice(before), [active, inactive]);
		}
	}
	assert.deepEqual(session.errors, []);
});

test("synchronous dialog failures and nested native dialogs keep one balanced block", async (t) => {
	const session = await nativeSession(t, "tui");
	session.runner.setUIContext({
		select() { throw new Error("sync failure"); },
		custom: (..._args: unknown[]) => new Promise((resolve, reject) => session.pending.push({ kind: "custom", resolve, reject })),
		input: (..._args: unknown[]) => new Promise((resolve, reject) => session.pending.push({ kind: "input", resolve, reject })),
	} as unknown as ExtensionUIContext, "tui");
	const ui = session.runner.getUIContext();
	assert.throws(() => ui.select("Pick", ["a"]), /sync failure/);
	await settle();
	assert.equal(session.count(), 0);
	assert.deepEqual(session.events, [active, inactive]);

	const outer = prompts.custom(ui);
	const nested = ui.input("Nested", "");
	await settle();
	session.pending.pop()!.resolve("nested");
	await nested;
	await settle();
	assert.equal(session.count(), 1, "outer dialog still blocks after nested dialog closes");
	session.pending.pop()!.resolve("done");
	await outer;
	await settle();
	assert.equal(session.count(), 0);
	assert.deepEqual(session.events, [active, inactive, active, inactive]);
	assert.deepEqual(session.errors, []);
});

test("ask_question with a custom answer overlaps dialog status without an early unblock", async (t) => {
	const session = await nativeSession(t, "tui", { paths: [askQuestionRoot], selectAnswer: (choices) => choices.at(-1) });
	const tool = session.loaded.extensions.flatMap((extension) => [...extension.tools.values()])
		.find((registered) => registered.definition.name === "ask_question")!.definition;
	const signal = new AbortController().signal;
	const result = tool.execute("call-1", { question: "Storage?", options: [{ label: "SQLite" }] },
		signal, undefined, session.runner.createToolContext("call-1", signal));
	await settle();
	await settle();
	assert.deepEqual(session.pending.map((prompt) => prompt.kind), ["select", "input"]);
	assert.ok(session.count() > 0, "custom input still blocks");
	session.pending.at(-1)!.resolve("Postgres");
	assert.deepEqual((await result).content, [{ type: "text", text: "User wrote: Postgres" }]);
	await settle();
	assert.equal(session.count(), 0);
	assert.equal(session.counts.indexOf(0), session.counts.length - 1, "Herdr is never unblocked before the question finishes");
	assert.deepEqual(session.errors, []);
});

test("dialog end delivered before a delayed start leaves no stale block", async (t) => {
	const gate = join(await mkdtemp(join(tmpdir(), "pi-herdr-tools-gate-")), "gate.mjs");
	t.after(() => rm(join(gate, ".."), { recursive: true, force: true }));
	await writeFile(gate, `export default (pi) => pi.on("ui_prompt_start", () => globalThis.herdrDialogGate);\n`);
	let release!: () => void;
	(globalThis as { herdrDialogGate?: Promise<void> }).herdrDialogGate = new Promise((resolve) => { release = resolve; });
	t.after(() => { delete (globalThis as { herdrDialogGate?: unknown }).herdrDialogGate; });
	const session = await nativeSession(t, "tui", { paths: [gate] });
	const result = prompts.select(session.ui);
	await settle();
	session.pending.shift()!.resolve("a");
	await result;
	await settle();
	release();
	await settle();
	assert.equal(session.count(), 0, "reversed start does not leave Herdr blocked");
	assert.deepEqual(session.events, []);

	const next = prompts.input(session.ui);
	await settle();
	assert.equal(session.count(), 1, "later dialogs still block");
	session.pending.shift()!.resolve("x");
	await next;
	await settle();
	assert.equal(session.count(), 0);
	assert.deepEqual(session.errors, []);
});

test("shutdown releases only this bridge's open block and ignores stale dialog events after reload", async (t) => {
	const consumer = herdrConsumer();
	const old = await nativeSession(t, "tui", { consumer });
	await old.runner.emit({ type: "session_shutdown", reason: "reload" });
	assert.deepEqual(consumer.events, [], "an idle shutdown emits nothing");

	const reloaded = await nativeSession(t, "tui", { consumer });
	const stale = prompts.custom(reloaded.ui);
	await settle();
	assert.equal(consumer.count(), 1);
	consumer.bus.emit("herdr:blocked", active); // Another emitter still waits for input.
	await reloaded.runner.emit({ type: "session_shutdown", reason: "reload" });
	reloaded.runner.invalidate();
	assert.equal(consumer.count(), 1, "shutdown releases only the bridge's contribution");
	consumer.bus.emit("herdr:blocked", inactive);
	assert.equal(consumer.count(), 0);
	assert.deepEqual(consumer.events, [active, active, inactive, inactive]);

	const current = await nativeSession(t, "tui", { consumer });
	const fresh = prompts.select(current.ui);
	await settle();
	assert.equal(consumer.count(), 1);
	reloaded.pending.shift()!.resolve("late");
	await stale;
	const lateStart = prompts.input(reloaded.ui);
	await settle();
	assert.equal(consumer.count(), 1, "stale old-runtime events neither unblock nor block");
	reloaded.pending.shift()!.resolve("late");
	await lateStart;
	current.pending.shift()!.resolve("a");
	await fresh;
	await settle();
	assert.equal(consumer.count(), 0);
	assert.deepEqual(consumer.events, [active, active, inactive, inactive, active, inactive]);
	assert.deepEqual([...old.errors, ...reloaded.errors, ...current.errors], []);
});

test("RPC, JSON, and print dialogs never report Herdr blocked status", async (t) => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const session = await nativeSession(t, mode);
		if (mode === "rpc") assert.equal(session.runner.createContext().hasUI, true);
		const result = prompts.confirm(session.ui);
		await settle();
		session.pending.shift()!.resolve(true);
		await result;
		await session.runner.emit({ type: "session_shutdown", reason: "quit" });
		assert.deepEqual(session.events, [], mode);
		assert.deepEqual(session.errors, [], mode);
	}
});
