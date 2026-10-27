import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HerdrClient } from "@henryqw/pi-herdr";
import { withMainTab } from "../internal/main-tab.ts";

const TOKEN = "pi_harness_main_tab";
const signal = () => new AbortController().signal;
const unused = async () => assert.fail("callback must not run");

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-main-tab-")));
	const previousSocket = process.env.HERDR_SOCKET_PATH;
	process.env.HERDR_SOCKET_PATH = "/tmp/main-tab-test.sock";
	t.after(async () => {
		if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = previousSocket;
		await rm(root, { recursive: true, force: true });
	});
	const ws = { workspace_id: "w1", label: "Workspace", tokens: {} as Record<string, string>, worktree: { checkout_path: root, is_linked_worktree: true } as object | null };
	const tabs = [1, 2].map((number) => ({ workspace_id: "w1", tab_id: `w1:t${number}`, label: `Tab ${number}`, number, pane_count: 1 }));
	const panes = tabs.map((tab, index) => ({ pane_id: `w1:p${index + 1}`, tab_id: tab.tab_id, workspace_id: "w1", cwd: root }));
	const calls: string[][] = [];
	let before: ((args: readonly string[]) => void) | undefined;
	const client: HerdrClient<{ signal: AbortSignal }> = {
		exec: async () => { throw new Error("unexpected exec"); },
		run: async (args) => {
			calls.push([...args]); before?.(args);
			assert.deepEqual(args.slice(0, 5), ["workspace", "report-metadata", ws.workspace_id, "--source", "pi-herdr-tools"]);
			assert.equal(args[5], "--token");
			const [name, value] = args[6]!.split("=");
			ws.tokens[name!] = value!;
			return "{}";
		},
		json: async (args) => {
			calls.push([...args]); before?.(args);
			let value: object;
			switch (`${args[0]} ${args[1]}`) {
				case "pane get": value = { type: "pane_info", pane: panes.find((pane) => pane.pane_id === args[2]) }; break;
				case "tab get": value = { type: "tab_info", tab: tabs.find((tab) => tab.tab_id === args[2]) }; break;
				case "workspace get": value = { type: "workspace_info", workspace: ws }; break;
				case "pane list": assert.deepEqual(args.slice(2), ["--workspace", ws.workspace_id]); value = { type: "pane_list", panes }; break;
				case "tab list": assert.deepEqual(args.slice(2), ["--workspace", ws.workspace_id]); value = { type: "tab_list", tabs }; break;
				default: throw new Error(`unexpected command ${args}`);
			}
			return structuredClone({ result: value });
		},
	};
	return { root, ws, tabs, panes, calls, client, state: join(root, ".context/pi-harness/pi-herdr-tools/state.json"), before: (hook?: typeof before) => { before = hook; } };
}

test("first-created tab is the default and a closed main tab is not replaced", async (t) => {
	const f = await fixture(t);
	const side = await withMainTab(f.client, "w1:p2", signal(), "auto", unused);
	assert.equal(side.selection, "other-tab");
	assert.equal(side.mainTabId, "w1:t1");
	let ran = 0;
	const main = await withMainTab(f.client, "w1:p1", signal(), "auto", async (location) => { ran++; return location.workspaceLabel; });
	assert.equal(main.selection, "main");
	assert.equal(main.selection === "main" && main.value, "Workspace");
	f.tabs[1]!.pane_count = 2;
	const selected = await withMainTab(f.client, "w1:p2", signal(), "select", async () => { ran++; });
	assert.equal(selected.selection, "main");
	assert.equal(selected.tabLabel, "Tab 2");
	assert.equal(selected.paneCount, 2);
	await withMainTab(f.client, "w1:p1", signal(), "auto", unused);
	f.tabs.pop(); f.panes.pop();
	assert.equal((await withMainTab(f.client, "w1:p1", signal(), "auto", unused)).selection, "other-tab");
	assert.equal(ran, 2);
	assert.equal((await stat(f.state)).mode & 0o777, 0o600);
	assert.equal((await stat(join(f.state, ".."))).mode & 0o777, 0o700);
});

test("a missing first tab or an unmatched live token requires explicit selection", async (t) => {
	const f = await fixture(t);
	f.ws.tokens = { [TOKEN]: "already-live" };
	assert.equal((await withMainTab(f.client, "w1:p2", signal(), "auto", unused)).selection, "unselected");
	assert.deepEqual(f.ws.tokens, { [TOKEN]: "already-live" });
	f.ws.tokens = {};
	f.tabs.shift(); f.panes.shift();
	assert.equal((await withMainTab(f.client, "w1:p2", signal(), "auto", unused)).selection, "unselected");
	assert.equal(f.calls.some((args) => args[1] === "report-metadata"), false);
	await assert.rejects(readFile(f.state), { code: "ENOENT" });
});

