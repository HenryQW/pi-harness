import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withPathLock } from "../packages/pi-herdr/src/path-lock.ts";
import { atomicState, releaseJob, writePrivate } from "../extensions/pi-herdr-tools/internal/command-state.ts";

const script = new URL("../.agents/skills/automated-pi-extension-dev/scripts/finish-worktree.sh", import.meta.url).pathname;
async function fixture(t, fault = "") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "finish-worktree-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = join(root, "main"), checkout = join(root, "linked"), bin = join(root, "bin"), events = join(root, "events");
	const agentDir = join(root, "agent"), store = join(agentDir, "config", "pi-herdr-tools", "commands");
	await Promise.all([main, checkout, bin, join(root, "unrelated")].map((path) => mkdir(path)));
	await mkdir(store, { recursive: true, mode: 0o700 });
	await symlink(checkout, join(root, "alias"));
	await symlink(checkout, join(root, "target-alias"));
	await symlink(join(root, "unrelated"), join(root, "other-alias"));
	await symlink(join(root, "vanished"), join(root, "dangling"));
	const stub = join(bin, "stub.mjs");
	await writeFile(stub, `#!${process.execPath}
import { appendFileSync, closeSync, existsSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
const root = process.env.FIXTURE, main = root + "/main", checkout = root + "/linked", fault = process.env.FAULT;
const command = basename(process.argv[1]), args = process.argv.slice(2);
function locked(path) {
  if (!existsSync(path + ".lock")) return false;
  if (statSync(path + ".lock").isDirectory()) return true;
  const fd = openSync(path + ".lock", "r+");
  try {
    const result = spawnSync(process.platform === "darwin" ? "/usr/bin/lockf" : "flock",
      process.platform === "darwin" ? ["-t", "0", "3"] : ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (result.status !== 0 && result.status !== 75) throw new Error("Probe failed");
    return result.status === 75;
  } finally { closeSync(fd); }
}
const store = root + "/agent/config/pi-herdr-tools/commands";
appendFileSync(root + "/events", JSON.stringify({ command, args, linked: locked(checkout), primary: locked(main), store: locked(store) }) + "\\n");
if (command === "gh") console.log(JSON.stringify({ state: "MERGED", baseRefName: "main", headRefName: "worker", headRefOid: "merged-head" }));
else if (command === "herdr") {
  if (args[0] === "worktree") console.log(JSON.stringify({ result: { worktrees: [{ open_workspace_id: "workspace", path: root + "/alias" }] } }));
  else if (args[0] === "agent") console.log('{"result":{"agents":[]}}');
  else if (args[0] === "api") {
    const paths = { pane: "/target-alias", "missing-target": "/linked/deleted", "missing-alias": "/target-alias/deleted", "vanished-target-alias": "/alias/deleted", "vanished-pane": "/unrelated/deleted", "vanished-alias": "/other-alias/deleted", dangling: "/dangling/deleted" };
    if (fault === "vanished-target-alias") unlinkSync(root + "/alias");
    console.log(JSON.stringify({ result: { snapshot: { panes: paths[fault] ? [{ workspace_id: "other", cwd: root + paths[fault], pane_id: "blocked" }] : [] } } }));
  }
  else if (args[0] === "workspace") writeFileSync(root + "/closed", "");
  else throw new Error("Unexpected Herdr command");
} else if (command === "git") {
  if (args[0] === "worktree") process.stdout.write("worktree " + main + "\\0\\0worktree " + checkout + "\\0\\0");
  else if (args[2] === "rev-parse") {
    if (args[3] === "--abbrev-ref") console.log(args[1] === main ? (fault === "primary-drift" && existsSync(root + "/closed") ? "changed" : "main") : (fault === "branch" ? "changed" : "worker"));
    else console.log(fault === "head" && args[1] === checkout ? "changed" : "merged-head");
  } else if (args[2] === "status") { if (fault === "dirty") console.log(" M preserve.txt"); }
  else if (args[2] === "worktree" && fault === "concurrent-launch") {
    const { CommandManager } = await import(${JSON.stringify(new URL("../extensions/pi-herdr-tools/internal/commands.ts", import.meta.url).href)});
    const { checkoutAdmission } = await import(${JSON.stringify(new URL("../packages/pi-herdr/src/admission.ts", import.meta.url).href)});
    const admission = checkoutAdmission({ on() {}, exec() { throw new Error("Must not resolve checkout"); } });
    const manager = new CommandManager(store, admission, async () => { throw new Error("Must not dispatch"); });
    try {
      await manager.launch({ command: "must not execute", access: "write", callId: "call", callEntryId: "entry", sessionId: "session", sessionFile: null, cwd: checkout, checkout }, { runtimeMs: 5000, outputBytes: 4096, concurrency: 4, retainedJobs: 100 });
      throw new Error("Concurrent launch entered cleanup");
    } catch (error) {
      if (error.code !== "ELOCKED") throw error;
      writeFileSync(root + "/launch-blocked", error.code);
    }
  } else if (!["worktree", "pull"].includes(args[2])) throw new Error("Unexpected Git command");
} else throw new Error("Unexpected command");
`, { mode: 0o755 });
	for (const command of ["git", "gh", "herdr"]) await symlink(stub, join(bin, command));
	async function run() {
		const child = spawn("/bin/sh", [script, "workspace", "123"], {
			cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: root, FAULT: fault,
				PI_CODING_AGENT_DIR: agentDir, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_SOCKET_PATH: join(root, "herdr.sock"), PI_SUBAGENT_PROCESS_LEASE: undefined },
		});
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		return { code, output, events: (await readFile(events, "utf8")).trim().split("\n").map(JSON.parse) };
	}
	return { root, main, checkout, store, run };
}
const removed = (event) => event.command === "git" && event.args[2] === "worktree";
const pulled = (event) => event.command === "git" && event.args[2] === "pull";
async function addJob(f, state, access = "write") {
	const id = randomUUID(), dir = join(f.store, id);
	await mkdir(dir, { mode: 0o700 });
	const spec = { version: 1, id, token: randomUUID(), callId: "call", callEntryId: "entry", sessionId: "session", sessionFile: null,
		createdAt: Date.now() - 30_000, cwd: f.checkout, checkout: f.checkout, workspaceId: "workspace", socketPath: join(f.root, "herdr.sock"),
		command: "must not execute", access, runtimeMs: 5000, outputBytes: 4096 };
	await writePrivate(join(dir, "spec.json"), spec);
	if (state === "running") {
		const claim = { id, token: spec.token, runnerId: randomUUID(), workspaceId: "workspace", tabId: "tab", paneId: "pane" };
		await writePrivate(join(dir, "claim.json"), claim);
		await atomicState(dir, { ...claim, state, updatedAt: Date.now(), exitCode: null, signal: null });
	}
	return { dir, spec };
}

