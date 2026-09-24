import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { exactDirectAnswer } from "../src/direct-herdr.ts";

// Run explicitly inside Herdr: PI_SUBAGENT_E2E=1 node --test test/direct-e2e.test.ts
// Uses real configured Pi models and real Herdr tabs; never runs in the default package suite.
const enabled = process.env.PI_SUBAGENT_E2E === "1";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(packageRoot, "extensions", "subagent.ts");
const deadlineMs = 180_000;

type RecordValue = Record<string, any>;
type Observation = {
	toolCalls: RecordValue[];
	toolResults: RecordValue[];
	message: RecordValue;
};

async function runDirect(params: RecordValue, model: string): Promise<Observation> {
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-agent-"));
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".pi", "agent");
	try {
		// Reuse credentials and the effective model routes, but not unrelated user Roles or extensions.
		await copyFile(join(configuredAgentDir, "auth.json"), join(agentDir, "auth.json"));
		await chmod(join(agentDir, "auth.json"), 0o600);
		await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
		await copyFile(join(configuredAgentDir, "config", "pi-task-models", "config.json"), join(agentDir, "config", "pi-task-models", "config.json"));
	} catch (error) {
		await rm(agentDir, { recursive: true, force: true });
		await rm(sessionDir, { recursive: true, force: true });
		throw error;
	}
	const child = spawn("pi", [
		"--mode", "rpc", "--session-dir", sessionDir, "--no-extensions", "--extension", extension,
		"--no-skills", "--no-context-files", "--no-builtin-tools", "--tools", "delegate_task",
		"--model", model, "--thinking", "low", "--system-prompt",
		"You are an E2E driver. Call delegate_task exactly once using the JSON arguments in the user message without changing them. Do not use other tools or repeat the delegation. Once the result arrives, stop.",
	], { cwd: packageRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] });
	const toolCalls: RecordValue[] = [];
	const toolResults: RecordValue[] = [];
	let message: RecordValue | undefined;
	let pending = Buffer.alloc(0);
	let stderr = "";
	let failure: Error | undefined;
	const completed = new Promise<Observation>((resolveResult, rejectResult) => {
		let settled = false;
		const timer = setTimeout(() => fail(new Error("Timed out waiting for Pi's direct follow-up.")), deadlineMs);
		const fail = (error: Error) => { clearTimeout(timer); rejectResult(error); };
		child.on("error", fail);
		child.stdin.on("error", fail);
		child.on("exit", (code) => {
			if (!settled) fail(new Error(`Pi exited before its direct follow-up settled (exit ${code}): ${stderr.slice(-2000)}`));
		});
		child.stdout.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			if (pending.length > 4 * 1024 * 1024) return fail(new Error("Pi RPC record exceeded 4 MiB."));
			for (let newline = pending.indexOf(10); newline >= 0; newline = pending.indexOf(10)) {
				const line = pending.subarray(0, newline);
				pending = pending.subarray(newline + 1);
				let event: RecordValue;
				try { event = JSON.parse(line.toString("utf8")); }
				catch { return fail(new Error("Pi emitted invalid RPC JSON.")); }
				if (event.type === "response" && event.success === false) return fail(new Error(`Pi rejected ${event.command}: ${event.error}`));
				if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
					return fail(new Error("Pi provider failed; see the retained private session for details."));
				}
				if (event.type === "tool_execution_start" && event.toolName === "delegate_task") toolCalls.push(event);
				if (event.type === "tool_execution_end" && event.toolName === "delegate_task") {
					toolResults.push(event);
					if (event.isError) return fail(new Error(`delegate_task failed: ${event.result?.content?.[0]?.text?.slice(0, 500)}`));
				}
				if (event.type === "message_end" && event.message?.customType === "subagent-direct-result") message = event.message;
				if (event.type === "agent_settled" && !message && toolCalls.length === 0) return fail(new Error(`Main did not call delegate_task: ${stderr.slice(-1000)}`));
				if (event.type === "agent_settled" && message) {
					settled = true;
					clearTimeout(timer);
					resolveResult({ toolCalls, toolResults, message });
				}
			}
		});
	});
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
	child.stdin.write(`${JSON.stringify({ id: "e2e", type: "prompt", message: `Call delegate_task with exactly these arguments: ${JSON.stringify(params)}` })}\n`);
	try {
		return await completed;
	} catch (error) {
		failure = error as Error;
		throw error;
	} finally {
		child.stdin.end();
		if (child.exitCode === null) {
			let timer: NodeJS.Timeout;
			await Promise.race([
				new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
				new Promise<void>((resolveTimeout) => { timer = setTimeout(resolveTimeout, 5_000); }),
			]);
			clearTimeout(timer!);
			if (child.exitCode === null) child.kill();
		}
		await rm(agentDir, { recursive: true, force: true });
		if (!failure) await rm(sessionDir, { recursive: true, force: true });
		else console.error(`Pi E2E session retained for recovery: ${sessionDir}; ${failure.message}`);
	}
}

