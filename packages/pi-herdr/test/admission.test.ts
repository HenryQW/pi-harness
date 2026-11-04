import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkoutAdmission, registerCheckoutAdmission } from "../src/admission.ts";

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