test("missing or replaced lifetime tokens need select, even when tab identifiers are reused", async (t) => {
	const f = await fixture(t);
	await withMainTab(f.client, "w1:p1", signal(), "select", async () => {});
	const saved = await readFile(f.state, "utf8");
	for (const replacement of [undefined, "another-lifetime"]) {
		if (replacement === undefined) delete f.ws.tokens[TOKEN]; else f.ws.tokens[TOKEN] = replacement;
		assert.equal((await withMainTab(f.client, "w1:p1", signal(), "auto", unused)).selection, "stale-token");
		assert.equal(await readFile(f.state, "utf8"), saved);
	}
	await withMainTab(f.client, "w1:p2", signal(), "select", async () => {});
	assert.notEqual(await readFile(f.state, "utf8"), saved);
	assert.equal((await withMainTab(f.client, "w1:p1", signal(), "auto", unused)).selection, "other-tab");
});

test("the last token read gates the callback; uncertain metadata writes do not enable auto recovery", async (t) => {
	const f = await fixture(t);
	let reported = false;
	f.before((args) => {
		if (args[1] === "report-metadata") reported = true;
		if (reported && args[0] === "workspace" && args[1] === "get") delete f.ws.tokens[TOKEN];
	});
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /token changed/);
	f.before((args) => { if (args[1] === "report-metadata") throw new Error("metadata rejected"); });
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /metadata rejected/);
	f.before();
	assert.equal((await withMainTab(f.client, "w1:p1", signal(), "auto", unused)).selection, "stale-token");
});

test("one checkout keeps separate socket and workspace selections", async (t) => {
	const f = await fixture(t);
	await withMainTab(f.client, "w1:p1", signal(), "select", async () => {});
	const firstTokens = { ...f.ws.tokens };
	process.env.HERDR_SOCKET_PATH = "/tmp/another-main-tab-test.sock";
	f.ws.tokens = {};
	await withMainTab(f.client, "w1:p2", signal(), "select", async () => {});
	process.env.HERDR_SOCKET_PATH = "/tmp/main-tab-test.sock";
	f.ws.tokens = firstTokens;
	assert.equal((await withMainTab(f.client, "w1:p2", signal(), "auto", unused)).selection, "other-tab");
	f.ws.workspace_id = "w2"; f.ws.tokens = {};
	for (const item of [...f.panes, ...f.tabs]) item.workspace_id = "w2";
	await withMainTab(f.client, "w1:p2", signal(), "select", async () => {});
	assert.equal(Object.keys(JSON.parse(await readFile(f.state, "utf8")).workspaces).length, 3);
});

test("invalid state stays unchanged, including invalid text, size, schema, and symlinks", async (t) => {
	const f = await fixture(t);
	await withMainTab(f.client, "w1:p1", signal(), "select", async () => {});
	const valid = JSON.parse(await readFile(f.state, "utf8"));
	const wrongIdentity = structuredClone(valid);
	Object.values(wrongIdentity.workspaces as Record<string, { workspaceId: string }>)[0]!.workspaceId = "wrong";
	for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(65_537, 32), Buffer.from('{"version":2,"workspaces":{}}'), Buffer.from(JSON.stringify({ ...valid, extra: true })), Buffer.from(JSON.stringify(wrongIdentity))]) {
		await writeFile(f.state, bytes);
		await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused));
		assert.deepEqual(await readFile(f.state), bytes);
	}
	const target = join(f.root, "unchanged");
	await writeFile(target, JSON.stringify(valid));
	await rm(f.state); await symlink(target, f.state);
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused));
	assert.equal((await readFile(target, "utf8")), JSON.stringify(valid));
});

