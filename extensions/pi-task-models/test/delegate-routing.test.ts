import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTaskModelsExtension } from "../dist/index.js";

const fast = { provider: "test", id: "fast", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", high: "high" } };
const balanced = { provider: "test", id: "balanced", input: ["text"], reasoning: false };
const route = (model: string, thinkingLevel: string) => ({ model: `test/${model}`, thinkingLevel });

test("native delegate calls resolve live routes, honor overrides, and block failures", async () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-routing-"));
	const config = join(dir, "config", "pi-task-models", "config.json");
	mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
	const external = join(dir, "billion-context.json");
	writeFileSync(external, '{"keep":true}');
	const save = (profiles: object, tasks = {}) => writeFileSync(config, JSON.stringify({ profiles, tasks }));
	const profiles = { fast: { primary: route("fast", "low") }, balanced: { primary: route("balanced", "off") } };
	save(profiles);
	const handlers: Array<(event: any, ctx: any) => any> = [];
	let source = "npm:billion-context";
	let models = [fast, balanced];
	const warnings: string[] = [];
	const bus = { on: () => () => {}, emit: () => {} };
	const pi = { events: bus, on: (name: string, handler: any) => { if (name === "tool_call") handlers.push(handler); }, registerCommand: () => {}, getAllTools: () => [{ name: "acp_delegate", sourceInfo: { origin: "package", source } }] };
	createTaskModelsExtension(pi as never, { agentDir: dir });
	const ctx = { model: balanced, scopedModels: [{ model: balanced }], modelRegistry: { getAvailable: () => models }, hasUI: true, ui: { notify: (text: string) => warnings.push(text) } };
	const call = async (input: Record<string, unknown>, toolName = "acp_delegate", nested = false) => {
		const event = { type: "tool_call", toolName, input, toolCallId: "1", ...(nested ? { parentToolCallId: "parent" } : {}) };
		for (const handler of handlers) { const result = await handler(event, ctx); if (result?.block) return result; }
		return undefined;
	};
	try {
		const input: Record<string, unknown> = { agent: "worker", task: "work" };
		assert.equal(await call(input, "acp_delegate", true), undefined);
		assert.deepEqual([input.model, input.thinkingLevel], ["test/balanced", "off"]);
		const explicit = { agent: "worker", model: "test/fast", thinkingLevel: "high" };
		assert.equal(await call(explicit), undefined);
		assert.deepEqual(explicit, { agent: "worker", model: "test/fast", thinkingLevel: "high" });
		const requested = { ...fast, provider: "openai-codex-3", id: "shared" };
		const parent = { ...balanced, provider: "openai-codex-2", id: "shared" };
		models = [requested, parent]; ctx.model = parent;
		const exactModel = { agent: "worker", model: "openai-codex-3/shared", thinkingLevel: "high" };
		assert.equal(await call(exactModel), undefined);
		assert.equal(exactModel.model, "openai-codex-3/shared");
		models = [fast, balanced]; ctx.model = balanced;
		const emptyResume: Record<string, unknown> = { agent: "researcher", resumeFrom: "" };
		assert.equal(await call(emptyResume), undefined);
		assert.deepEqual([emptyResume.model, emptyResume.thinkingLevel], ["test/fast", "low"]);
		const thinking: Record<string, unknown> = { agent: "researcher", thinkingLevel: "high" };
		assert.equal(await call(thinking), undefined);
		assert.deepEqual([thinking.model, thinking.thinkingLevel], ["test/fast", "high"]);
		assert.match((await call({ agent: "worker", model: "test/balanced", thinkingLevel: "high" })).reason, /does not support/);
		assert.match((await call({ agent: "worker", thinkingLevel: "wrong" })).reason, /Invalid/);
		const resume = { agent: "worker", resumeFrom: "run" };
		await call(resume); assert.deepEqual(resume, { agent: "worker", resumeFrom: "run" });
		const unrelated = { agent: "worker" }; await call(unrelated, "other"); assert.deepEqual(unrelated, { agent: "worker" });
		source = "npm:foreign"; await call(unrelated); assert.deepEqual(unrelated, { agent: "worker" }); source = "npm:billion-context@1.0.0";
		save(profiles, { "billion-context/acp-worker": "fast" });
		const changed: Record<string, unknown> = { agent: "worker" }; await call(changed); assert.equal(changed.model, "test/fast");
		save({ balanced: { primary: route("missing", "off"), fallback: route("balanced", "off") } });
		const fallback: Record<string, unknown> = { agent: "worker" }; await call(fallback); assert.equal(fallback.model, "test/balanced"); assert.match(warnings.at(-1)!, /fallback test\/balanced/);
		models = []; const blocked: Record<string, unknown> = { agent: "worker" };
		assert.match((await call(blocked)).reason, /no available route/); assert.equal(blocked.model, undefined);
		save({}); assert.match((await call({ agent: "worker" })).reason, /not configured/);
		save(profiles, { "billion-context/acp-worker": "unknown" }); assert.match((await call({ agent: "worker" })).reason, /issues/);
		writeFileSync(config, "{"); assert.match((await call({ agent: "worker" })).reason, /issues/);
		rmSync(config); assert.match((await call({ agent: "worker" })).reason, /missing/);
		assert.equal(readFileSync(external, "utf8"), '{"keep":true}');
		assert.deepEqual(readdirSync(dir).sort(), ["billion-context.json", "config"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
