import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "pi-herdr-rename";
const WIDGET_RESULT_MS = 2_000;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 4_000;
const TITLE_PROMPT =
	"Return only a short chat title for the current conversation topic, prioritizing the most recent user intent: lowercase, at most five words, and at most 60 characters.";
const configPath = () => join(getAgentDir(), "config", "pi-herdr-rename.json");

async function configuredModel(): Promise<string | undefined> {
	try {
		const config: unknown = JSON.parse(await readFile(configPath(), "utf8"));
		if (config && typeof config === "object" && !Array.isArray(config)) {
			const model = (config as { model?: unknown }).model;
			if (typeof model === "string" && /^[^\s/]+\/\S+$/.test(model)) return model;
		}
	} catch {}
}

async function saveModel(model: string): Promise<void> {
	const path = configPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ model }, null, 2)}\n`, "utf8");
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}

function latestSessionUserText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content);
		if (text.trim()) return text.slice(0, MAX_MESSAGE_CHARS);
	}
}

function recentConversation(ctx: ExtensionContext, fallback?: string): string | undefined {
	const rounds: Array<{ user: string; assistant?: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
		const text = messageText(entry.message.content).trim();
		if (!text) continue;
		if (entry.message.role === "user") rounds.push({ user: text });
		else if (entry.message.role === "assistant" && rounds.length) rounds[rounds.length - 1].assistant = text;
	}
	if (!rounds.length && fallback?.trim()) rounds.push({ user: fallback.trim() });
	if (!rounds.length) return undefined;

	const messages = rounds.slice(-3).flatMap((round) => [
		`user: ${round.user.slice(0, MAX_MESSAGE_CHARS)}`,
		...(round.assistant ? [`assistant: ${round.assistant.slice(0, MAX_MESSAGE_CHARS)}`] : []),
	]);
	const selected: string[] = [];
	let remaining = MAX_CONTEXT_CHARS;
	for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
		const separator = selected.length ? 2 : 0;
		const available = remaining - separator;
		if (available <= 0) break;
		const text = messages[index].slice(0, available);
		if (!text) break;
		selected.push(text);
		remaining -= text.length + separator;
	}
	return selected.reverse().join("\n\n");
}

async function generateTitle(text: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
	const key = await configuredModel();
	if (!key) throw new Error("Rename model is not configured. Run /rename-model.");
	const separator = key.indexOf("/");
	const provider = key.slice(0, separator);
	const id = key.slice(separator + 1);
	const model = ctx.modelRegistry
		.getAvailable()
		.find((candidate) => candidate.provider === provider && candidate.id === id && candidate.input.includes("text"));
	if (!model) throw new Error(`Rename model unavailable: ${key}. Run /rename-model.`);

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: TITLE_PROMPT,
			messages: [{ role: "user", content: text.slice(0, MAX_CONTEXT_CHARS), timestamp: Date.now() }],
		},
		{ signal, maxRetries: 0, maxTokens: 64 },
	);
	if (response.stopReason !== "stop") throw new Error("Rename model did not return a complete title.");

	const title = response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join(" ")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
	if (!title || title.length > 60 || title.split(" ").length > 5) {
		throw new Error("Rename model returned an invalid title.");
	}
	return title;
}

async function herdr(pi: ExtensionAPI, args: string[], signal: AbortSignal): Promise<string> {
	const result = await pi.exec("herdr", args, { signal });
	if (result.code !== 0 || result.killed) {
		throw new Error(`Herdr ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
	}
	return result.stdout;
}

