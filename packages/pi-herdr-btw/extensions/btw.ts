import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, startPiAgent } from "@henryqw/pi-herdr";
import {
	loadTaskModelsConfig,
	registerModelTask,
	resolveConfiguredTaskRoutes,
	type ModelTask,
	type ResolvedTaskRoute,
	type TaskRouteError,
} from "@henryqw/pi-task-models";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	applyConfigCommand,
	CONFIG_COMMAND_USAGE,
	createBtwConfigStore,
	DEFAULT_CONFIG,
	formatConfig,
	type BtwConfig,
} from "../internal/config.ts";
import { ContextStore } from "../internal/context-store.ts";
import {
	buildAgentStartArgs,
	buildContextDocument,
	isAgentStartReady,
	CHILD_PAYLOAD_ARG,
	CHILD_PAYLOAD_FLAG,
	buildNativeBridgeMessage,
	buildParentContextMessage,
	classifyLaunchResult,
	createPayload,
	LAUNCH_DRAFT_ARG,
	LAUNCH_DRAFT_COMMAND,
	buildPaneSplitArgs,
	parsePaneSplitPaneId,
	parseReadyAgentPaneId,
	safeErrorText,
	type BtwPayload,
	type HerdrLaunchOptions,
} from "../internal/core.ts";
import {
	buildMergeTranscript,
	isPromptWithinBounds,
	MAX_PROMPT_BYTES,
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	MergeCoordinator,
	type MergeRequest,
} from "../internal/merge.ts";
import { HELP_TEXT, parseBtwCommand } from "../internal/router.ts";

