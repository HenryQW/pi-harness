import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piBin = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "extensions/auto-compact.ts");

for (const scenario of ["trim", "compact"] as const) test(`real Pi ${scenario}s at a tool boundary without an extra turn`, { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-boundary-"));
	const requests: Array<{ messages: unknown[] }> = [];
	let normalRequests = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body) as { messages: unknown[] };
		requests.push(input);
		const index = requests.length;
		const summarizing = JSON.stringify(input.messages).toLowerCase().includes("summarize");
		if (!summarizing) normalRequests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const data = (delta: object, finish_reason: string | null) => response.write(
			`data: ${JSON.stringify({ id: `turn-${index}`, model: "model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
		if (summarizing) {
			data({ role: "assistant", content: "SUMMARY" }, null);
			data({}, "stop");
		} else if (normalRequests <= 2) {
			const path = scenario === "compact" && normalRequests === 2 ? "other.txt" : "source.txt";
			data({ role: "assistant", tool_calls: [{ index: 0, id: `read-${index}`, type: "function",
				function: { name: "read", arguments: JSON.stringify({ path }) } }] }, null);
			data({}, "tool_calls");
		} else {
			data({ role: "assistant", content: "DONE" }, null);
			data({}, "stop");
		}
		response.write(`data: ${JSON.stringify({ id: `turn-${index}`, model: "model", choices: [], usage: {
			prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
		} })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	let child: ReturnType<typeof spawn> | undefined;
	try {
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await writeFile(join(root, "source.txt"), "One stable read result.\n".repeat(900));
		await writeFile(join(root, "other.txt"), "One stable read result.\n".repeat(900));
		await mkdir(join(root, "config", "pi-auto-compact"), { recursive: true });
		await writeFile(join(root, "config", "pi-auto-compact", "config.json"), JSON.stringify({ autoCompactThreshold: 70 }));
		await writeFile(join(root, "settings.json"), JSON.stringify({
			defaultProvider: "fake", defaultModel: "model", defaultThinkingLevel: "off",
			defaultProjectTrust: "never", quietStartup: true,
			compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 6_000 },
		}));
		await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fake: {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test",
			models: [{ id: "model", contextWindow: 12_000, maxTokens: 512 }],
		} } }));
		child = spawn(piBin, ["--mode", "rpc", "--no-extensions", "-e", extension, "--no-skills",
			"--no-context-files", "--model", "fake/model", "--session-dir", join(root, "sessions")], {
			cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr!.on("data", (chunk) => { stderr += chunk; });
		const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
		const readUntil = async (predicate: (event: Record<string, unknown>) => boolean) => {
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline) {
				const remaining = deadline - Date.now();
				let timer: NodeJS.Timeout | undefined;
				try {
					const next = await Promise.race([lines.next(), new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`Pi RPC timeout: ${stderr.slice(-1000)}`)), remaining);
					})]);
					assert.equal(next.done, false, `Pi exited: ${stderr.slice(-1000)}`);
					const event = JSON.parse(next.value) as Record<string, unknown>;
					if (predicate(event)) return event;
				} finally { if (timer) clearTimeout(timer); }
			}
			throw new Error(`Pi RPC timeout: ${stderr.slice(-1000)}`);
		};
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message: "Read source.txt twice, then reply DONE." })}\n`);
		await readUntil((event) => event.type === "agent_settled");
		child.stdin!.write(`${JSON.stringify({ id: "entries", type: "get_entries" })}\n`);
		const response = await readUntil((event) => event.type === "response" && event.id === "entries");
		assert.equal(response.success, true, JSON.stringify(response));
		const entries = (response.data as { entries: Array<Record<string, unknown>> }).entries;
		assert.equal(normalRequests, 3, "the tool loop needs exactly three provider requests");
		assert.equal(entries.some((entry) => entry.type === "custom_message" && entry.customType === "pi-auto-compact/resume"), false);
		if (scenario === "trim") {
			assert.ok(entries.some((entry) => entry.type === "context_edit"), "expected native boundary edit");
			assert.equal(entries.some((entry) => entry.type === "compaction"), false);
			const last = JSON.stringify(requests[2]);
			assert.match(last, /Duplicate read; full result retained/);
			assert.equal((last.match(/One stable read result/g) ?? []).length, 900);
		} else {
			assert.ok(entries.some((entry) => entry.type === "compaction"),
				`expected native checkpoint; ${JSON.stringify(entries.map((entry) => entry.type))}`);
			assert.ok(requests.some((input) => JSON.stringify(input.messages).includes("SUMMARY")),
				"the next provider request must contain the persisted summary");
		}
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => child!.once("close", () => resolveExit()));
		}
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});
