import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkoutAdmission, checkoutKey, registerCheckoutAdmission } from "../src/admission.ts";

function exec(command: string, args: string[], options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) {
	const result = spawnSync(command, args, { ...options, encoding: "utf8" });
	if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw result.error;
	return { code: result.status ?? 0, killed: result.signal !== null, stdout: result.stdout };
}

async function directory(t: { after: (callback: () => Promise<void>) => void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "admission-git-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("verified completion rejects stale restoration and reuse but preserves other owners", async () => {
	const admission = checkoutAdmission({ on() {}, exec: async () => ({ code: 0, stdout: "/checkout\n" }) });
	admission.restore("finished", "/checkout");
	admission.restoreSet("unknown", ["/other", "/selected"]);
	admission.complete("finished");
	admission.restore("finished", "/checkout");
	(await admission.reserve("new", "/checkout"))();
	await assert.rejects(admission.reserve("finished", "/checkout"), /cannot reserve again/);
	await assert.rejects(admission.reserve("other", "/other"), /active writer/);
	await assert.rejects(admission.reserve("selected", "/selected"), /active writer/);
	admission.complete("unknown");
	admission.restoreSet("unknown", ["/other", "/selected"]);
	(await admission.reserve("new-selected", "/selected"))();
});

test("a terminated subdirectory lookup blocks writes and retries against the root owner", async (t) => {
	const root = await directory(t), nested = join(root, "nested");
	await mkdir(nested);
	assert.equal(exec("git", ["init", "--quiet"], { cwd: root, timeout: 5_000 }).code, 0);
	const handlers = new Map<string, (...args: any[]) => any>();
	let timeout = true, lookups = 0;
	const host = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
			if (options.cwd === nested) {
				lookups++;
				// Pi can return code 0 after a timeout; killed is the failure signal.
				if (timeout) return exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 20 });
			}
			return exec(command, args, options);
		},
	};
	const hold = registerCheckoutAdmission(host, () => true);
	const call = (id: string, toolName: string, cwd: string) => handlers.get("tool_call")!({ toolCallId: id, toolName, input: {} }, { cwd });
	assert.equal(await call("owner", "delegate_task", root), undefined);
	const release = hold("owner");
	await assert.rejects(call("timeout", "edit", nested), /terminated.*writes are blocked/);
	timeout = false;
	assert.match((await call("recovered", "edit", nested)).reason, /\(owner\)/);
	assert.equal(lookups, 2, "the failed lookup must not be cached");
	release();
	assert.equal(await call("next", "delegate_task", nested), undefined, "failure must leave no Main call in flight");
	assert.equal(lookups, 2, "the successful root lookup is cached");
});

test("real non-Git workspaces retain canonical admission and selected repositories", async (t) => {
	const root = await directory(t), repository = join(root, "selected"), alias = join(root, "alias");
	await mkdir(repository);
	assert.equal(exec("git", ["init", "--quiet"], { cwd: repository, timeout: 5_000 }).code, 0);
	await symlink(root, alias);
	assert.equal(await checkoutKey({ exec: async (...args) => exec(...args) }, { cwd: alias }), root);
	const handlers = new Map<string, (...args: any[]) => any>();
	registerCheckoutAdmission({
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		exec: async (...args) => exec(...args),
	}, () => true, async () => [repository]);
	const call = (id: string, toolName: string, cwd: string) => handlers.get("tool_call")!({ toolCallId: id, toolName, input: {} }, { cwd });
	assert.equal(await call("owner", "delegate_task", root), undefined);
	for (const cwd of [alias, repository]) assert.match((await call(cwd, "edit", cwd)).reason, /\(owner\)/);
});

