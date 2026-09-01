import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type JsonObject = Record<string, unknown>;
type JsonLineIterator = AsyncIterator<string>;

const live = process.env.PI_AUTO_COMPACT_LIVE === "1";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const resumeMessageType = "pi-auto-compact/resume";
const resumeMessage = "Auto-compact ran. Continue the current task.";

function record(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not an object`);
	}
	return value as JsonObject;
}

function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const separator = spec.indexOf("/");
	if (separator <= 0 || separator === spec.length - 1) {
		throw new Error(`PI_AUTO_COMPACT_MODEL must be provider/model, got ${spec}`);
	}
	return { provider: spec.slice(0, separator), modelId: spec.slice(separator + 1) };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		const item = record(block, "content block");
		return typeof item.text === "string" ? item.text : "";
	}).join("");
}

function send(stdin: NodeJS.WritableStream, message: JsonObject): void {
	stdin.write(`${JSON.stringify(message)}\n`);
}

async function readUntil(
	lines: JsonLineIterator,
	predicate: (event: JsonObject) => boolean,
	timeoutMs: number,
): Promise<JsonObject> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for Pi RPC event");

		let timer: NodeJS.Timeout | undefined;
		try {
			const next = await Promise.race([
				lines.next(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Timed out waiting for Pi RPC event")), remaining);
				}),
			]);
			if (next.done) throw new Error("Pi RPC exited before expected event");
			const event = record(JSON.parse(next.value), "Pi RPC event");
			if (predicate(event)) return event;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

async function waitForExit(process: ReturnType<typeof spawn>): Promise<void> {
	if (process.exitCode !== null) return;
	await new Promise<void>((resolveExit) => process.once("close", () => resolveExit()));
}

test("real Pi compacts and resumes the task", { skip: !live }, async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-"));
	const sessionDir = join(tempRoot, "sessions");
	const authFile = resolve(
		process.env.PI_AUTO_COMPACT_AUTH_FILE ??
			join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"),
	);
	const modelSpec = parseModelSpec(process.env.PI_AUTO_COMPACT_MODEL ?? "openai-codex/gpt-5.6-luna");
	const contextWindow = Number(process.env.PI_AUTO_COMPACT_CONTEXT_WINDOW ?? 12_000);
	const promptRepeat = Number(process.env.PI_AUTO_COMPACT_PROMPT_REPEAT ?? 650);

	try {
		await access(authFile).catch(() => {
			throw new Error(`Missing Pi auth file: ${authFile}`);
		});
		await symlink(authFile, join(tempRoot, "auth.json"));
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({
			defaultProvider: modelSpec.provider,
			defaultModel: modelSpec.modelId,
			defaultThinkingLevel: "off",
			defaultProjectTrust: "never",
			quietStartup: true,
			compaction: { enabled: false, reserveTokens: 2_000, keepRecentTokens: 2_000 },
			packages: [packageRoot],
		}, null, 2));
		await writeFile(join(tempRoot, "models.json"), JSON.stringify({
			providers: {
				[modelSpec.provider]: {
					modelOverrides: {
						[modelSpec.modelId]: { contextWindow, maxTokens: 512 },
					},
				},
			},
		}, null, 2));

		const child = spawn(
			process.env.PI_AUTO_COMPACT_PI_BIN ?? "pi",
			["--mode", "rpc", "--session-dir", sessionDir, "--no-context-files", "--no-skills"],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: tempRoot },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		try {
			send(child.stdin, { id: "first", type: "prompt", message: "Reply with exactly READY." });
			await readUntil(lines, (event) => event.type === "agent_settled", 120_000);

			const largePrompt = "Remember this context. " +
				"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(promptRepeat);
			send(child.stdin, { id: "large", type: "prompt", message: largePrompt });
			await readUntil(lines, (event) => event.type === "compaction_end", 180_000);
			await readUntil(lines, (event) => event.type === "agent_start", 30_000);
			await readUntil(lines, (event) => event.type === "agent_settled", 180_000);

			send(child.stdin, { id: "messages", type: "get_messages" });
			const response = await readUntil(
				lines,
				(event) => event.type === "response" && event.id === "messages",
				30_000,
			);
			const data = record(response.data, "get_messages response data");
			const messages = data.messages;
			if (!Array.isArray(messages)) throw new Error("get_messages must return messages");
			const resumeIndex = messages.findIndex(
				(message) => {
					const item = record(message, "session message");
					return item.role === "custom" &&
						item.customType === resumeMessageType &&
						contentText(item.content).includes(resumeMessage);
				},
			);
			assert.notEqual(resumeIndex, -1, "custom resume message must persist in session");
			assert.ok(
				messages.slice(resumeIndex + 1).some((message) => record(message, "session message").role === "assistant"),
				"assistant must respond after resume message",
			);
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
