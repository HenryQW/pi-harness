import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode } from "@henryqw/pi-herdr";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	applyConfigCommand,
	CONFIG_COMMAND_USAGE,
	ConfigStore,
	formatConfig,
	THINKING_LEVELS,
	type BtwConfig,
	type BtwThinkingLevel,
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
	parsePaneListPaneIds,
	parsePaneSplitPaneId,
	safeErrorText,
	type BtwPayload,
	type HerdrLaunchOptions,
} from "../internal/core.ts";
import {
	ackMatchesRequest,
	buildMergeTranscript,
	isMergeAck,
	isPromptWithinBounds,
	MAX_PROMPT_BYTES,
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	MergeCoordinator,
	isMergeRequest,
	type MergeAck,
	type MergeRequest,
} from "../internal/merge.ts";
import { HELP_TEXT, parseBtwCommand } from "../internal/router.ts";

const CHILD_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;
const LITERAL_DRAFT_PREFIX = "\u200b";
const MERGE_POLL_INTERVAL_MS = 3_000;
const ACK_POLL_INTERVAL_MS = 2_000;
const ACK_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT_START_BUSY_RETRIES = 5;
const AGENT_START_RETRY_DELAY_MS = 250;

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
	| "writeMergeAck"
	| "readMergeAck"
	| "removeIfNoPendingMerge"
>;
export type ConfigStorePort = Pick<ConfigStore, "load" | "save" | "update" | "reset">;

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

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

function supportedThinkingLevels(model: AvailableModel): BtwThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
	});
}

type ModelOption = { model: AvailableModel; pinnedThinkingLevel?: BtwThinkingLevel };

function availableTextModelOptions(ctx: ExtensionContext): ModelOption[] {
	const options: ModelOption[] = ctx.scopedModels.length
		? ctx.scopedModels.map(({ model, thinkingLevel }) => ({
				model,
				pinnedThinkingLevel: thinkingLevel as BtwThinkingLevel | undefined,
			}))
		: ctx.modelRegistry.getAvailable().map((model) => ({ model }));
	return options.filter(({ model }) => model.input.includes("text"));
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
	const herdr = createHerdrClient<HerdrOptions>((command, args, options) =>
		pi.exec(command, [...args], options));
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
	let ackTimer: ReturnType<typeof setInterval> | undefined;
	let pendingAckRequestId: string | undefined;
	let pendingAckStartedAt: number | undefined;
	let notifyAck: (message: string, type: "info" | "warning" | "error") => void = () => undefined;

	const stopAckPolling = (): void => {
		if (ackTimer) {
			clearInterval(ackTimer);
			ackTimer = undefined;
		}
	};

	const finishAck = (ack: MergeAck): void => {
		stopAckPolling();
		pendingAckRequestId = undefined;
		pendingAckStartedAt = undefined;
		notifyAck(
			ack.status === "accepted"
				? "Merge accepted: the parent has the side thread and is continuing with your prompt."
				: `Merge rejected by the parent: ${ack.reason ?? "unknown reason"}`,
			ack.status === "accepted" ? "info" : "error",
		);
	};

	const startAckPolling = (requestId: string, startedAt: number): void => {
		stopAckPolling();
		ackTimer = setInterval(async () => {
			const ack = await store.readMergeAck(payloadPath).catch(() => undefined);
			if (ack !== undefined && isMergeAck(ack) && ack.requestId === requestId) {
				finishAck(ack);
			} else if (Date.now() - startedAt > ACK_POLL_TIMEOUT_MS) {
				stopAckPolling();
				pendingAckRequestId = undefined;
				pendingAckStartedAt = undefined;
				notifyAck(
					"Merge still unacknowledged; it stays pending until the parent picks it up or it expires.",
					"warning",
				);
			}
		}, ACK_POLL_INTERVAL_MS);
		ackTimer.unref?.();
	};

	const resumeAckPolling = async (): Promise<void> => {
		if (!payload) return;
		const request = await store.readMergeRequest(payloadPath).catch(() => undefined);
		if (!isMergeRequest(request)) return;
		const ack = await store.readMergeAck(payloadPath).catch(() => undefined);
		if (ackMatchesRequest(ack, request)) {
			if (isMergeAck(ack)) finishAck(ack);
			return;
		}
		const sameRequest = pendingAckRequestId === request.requestId;
		pendingAckRequestId = request.requestId;
		if (!sameRequest || pendingAckStartedAt === undefined) {
			const createdAt = Date.parse(request.createdAt);
			pendingAckStartedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
		}
		startAckPolling(request.requestId, pendingAckStartedAt ?? Date.now());
	};

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

			const existingAck = await store.readMergeAck(payloadPath).catch(() => undefined);
			const existingRequest = await store.readMergeRequest(payloadPath).catch(() => undefined);
			if (existingRequest !== undefined) {
				if (!ackMatchesRequest(existingAck, existingRequest)) {
					ctx.ui.notify("A merge is already pending; the parent has not acknowledged it yet.", "warning");
					return;
				}
				if (isMergeAck(existingAck) && existingAck.status === "accepted") {
					ctx.ui.notify("This side thread was already merged into the parent.", "warning");
					return;
				}
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

			// Close the loop: hand focus back to the parent pane and close this one.
			// The mailbox request survives the pane teardown (cleanup is ack-aware),
			// and the parent picks it up on its next poll or agent_settled.
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

			// Fallback (not in a Herdr pane, or the close failed): stay open and
			// watch for the acknowledgement instead.
			ctx.ui.notify("Merge pending: waiting for the parent session to accept it.", "info");
			notifyAck = (message, type) => ctx.ui.notify(message, type);
			pendingAckRequestId = request.requestId;
			pendingAckStartedAt = Date.now();
			startAckPolling(request.requestId, pendingAckStartedAt);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		notifyAck = (message, type) => ctx.ui.notify(message, type);
		await resumeAckPolling();
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
		stopAckPolling();
		if (event.reason === "quit") {
			pendingAckRequestId = undefined;
			pendingAckStartedAt = undefined;
			// Acknowledgement-aware cleanup: an unacknowledged merge outlives the
			// child (until ack or the stale TTL), so the parent can still import it.
			await store.removeIfNoPendingMerge(payloadPath).catch(() => undefined);
		}
	});
}