test("finish holds the canonical linked lock for validation and removal, then only the primary lock for pull", async (t) => {
	const f = await fixture(t);
	const result = await f.run();
	assert.equal(result.code, 0, result.output);
	const checks = result.events.filter((event) => event.command === "git" && event.args[0] === "-C");
	const pull = checks.findIndex(pulled);
	assert.ok(pull > 0);
	const removal = checks.findIndex(removed);
	assert.ok(removal > 0);
	assert.ok(checks.slice(0, removal + 1).every((event) => event.linked && event.store && !event.primary));
	assert.ok(checks.slice(removal + 1).every((event) => !event.linked && !event.store && event.primary));
	await withPathLock(f.checkout, async () => {});
	await withPathLock(f.main, async () => {});
});

for (const fault of ["branch", "head", "dirty", "pane", "missing-target", "missing-alias", "vanished-target-alias", "dangling", "primary-drift"])
test(`finish refuses ${fault} under its lock`, async (t) => {
	const f = await fixture(t, fault);
	const result = await f.run();
	assert.equal(result.code, 1, result.output);
	assert.equal(result.events.some(pulled), false);
	assert.equal(result.events.some(removed), fault === "primary-drift");
	const last = result.events.at(-1);
	assert.equal(last.linked, fault !== "primary-drift");
	assert.equal(last.primary, fault === "primary-drift");
	assert.equal(last.store, fault !== "primary-drift");
});

for (const target of ["checkout", "store", "main"])
test(`finish refuses a live ${target} lock without entering the protected work`, async (t) => {
	const f = await fixture(t);
	await withPathLock(f[target], async () => {
		const result = await f.run();
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /already being held/);
		assert.equal(result.events.some(pulled), false);
		assert.equal(result.events.some(removed), target === "main");
		if (target === "store") assert.ok((await lstat(f.checkout + ".lock")).isFile(), "Checkout acquisition must precede store acquisition");
	});
});

test("finish refuses a legacy lock directory without cleanup or pull", async (t) => {
	const f = await fixture(t);
	await mkdir(`${f.checkout}.lock`);
	const result = await f.run();
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /Legacy lock directory/);
	assert.equal(result.events.some(removed), false);
	assert.equal(result.events.some(pulled), false);
});

for (const fault of ["vanished-pane", "vanished-alias", "concurrent-launch"])
test(`finish handles ${fault} without a launch gap`, async (t) => {
	const f = await fixture(t, fault);
	const result = await f.run();
	assert.equal(result.code, 0, result.output);
	assert.ok(result.events.some(removed));
	if (fault === "concurrent-launch") assert.equal(await readFile(join(f.root, "launch-blocked"), "utf8"), "ELOCKED");
});

for (const state of ["running", "unknown"])
for (const access of ["read", "write"])
test(`finish refuses a ${state} ${access} command before any removal`, async (t) => {
	const f = await fixture(t);
	await addJob(f, state, access);
	const result = await f.run();
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /Active or unknown background commands block worktree removal/);
	assert.equal(result.events.some(removed), false);
	assert.equal(result.events.some(pulled), false);
});

test("finish accepts only a verified user release, even when the released record lock is held", async (t) => {
	const f = await fixture(t);
	const { dir, spec } = await addJob(f, "unknown");
	await writePrivate(join(dir, "released.json"), { version: 1, id: spec.id, token: "wrong" });
	const refused = await f.run();
	assert.equal(refused.code, 1, refused.output);
	assert.match(refused.output, /protection stays held/);
	assert.equal(refused.events.some(removed), false);
	await rm(join(dir, "released.json"));
	await assert.rejects(releaseJob(dir, spec, false, () => {}), /Explicit user confirmation is required/);
	await releaseJob(dir, spec, true, () => {});
	await withPathLock(dir, async () => {
		const accepted = await f.run();
		assert.equal(accepted.code, 0, accepted.output);
		assert.ok(accepted.events.some(removed));
	});
});

test("finish refuses incomplete publication without waiting for its own store lock", { timeout: 5000 }, async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.store, randomUUID()), { mode: 0o700 });
	const result = await f.run();
	assert.equal(result.code, 1, result.output);
	assert.equal(result.events.some(removed), false);
	assert.equal(result.events.some(pulled), false);
	await withPathLock(f.store, async () => {});
	await withPathLock(f.checkout, async () => {});
});