export default function herdrRenameExtension(pi: ExtensionAPI): void {
	let latestUserText: string | undefined;
	let automaticStarted = false;
	let sequence = 0;
	let active: AbortController | undefined;
	let widgetSequence = 0;
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;

	const isCurrent = (request: number, controller: AbortController) =>
		request === sequence && active === controller && !controller.signal.aborted;

	const applyHerdr = async (title: string, request: number, controller: AbortController): Promise<void> => {
		const paneId = process.env.HERDR_PANE_ID;
		if (!paneId) return;

		if (!isCurrent(request, controller)) return;
		await herdr(pi, ["pane", "rename", paneId, title], controller.signal);
		if (!isCurrent(request, controller)) return;

		const paneResponse: unknown = JSON.parse(
			await herdr(pi, ["pane", "get", paneId], controller.signal),
		);
		const tabId = (paneResponse as { result?: { pane?: { tab_id?: unknown } } }).result?.pane?.tab_id;
		if (typeof tabId !== "string" || !tabId) throw new Error("Herdr pane response omitted tab_id.");
		if (!isCurrent(request, controller)) return;

		const tabResponse: unknown = JSON.parse(await herdr(pi, ["tab", "get", tabId], controller.signal));
		const paneCount = (tabResponse as { result?: { tab?: { pane_count?: unknown } } }).result?.tab?.pane_count;
		if (typeof paneCount !== "number") throw new Error("Herdr tab response omitted pane_count.");
		if (paneCount === 1 && isCurrent(request, controller)) {
			await herdr(pi, ["tab", "rename", tabId, title], controller.signal);
		}
	};

	const begin = () => {
		active?.abort();
		const controller = new AbortController();
		active = controller;
		return { request: ++sequence, controller };
	};

	const finish = (request: number, controller: AbortController) => {
		if (isCurrent(request, controller)) active = undefined;
	};

	const rename = async (text: string, ctx: ExtensionContext, manual: boolean): Promise<string | undefined> => {
		const { request, controller } = begin();
		try {
			const title = await generateTitle(text, ctx, controller.signal);
			if (!isCurrent(request, controller)) return;
			pi.setSessionName(title);
			await applyHerdr(title, request, controller);
			return title;
		} catch (error) {
			if (manual && isCurrent(request, controller)) {
				ctx.ui.notify(error instanceof Error ? error.message : "Rename failed.", "warning");
			}
			return undefined;
		} finally {
			finish(request, controller);
		}
	};

	const clearWidget = (ctx: ExtensionContext) => {
		widgetSequence++;
		if (widgetTimer) clearTimeout(widgetTimer);
		widgetTimer = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		clearWidget(ctx);
		active?.abort();
		active = undefined;
		sequence++;
		latestUserText = latestSessionUserText(ctx);
		if (!(await configuredModel())) {
			ctx.ui.notify("Run /rename-model to configure chat title generation.", "warning");
		}
		const title = pi.getSessionName();
		automaticStarted = Boolean(title || latestUserText);
		if (!title) return;

		const { request, controller } = begin();
		void applyHerdr(title, request, controller)
			.catch(() => undefined)
			.finally(() => finish(request, controller));
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !event.text.trim()) return { action: "continue" };
		latestUserText = event.text.slice(0, MAX_MESSAGE_CHARS);
		if (!automaticStarted) {
			automaticStarted = true;
			void rename(latestUserText, ctx, false);
		}
		return { action: "continue" };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearWidget(ctx);
		active?.abort();
		active = undefined;
		sequence++;
	});

	pi.registerCommand("rename", {
		description: "Generate a new chat title from recent conversation context",
		handler: async (_args, ctx) => {
			const context = recentConversation(ctx, latestUserText);
			if (!context) {
				ctx.ui.notify("No user text is available to rename this chat.", "warning");
				return;
			}
			if (widgetTimer) clearTimeout(widgetTimer);
			widgetTimer = undefined;
			const widgetRequest = ++widgetSequence;
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => new BorderedLoader(tui, theme, "renaming...", { cancellable: false }),
			);
			const title = await rename(context, ctx, true);
			if (widgetRequest !== widgetSequence) return;
			if (!title) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			ctx.ui.setWidget(WIDGET_KEY, [`renamed to ${title}`]);
			widgetTimer = setTimeout(() => {
				if (widgetRequest !== widgetSequence) return;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				widgetTimer = undefined;
			}, WIDGET_RESULT_MS);
			widgetTimer.unref?.();
		},
	});

	pi.registerCommand("rename-model", {
		description: "Choose the model used to generate chat titles",
		handler: async (_args, ctx) => {
			const models = ctx.modelRegistry
				.getAvailable()
				.filter((model) => model.input.includes("text"))
				.map((model) => `${model.provider}/${model.id}`)
				.sort();
			if (!models.length) {
				ctx.ui.notify("No authenticated text models are available.", "warning");
				return;
			}
			const selected = await ctx.ui.select("Rename model", models);
			if (!selected) return;
			try {
				await saveModel(selected);
				ctx.ui.notify(`Rename model saved: ${selected}`, "info");
			} catch {
				ctx.ui.notify("Couldn't save rename model config.", "warning");
			}
		},
	});
}
