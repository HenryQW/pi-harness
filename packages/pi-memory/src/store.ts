import { copyFile, mkdir, open, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ENTRY_DELIMITER: string = "\n§\n";

export type Target = "memory" | "user";

export interface StoreConfig {
	directory: string;
	memoryCharLimit: number;
	userCharLimit: number;
	/** Called before every rewrite of an existing file; store copies the old file there. */
	backupPath?: (target: Target) => string;
	/** Test seam: rename implementation. Defaults to fs.rename. */
	renameFn?: (from: string, to: string) => Promise<void>;
}

export interface LoadResult {
	entries: string[];
	status?: "unreadable" | "oversized";
	conflictWarning?: string;
}

export interface BatchOperation {
	action?: string;
	content?: string;
	new_text?: string;
	old_text?: string;
}

/** Refuse to inject snapshots above this size into context. */
export const MAX_FILE_BYTES = 1_000_000;

export type FileState =
	| { kind: "ok"; raw: string }
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "oversized"; bytes: number };

type Result = {
	success: boolean;
	message?: string;
	error?: string;
	usage?: string;
	entryCount?: number;
	currentEntries?: string[];
	matches?: string[];
	done?: boolean;
	note?: string;
	target?: Target;
};

const PREVIEW_WIDTH = 80;

function previews(entries: string[]): string[] {
	return entries.map((e) => (e.length > PREVIEW_WIDTH ? `${e.slice(0, PREVIEW_WIDTH)}...` : e));
}

/**
 * Binding normalization order: strip BOM -> all line terminators to LF -> trim.
 * Delimiter validation, parsing, budgeting, and matching all operate on
 * normalized text so "a\r\n§\r\nb" cannot smuggle a delimiter past us and
 * CR/LF/NEL/VT/FF/U+2028/U+2029 cannot smuggle fake frame lines past line-based
 * filters. ponytail: NFKC/zero-width lookalike spoofing is NOT handled — the
 * frame headers are advisory context, not a security boundary; revisit only if
 * entries start coming from untrusted writers.
 */
function normalize(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/\r\n?|[\u2028\u2029\u0085\u000B\u000C]/g, "\n").trim();
}

function parseEntries(raw: string): string[] {
	const text = normalize(raw);
	if (!text) return [];
	// Deduplicate, preserving order and first occurrence.
	return [...new Set(text.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean))];
}

export class MemoryStore {
	private readonly config: StoreConfig;
	private readonly entries = new Map<Target, string[]>([
		["memory", []],
		["user", []],
	]);
	private consolidationFailures = 0;

	constructor(config: StoreConfig) {
		this.config = config;
	}

	private limit(target: Target): number {
		return target === "user" ? this.config.userCharLimit : this.config.memoryCharLimit;
	}

	private pathFor(target: Target): string {
		return join(this.config.directory, target === "user" ? "USER.md" : "MEMORY.md");
	}

	private charCount(target: Target): number {
		const entries = this.entries.get(target)!;
		return entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
	}

	private usage(target: Target): string {
		const current = this.charCount(target);
		const limit = this.limit(target);
		const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
		return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
	}

	private successResponse(target: Target, message?: string): Result {
		this.resetOnSuccess();
		return {
			success: true,
			done: true,
			target,
			message,
			usage: this.usage(target),
			entryCount: this.entries.get(target)!.length,
			note: "Write saved. This update is complete — do not repeat it.",
		};
	}

	private consolidationFailure(error: string, extra?: Partial<Result>): Result {
		const target = extra?.target ?? "memory";
		return {
			success: false,
			error,
			currentEntries: this.entries.get(target)!,
			usage: this.usage(target),
			...extra,
		};
	}

	/**
	 * Track consecutive consolidation failures. After 3, the model is told to
	 * stop retrying ({ done: true }); a successful write resets the count.
	 */
	incrementFailure(): { done: boolean } {
		this.consolidationFailures += 1;
		if (this.consolidationFailures >= 3) {
			return { done: true };
		}
		return { done: false };
	}

