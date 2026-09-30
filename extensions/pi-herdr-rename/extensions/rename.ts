import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHerdrClient, withWorktreeLock } from "@henryqw/pi-herdr";
import {
	executeTaskRoutes,
	loadTaskModelsConfig,
	registerModelTask,
	resolveConfiguredTaskRoutes,
	type ModelTask,
	type ResolvedTaskRoute,
	type TaskRouteError,
} from "@henryqw/pi-task-models";

const WIDGET_KEY = "pi-herdr-rename";
const WIDGET_RESULT_MS = 2_000;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 5_000;
const MAX_CONTEXT_MESSAGES = 5;
const DISPLAY_MAX_WORDS = 4;
const DISPLAY_MAX_CHARS = 20;
const SEMANTIC_TYPE_MAX_CHARS = 12;
const TITLE_SHAPE = `{"kind":"<one lowercase English word, at most ${SEMANTIC_TYPE_MAX_CHARS} letters>","subject":"<2 or 3 lowercase English words, letters and digits only, single spaces, at most ${DISPLAY_MAX_CHARS} characters>"}`;
const TITLE_PROMPT = `You label a coding session with one short English title. Reply with one JSON object and nothing else: ${TITLE_SHAPE}. Use English even when the user writes in another language. Example reply: {"kind":"fix","subject":"login crash"}`;
const TITLE_REPAIR_PROMPT = `Your previous reply was rejected. Reply only with one JSON object shaped ${TITLE_SHAPE}, where kind is one lowercase English word of at most ${SEMANTIC_TYPE_MAX_CHARS} letters and subject is 2 or 3 lowercase English words of letters and digits with single spaces, at most ${DISPLAY_MAX_CHARS} characters.`;
export const RENAME_TASK = {
	id: "pi-herdr-rename/rename",
	label: "Conversation rename",
	purpose: "Generate a short conversation title.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
const TITLE_STATE_TYPE = "pi-herdr-rename/title";
const HERDR_DEFAULT_WORKTREE_NAME = /^(?:worktree[-/])?(?:brave|calm|clear|green|lucky|quiet|rapid|silver)-(?:river|cloud|field|forest|harbor|meadow|stone|valley)-[0-9a-f]{4}$/;
const SEMANTIC_BRANCH = /^[a-z][a-z0-9-]{0,11}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

type GeneratedTitle = { display: string; branch: string };

class RenameModelError extends Error {}

function configuredRenameRoutes(ctx: ExtensionContext): ResolvedTaskRoute[] {
	try {
		return resolveConfiguredTaskRoutes(ctx, RENAME_TASK);
	} catch (error) {
		const { taskRouteCode, profileName } = error as TaskRouteError;
		throw new RenameModelError(
			taskRouteCode === "profile-missing"
				? `Rename task profile ${profileName} is not configured. Run /task-models.`
				: taskRouteCode === "no-route"
					? `Rename task profile ${profileName} has no available route. Run /task-models.`
					: "Couldn't read task model config. Run /task-models.",
		);
	}
}

function validSubject(subject: string): boolean {
	return /^[a-z0-9]+(?: [a-z0-9]+)*$/.test(subject)
		&& subject.length <= DISPLAY_MAX_CHARS
		&& subject.split(" ").length <= DISPLAY_MAX_WORDS;
}

function isDisplayTitle(value: unknown): value is string {
	if (typeof value !== "string" || !value) return false;
	const subject = value[0].toLowerCase() + value.slice(1);
	return validSubject(subject) && value === subject[0].toUpperCase() + subject.slice(1);
}

function shapedTitle(kind: string, subject: string): GeneratedTitle | undefined {
	const normalizedKind = kind.trim().toLowerCase();
	const normalizedSubject = subject.trim().toLowerCase().replace(/\s+/g, " ");
	if (!/^[a-z][a-z0-9-]*$/.test(normalizedKind) || normalizedKind.length > SEMANTIC_TYPE_MAX_CHARS) return undefined;
	if (!validSubject(normalizedSubject)) return undefined;
	return {
		display: normalizedSubject[0].toUpperCase() + normalizedSubject.slice(1),
		branch: `${normalizedKind}/${normalizedSubject.replaceAll(" ", "-")}`,
	};
}

function parseGeneratedTitle(response: string): GeneratedTitle | undefined {
	for (const candidate of response.match(/\{[^{}]*\}/gs) ?? []) {
		let value: unknown;
		try {
			value = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const { kind, subject } = value as { kind?: unknown; subject?: unknown };
		if (typeof kind !== "string" || typeof subject !== "string") continue;
		const parsed = shapedTitle(kind, subject);
		if (parsed) return parsed;
	}
	const legacy = /^([a-z][a-z0-9-]*): (.+)$/.exec(response.trim().toLowerCase().replace(/\s+/g, " "));
	return legacy ? shapedTitle(legacy[1], legacy[2]) : undefined;
}

function savedTitle(ctx: ExtensionContext): GeneratedTitle | undefined {
	const entry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((candidate) => candidate.type === "custom" && candidate.customType === TITLE_STATE_TYPE);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
	const { display, branch } = entry.data as { display?: unknown; branch?: unknown };
	return isDisplayTitle(display) && typeof branch === "string" && SEMANTIC_BRANCH.test(branch)
		? { display, branch }
		: undefined;
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

function recentUserMessages(ctx: ExtensionContext, fallback?: string): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	const recentMessages: string[] = [];
	for (let index = branch.length - 1; index >= 0 && recentMessages.length < MAX_CONTEXT_MESSAGES; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content).trim();
		if (text) recentMessages.push(`user: ${text.slice(0, MAX_MESSAGE_CHARS)}`);
	}
	if (!recentMessages.length && fallback?.trim()) recentMessages.push(`user: ${fallback.trim().slice(0, MAX_MESSAGE_CHARS)}`);
	if (!recentMessages.length) return undefined;

	recentMessages.reverse();
	const selected: string[] = [];
	let remaining = MAX_CONTEXT_CHARS;
	for (let index = recentMessages.length - 1; index >= 0 && remaining > 0; index--) {
		const separator = selected.length ? 2 : 0;
		const available = remaining - separator;
		if (available <= 0) break;
		const text = recentMessages[index].slice(0, available);
		if (!text) break;
		selected.push(text);
		remaining -= text.length + separator;
	}
	return selected.reverse().join("\n\n");
}

async function generateTitle(text: string, ctx: ExtensionContext, signal: AbortSignal): Promise<GeneratedTitle> {
	const prompt = text.slice(0, MAX_CONTEXT_CHARS);
	const complete = async (route: ResolvedTaskRoute, messages: Array<{ role: "user"; content: string; timestamp: number }>) => {
		let response;
		try {
			response = await ctx.modelRegistry.streamSimple(route.model, { systemPrompt: TITLE_PROMPT, messages }, {
				signal,
				maxRetries: 0,
				...(route.thinkingLevel === "off" ? {} : { reasoning: route.thinkingLevel }),
			}).result();
		} catch (error) {
			if (signal.aborted) throw error;
			throw new RenameModelError(error instanceof Error ? error.message : "Rename task model failed.");
		}
		if (response.stopReason === "error") throw new RenameModelError(response.errorMessage || "Rename task model failed.");
		if (response.stopReason !== "stop") throw new RenameModelError("Rename task model did not return a complete title.");
		return response;
	};

	return executeTaskRoutes(
		configuredRenameRoutes(ctx),
		async (route) => {
			const firstMessages = [{ role: "user" as const, content: prompt, timestamp: Date.now() }];
			const response = await complete(route, firstMessages);
			const title = response.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(" ");
			const generated = parseGeneratedTitle(title);
			if (generated) return generated;

			signal.throwIfAborted();
			const repaired = await complete(route, [
				...firstMessages,
				{ role: "user", content: `${JSON.stringify(title.trim().slice(0, MAX_MESSAGE_CHARS))} ${TITLE_REPAIR_PROMPT}`, timestamp: Date.now() },
			]);
			const repairedTitle = repaired.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(" ");
			const repairedGenerated = parseGeneratedTitle(repairedTitle);
			if (!repairedGenerated) throw new RenameModelError("Rename task model returned an invalid title.");
			return repairedGenerated;
		},
		{
			signal,
			shouldFallback: (error) => error instanceof RenameModelError,
		},
	);
}

export default function herdrRenameExtension(pi: ExtensionAPI): void {
	registerModelTask(pi, RENAME_TASK);
	const herdr = createHerdrClient<{ signal: AbortSignal }>(pi.exec.bind(pi));
	let latestUserText: string | undefined;
	let automaticStarted = false;
	let automaticPending = false;
	let sequence = 0;
	let active: AbortController | undefined;
	let widgetSequence = 0;
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;

	const isCurrent = (request: number, controller: AbortController) =>
		request === sequence && active === controller && !controller.signal.aborted;

	const applyHerdr = async (
		displayTitle: string,
		branchCandidate: string,
		previousDisplayTitle: string | undefined,
		forceWorkspaceRename: boolean,
		request: number,
		controller: AbortController,
	): Promise<void> => {
		const paneId = process.env.HERDR_PANE_ID;
		if (process.env.HERDR_ENV !== "1" || !paneId) return;

		if (!isCurrent(request, controller)) return;
		await herdr.run(["pane", "rename", paneId, displayTitle], { signal: controller.signal });
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
			await herdr.run(["tab", "rename", tabId, displayTitle], { signal: controller.signal });
		}
		if (!isCurrent(request, controller)) return;

		const workspaceId = pane?.workspace_id;
		if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Herdr pane response omitted workspace_id.");
		const workspaceResponse: unknown = await herdr.json(["workspace", "get", workspaceId], { signal: controller.signal });
		const workspace = (workspaceResponse as { result?: { workspace?: { label?: unknown; worktree?: { checkout_path?: unknown; is_linked_worktree?: unknown } } } }).result?.workspace;
		const workspaceName = workspace?.label;
		if (typeof workspaceName !== "string") throw new Error("Herdr workspace response omitted label.");
		const worktree = workspace?.worktree;
		if (
			workspaceName !== displayTitle &&
			(forceWorkspaceRename ||
				(worktree?.is_linked_worktree === true &&
					(HERDR_DEFAULT_WORKTREE_NAME.test(workspaceName) || workspaceName === previousDisplayTitle))) &&
			isCurrent(request, controller)
		) {
			await herdr.run(["workspace", "rename", workspaceId, displayTitle], { signal: controller.signal });
		}

		const checkoutPath = worktree?.checkout_path;
		if (worktree?.is_linked_worktree !== true || typeof checkoutPath !== "string" || !checkoutPath) return;

		const runGit = async (args: string[]) => {
			const result = await pi.exec("git", args, { cwd: checkoutPath, signal: controller.signal });
			if (result.code !== 0 || result.killed) {
				throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || (result.killed ? "killed" : `exit ${result.code}`)}`);
			}
			return result.stdout.trim();
		};

		await withWorktreeLock(checkoutPath, async () => {
			if (!isCurrent(request, controller)) return;
			const branch = await runGit(["branch", "--show-current"]);
			if (!branch || branch.startsWith("worktree/")) {
				if (!isCurrent(request, controller)) return;
				const branches = (await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
					.split("\n")
					.filter(Boolean);
				const semanticBranch = availableBranch(branchCandidate, branches);
				await runGit(branch ? ["branch", "-m", semanticBranch] : ["switch", "-c", semanticBranch]);
			}
		});
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
		if (manual) {
			automaticPending = false;
			automaticStarted = true;
		}
		const { request, controller } = begin();
		try {
			const title = await generateTitle(text, ctx, controller.signal);
			if (!isCurrent(request, controller)) return;
			const saved = savedTitle(ctx);
			const previousDisplayTitle = saved && pi.getSessionName() === saved.display ? saved.display : undefined;
			pi.setSessionName(title.display);
			pi.appendEntry(TITLE_STATE_TYPE, title);
			await applyHerdr(title.display, title.branch, previousDisplayTitle, manual, request, controller);
			return title.display;
		} catch (error) {
			if (isCurrent(request, controller)) {
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

	pi.on("session_start", (_event, ctx) => {
		clearWidget(ctx);
		active?.abort();
		active = undefined;
		sequence++;
		automaticPending = false;
		latestUserText = latestSessionUserText(ctx);
		try {
			const taskModels = loadTaskModelsConfig();
			if (taskModels.source === "missing") {
				ctx.ui.notify("Task model config is missing; run /task-models to configure rename routing.", "warning");
			} else {
				const profileName = taskModels.value.tasks[RENAME_TASK.id] ?? RENAME_TASK.defaultProfile;
				if (!taskModels.value.profiles[profileName]) {
					ctx.ui.notify(`Configure rename task profile ${profileName} with /task-models.`, "warning");
				}
			}
		} catch {
			ctx.ui.notify("Couldn't read task model config. Run /task-models.", "warning");
		}
		const title = pi.getSessionName();
		automaticStarted = Boolean(title || latestUserText);
		const saved = savedTitle(ctx);
		if (!title || title !== saved?.display) return;

		const { request, controller } = begin();
		void applyHerdr(title, saved.branch, saved.display, false, request, controller)
			.catch((error) => {
				if (isCurrent(request, controller)) {
					ctx.ui.notify(error instanceof Error ? error.message : "Rename failed.", "warning");
				}
			})
			.finally(() => finish(request, controller));
	});

	pi.on("input", (event) => {
		if (event.source === "extension" || !event.text.trim()) return { action: "continue" };
		latestUserText = event.text.slice(0, MAX_MESSAGE_CHARS);
		if (!automaticStarted) automaticPending = true;
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (automaticStarted || !automaticPending || !event.prompt.trim()) return;
		automaticPending = false;
		automaticStarted = true;
		latestUserText = event.prompt.slice(0, MAX_MESSAGE_CHARS);
		void rename(latestUserText, ctx, false);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearWidget(ctx);
		active?.abort();
		active = undefined;
		automaticPending = false;
		sequence++;
	});

	pi.registerCommand("rename", {
		description: "Generate a new display title from recent user messages",
		handler: async (_args, ctx) => {
			const context = recentUserMessages(ctx, latestUserText);
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
			widgetTimer.unref();
		},
	});
}
