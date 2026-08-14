import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@henryqw/pi-herdr";

const WIDGET_KEY = "pi-herdr-rename";
const WIDGET_RESULT_MS = 2_000;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 4_000;
const DEFAULT_MAX_WORDS = 4;
const DEFAULT_MAX_CHARS = 40;
const HERDR_DEFAULT_WORKTREE_NAME = /^(?:worktree[-/])?(?:brave|calm|clear|green|lucky|quiet|rapid|silver)-(?:river|cloud|field|forest|harbor|meadow|stone|valley)-[0-9a-f]{4}$/;
const configPath = () => join(getAgentDir(), "config", "pi-herdr-rename.json");

type RenameConfig = { model?: string; maxWords: number; maxChars: number };

const isTransportFailure = (message: string) => /\b(?:fetch failed|network[- ]error|connection[- ]error|timed? out|timeout)\b/i.test(message);

class RenameModelError extends Error {}

const positiveInteger = (value: unknown, fallback: number, minimum = 1) =>
	typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : fallback;

function branchFromTitle(title: string): string | undefined {
	const match = /^([a-z][a-z0-9-]*): ([a-z0-9]+(?: [a-z0-9]+)*)$/.exec(title);
	return match ? `${match[1]}/${match[2].replaceAll(" ", "-")}` : undefined;
}

function branchAvailable(candidate: string, branches: string[]): boolean {
	return branches.every((branch) => branch !== candidate && !branch.startsWith(`${candidate}/`) && !candidate.startsWith(`${branch}/`));
}

function availableBranch(branch: string, branches: string[]): string {
	const [type, subject] = branch.split("/");
	for (let suffix = 1; suffix <= branches.length + 1; suffix++) {
		const candidate = suffix === 1 ? branch : `${type}/${subject}-${suffix}`;
		if (branchAvailable(candidate, branches)) return candidate;
	}
	for (let suffix = 2; suffix <= branches.length + 2; suffix++) {
		const candidate = `${type}-${suffix}/${subject}`;
		if (branchAvailable(candidate, branches)) return candidate;
	}
	throw new Error("Could not choose an available semantic branch.");
}

async function configured(): Promise<RenameConfig> {
	try {
		const config: unknown = JSON.parse(await readFile(configPath(), "utf8"));
		if (config && typeof config === "object" && !Array.isArray(config)) {
			const values = config as { model?: unknown; maxWords?: unknown; maxChars?: unknown };
			return {
				model: typeof values.model === "string" && /^[^\s/]+\/\S+$/.test(values.model) ? values.model : undefined,
				maxWords: positiveInteger(values.maxWords, DEFAULT_MAX_WORDS, 2),
				maxChars: positiveInteger(values.maxChars, DEFAULT_MAX_CHARS, 6),
			};
		}
	} catch {}
	return { maxWords: DEFAULT_MAX_WORDS, maxChars: DEFAULT_MAX_CHARS };
}