	resetOnSuccess(): void {
		this.consolidationFailures = 0;
	}

	async load(target: Target): Promise<LoadResult> {
		const file = await this.readFileState(target);
		if (file.kind === "unreadable") {
			return {
				entries: [],
				status: "unreadable",
				conflictWarning: `${this.pathFor(target)} exists but could not be read; refusing to serve a possibly-wrong view.`,
			};
		}
		if (file.kind === "oversized") {
			return {
				entries: [],
				status: "oversized",
				conflictWarning: `${this.pathFor(target)} is ${file.bytes.toLocaleString()} bytes, over the ${MAX_FILE_BYTES.toLocaleString()}-byte injection limit; refusing to serve it. Consolidate the file manually.`,
			};
		}
		return { entries: file.kind === "ok" ? parseEntries(file.raw) : [] };
	}

	/**
	 * Returns file state: "absent" for a missing file, "unreadable" when the file
	 * EXISTS but could not be read (permissions or invalid UTF-8), "oversized"
	 * when it exceeds MAX_FILE_BYTES. Callers must abort on unreadable/oversized
	 * rather than treat it as an empty store.
	 */
	private async readFileState(target: Target): Promise<FileState> {
		// Bounded, EOF-complete read: at most MAX_FILE_BYTES + 1 bytes leave the
		// filesystem (so a huge synced file can't exhaust memory), and we keep
		// reading until EOF so a short read from a network/synced filesystem can
		// never be mistaken for the whole file.
		let handle: import("node:fs/promises").FileHandle | undefined;
		try {
			handle = await open(this.pathFor(target), "r");
			const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
			let total = 0;
			for (;;) {
				if (total > MAX_FILE_BYTES) return { kind: "oversized", bytes: total };
				const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
				total += bytesRead;
				if (bytesRead === 0) break; // EOF
			}
			// Fatal decode: invalid UTF-8 counts as unreadable — a lossy replacement
			// view could get persisted back over the real bytes.
			return { kind: "ok", raw: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
			return { kind: "unreadable" };
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	/**
	 * Re-read from disk into in-memory state. Returns false when the file is
	 * unreadable or oversized — callers must NOT proceed (never rewrite from an
	 * assumed-empty view).
	 */
	private async reloadTarget(target: Target): Promise<boolean> {
		const file = await this.readFileState(target);
		if (file.kind !== "ok" && file.kind !== "absent") return false;
		this.entries.set(target, file.kind === "ok" ? parseEntries(file.raw) : []);
		return true;
	}

	private async persist(target: Target): Promise<void> {
		await mkdir(this.config.directory, { recursive: true });
		const path = this.pathFor(target);
		const backup = this.config.backupPath?.(target);
		if (backup) {
			try {
				await copyFile(path, backup);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const content = this.entries.get(target)!.join(ENTRY_DELIMITER);
		const tmp = join(dirname(path), `.mem_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			await writeFile(tmp, content, "utf-8");
			await (this.config.renameFn ?? rename)(tmp, path);
		} finally {
			await rm(tmp, { force: true }).catch(() => {});
		}
	}

	private static checkContent(content: string): string | undefined {
		const normalized = normalize(content);
		if (!normalized) return "Content cannot be empty.";
		if (normalized.includes(ENTRY_DELIMITER)) return `Content must not contain the entry delimiter ("${ENTRY_DELIMITER.trim()}”).`;
		if (/^[ \t]*═{3,}[ \t]*$/m.test(normalized)) return "Content must not contain lines made solely of '═' characters.";
		if (/^[ \t]*(MEMORY \(your personal notes|USER PROFILE \(who the user is)/m.test(normalized)) {
			return "Content must not start a line with the reserved headers 'MEMORY (your personal notes' or 'USER PROFILE (who the user is'.";
		}
		return undefined;
	}

	private static missingOldTextError(target: Target, action: "replace" | "remove", store: MemoryStore): Result {
		return {
			success: false,
			error: `'${action}' needs old_text -- a short unique substring of the entry to ${action}. None was provided. Reissue the ${action} with old_text set to part of one of the current_entries below.`,
			currentEntries: store.entries.get(target)!,
			usage: store.usage(target),
		};
	}

	private static ambiguousError(oldText: string, matches: string[]): Result {
		return {
			success: false,
			error: `Multiple entries matched '${oldText}'. Be more specific.`,
			matches: previews(matches),
		};
	}

	/**
	 * Resolve substring matches against entries. Entries are duplicate-free by
	 * invariant (dedupe on load + after every mutation), so multiple matches
	 * are always distinct entries.
	 */
	private static resolveMatch(entries: string[], oldText: string): ["missing"] | ["ambiguous", string[]] | [number] {
		const matches = entries.map((e, i) => (e.includes(oldText) ? i : -1)).filter((i) => i >= 0);
		if (matches.length === 0) return ["missing"];
		if (matches.length > 1) {
			return ["ambiguous", matches.map((i) => entries[i])];
		}
		return [matches[0]];
	}

	async add(target: Target, content: string): Promise<Result> {
		const contentError = MemoryStore.checkContent(content);
		if (contentError) return { success: false, error: contentError };
		const text = normalize(content);

		if (!(await this.reloadTarget(target))) {
			return this.unreadableAbort(target);
		}
		const entries = this.entries.get(target)!;

		if (entries.includes(text)) {
			return this.successResponse(target, "Entry already exists (no duplicate added).");
		}

		const newTotal = [...entries, text].join(ENTRY_DELIMITER).length;
		if (newTotal > this.limit(target)) {
			return this.consolidationFailure(
				`Memory at ${this.charCount(target).toLocaleString()}/${this.limit(target).toLocaleString()} chars. `
					+ `Adding this entry (${text.length} chars) would exceed the limit. Consolidate now: use 'replace' to merge `
					+ `overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), `
					+ `then retry this add — all in this turn.`,
				{ target },
			);
		}

		entries.push(text);
		await this.persist(target);
		return this.successResponse(target, "Entry added.");
	}

	private unreadableAbort(target: Target): Result {
		return {
			success: false,
			error: `${this.pathFor(target)} exists but could not be read (unreadable, or over the ${MAX_FILE_BYTES.toLocaleString()}-byte limit). The on-disk entries are unknown, so writing would `
				+ `risk wiping them. Fix the file and retry — nothing was changed.`,
		};
	}

	async replace(target: Target, oldText: string, newText: string): Promise<Result> {
		const contentError = MemoryStore.checkContent(newText);
		if (contentError) return { success: false, error: contentError };

		// Reload before validating old_text so failure results reflect DISK state.
		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);
		const trimmedOld = normalize(oldText ?? "");
		if (!trimmedOld) return MemoryStore.missingOldTextError(target, "replace", this);
		const entries = this.entries.get(target)!;

		const resolved = MemoryStore.resolveMatch(entries, trimmedOld);
		if (resolved[0] === "missing") {
			return this.consolidationFailure(
				`No entry matched '${trimmedOld}'. Check current_entries below and retry with the exact text of the entry you want to replace.`,
				{ target },
			);
		}
		if (resolved[0] === "ambiguous") return MemoryStore.ambiguousError(trimmedOld, resolved[1]);

		const text = normalize(newText);
		const testEntries = [...entries];
		testEntries[resolved[0]] = text;
		// A replace can create a duplicate; dedupe order-preserving before budget.
		const deduped = [...new Set(testEntries)];
		const newTotal = deduped.join(ENTRY_DELIMITER).length;
		if (newTotal > this.limit(target)) {
			return this.consolidationFailure(
				`Replacement would put memory at ${newTotal.toLocaleString()}/${this.limit(target).toLocaleString()} chars. `
					+ `Shorten the new content, or 'remove' other stale or less important entries to make room `
					+ `(see current_entries below), then retry — all in this turn.`,
				{ target },
			);
		}

		this.entries.set(target, deduped);
		await this.persist(target);
		return this.successResponse(target, "Entry replaced.");
	}

	async remove(target: Target, oldText: string): Promise<Result> {
		// Reload before validating old_text so failure results reflect DISK state.
		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);
		const trimmedOld = normalize(oldText ?? "");
		if (!trimmedOld) return MemoryStore.missingOldTextError(target, "remove", this);
		const entries = this.entries.get(target)!;

		const resolved = MemoryStore.resolveMatch(entries, trimmedOld);
		if (resolved[0] === "missing") {
			return this.consolidationFailure(
				`No entry matched '${trimmedOld}'. Check current_entries below and retry with the exact text of the entry you want to remove.`,
				{ target },
			);
		}
		if (resolved[0] === "ambiguous") return MemoryStore.ambiguousError(trimmedOld, resolved[1]);

		entries.splice(resolved[0], 1);
		await this.persist(target);
		return this.successResponse(target, "Entry removed.");
	}

	/**
	 * Apply add/replace/remove operations atomically against the FINAL budget:
	 * intermediate overflow is fine, only the end state is checked. All-or-nothing.
	 */
	async applyBatch(target: Target, operations: BatchOperation[]): Promise<Result> {
		if (!operations || operations.length === 0) {
			return { success: false, error: "operations list is empty." };
		}
		for (const op of operations) {
			const content = op.content ?? op.new_text ?? "";
			if ((op.action === "add" || op.action === "replace") && content) {
				const contentError = MemoryStore.checkContent(content);
				if (contentError) return { success: false, error: contentError };
			}
		}

		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);

		let working = [...this.entries.get(target)!];
		const fail = (message: string): Result =>
			this.consolidationFailure(`${message} No operations were applied (batch is all-or-nothing).`, { target });

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i] ?? {};
			const action = op.action;
			const content = normalize(op.content ?? op.new_text ?? "");
			const oldText = normalize(op.old_text ?? "");
			const pos = `Operation ${i + 1} (${action ?? "unknown"})`;

			if (action === "add") {
				if (!content) return fail(`${pos}: content is required.`);
				if (working.includes(normalize(content))) continue; // idempotent duplicate
				working.push(normalize(content));
			} else if (action === "replace") {
				if (!oldText) return fail(`${pos}: old_text is required.`);
				if (!content) return fail(`${pos}: content is required (use action='remove' to delete).`);
				const resolved = MemoryStore.resolveMatch(working, oldText);
				if (resolved[0] === "missing") return fail(`${pos}: no entry matched '${oldText}'.`);
				if (resolved[0] === "ambiguous") return fail(`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`);
				working[resolved[0]] = content;
				// A replace can create a duplicate; dedupe order-preserving before later ops/budget.
				working = [...new Set(working)];
			} else if (action === "remove") {
				if (!oldText) return fail(`${pos}: old_text is required.`);
				const resolved = MemoryStore.resolveMatch(working, oldText);
				if (resolved[0] === "missing") return fail(`${pos}: no entry matched '${oldText}'.`);
				if (resolved[0] === "ambiguous") return fail(`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`);
				working.splice(resolved[0], 1);
			} else {
				return fail(`${pos}: unknown action. Use add, replace, or remove.`);
			}
		}

		const newTotal = working.length ? working.join(ENTRY_DELIMITER).length : 0;
		if (newTotal > this.limit(target)) {
			const current = this.charCount(target);
			return this.consolidationFailure(
				`After applying all ${operations.length} operations, memory would be at ${newTotal.toLocaleString()}/`
					+ `${this.limit(target).toLocaleString()} chars -- over the limit. Remove or shorten more entries in the same batch `
					+ `(see current_entries below), then retry.`,
				{ target, usage: `${current.toLocaleString()}/${this.limit(target).toLocaleString()}` },
			);
		}

		this.entries.set(target, working);
		await this.persist(target);
		return this.successResponse(target, `Applied ${operations.length} operation(s).`);
	}
}