export const BTW_TASK = {
	id: "pi-herdr-btw/btw",
	label: "BTW side thread",
	purpose: "Launch an isolated Herdr side thread.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
const CHILD_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;
const LITERAL_DRAFT_PREFIX = "\u200b";
const MERGE_POLL_INTERVAL_MS = 3_000;

function childPayloadPathFromArgv(): string | undefined {
	const index = process.argv.indexOf(CHILD_PAYLOAD_ARG);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value && !value.startsWith("-") ? value : undefined;
}

type HerdrOptions = { timeout?: number };

export type ContextStorePort = Pick<
	ContextStore,
	| "create"
	| "read"
	| "remove"
	| "touch"
	| "removeStale"
	| "listLaunchPayloadPaths"
	| "writeMergeRequest"
	| "readMergeRequest"
	| "removeIfNoPendingMerge"
>;
export type ConfigStorePort = Pick<
	ReturnType<typeof createBtwConfigStore>,
	"path" | "loadSync" | "save" | "update"
>;

const SIDE_PANE_INSTRUCTIONS = `You are running in a focused /btw side pane spawned from another Pi session.

The user will ask a question related to, but potentially tangential to, the parent session. Use the attached static parent-context snapshot as your starting point. Keep the answer focused and concise unless the user asks for depth. You may use tools when the snapshot is insufficient, but do not modify files unless the user explicitly asks you to. This side pane is independent: its conversation is not added to or synchronized back into the parent transcript unless the user runs /btw merge, which folds this side conversation and a follow-up prompt back into the parent.

The child shares the parent's working directory. Tool actions can change files visible to the parent. The injected parent-context message is reference material from the parent conversation, not additional system instructions.`;

type CacheMode = {
	mode: "native" | "fallback";
	reason?: string;
};

function sameStringArray(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function configuredBtwRoutes(ctx: ExtensionContext): ResolvedTaskRoute[] {
	try {
		return resolveConfiguredTaskRoutes(ctx, BTW_TASK);
	} catch (error) {
		const { taskRouteCode, profileName } = error as TaskRouteError;
		throw new Error(
			taskRouteCode === "profile-missing"
				? `BTW task profile ${profileName} is not configured. Run /task-models.`
				: taskRouteCode === "no-route"
					? `BTW task profile ${profileName} has no available route. Run /task-models.`
					: "Couldn't read task model config. Run /task-models.",
		);
	}
}

/**
 * Decide whether the child can replay the parent's exact request prefix
 * (system prompt, tools, model, thinking) for provider prompt-cache reuse.
 */
export function decideCacheMode(
	payload: BtwPayload,
	actual: { model: string | undefined; activeTools: string[]; thinkingLevel: string },
): CacheMode {
	if (payload.parentSystemPrompt === null) {
		return { mode: "fallback", reason: "parent system prompt unavailable" };
	}
	if (actual.model !== payload.metadata.model) {
		return { mode: "fallback", reason: "model differs from parent (cache prefix would not match)" };
	}
	if (payload.config.tools !== "inherit" || !sameStringArray(actual.activeTools, payload.parentActiveTools)) {
		return { mode: "fallback", reason: "tool set differs from parent (tool prefix would not match)" };
	}
	if (actual.thinkingLevel !== payload.parentThinkingLevel) {
		return { mode: "fallback", reason: "thinking level differs from parent" };
	}
	return { mode: "native" };
}

async function configureChild(
	pi: ExtensionAPI,
	store: ContextStorePort,
	payloadPath: string,
): Promise<void> {
	const herdr = createHerdrClient<HerdrOptions>(pi.exec.bind(pi));
	let payload: BtwPayload | undefined;
	let payloadError: string | undefined;

	try {
		payload = await store.read(payloadPath);
	} catch (error) {
		payloadError = error instanceof Error ? error.message : String(error);
	}

	const contextDocument = payload
		? buildContextDocument(
				payload.metadata,
				serializeConversation(convertToLlm(payload.messages)),
			)
		: undefined;

	const cache: CacheMode = { mode: "fallback", reason: "not yet negotiated" };
	let widgetUi:
		| { setWidget(name: string, lines: string[]): void; theme: { fg(color: string, text: string): string } }
		| undefined;

	function renderWidget(): void {
		if (!widgetUi || !payload) return;
		const capability =
			payload.config.tools === "none"
				? "tool-free"
				: payload.config.tools === "read-only"
					? "read-only"
					: "tool-enabled";
		widgetUi.setWidget("herdr-btw-context", [
			widgetUi.theme.fg("accent", `BTW — ${capability} pane`),
		]);
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (!payload) return;
		const decision = decideCacheMode(payload, {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			activeTools: pi.getActiveTools(),
			thinkingLevel: pi.getThinkingLevel(),
		});
		cache.mode = decision.mode;
		cache.reason = decision.reason;
		if (cache.mode === "native") {
			// Replay the parent's exact system prompt; side-pane policy moves to
			// a suffix message so the cached prefix stays byte-identical.
			return { systemPrompt: payload.parentSystemPrompt as string };
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${SIDE_PANE_INSTRUCTIONS}` };
	});

	pi.on("context", (event) => {
		if (!payload) return;
		if (cache.mode === "native") {
			return {
				messages: [
					...payload.messages,
					buildNativeBridgeMessage(SIDE_PANE_INSTRUCTIONS),
					...event.messages,
				],
			};
		}
		return {
			messages: [buildParentContextMessage(contextDocument ?? ""), ...event.messages],
		};
	});

	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const startHeartbeat = (): void => {
		if (!payload || heartbeatTimer) return;
		void store.touch(payloadPath).catch(() => undefined);
		heartbeatTimer = setInterval(() => {
			void store.touch(payloadPath).catch(() => undefined);
		}, CHILD_HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	};
	startHeartbeat();
	pi.on("session_start", () => startHeartbeat());

	if (payloadError) {
		pi.on("input", (_event, ctx) => {
			ctx.ui.notify(`/btw is blocked: ${payloadError}`, "error");
			return { action: "handled" };
		});
	}

	let literalDraftPending = false;
	pi.on("input", (event) => {
		if (!literalDraftPending || !event.text.startsWith(LITERAL_DRAFT_PREFIX)) return;
		literalDraftPending = false;
		return {
			action: "transform",
			text: event.text.slice(LITERAL_DRAFT_PREFIX.length),
			images: event.images,
		};
	});

	// One-shot launch-draft submit, armed only for auto-submit payloads. The
	// parent delivers `/btw --launch-draft` as pi's initial message, which pi
	// processes after its initial render — sending from session_start instead
	// races the TUI startup and paints the question twice.
	let launchDraftPending = !!(payload?.config.autoSubmit && payload.draftQuestion.trim());

	// Child-side /btw: reviewed merge back to the parent, plus help.
	pi.registerCommand("btw", {
		description:
			"Side-thread /btw: fold this side thread into the parent and continue there (/btw merge <prompt...>)",
		handler: async (args, ctx) => {
			if (args.trim() === LAUNCH_DRAFT_ARG) {
				if (launchDraftPending && payload) {
					launchDraftPending = false;
					pi.sendUserMessage(payload.draftQuestion);
				}
				return;
			}
			const route = parseBtwCommand(args);
			if (route.kind === "help") {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			if (route.kind !== "merge") {
				ctx.ui.notify("This is a /btw side pane. Use /btw merge <prompt...> or /btw help.", "warning");
				return;
			}
			if (!payload) {
				ctx.ui.notify(`/btw merge is unavailable: ${payloadError ?? "missing launch payload"}`, "error");
				return;
			}

			let existingRequest: unknown;
			try {
				existingRequest = await store.readMergeRequest(payloadPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/btw merge could not check pending delivery: ${message.slice(0, 500)}`, "error");
				return;
			}
			if (existingRequest !== undefined) {
				ctx.ui.notify("A merge was already sent from this side thread.", "warning");
				return;
			}

			// The prompt after `merge` is what the parent will auto-submit; bare
			// /btw merge opens an editor to compose it.
			let prompt = route.text.trim();
			if (!prompt && !ctx.hasUI) {
				ctx.ui.notify("Bare /btw merge requires interactive UI", "error");
				return;
			}
			if (!prompt) {
				const composed = await ctx.ui.editor("Prompt for the parent conversation after the merge", "");
				prompt = composed?.trim() ?? "";
			}
			if (!prompt) {
				ctx.ui.notify("Merge cancelled; nothing was sent to the parent.", "info");
				return;
			}
			if (!isPromptWithinBounds(prompt)) {
				ctx.ui.notify(`Merge prompt must be 1..${MAX_PROMPT_BYTES / 1024} KiB of text.`, "error");
				return;
			}

			const transcript = buildMergeTranscript(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			if (!transcript) {
				ctx.ui.notify("Nothing to merge: this side thread has no conversation yet.", "warning");
				return;
			}

			const request: MergeRequest = {
				protocolVersion: MERGE_PROTOCOL_VERSION,
				requestId: randomUUID(),
				launchId: payload.launchId,
				parentSessionId: payload.parentSessionId,
				capability: payload.capability,
				createdAt: new Date().toISOString(),
				summary: transcript,
				prompt,
			};
			try {
				await store.writeMergeRequest(payloadPath, request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/btw merge failed: ${message.slice(0, 500)}`, "error");
				return;
			}

			// Hand focus back to the parent and close this side pane. The durable
			// request survives teardown until the parent consumes it.
			const ownPaneId = process.env.HERDR_PANE_ID;
			if (ownPaneId) {
				if (payload.parentPaneId) {
					await herdr.run(["agent", "focus", payload.parentPaneId], { timeout: 5_000 }).catch(() => undefined);
				}
				const closed = await herdr
					.run(["pane", "close", ownPaneId], { timeout: 5_000 })
					.then(() => true)
					.catch(() => false);
				// A successful close tears this process down with the pane.
				if (closed) return;
			}

			// Fallback: process stays open, but handoff is complete.
			ctx.ui.notify("Merge sent to the parent session.", "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle("pi /btw — Herdr side thread");

		if (payloadError) {
			ctx.ui.setWidget("herdr-btw-context", [
				ctx.ui.theme.fg("error", "BTW side thread could not load its parent context."),
				ctx.ui.theme.fg("dim", payloadError),
				ctx.ui.theme.fg("dim", "Prompts are blocked. Quit this pane and retry /btw from the parent."),
			]);
			return;
		}

		widgetUi = ctx.ui;
		renderWidget();

		// Auto-submit drafts are sent via the launch-draft sentinel instead of
		// here: session_start fires before pi's initial render, and a message
		// sent from it is painted twice.
		if (event.reason === "startup" && payload?.draftQuestion.trim() && !payload.config.autoSubmit) {
			const draft = payload.draftQuestion.trim();
			if (draft.startsWith("/")) {
				literalDraftPending = true;
				ctx.ui.setEditorText(`${LITERAL_DRAFT_PREFIX}${draft}`);
			} else {
				ctx.ui.setEditorText(payload.draftQuestion);
			}
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (event.reason === "quit") {
			// A pending request outlives the child until parent consumption or TTL.
			await store.removeIfNoPendingMerge(payloadPath).catch(() => undefined);
		}
	});
}

export async function registerBtwExtension(
	pi: ExtensionAPI,
	options: { store?: ContextStorePort; configStore?: ConfigStorePort } = {},
): Promise<void> {
	registerModelTask(pi, BTW_TASK);
	const store = options.store ?? new ContextStore();
	// Pi applies extension flag values after factories load, so inspect argv here
	// while registering the same flag keeps Pi's CLI validation and help intact.
	pi.registerFlag(CHILD_PAYLOAD_FLAG, {
		description: "Internal /btw child payload path",
		type: "string",
	});
	const childPayloadPath = childPayloadPathFromArgv();
	if (childPayloadPath) {
		await configureChild(pi, store, childPayloadPath);
		return;
	}

	const configStore = options.configStore ?? createBtwConfigStore();
	const herdr = createHerdrClient<HerdrOptions>(pi.exec.bind(pi));

	// --- Parent-side merge coordination ---------------------------------
	let sessionCtx:
		| Pick<ExtensionCommandContext, "sessionManager" | "isIdle" | "model" | "modelRegistry">
		| undefined;
	let sessionGeneration = 0;
	let missingConfigWarningSessionId: string | undefined;
	let missingTaskModelsConfigWarningSessionId: string | undefined;
	// Notifications need a UI context; route them through the last known ctx.
	let notifyFn: ((message: string, type: "info" | "warning" | "error") => void) | undefined;
	const coordinator = new MergeCoordinator(store, {
		getSessionId: () => sessionCtx?.sessionManager.getSessionId() ?? "",
		isIdle: () => sessionCtx?.isIdle() ?? false,
		getBranch: () => sessionCtx?.sessionManager.getBranch() ?? [],
		canSubmitPrompt: async () => {
			const generation = sessionGeneration;
			const model = sessionCtx?.model;
			const modelRegistry = sessionCtx?.modelRegistry;
			if (!model || !modelRegistry) return false;
			const modelName = `${model.provider}/${model.id}`;
			try {
				const authenticated = (await modelRegistry.getApiKeyAndHeaders(model)).ok;
				const currentModel = sessionCtx?.model;
				return (
					authenticated &&
					generation === sessionGeneration &&
					!!currentModel &&
					`${currentModel.provider}/${currentModel.id}` === modelName
				);
			} catch {
				return false;
			}
		},
		sendMergeMessage: (content, details) =>
			pi.sendMessage(
				{ customType: MERGE_CUSTOM_TYPE, content, display: true, details },
				{ triggerTurn: false },
			),
		// The merge prompt is user-authored in the child pane; submitting it
		// starts the parent turn that "closes the loop".
		submitPrompt: (prompt) => pi.sendUserMessage(prompt),
		notify: (message, type) => notifyFn?.(message, type),
	});

	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let startupScan: ReturnType<typeof setImmediate> | undefined;
	async function scanMerges() {
		await store.removeStale().catch(() => undefined);
		return coordinator.scan();
	}
	function ensurePolling(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			void scanMerges();
		}, MERGE_POLL_INTERVAL_MS);
		// Never keep the process alive just to poll the merge mailbox.
		pollTimer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (missingConfigWarningSessionId !== sessionId && configStore.loadSync().source === "missing") {
			missingConfigWarningSessionId = sessionId;
			ctx.ui.notify(`BTW config is missing: ${configStore.path}; defaults are used.`, "warning");
		}
		if (missingTaskModelsConfigWarningSessionId !== sessionId && loadTaskModelsConfig().source === "missing") {
			missingTaskModelsConfigWarningSessionId = sessionId;
			ctx.ui.notify("Task model config is missing; run /task-models to configure it.", "warning");
		}
		sessionGeneration += 1;
		sessionCtx = ctx;
		notifyFn = (message, type) => ctx.ui.notify(message, type);
		// Pi renders restored messages after session_start. Defer recovery so a
		// pending merge does not get painted once by the live event and again by
		// renderInitialMessages().
		ensurePolling();
		if (startupScan) clearImmediate(startupScan);
		startupScan = setImmediate(() => {
			startupScan = undefined;
			void scanMerges();
		});
	});
	pi.on("model_select", (event, ctx) => {
		if (sessionCtx) sessionCtx = { ...sessionCtx, model: event.model };
		notifyFn = (message, type) => ctx.ui.notify(message, type);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		sessionCtx = ctx;
		notifyFn = (message, type) => ctx.ui.notify(message, type);
		await scanMerges();
	});
	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		sessionCtx = undefined;
		notifyFn = undefined;
		if (startupScan) {
			clearImmediate(startupScan);
			startupScan = undefined;
		}
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	});

	pi.registerCommand("btw", {
		// Pi has no argumentHint field for extension commands (only builtins and
		// prompt templates); the TUI renders template hints as "hint — description",
		// so we bake the same shape into the description.
		description: "[question] — Open a Herdr side thread, or use ask, config, merge, help",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			notifyFn = (message, type) => ctx.ui.notify(message, type);
			const route = parseBtwCommand(args);

			if (route.kind === "help") {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}

			// Config routes before any Herdr/model/conversation launch checks.
			if (route.kind === "config") {
				try {
					if (route.args === "reset") {
						const config = { ...DEFAULT_CONFIG };
						await configStore.save(config);
						ctx.ui.notify(`BTW config — ${formatConfig(config)}`, "info");
						return;
					}
					const trimmedArgs = route.args.trim();
					const result = !trimmedArgs || trimmedArgs === "show"
						? applyConfigCommand(configStore.loadSync().value, route.args)
						: {
							action: "save" as const,
							config: await configStore.update((latest) => applyConfigCommand(latest, route.args).config),
						};
					ctx.ui.notify(
						result.action === "show"
							? `BTW config — ${formatConfig(result.config)}\n${CONFIG_COMMAND_USAGE}`
							: `BTW config — ${formatConfig(result.config)}`,
						"info",
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
				}
				return;
			}

			if (route.kind === "merge") {
				// Parent-side recovery: scan for pending requests now.
				const result = await scanMerges();
				ctx.ui.notify(
					result.delivered > 0 || result.rejected > 0
						? `BTW merge scan — delivered ${result.delivered}, rejected ${result.rejected}, deferred ${result.deferred}`
						: result.deferred > 0
							? "BTW merge scan — a merge is pending and will land when the agent settles."
							: "BTW merge scan — no pending side-thread merges for this session.",
					"info",
				);
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires Pi's interactive mode", "error");
				return;
			}
			if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
				ctx.ui.notify("/btw must be run inside a Herdr-managed pane", "error");
				return;
			}
			const sessionContext = buildSessionContext(
				ctx.sessionManager.getEntries(),
				ctx.sessionManager.getLeafId(),
			);
			if (sessionContext.messages.length === 0) {
				ctx.ui.notify("There is no parent conversation to pass to /btw yet", "warning");
				return;
			}

			const draftQuestion = route.kind === "ask" ? route.question : "";
			const launchGeneration = sessionGeneration;
			const closeAndRemove = async (paneId: string, path: string): Promise<boolean> => {
				try {
					await herdr.run(["pane", "close", paneId], { timeout: 5_000 });
				} catch {
					ensurePolling();
					return false;
				}
				await store.remove(path);
				return true;
			};
			const reportKnownPaneFailure = async (message: string, paneId: string, path: string): Promise<void> => {
				if (await closeAndRemove(paneId, path)) {
					ctx.ui.notify(message, "error");
					return;
				}
				ctx.ui.notify(`${message}. The side pane could not be closed; context cleanup is deferred.`, "warning");
			};

			let payloadPath: string | undefined;
			try {
				const config: BtwConfig = configStore.loadSync().value;
				await store.removeStale();
				const createdAt = new Date().toISOString();
				const sessionId = ctx.sessionManager.getSessionId();
				const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
				const thinkingLevel = pi.getThinkingLevel();
				let launchRoute: ResolvedTaskRoute | undefined;
				for (const route of configuredBtwRoutes(ctx)) {
					try {
						const authenticated = (await ctx.modelRegistry.getApiKeyAndHeaders(route.model)).ok;
						if (launchGeneration !== sessionGeneration) return;
						if (authenticated) {
							launchRoute = route;
							break;
						}
					} catch {
						if (launchGeneration !== sessionGeneration) return;
					}
				}
				if (!launchRoute) {
					ctx.ui.notify("No authenticated BTW task model route is available. Run /task-models.", "error");
					return;
				}
				const activeTools = pi.getActiveTools();
				let parentSystemPrompt: string | null = null;
				try {
					parentSystemPrompt = ctx.getSystemPrompt();
				} catch {
					parentSystemPrompt = null;
				}
				payloadPath = await store.create(
					createPayload({
						createdAt,
						parentSessionId: sessionId,
						parentPaneId: process.env.HERDR_PANE_ID ?? null,
						metadata: {
							generatedAt: createdAt,
							cwd: ctx.cwd,
							session: ctx.sessionManager.getSessionFile() ?? "ephemeral",
							model: currentModel,
						},
						parentSystemPrompt,
						parentActiveTools: activeTools,
						parentThinkingLevel: thinkingLevel,
						messages: sessionContext.messages,
						draftQuestion,
						config,
					}),
				);
				if (launchGeneration !== sessionGeneration) {
					await store.remove(payloadPath);
					return;
				}

				const launchOptions: HerdrLaunchOptions = {
					paneName: `btw-${sessionId.slice(0, 6)}-${Date.now().toString(36).slice(-4)}`,
					cwd: ctx.cwd,
					parentPaneId: process.env.HERDR_PANE_ID,
					payloadPath,
					model: `${launchRoute.model.provider}/${launchRoute.model.id}`,
					thinkingLevel: launchRoute.thinkingLevel,
					toolMode: config.tools,
					activeTools,
					split: config.split,
					projectTrusted: ctx.isProjectTrusted(),
					// Auto-submitted drafts go through pi's initial-message path
					// (processed after initial render) to avoid the double-paint
					// startup race; only this sentinel hits argv, never the question.
					initialMessage:
						config.autoSubmit && draftQuestion.trim() ? LAUNCH_DRAFT_COMMAND : undefined,
				};

				// Step 1: create the side pane with the parent's cwd.
				const splitResult = await herdr.exec(buildPaneSplitArgs(launchOptions), {
					timeout: 10_000,
				});
				if (launchGeneration !== sessionGeneration) {
					const paneId = parsePaneSplitPaneId(splitResult.stdout);
					if (!paneId) {
						await store.remove(payloadPath);
					} else if (!(await closeAndRemove(paneId, payloadPath))) {
						ctx.ui.notify("/btw cancellation could not close the side pane; context cleanup is deferred.", "warning");
					}
					return;
				}
				const splitOutcome = classifyLaunchResult(splitResult);
				if (splitOutcome !== "success") {
					await store.remove(payloadPath);
					ctx.ui.notify(
						`/btw failed: ${safeErrorText(splitResult.stdout, splitResult.stderr)}`,
						"error",
					);
					return;
				}

				const paneId = parsePaneSplitPaneId(splitResult.stdout);
				if (!paneId) {
					// Without split's returned ID, no later pane lookup can prove ownership.
					await store.remove(payloadPath);
					ctx.ui.notify(
						"/btw failed: could not determine the new pane ID from `herdr pane split` output",
						"error",
					);
					return;
				}

				// Step 2: adopt pi into the new pane; herdr waits for readiness.
				const agentStartArgs = buildAgentStartArgs(launchOptions);
				let result;
				try {
					result = await startPiAgent(herdr, {
						name: launchOptions.paneName,
						pane: paneId,
						args: agentStartArgs,
						options: { timeout: 45_000 },
						shouldRetry: (candidate) => !candidate.killed && launchGeneration === sessionGeneration,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await reportKnownPaneFailure(`/btw failed: ${message.slice(0, 500)}`, paneId, payloadPath);
					return;
				}
				if (launchGeneration !== sessionGeneration) {
					if (!(await closeAndRemove(paneId, payloadPath))) {
						ctx.ui.notify("/btw cancellation could not close the side pane; context cleanup is deferred.", "warning");
					}
					return;
				}
				const outcome = classifyLaunchResult(result);
				if (outcome === "success" && !isAgentStartReady(result.stdout, { name: launchOptions.paneName, paneId })) {
					await reportKnownPaneFailure(
						"/btw failed: `herdr agent start` returned an invalid or non-interactive result",
						paneId,
						payloadPath,
					);
					return;
				}
				if (outcome === "success") {
					ensurePolling();
					return;
				}

				if (outcome === "failed") {
					await reportKnownPaneFailure(
						`/btw failed: ${safeErrorText(result.stdout, result.stderr)}`,
						paneId,
						payloadPath,
					);
					return;
				}

				const reconciled = await herdr
					.exec(
						[
							"agent",
							"wait",
							launchOptions.paneName,
							"--until",
							"idle",
							"--until",
							"working",
							"--until",
							"blocked",
							"--until",
							"done",
							"--timeout",
							"5000",
						],
						{ timeout: 6_000 },
					)
					.catch(() => undefined);
				if (launchGeneration !== sessionGeneration) {
					if (!(await closeAndRemove(paneId, payloadPath))) {
						ctx.ui.notify("/btw cancellation could not close the side pane; context cleanup is deferred.", "warning");
					}
					return;
				}
				const reconciledPaneId =
					reconciled?.code === 0 && !reconciled.killed
						? parseReadyAgentPaneId(reconciled.stdout)
						: null;
				if (reconciledPaneId === paneId) {
					ensurePolling();
					return;
				}
				if (
					reconciledPaneId ||
					(reconciled && !reconciled.killed && hasHerdrErrorCode(reconciled, "agent_not_found"))
				) {
					await reportKnownPaneFailure(
						"/btw failed: Herdr did not start Pi in the new pane",
						paneId,
						payloadPath,
					);
					return;
				}

				ensurePolling();
				ctx.ui.notify(
					"/btw launch timed out or was killed after it may have reached Herdr. Context cleanup is deferred in case the child pane is still starting.",
					"warning",
				);
			} catch (error) {
				if (payloadPath) await store.remove(payloadPath).catch(() => undefined);
				if (launchGeneration !== sessionGeneration) return;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/btw failed: ${message.slice(0, 500)}`, "error");
			}
		},
	});
}

export default registerBtwExtension;