test("Git failures cannot prove repository absence", async (t) => {
	const root = await directory(t), repository = join(root, "repository"), bare = join(root, "bare");
	await mkdir(repository); await mkdir(bare);
	assert.equal(exec("git", ["init", "--quiet"], { cwd: repository, timeout: 5_000 }).code, 0);
	assert.equal(exec("git", ["init", "--bare", "--quiet"], { cwd: bare, timeout: 5_000 }).code, 0);
	const invalidConfig = join(root, "invalid-config");
	await writeFile(invalidConfig, "[invalid\n");
	for (const [name, cwd, env] of [
		["unsafe owner", repository, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "" }],
		["bare repository", bare, {}],
		["restricted bare repository", bare, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" }],
		["invalid configuration outside a repository", root, { GIT_CONFIG_GLOBAL: invalidConfig }],
	] as const) {
		await t.test(name, async () => {
			await assert.rejects(checkoutKey({ exec: async (command, args, options) =>
				exec(command, args, { ...options, env: { ...process.env, ...env } }),
			}, { cwd }), /failed.*writes are blocked/);
		});
	}
	await assert.rejects(checkoutKey({ exec: async (command, args, options) => args[0] === "rev-parse"
		? { code: 128, killed: false, stdout: "" } : exec(command, args, options),
	}, { cwd: repository }), /failed.*writes are blocked/);
	await writeFile(join(repository, ".git", "config"), "[invalid\n");
	await assert.rejects(checkoutKey({ exec: async (...args) => exec(...args) }, { cwd: repository }), /failed.*writes are blocked/);
	for (const result of [{ code: 1, killed: false }, { code: 128, killed: true }]) {
		await assert.rejects(checkoutKey({ exec: async () => ({ ...result, stdout: "" }) }, { cwd: root }), /writes are blocked/);
	}
	await assert.rejects(checkoutKey({ exec: async (command, args, options) => args[0] === "rev-parse"
		? exec(command, args, options) : { code: 0, killed: true, stdout: "" },
	}, { cwd: root }), /failed.*writes are blocked/);
});

test("selected checkout admission is all-or-none and stays held until every owned worker stops", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "admission-set-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secondary = join(root, "selected"); await mkdir(secondary);
	const handlers = new Map<string, (...args: any[]) => any>();
	const hold = registerCheckoutAdmission({
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		exec: async (_command, _args, { cwd }) => ({ code: 0, stdout: `${cwd}\n` }),
	}, () => true, async () => [root, secondary]);
	const call = (id: string, toolName: string, cwd: string) => handlers.get("tool_call")!({ toolCallId: id, toolName, input: {} }, { cwd });
	// A selected checkout is canonicalized by the caller; this host only proves coordinated ownership.
	assert.equal(await call("main", "edit", secondary), undefined);
	assert.equal((await call("refused", "delegate_task", root)).block, true);
	assert.equal(await call("free", "edit", root), undefined, "failed set admission reserves no member");
	handlers.get("tool_result")!({ toolCallId: "free" });
	handlers.get("tool_result")!({ toolCallId: "main" });
	assert.equal(await call("worker", "delegate_task", root), undefined);
	const release = hold("worker");
	handlers.get("tool_result")!({ toolCallId: "worker" });
	handlers.get("session_shutdown")!();
	assert.equal((await call("other", "delegate_task", root)).block, true);
	assert.equal((await call("edit", "edit", root)).block, true);
	assert.equal((await call("secondary-edit", "edit", secondary)).block, true);
	release();
	assert.equal(await call("next", "delegate_task", root), undefined);
});

test("recovery receives the exact set and cannot admit a call that settles while it waits", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "admission-recovery-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secondary = join(root, "selected"); await mkdir(secondary);
	const handlers = new Map<string, (...args: any[]) => any>();
	const host = {
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		exec: async () => ({ code: 0, stdout: `${root}\n` }),
	};
	const admission = checkoutAdmission(host);
	admission.install(host);
	admission.classifyDirect(() => true, async () => [secondary, root, secondary]);
	let entered!: () => void, resume!: () => void;
	const pending = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { resume = resolve; });
	const sets: (readonly string[])[] = [];
	admission.guard("recovery", async (keys) => { sets.push(keys); entered(); await gate; });
	const call = handlers.get("tool_call")!({ toolCallId: "settled", toolName: "delegate_task", input: {} }, { cwd: root });
	await pending;
	handlers.get("tool_execution_end")!({ toolCallId: "settled" });
	resume();
	assert.match((await call).reason, /already settled/);
	assert.throws(() => admission.hold("settled"), /was not admitted/);
	(await admission.reserve("next", secondary))();
	assert.deepEqual(sets, [[root, secondary], [secondary]]);
});
