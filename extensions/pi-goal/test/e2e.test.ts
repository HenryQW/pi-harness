import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piBin = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "extensions/goal.ts");

test("real Pi continues an active goal with a hidden message until the goal completes", { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-goal-"));
	const requests: string[] = [];
	// Turn script: create, stop early, (hidden continuation) complete, final reply.
	const turns = [
		{ tool: { action: "create", objective: "Write done.txt", deliverables: ["done.txt exists"] } },
		{ text: "Started." },
		{ tool: { action: "complete", evidence: [{ deliverable: "done.txt exists", evidence: "ls shows done.txt" }] } },
		{ text: "Done." },
	];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(body);
		const turn = turns[requests.length - 1] ?? { text: "Unexpected." };
		const data = (delta: object, finish_reason: string | null) => response.write(
			`data: ${JSON.stringify({ id: `turn-${requests.length}`, model: "model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
		response.writeHead(200, { "content-type": "text/event-stream" });
		if ("tool" in turn) {
			data({ role: "assistant", tool_calls: [{ index: 0, id: `goal-${requests.length}`, type: "function",
				function: { name: "goal", arguments: JSON.stringify(turn.tool) } }] }, null);
			data({}, "tool_calls");
		} else {
			data({ role: "assistant", content: turn.text }, null);
			data({}, "stop");
		}
		response.write(`data: ${JSON.stringify({ id: "usage", model: "model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	let child: ReturnType<typeof spawn> | undefined;
	try {
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await writeFile(join(root, "settings.json"), JSON.stringify({
			defaultProvider: "fake", defaultModel: "model", defaultThinkingLevel: "off",
			defaultProjectTrust: "never", quietStartup: true, compaction: { enabled: false },
		}));
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fake: {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test",
			models: [{ id: "model", contextWindow: 100_000, maxTokens: 512 }],
		} } }));
		child = spawn(piBin, ["--mode", "rpc", "--no-extensions", "-e", extension, "--no-skills",
			"--no-context-files", "--model", "fake/model", "--session-dir", join(root, "sessions")], {
			cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr!.on("data", (chunk) => { stderr += chunk; });
		const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
		const readUntil = async (predicate: (event: Record<string, unknown>) => boolean) => {
			for (;;) {
				const next = await lines.next();
				assert.equal(next.done, false, `Pi exited: ${stderr.slice(-1000)}`);
				const event = JSON.parse(next.value) as Record<string, unknown>;
				if (predicate(event)) return event;
			}
		};
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "Write done.txt as a goal." })}\n`);
		await readUntil((event) => event.type === "agent_settled");
		child.stdin!.write(`${JSON.stringify({ id: "entries", type: "get_entries" })}\n`);
		const response = await readUntil((event) => event.type === "response" && event.id === "entries");
		assert.equal(response.success, true, JSON.stringify(response));
		const entries = (response.data as { entries: Array<Record<string, unknown>> }).entries;

		assert.equal(requests.length, 4, "create, early stop, continuation, final reply");
		const continuations = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-goal-continuation");
		assert.equal(continuations.length, 1);
		assert.equal(continuations[0]!.display, false);
		assert.match(requests[2]!, /Continue the active goal/);
		const results = entries.flatMap((entry) => {
			const message = entry.message as { role?: string; details?: { goal: { status: string } } } | undefined;
			return entry.type === "message" && message?.role === "toolResult" ? [message.details?.goal.status] : [];
		});
		assert.deepEqual(results, ["active", "complete"]);
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => child!.once("close", () => resolveExit()));
		}
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});