test("state-directory symlinks cannot write or chmod outside the checkout", async (t) => {
	const f = await fixture(t);
	const outside = await mkdtemp(join(tmpdir(), "pi-main-tab-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	const components = [".context", "pi-harness", "pi-herdr-tools"];
	for (let index = 0; index < components.length; index++) {
		const target = join(outside, ...components.slice(index + 1));
		await mkdir(target, { recursive: true, mode: 0o755 });
		const sentinel = join(target, "state.json");
		await writeFile(sentinel, "preserve external state");
		const mode = (await stat(target)).mode;
		const contents = await readdir(target);
		const link = join(f.root, ...components.slice(0, index + 1));
		await mkdir(dirname(link), { recursive: true, mode: 0o700 });
		await symlink(outside, link);
		await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /Unsafe main-tab state directory/);
		assert.equal(await readFile(sentinel, "utf8"), "preserve external state");
		assert.equal((await stat(target)).mode, mode);
		assert.deepEqual(await readdir(target), contents);
		await rm(join(f.root, ".context"), { recursive: true });
	}
	assert.equal(f.calls.some((args) => args[1] === "report-metadata"), false);
});

test("live identities, counts, scope changes, and cancellation fail before callbacks", async (t) => {
	const f = await fixture(t);
	await assert.rejects(withMainTab(f.client, "--bad", signal(), "auto", unused), /identity/);
	const originalSocket = process.env.HERDR_SOCKET_PATH;
	delete process.env.HERDR_SOCKET_PATH;
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "auto", unused), /text/);
	process.env.HERDR_SOCKET_PATH = originalSocket;
	f.tabs[0]!.pane_count = 1.5;
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "auto", unused), /pane count/);
	f.tabs[0]!.pane_count = 1;
	f.tabs[0]!.label = "";
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "auto", unused), /text/);
	f.tabs[0]!.label = "Tab 1";
	f.tabs[0]!.workspace_id = "wrong";
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "auto", unused), /identity changed/);
	f.tabs[0]!.workspace_id = "w1";
	let reads = 0;
	f.before((args) => { if (args[0] === "pane" && args[1] === "get" && ++reads === 2) f.panes[0]!.tab_id = "w1:t2"; });
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "auto", unused), /scope changed/);
	f.before(); f.panes[0]!.tab_id = "w1:t1";
	const controller = new AbortController(); controller.abort();
	await assert.rejects(withMainTab(f.client, "w1:p1", controller.signal, "select", unused), { name: "AbortError" });
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", async () => { throw new Error("callback failed"); }), /callback failed/);
	assert.equal((await withMainTab(f.client, "w1:p1", signal(), "auto", async () => 1)).selection, "main");
	const lateAbort = new AbortController(); reads = 0;
	f.before((args) => { if (args[0] === "workspace" && args[1] === "get" && ++reads === 3) lateAbort.abort(); });
	await assert.rejects(withMainTab(f.client, "w1:p1", lateAbort.signal, "auto", unused), { name: "AbortError" });
});

test("directory fallback requires every pane to agree and must be outside Git", async (t) => {
	const f = await fixture(t);
	f.ws.worktree = null;
	f.panes[1]!.cwd = join(f.root, "elsewhere");
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /directories do not agree/);
	f.panes[1]!.cwd = f.root;
	const previousPath = process.env.PATH;
	process.env.PATH = f.root;
	try {
		assert.equal((await withMainTab(f.client, "w1:p1", signal(), "select", async () => {})).isLinkedWorktree, false);
	} finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
	}
	await writeFile(join(f.root, ".git"), "gitdir: elsewhere\n");
	const nested = join(f.root, "nested"); await mkdir(nested);
	for (const pane of f.panes) pane.cwd = nested;
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /omitted the Git checkout/);
	await rm(join(f.root, ".git"));
	await writeFile(join(f.root, "HEAD"), "ref: refs/heads/main\n");
	await mkdir(join(f.root, "objects")); await mkdir(join(f.root, "refs"));
	await assert.rejects(withMainTab(f.client, "w1:p1", signal(), "select", unused), /omitted the Git checkout/);
});

test("separate processes hold the same lock through the callback; waiting can be aborted", { timeout: 15_000 }, async (t) => {
	const f = await fixture(t);
	await withMainTab(f.client, "w1:p1", signal(), "select", async () => {});
	const replies: Record<string, unknown> = {};
	for (const args of [["pane", "get", "w1:p1"], ["tab", "get", "w1:t1"], ["workspace", "get", "w1"]]) replies[args.join(" ")] = await f.client.json(args, { signal: signal() });
	const script = `
		import { withMainTab } from ${JSON.stringify(new URL("../internal/main-tab.ts", import.meta.url).href)};
		const replies = ${JSON.stringify(replies)};
		await withMainTab({ json: async args => replies[args.join(' ')] }, 'w1:p1', new AbortController().signal, 'auto', async () => {
			process.send('entered');
			await new Promise(resolve => process.once('message', resolve));
		});
		process.disconnect();
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	t.after(() => { if (child.exitCode === null) child.kill(); });
	let errors = "";
	child.stderr!.on("data", (chunk) => { errors = (errors + chunk).slice(-8192); });
	const exited = once(child, "exit");
	const entered = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(errors || "child exited before callback"); })]);
	assert.deepEqual(entered, ["entered", undefined]);
	const controller = new AbortController();
	let initialRead!: () => void;
	const read = new Promise<void>((resolve) => { initialRead = resolve; });
	f.before((args) => { if (args[0] === "workspace" && args[1] === "get") initialRead(); });
	const waiting = withMainTab(f.client, "w1:p2", controller.signal, "select", unused);
	await read;
	await new Promise((resolve) => setTimeout(resolve, 75));
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal(Object.values(JSON.parse(await readFile(f.state, "utf8")).workspaces as Record<string, { tabId: string }>)[0]!.tabId, "w1:t1");
	child.send("release");
	assert.deepEqual(await exited, [0, null], errors);
	f.before();
	assert.equal((await withMainTab(f.client, "w1:p2", signal(), "select", async () => {})).selection, "main");
});
