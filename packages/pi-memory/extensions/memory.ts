import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { lock } from "proper-lockfile";
import { Type } from "typebox";
import { configPath, loadMemoryConfig, type MemoryConfig } from "../src/config.ts";
import { ENTRY_DELIMITER, MemoryStore, usage, type Target } from "../src/store.ts";

const SEPARATOR = "═".repeat(46);
// Backups and the lock file live OUTSIDE config.directory (which may be
// iCloud-synced) so the memory dir holds exactly MEMORY.md and USER.md (ADR 005).
const BACKUP_DIR = () => join(getAgentDir(), "config", "pi-memory", "backups");
// Defense-in-depth against snapshot frame spoofing by poisoned on-disk entries.
const FRAME_TOKEN_LINE = /^\s*(?:═{3,}|MEMORY \(your personal notes|USER PROFILE \(who the user is)/;
const FRAME_TOKEN_REPLACEMENT = "[filtered frame token]";
const DISPLAY_CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/gu;
// @henryqw/pi-herdr-btw does not export internal/core.ts from its package root.
const BTW_CHILD_PAYLOAD_ARG = "--pi-herdr-btw-payload";
const CONSOLIDATION_FAILURE = /(?:exceed|over) the limit|would put memory|no entry matched|[Mm]ultiple entries matched|matched multiple distinct/i;
const MEMORY_CHECK = "MEMORY CHECK: Save explicit durable user preferences or corrections immediately. Save an inferred habit only after two independent signals from the conversation and/or existing profile. Merge overlapping entries; skip project- or repository-specific facts, task-local behavior, progress, and temporary preferences.";
const MEMORY_DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Memory is injected into every future turn, so keep entries compact and high-signal.

HOW: Prefer one operations batch for multiple changes or consolidation. A batch applies atomically and checks the character limit only on the final result, so it can remove or shorten stale entries and add new ones in one call. Use action/content/old_text only for one lone change. A successful response finishes the update; do not repeat it.

WHEN: Save proactively when the user states a preference, correction, or personal detail, or you learn a stable fact about their environment, conventions, or workflow. Prioritize user preferences and corrections, then environment facts, then procedures.

IF FULL: Reissue one batch that removes or shortens enough stale entries and adds the new entry together.

TARGETS: user is who the user is (name, role, preferences, style). memory is your notes (environment, conventions, tool quirks, lessons).

EXCLUDE: project- or repository-specific facts (build commands, repo conventions, architecture) do NOT belong here — this store is global across projects; put them in that repository's docs instead.

SKIP: trivial or obvious information, easily rediscovered facts, raw dumps, task progress, completed-work logs, and temporary TODO state. Reusable procedures belong in a skill, not memory.`;

function sanitizeEntry(entry: string): string {
	return entry.split("\n").map((line) => FRAME_TOKEN_LINE.test(line) ? FRAME_TOKEN_REPLACEMENT : line).join("\n");
}

// Strip control characters so externally-influenced names can't smuggle
// prompt structure into warnings.
function sanitizeName(name: string): string {
	return name.replace(/[\p{C}]/gu, "").slice(0, 120);
}

function escapeDisplayControls(text: string): string {
	return text.replace(DISPLAY_CONTROL_CHARACTER, (character) => {
		if (character === "\n") return character;
		const codePoint = character.codePointAt(0)!;
		return codePoint <= 0xffff
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: `\\u{${codePoint.toString(16)}}`;
	});
}

function renderBlock(target: Target, entries: string[], config: MemoryConfig, warnings: string[]): string {
	if (!entries.length) return "";
	const limit = target === "user" ? config.userCharLimit : config.memoryCharLimit;
	// Sanitize BEFORE budgeting: expansion from frame-token replacement must
	// count against the cap, or many short reserved lines could inflate the
	// injected snapshot past it.
	const sanitized = entries.map(sanitizeEntry);
	// Cap the snapshot at the configured char budget even when the on-disk file
	// exceeds it (external edit / sync). Omitted entries stay on disk; the
	// warning tells the model to consolidate before anything new fits.
	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const entry of sanitized) {
		const cost = entry.length + (kept.length ? ENTRY_DELIMITER.length : 0);
		// No kept.length exemption: a single oversized entry (manual edit or sync)
		// must be omitted too, or it defeats the advertised context cap.
		if (used + cost > limit) {
			omitted = entries.length - kept.length;
			break;
		}
		kept.push(entry);
		used += cost;
	}
	const content = kept.join(ENTRY_DELIMITER);
	if (content.includes(FRAME_TOKEN_REPLACEMENT)) {
		warnings.push(`WARNING: frame-token-like lines were filtered out of the ${target} snapshot (see "${FRAME_TOKEN_REPLACEMENT}").`);
	}
	if (omitted > 0) {
		warnings.push(`WARNING: ${target} store is over its character cap; ${omitted} entr${omitted === 1 ? "y was" : "ies were"} omitted from this snapshot. Consolidate stale entries via a memory batch.`);
	}
	// Everything omitted (e.g. one entry larger than the whole cap): no block,
	// the standalone warning above still reaches the prompt.
	if (!kept.length) return "";
	const usageText = usage(used, limit);
	const header = target === "user" ? "USER PROFILE (who the user is)" : "MEMORY (your personal notes)";
	return `${SEPARATOR}\n${header} [${usageText}]\n${SEPARATOR}\n${content}`;
}

export default function memoryExtension(pi: ExtensionAPI): void {
	const state: {
		config?: MemoryConfig;
		stores?: Record<Target, MemoryStore>;
		snapshotBlocks?: string[];
		conflictWarnings: string[];
		initError?: string;
	} = { conflictWarnings: [] };

	pi.on("session_start", async () => {
		state.config = undefined;
		state.stores = undefined;
		state.snapshotBlocks = undefined;
		state.conflictWarnings = [];
		state.initError = undefined;
		try {
			await mkdir(BACKUP_DIR(), { recursive: true });
			const config = loadMemoryConfig();
			await mkdir(config.directory, { recursive: true });
			// The runtime contract keeps backups OUTSIDE the memory directory; reject
			// overlap (equal, ancestor, descendant) so backup cleanup can never eat
			// the store and .bak files can't be mistaken for memory files. Both dirs
			// exist by now — resolve symlinks and '..' components via realpath.
			const [realStore, realBackup] = await Promise.all([realpath(config.directory), realpath(BACKUP_DIR())]);
			if (realStore === realBackup || realStore.startsWith(realBackup + sep) || realBackup.startsWith(realStore + sep)) {
				throw new Error(`Memory directory must not overlap the backup directory (${BACKUP_DIR()}): got ${config.directory}`);
			}
			const backupPath = (target: Target) => join(BACKUP_DIR(), target === "user" ? "USER.md.bak" : "MEMORY.md.bak");
			const stores: Record<Target, MemoryStore> = {
				memory: new MemoryStore({ ...config, backupPath }),
				user: new MemoryStore({ ...config, backupPath }),
			};
			const [memory, user, siblings] = await Promise.all([
				stores.memory.load("memory"),
				stores.user.load("user"),
				readdir(config.directory, { withFileTypes: true }),
			]);
			const conflictWarnings = [memory.conflictWarning, user.conflictWarning].filter((warning): warning is string => !!warning);
			// Directory contract is exactly MEMORY.md + USER.md — warn on ANY other
			// regular file (iCloud conflict copies, stray edits) without guessing its
			// origin from the name. Bound the list so pointing directory at a large
			// existing folder can't flood the system prompt.
			const MAX_LISTED_FILES = 3;
			const unexpected = siblings.filter((sibling) => sibling.isFile() && sibling.name !== "MEMORY.md" && sibling.name !== "USER.md").map((sibling) => sibling.name).sort();
			if (unexpected.length > 0) {
				const listed = unexpected.slice(0, MAX_LISTED_FILES).map((name) => `"${sanitizeName(name)}"`).join(", ");
				const more = unexpected.length > MAX_LISTED_FILES ? ` and ${unexpected.length - MAX_LISTED_FILES} more` : "";
				conflictWarnings.push(`WARNING: ${unexpected.length} unexpected file${unexpected.length === 1 ? "" : "s"} in the memory directory (${listed}${more}). Only MEMORY.md and USER.md are loaded; reconcile or remove the rest.`);
			}

			state.config = config;
			state.stores = stores;
			state.snapshotBlocks = [renderBlock("memory", memory.entries, config, conflictWarnings), renderBlock("user", user.entries, config, conflictWarnings)];
			state.conflictWarnings = conflictWarnings;
		} catch (error) {
			// Surface once, disable quietly: no throw-loop every turn.
			state.initError = error instanceof Error ? error.message : String(error);
		}
	});

	// Tool is registered unconditionally at factory time so a failed init
	// degrades to per-call errors instead of a missing tool.
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description: `${MEMORY_DESCRIPTION}\n\nTo see current live entries, read MEMORY.md in the configured memory directory with the read tool.`,
		promptSnippet: "Save durable facts to persistent memory",
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["add", "replace", "remove"] as const, {
				description: "Single change to perform. Omit when using operations.",
			})),
			target: Type.Optional(StringEnum(["memory", "user"] as const, {
				default: "memory",
				description: "memory for agent notes; user for user profile facts. Defaults to memory.",
			})),
			content: Type.Optional(Type.String({ description: "Entry content for add or replace." })),
			old_text: Type.Optional(Type.String({ description: "Unique substring identifying the entry for replace or remove." })),
			operations: Type.Optional(Type.Array(Type.Object({
				action: StringEnum(["add", "replace", "remove"] as const),
				content: Type.Optional(Type.String()),
				old_text: Type.Optional(Type.String()),
			}), { description: "Preferred atomic batch of memory changes." })),
		}),

		async execute(_toolCallId, params) {
			if (state.initError) throw new Error(`Memory extension failed to initialize and is disabled: ${state.initError}`);
			if (!state.config || !state.stores) throw new Error("Memory extension is not initialized.");
			const target = params.target ?? "memory";
			const store = state.stores[target];
			// Serialize the entire mutation window against Pi's edit/write tools.
			return withFileMutationQueue(join(state.config.directory, target === "user" ? "USER.md" : "MEMORY.md"), async () => {
				// Recreate before locking: a cleaned-up backup dir would otherwise fail
				// lock-file creation before persist() gets a chance to restore it.
				await mkdir(BACKUP_DIR(), { recursive: true });
				const release = await lock(join(BACKUP_DIR(), ".memory-lock"), {
					realpath: false,
					stale: 10_000,
					retries: { retries: 2, minTimeout: 50, maxTimeout: 200 },
				});
				try {
					let result: Awaited<ReturnType<MemoryStore["add"]>>;
					if (params.operations !== undefined) result = await store.applyBatch(target, params.operations);
					else if (params.action === "add") result = await store.add(target, params.content ?? "");
					else if (params.action === "replace") result = await store.replace(target, params.old_text ?? "", params.content ?? "");
					else if (params.action === "remove") result = await store.remove(target, params.old_text ?? "");
					else result = { success: false, error: "Provide action for a single change or operations for a batch." };

					if (!result.success) {
						let error = result.error ?? "Memory write failed.";
						// Pi tool errors are plain strings — surface match previews and usage.
						if (result.matches?.length) error += `\nMatching entries: ${JSON.stringify(result.matches)}`;
						if (result.usage) error += `\nUsage: ${result.usage}`;
						if (CONSOLIDATION_FAILURE.test(error) && store.incrementFailure().done) {
							throw new Error("Memory consolidation failed repeatedly this turn. Stop retrying memory calls, continue replying to the user.");
						}
						if (result.currentEntries?.length) error += `\nCurrent entries: ${JSON.stringify(result.currentEntries)}`;
						throw new Error(error);
					}
					store.resetOnSuccess();
					return {
						content: [{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								done: true,
								usage: result.usage,
								entryCount: result.entryCount,
								message: "Write saved. This update is complete — do not repeat it.",
							}),
						}],
						details: { status: result.message ?? "Write saved.", entries: result.writtenEntries ?? [] },
					};
				} finally {
					await release();
				}
			});
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as { status: string; entries: string[] } | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			let text = theme.fg("success", `✓ ${details.status}`);
			for (const entry of details.entries) {
				text += `\n  ${theme.fg("accent", escapeDisplayControls(entry).replaceAll("\n", "\n  "))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.on("before_agent_start", (event) => {
		for (const store of Object.values(state.stores ?? {})) store.resetOnSuccess();
		if (process.argv.includes(BTW_CHILD_PAYLOAD_ARG)) return;
		// Failed init stays visible every turn (correctness-critical config must
		// not vanish silently) but as a warning line, not a per-turn throw-loop.
		if (state.initError) {
			return { systemPrompt: `${event.systemPrompt}\n\nWARNING: persistent memory is DISABLED this session — initialization failed: ${sanitizeName(state.initError)} Fix ${configPath()} and restart.` };
		}
		if (!state.config || !state.stores || !state.snapshotBlocks) return;
		const blocks = [...state.snapshotBlocks, ...state.conflictWarnings].filter(Boolean).join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks ? `${blocks}\n\n` : ""}${MEMORY_CHECK}` };
	});
}