function verify(observed: Observation, expectedMode: string, names: string[]): RecordValue[] {
	assert.equal(observed.toolCalls.length, 1, "Main must call delegate_task once");
	assert.equal(observed.toolCalls[0]!.args.mode, "direct");
	assert.equal(observed.toolResults.length, 1, "the first verified tab must yield a handle");
	assert.equal(observed.toolResults[0]!.isError, false);
	assert.match(observed.toolResults[0]!.result.content[0].text, /Herdr tab:/);
	assert.equal(observed.message.details.mode, expectedMode);
	assert.equal(observed.message.details.outcome, "completed");
	assert.deepEqual(observed.message.details.entries.map((entry: RecordValue) => entry.name), names);
	assert.deepEqual(observed.message.details.entries.map((entry: RecordValue) => entry.status), names.map(() => "succeeded"));
	assert.equal(observed.message.details.tabs.length, names.length);
	assert.match(observed.message.content, /Recovery \(also available via \/subagent\):/);
	return observed.message.details.tabs;
}

async function closeOwnedTabs(tabs: RecordValue[]): Promise<void> {
	for (const { tabId, paneId, sessionFile } of tabs) {
		const info = JSON.parse(execFileSync("herdr", ["tab", "get", tabId], { encoding: "utf8", timeout: 15_000 }));
		assert.equal(info.result.tab.workspace_id, process.env.HERDR_WORKSPACE_ID);
		const pane = JSON.parse(execFileSync("herdr", ["pane", "get", paneId], { encoding: "utf8", timeout: 15_000 }));
		assert.equal(pane.result.pane.tab_id, tabId);
		execFileSync("herdr", ["tab", "close", tabId], { timeout: 15_000 });
		const directory = dirname(sessionFile);
		assert.ok(directory.startsWith(join(tmpdir(), "pi-subagent-direct-")) && sessionFile === join(directory, "session.jsonl"));
		await rm(directory, { recursive: true, force: true });
	}
}

test("real Pi and Herdr deliver single, parallel, and chain direct results", { skip: !enabled, timeout: 3 * deadlineMs + 30_000 }, async () => {
	assert.equal(process.env.HERDR_ENV, "1", "Run from a Herdr-managed pane.");
	assert.ok(process.env.HERDR_WORKSPACE_ID && process.env.HERDR_PANE_ID);
	const source = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".pi", "agent");
	const routes = JSON.parse(await readFile(join(source, "config", "pi-task-models", "config.json"), "utf8"));
	const model: string = process.env.PI_SUBAGENT_E2E_MODEL ?? routes.profiles.fast.primary.model;
	assert.ok(model.includes("/"), "A configured fast model is required for this E2E test.");
	const token = randomUUID().slice(0, 8);
	const tasks = [
		{ mode: "direct", role: "scout", name: "E2E single", task: `Reply with exactly SINGLE-${token}.`, model },
		{ mode: "direct", tasks: [
			{ role: "scout", name: "E2E parallel A", task: `Reply with exactly PARALLEL-A-${token}.`, model },
			{ role: "scout", name: "E2E parallel B", task: `Reply with exactly PARALLEL-B-${token}.`, model },
		] },
		{ mode: "direct", chain: [
			{ role: "scout", name: "E2E chain first", task: `Reply with exactly CHAIN-${token}.`, model },
			{ role: "scout", name: "E2E chain second", task: "Repeat this prior answer verbatim: {previous}", model },
		] },
	];
	const modes = ["single", "parallel", "chain"];
	const names = [["E2E single"], ["E2E parallel A", "E2E parallel B"], ["E2E chain first", "E2E chain second"]];
	for (const [index, params] of tasks.entries()) {
		const observed = await runDirect(params, model);
		const tabs = verify(observed, modes[index]!, names[index]!);
		const outputs = index === 0 ? [`SINGLE-${token}`] : index === 1
			? [`PARALLEL-A-${token}`, `PARALLEL-B-${token}`] : [`CHAIN-${token}`, `CHAIN-${token}`];
		for (const [position, entry] of observed.message.details.entries.entries()) {
			assert.ok(entry.summary.includes(outputs[position]!), `worker ${position} must return its assigned token`);
		}
		if (index === 2) {
			const first = await readFile(tabs[0]!.sessionFile, "utf8");
			const firstPrompt = JSON.parse(first.trim().split("\n").find((line) => {
				const entry = JSON.parse(line);
				return entry.type === "message" && entry.message?.role === "user";
			})!).message.content[0].text;
			const prior = exactDirectAnswer(first, firstPrompt);
			const second = await readFile(tabs[1]!.sessionFile, "utf8");
			assert.match(second, /Repeat this prior answer verbatim:/);
			assert.ok(second.includes(`Repeat this prior answer verbatim: ${prior}`), "chain must substitute the exact preceding answer");
			assert.ok(!second.includes("Repeat this prior answer verbatim: {previous}"));
		}
		await closeOwnedTabs(tabs);
	}
});
