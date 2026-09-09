import assert from "node:assert/strict";
import test from "node:test";
import type { ExecResult, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import rtkTestExtension from "../extensions/rtk-test.ts";

type ToolCallHandler = (event: ToolCallEvent) => unknown;
type Probe = () => Promise<ExecResult>;
type ProbeCall = {
	command: string;
	args: string[];
	options?: { timeout?: number };
};

function probeResult(code = 0, killed = false): ExecResult {
	return { stdout: "", stderr: "", code, killed };
}

function bashCall(command: unknown): Extract<ToolCallEvent, { toolName: "bash" }> {
	return {
		type: "tool_call",
		toolCallId: "call",
		toolName: "bash",
		input: { command },
	} as unknown as Extract<ToolCallEvent, { toolName: "bash" }>;
}

async function loadExtension(probe: Probe): Promise<{
	handler: ToolCallHandler;
	probeCalls: ProbeCall[];
	registeredEvents: string[];
}> {
	let handler: ToolCallHandler | undefined;
	const probeCalls: ProbeCall[] = [];
	const registeredEvents: string[] = [];

	await rtkTestExtension({
		exec(command: string, args: string[], options?: { timeout?: number }) {
			probeCalls.push({ command, args, options });
			return probe();
		},
		on(event: string, registered: unknown) {
			registeredEvents.push(event);
			if (event === "tool_call") handler = registered as ToolCallHandler;
		},
	} as unknown as ExtensionAPI);

	if (!handler) throw new Error("tool_call handler was not registered");
	return { handler, probeCalls, registeredEvents };
}

const blocked = {
	block: true,
	reason: "RTK is unavailable. Install RTK and verify `rtk test --help`.",
};

for (const scenario of [
	{ name: "succeeds", probe: () => Promise.resolve(probeResult()), available: true },
	{ name: "returns nonzero", probe: () => Promise.resolve(probeResult(1)), available: false },
	{ name: "is killed", probe: () => Promise.resolve(probeResult(0, true)), available: false },
	{ name: "throws", probe: () => { throw new Error("missing RTK"); }, available: false },
] satisfies { name: string; probe: Probe; available: boolean }[]) {
	test(`probes RTK once and ${scenario.name}`, async () => {
		const extension = await loadExtension(scenario.probe);
		assert.deepEqual(extension.probeCalls, [{
			command: "rtk",
			args: ["test", "--help"],
			options: { timeout: 2_000 },
		}]);
		assert.deepEqual(extension.registeredEvents, ["tool_call"]);

		const event = bashCall("pnpm test");
		const outcome = await extension.handler(event);
		if (scenario.available) {
			assert.equal(outcome, undefined);
			assert.equal(event.input.command, "rtk test pnpm test");
		} else {
			assert.deepEqual(outcome, blocked);
			assert.equal(event.input.command, "pnpm test");
		}
	});
}

test("rewrites direct pnpm test arguments and trims only the command edges", async () => {
	const extension = await loadExtension(() => Promise.resolve(probeResult()));
	for (const { source, rewritten } of [
		{ source: "pnpm test -- marker", rewritten: "rtk test pnpm test -- marker" },
		{ source: " \tpnpm  test  --  marker\t ", rewritten: "rtk test pnpm  test  --  marker" },
	]) {
		const event = bashCall(source);
		assert.equal(await extension.handler(event), undefined);
		assert.equal(event.input.command, rewritten);
	}
});

test("leaves excluded commands and non-bash inputs unchanged when RTK is unavailable", async () => {
	const extension = await loadExtension(() => Promise.resolve(probeResult(1)));
	for (const source of [
		"pnpm run test",
		"pnpm run-script test",
		"pnpm --filter pkg test",
		"pnpm --global test",
		"\"pnpm\" test",
		"env pnpm test",
		"pnpm test:watch",
		"npm test",
		"rtk pnpm test",
		" rtk test pnpm test ",
		"pnpm test\n",
		"pnpm test\r",
		"pnpm test; echo unsafe",
		"pnpm test | cat",
		"pnpm test &",
		"pnpm test < input",
		"pnpm test > output",
		"pnpm test `echo unsafe`",
		"pnpm test $(echo unsafe)",
	]) {
		const event = bashCall(source);
		assert.equal(await extension.handler(event), undefined, source);
		assert.equal(event.input.command, source, source);
	}

	for (const event of [
		{ type: "tool_call", toolCallId: "call", toolName: "read", input: { path: "pnpm test" } } as ToolCallEvent,
		bashCall(1),
	]) {
		assert.equal(await extension.handler(event), undefined);
	}
});