export async function registerBtwExtension(
	pi: ExtensionAPI,
	options: { store?: ContextStorePort; configStore?: ConfigStorePort } = {},
): Promise<void> {
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

	const configStore = options.configStore ?? new ConfigStore();
	const herdr = createHerdrClient<HerdrOptions>((command, args, options) =>
		pi.exec(command, [...args], options));

	// --- Parent-side merge coordination ---------------------------------
	let sessionCtx:
		| Pick<ExtensionCommandContext, "sessionManager" | "isIdle" | "model" | "modelRegistry">
		| undefined;
	// Notifications need a UI context; route them through the last known ctx.
	let notifyFn: ((message: string, type: "info" | "warning" | "error") => void) | undefined;
	const coordinator = new MergeCoordinator(store, {
		getSessionId: () => sessionCtx?.sessionManager.getSessionId() ?? "",
		isIdle: () => sessionCtx?.isIdle() ?? false,
		getBranch: () => sessionCtx?.sessionManager.getBranch() ?? [],
		canSubmitPrompt: async () => {
			const model = sessionCtx?.model;
			const modelRegistry = sessionCtx?.modelRegistry;
			if (!model || !modelRegistry) return false;
			const modelName = `${model.provider}/${model.id}`;
			try {
				const authenticated = (await modelRegistry.getApiKeyAndHeaders(model)).ok;
				const currentModel = sessionCtx?.model;
				return authenticated && !!currentModel && `${currentModel.provider}/${currentModel.id}` === modelName;
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
		if (startupScan) {
			clearImmediate(startupScan);
			startupScan = undefined;
		}
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	});

	pi.registerCommand("btw-model", {
		description: "Choose model and thinking level used for /btw side threads",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /btw-model", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw-model requires interactive UI", "error");
				return;
			}
			try {
				await configStore.load();
			} catch {
				ctx.ui.notify("Couldn't read pi-herdr-btw config.", "error");
				return;
			}
			const models = availableTextModelOptions(ctx).sort((a, b) =>
				`${a.model.provider}/${a.model.id}`.localeCompare(`${b.model.provider}/${b.model.id}`),
			);
			if (!models.length) {
				ctx.ui.notify("No authenticated text models are available.", "warning");
				return;
			}
			const inherit = "Current session model";
			const modelNames = models.map(({ model }) => `${model.provider}/${model.id}`);
			const duplicateNames = new Set(
				modelNames.filter((name, index) => modelNames.indexOf(name) !== index),
			);
			const modelChoices = models.map((option) => {
				const modelName = `${option.model.provider}/${option.model.id}`;
				return {
					option,
					modelName,
					label: duplicateNames.has(modelName)
						? `${modelName} (${option.pinnedThinkingLevel ?? "default"})`
						: modelName,
				};
			});
			const selected = await ctx.ui.select(
				"BTW model",
				[inherit, ...modelChoices.map(({ label }) => label)],
			);
			if (!selected) return;
			if (selected === inherit) {
				try {
					await configStore.update((latest) => ({ ...latest, model: null, thinkingLevel: null }));
				} catch {
					ctx.ui.notify("Couldn't save pi-herdr-btw config.", "error");
					return;
				}
				ctx.ui.notify("BTW model and thinking set to current session values.", "info");
				return;
			}

			const selectedChoice = modelChoices.find(({ label }) => label === selected);
			if (!selectedChoice) return;
			const selectedModel = selectedChoice.option.model;
			const selectedModelName = selectedChoice.modelName;
			const thinkingLevels = selectedChoice.option.pinnedThinkingLevel
				? [selectedChoice.option.pinnedThinkingLevel]
				: supportedThinkingLevels(selectedModel);
			const thinkingLevel = thinkingLevels.length === 1
				? thinkingLevels[0]
				: await ctx.ui.select(`Thinking level · ${selectedModelName}`, thinkingLevels);
			if (!thinkingLevel || !thinkingLevels.includes(thinkingLevel as BtwThinkingLevel)) return;
			try {
				await configStore.update((latest) => ({
					...latest,
					model: selectedModelName,
					thinkingLevel: thinkingLevel as BtwThinkingLevel,
				}));
			} catch {
				ctx.ui.notify("Couldn't save pi-herdr-btw config.", "error");
				return;
			}
			ctx.ui.notify(`BTW model set to ${selectedModelName} (${thinkingLevel}).`, "info");
		},
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
						const config = await configStore.reset();
						ctx.ui.notify(`BTW config — ${formatConfig(config)}`, "info");
						return;
					}
					const trimmedArgs = route.args.trim();
					const result = !trimmedArgs || trimmedArgs === "show"
						? applyConfigCommand(await configStore.load(), route.args)
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

			let payloadPath: string | undefined;
			try {
				const config: BtwConfig = await configStore.load();
				await store.removeStale();
				const createdAt = new Date().toISOString();
				const sessionId = ctx.sessionManager.getSessionId();
				const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const configuredModel = config.model ?? currentModel;
				if (!configuredModel) {
					ctx.ui.notify("/btw requires a saved model or an active model", "error");
					return;
				}
				const thinkingLevel = pi.getThinkingLevel();
				const modelOptions = availableTextModelOptions(ctx).filter(
					({ model: candidate }) => `${candidate.provider}/${candidate.id}` === configuredModel,
				);
				const modelOption = modelOptions.find(
					({ pinnedThinkingLevel }) => pinnedThinkingLevel === (config.thinkingLevel ?? thinkingLevel),
				) ?? modelOptions.find(({ pinnedThinkingLevel }) => pinnedThinkingLevel === undefined) ?? modelOptions[0];
				if (!modelOption) {
					ctx.ui.notify(`BTW model unavailable: ${configuredModel}`, "error");
					return;
				}
				try {
					if (!(await ctx.modelRegistry.getApiKeyAndHeaders(modelOption.model)).ok) {
						ctx.ui.notify(`Couldn't authenticate BTW model: ${configuredModel}`, "error");
						return;
					}
				} catch {
					ctx.ui.notify(`Couldn't authenticate BTW model: ${configuredModel}`, "error");
					return;
				}
				const model = currentModel ?? null;
				const activeTools = pi.getActiveTools();
				const launchThinkingLevel = modelOption.pinnedThinkingLevel ?? config.thinkingLevel ?? thinkingLevel;
				if (!supportedThinkingLevels(modelOption.model).includes(launchThinkingLevel as BtwThinkingLevel)) {
					ctx.ui.notify(`BTW thinking level unavailable for ${configuredModel}: ${launchThinkingLevel}`, "error");
					return;
				}
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
							model,
						},
						parentSystemPrompt,
						parentActiveTools: activeTools,
						parentThinkingLevel: thinkingLevel,
						messages: sessionContext.messages,
						draftQuestion,
						config,
					}),
				);

				const launchOptions: HerdrLaunchOptions = {
					paneName: `btw-${sessionId.slice(0, 6)}-${Date.now().toString(36).slice(-4)}`,
					cwd: ctx.cwd,
					parentPaneId: process.env.HERDR_PANE_ID,
					payloadPath,
					model: configuredModel,
					thinkingLevel: launchThinkingLevel,
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

				const preSplitList = await herdr
					.exec(["pane", "list"], { timeout: 5_000 })
					.catch(() => undefined);
				const existingPaneIds =
					preSplitList?.code === 0 && !preSplitList.killed
						? new Set(parsePaneListPaneIds(preSplitList.stdout) ?? [])
						: undefined;

				const closeFocusedSplitPane = async (): Promise<void> => {
					const currentResult = await herdr
						.exec(["pane", "current", "--current"], { timeout: 5_000 })
						.catch(() => undefined);
					const currentPaneId =
						currentResult?.code === 0 && !currentResult.killed
							? parsePaneSplitPaneId(currentResult.stdout)
							: null;
					if (
						currentPaneId &&
						existingPaneIds &&
						!existingPaneIds.has(currentPaneId) &&
						currentPaneId !== launchOptions.parentPaneId
					) {
						await herdr.run(["pane", "close", currentPaneId], { timeout: 5_000 }).catch(() => undefined);
					}
				};

				// Step 1: create the side pane with the parent's cwd.
				const splitResult = await herdr.exec(buildPaneSplitArgs(launchOptions), {
					timeout: 10_000,
				});
				const splitOutcome = classifyLaunchResult(splitResult);
				if (splitOutcome === "failed") {
					await store.remove(payloadPath);
					ctx.ui.notify(
						`/btw failed: ${safeErrorText(splitResult.stdout, splitResult.stderr)}`,
						"error",
					);
					return;
				}
				if (splitOutcome === "ambiguous") {
					await closeFocusedSplitPane();
					await store.remove(payloadPath);
					ctx.ui.notify(
						`/btw failed: ${safeErrorText(splitResult.stdout, splitResult.stderr)}`,
						"error",
					);
					return;
				}

				const paneId = parsePaneSplitPaneId(splitResult.stdout);
				if (!paneId) {
					// Split focuses the new pane. Recover its ID from current-pane state
					// before cleanup when split's response body is malformed.
					await closeFocusedSplitPane();
					await store.remove(payloadPath);
					ctx.ui.notify(
						"/btw failed: could not determine the new pane ID from `herdr pane split` output",
						"error",
					);
					return;
				}

				// Step 2: adopt pi into the new pane; herdr waits for readiness.
				const agentStartArgs = buildAgentStartArgs(launchOptions, paneId);
				let result;
				try {
					result = await herdr.exec(agentStartArgs, { timeout: 45_000 });
					for (let attempt = 1; attempt < AGENT_START_BUSY_RETRIES; attempt += 1) {
						if (result.killed || !hasHerdrErrorCode(result, "agent_pane_busy")) break;
						await new Promise((resolve) => setTimeout(resolve, AGENT_START_RETRY_DELAY_MS));
						result = await herdr.exec(agentStartArgs, { timeout: 45_000 });
					}
				} catch (error) {
					await herdr.run(["pane", "close", paneId], { timeout: 5_000 }).catch(() => undefined);
					throw error;
				}
				const outcome = classifyLaunchResult(result);
				if (outcome === "success" && !isAgentStartReady(result.stdout, { name: launchOptions.paneName, paneId })) {
					await herdr.run(["pane", "close", paneId], { timeout: 5_000 }).catch(() => undefined);
					await store.remove(payloadPath);
					ctx.ui.notify("/btw failed: `herdr agent start` returned an invalid or non-interactive result", "error");
					return;
				}
				if (outcome === "success") {
					ensurePolling();
					return;
				}

				if (outcome === "failed") {
					await herdr.run(["pane", "close", paneId], { timeout: 5_000 }).catch(() => undefined);
					await store.remove(payloadPath);
					ctx.ui.notify(`/btw failed: ${safeErrorText(result.stdout, result.stderr)}`, "error");
					return;
				}

				ensurePolling();
				ctx.ui.notify(
					"/btw launch timed out or was killed after it may have reached Herdr. Context cleanup is deferred in case the child pane is still starting.",
					"warning",
				);
			} catch (error) {
				if (payloadPath) await store.remove(payloadPath).catch(() => undefined);
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/btw failed: ${message.slice(0, 500)}`, "error");
			}
		},
	});
}

export default registerBtwExtension;