async function saveModel(model: string): Promise<void> {
	const path = configPath();
	const { maxWords, maxChars } = await configured();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ model, maxWords, maxChars }, null, 2)}\n`, "utf8");
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
	const { model: key, maxWords, maxChars } = await configured();
	if (!key) throw new Error("Rename model is not configured. Run /rename-model.");
	const separator = key.indexOf("/");
	const provider = key.slice(0, separator);
	const id = key.slice(separator + 1);
	const model = ctx.modelRegistry
		.getAvailable()
		.find((candidate) => candidate.provider === provider && candidate.id === id && candidate.input.includes("text"));
	if (!model) throw new Error(`Rename model unavailable: ${key}. Run /rename-model.`);

	const completionContext = {
		systemPrompt: `Return only a semantic chat title for the current conversation topic, prioritizing the most recent user intent. Format: type: subject. Use a lowercase type such as feat, fix, docs, refactor, test, or chore; use lowercase alphanumeric subject words separated by spaces; use no other punctuation; at most ${maxWords} words and at most ${maxChars} characters.`,
		messages: [{ role: "user" as const, content: text.slice(0, MAX_CONTEXT_CHARS), timestamp: Date.now() }],
	};
	const complete = async (target: NonNullable<ExtensionContext["model"]>) => {
		let response;
		try {
			response = await ctx.modelRegistry.complete(target, completionContext, { signal, maxRetries: 0, maxTokens: 64 });
		} catch (error) {
			if (signal.aborted) throw error;
			throw new RenameModelError(error instanceof Error ? error.message : "Rename model failed.");
		}
		if (response.stopReason === "error") throw new RenameModelError(response.errorMessage || "Rename model failed.");
		if (response.stopReason !== "stop") throw new Error("Rename model did not return a complete title.");
		return response;
	};

	let response: Awaited<ReturnType<typeof complete>>;
	try {
		response = await complete(model);
	} catch (error) {
		const fallback = ctx.model;
		if (
			!(error instanceof RenameModelError && isTransportFailure(error.message)) ||
			signal.aborted ||
			!fallback?.input.includes("text") ||
			(fallback.provider === model.provider && fallback.id === model.id)
		) {
			throw error;
		}
		response = await complete(fallback);
	}

	const title = response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join(" ")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
	if (!title || title.length > maxChars || title.split(" ").length > maxWords || !branchFromTitle(title)) {
		throw new Error("Rename model returned an invalid title.");
	}
	return title;
}

export default function herdrRenameExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient<{ signal: AbortSignal }>((command, args, options) =>
		pi.exec(command, [...args], options));
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
		await herdr.run(["pane", "rename", paneId, title], { signal: controller.signal });
		if (!isCurrent(request, controller)) return;

		const paneResponse: unknown = await herdr.json(["pane", "get", paneId], { signal: controller.signal });
		const pane = (paneResponse as { result?: { pane?: { tab_id?: unknown; workspace_id?: unknown } } }).result?.pane;
		const tabId = pane?.tab_id;
		if (typeof tabId !== "string" || !tabId) throw new Error("Herdr pane response omitted tab_id.");
		if (!isCurrent(request, controller)) return;

		const tabResponse: unknown = await herdr.json(["tab", "get", tabId], { signal: controller.signal });
		const paneCount = (tabResponse as { result?: { tab?: { pane_count?: unknown } } }).result?.tab?.pane_count;
		if (typeof paneCount !== "number") throw new Error("Herdr tab response omitted pane_count.");
		if (paneCount === 1 && isCurrent(request, controller)) {
			await herdr.run(["tab", "rename", tabId, title], { signal: controller.signal });
		}
		if (!isCurrent(request, controller)) return;

		const workspaceId = pane?.workspace_id;
		if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Herdr pane response omitted workspace_id.");
		const workspaceResponse: unknown = await herdr.json(["workspace", "get", workspaceId], { signal: controller.signal });
		const workspace = (workspaceResponse as { result?: { workspace?: { label?: unknown; worktree?: { checkout_path?: unknown; is_linked_worktree?: unknown } } } }).result?.workspace;
		const workspaceName = workspace?.label;
		if (typeof workspaceName !== "string") throw new Error("Herdr workspace response omitted label.");
		const worktree = workspace?.worktree;
		const checkoutPath = worktree?.checkout_path;
		if (worktree?.is_linked_worktree !== true || typeof checkoutPath !== "string" || !checkoutPath) return;

		const runGit = async (args: string[]) => {
			const result = await pi.exec("git", args, { cwd: checkoutPath, signal: controller.signal });
			if (result.code !== 0 || result.killed) {
				throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || (result.killed ? "killed" : `exit ${result.code}`)}`);
			}
			return result.stdout.trim();
		};

		let branch = await runGit(["branch", "--show-current"]);
		if (!branch || branch.startsWith("worktree/")) {
			const generatedBranch = branchFromTitle(title);
			if (!generatedBranch || !isCurrent(request, controller)) return;
			const branches = (await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
				.split("\n")
				.filter(Boolean);
			const semanticBranch = availableBranch(generatedBranch, branches);
			await runGit(branch ? ["branch", "-m", semanticBranch] : ["switch", "-c", semanticBranch]);
			branch = semanticBranch;
		}
		if (HERDR_DEFAULT_WORKTREE_NAME.test(workspaceName) && isCurrent(request, controller)) {
			await herdr.run(["workspace", "rename", workspaceId, branch], { signal: controller.signal });
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
			if (isCurrent(request, controller) && (manual || error instanceof RenameModelError)) {
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
		if (!(await configured()).model) {
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
