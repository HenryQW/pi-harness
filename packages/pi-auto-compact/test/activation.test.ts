import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoCompact from "../extensions/auto-compact.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

function loadExtension(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	autoCompact({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return handlers;
}

test("suppresses only empty abort caused by pending extension compaction", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-abort-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({
			compaction: { enabled: false },
		}));
		const handlers = loadExtension();
		const compactionAbort = new AbortController();
		let signal = AbortSignal.abort();
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact() {},
			get signal() { return signal; },
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);

		const aborted = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "This operation was aborted",
			},
		};
		assert.equal(handlers.get("message_end")?.(aborted as never, ctx), undefined);

		signal = compactionAbort.signal;
		handlers.get("turn_start")?.({} as never, ctx);
		compactionAbort.abort();
		assert.equal(handlers.get("message_end")?.({
			...aborted,
			message: { ...aborted.message, content: [{ type: "text", text: "partial" }] },
		} as never, ctx), undefined);
		assert.equal(handlers.get("message_end")?.({
			...aborted,
			message: { ...aborted.message, errorMessage: "Provider failed" },
		} as never, ctx), undefined);
		assert.deepEqual(handlers.get("message_end")?.(aborted as never, ctx), {
			message: {
				...aborted.message,
				stopReason: "stop",
				errorMessage: undefined,
			},
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("activates only when Pi built-in auto-compaction is disabled", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-activation-"));
	const projectDir = join(tempRoot, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	await mkdir(join(projectDir, ".pi"), { recursive: true });

	try {
		for (const scenario of [
			{ name: "default enabled", global: {}, project: {}, rejects: true },
			{
				name: "globally disabled",
				global: { compaction: { enabled: false } },
				project: {},
				rejects: false,
			},
			{
				name: "project re-enabled",
				global: { compaction: { enabled: false } },
				project: { compaction: { enabled: true } },
				rejects: true,
			},
		]) {
			await writeFile(join(tempRoot, "settings.json"), JSON.stringify(scenario.global));
			await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify(scenario.project));

			const handlers = loadExtension();
			let compactions = 0;
			const ctx = {
				cwd: projectDir,
				isProjectTrusted: () => true,
				getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
				compact: () => { compactions++; },
			} as unknown as ExtensionContext;
			const start = () => handlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" } as never,
				ctx,
			);

			if (scenario.rejects) {
				assert.throws(start, /failed to activate.*compaction\.enabled.*false/i, scenario.name);
			} else {
				assert.doesNotThrow(start, scenario.name);
			}
			handlers.get("turn_start")?.({} as never, ctx);
			assert.equal(compactions, scenario.rejects ? 0 : 1, scenario.name);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});
