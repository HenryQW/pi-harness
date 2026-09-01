import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, rename, stat, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ENTRY_DELIMITER: string = "\n§\n";
const RESERVED_FRAME_LINE = /^\s*(?:═{3,}|MEMORY \(your personal notes|USER PROFILE \(who the user is)/;

export function isReservedFrameLine(line: string): boolean {
	return RESERVED_FRAME_LINE.test(line);
}

export type Target = "memory" | "user";

export interface StoreConfig {
	directory: string;
	memoryCharLimit: number;
	userCharLimit: number;
	/** Called before every rewrite of an existing file; store copies the old file there. */
	backupPath?: (target: Target) => string;
	/** Test seam: rename implementation. Defaults to fs.rename. */
	renameFn?: (from: string, to: string) => Promise<void>;
	/** Test seam: stat implementation for persistence-time checks. Defaults to fs.stat. */
	statFn?: (path: string) => Promise<import("node:fs").Stats>;
}

export interface LoadResult {
	entries: string[];
	/** Raw file state for callers that must detect a change between two reads. */
	state: "ok" | "absent" | "unreadable" | "oversized";
	raw?: string;
	status?: "unreadable" | "oversized";
	conflictWarning?: string;
}

export interface BatchOperation {
	action?: string;
	content?: string;
	old_text?: string;
}

/** Refuse to inject snapshots or accept serialized mutations above this size. */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_BATCH_OPERATIONS = 100;

export type FileState =
	| { kind: "ok"; raw: string }
	| { kind: "absent" }
	| { kind: "unreadable"; confirmedPresent: boolean }
	| { kind: "oversized"; bytes: number };

type Result = {
	success: boolean;
	message?: string;
	error?: string;
	usage?: string;
	entryCount?: number;
	writtenEntries?: string[];
	currentEntries?: string[];
	matches?: string[];
};

const PREVIEW_WIDTH = 80;
const MAX_PREVIEW_ITEMS = 20;
const MAX_PREVIEW_CHARS = 1500;

function previews(entries: string[]): string[] {
	let chars = 0;
	const shown: string[] = [];
	for (const entry of entries) {
		if (shown.length >= MAX_PREVIEW_ITEMS || chars + PREVIEW_WIDTH > MAX_PREVIEW_CHARS) break;
		shown.push(entry.length > PREVIEW_WIDTH ? `${entry.slice(0, PREVIEW_WIDTH)}...` : entry);
		chars += PREVIEW_WIDTH;
	}
	return shown;
}

export function usage(current: number, limit: number): string {
	const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
	return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
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
export function normalizeEntry(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/\r\n?|[\u2028\u2029\u0085\u000B\u000C]/g, "\n").trim();
}

export function validateEntryContent(content: string): string | undefined {
	const normalized = normalizeEntry(content);
	if (!normalized) return "Content cannot be empty.";
	if (normalized.includes(ENTRY_DELIMITER)) return `Content must not contain the entry delimiter ("${ENTRY_DELIMITER.trim()}”).`;
	// Same predicate as the snapshot sanitizer (leading Unicode whitespace
	// included): anything the sanitizer would filter must be rejected here,
	// or writes report success while vanishing from snapshots.
	for (const line of normalized.split("\n")) {
		if (isReservedFrameLine(line)) {
			return "Content must not contain lines starting with '═' separators or the reserved headers 'MEMORY (your personal notes' / 'USER PROFILE (who the user is'.";
		}
	}
	return undefined;
}

function parseEntries(raw: string): string[] {
	const text = normalizeEntry(raw);
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
	// Targets whose file was observed on disk this session — used to detect
	// unexpected mid-session disappearance before a mutation rewrites from an
	// empty view.
	private readonly observedExisting = new Set<Target>();
	private disappearanceDetected = false;
	private readonly unreadableReasons = new Map<Target, string>();
	// Metadata and content digest of the last successfully loaded file, per target.
	private readonly loadedFingerprints = new Map<Target, { mtimeMs: number; size: number; digest: string }>();

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
		return usage(this.charCount(target), this.limit(target));
	}

	private successResponse(target: Target, message?: string, writtenEntries: string[] = []): Result {
		this.resetOnSuccess();
		return {
			success: true,
			message,
			usage: this.usage(target),
			entryCount: this.entries.get(target)!.length,
			writtenEntries,
		};
	}

	private consolidationFailure(error: string, target: Target = "memory", resultUsage?: string): Result {
		return {
			success: false,
			error,
			currentEntries: previews(this.entries.get(target)!),
			usage: resultUsage ?? this.usage(target),
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
				state: "unreadable",
				status: "unreadable",
				conflictWarning: file.confirmedPresent
					? `${this.pathFor(target)} exists but could not be read; refusing to serve a possibly-wrong view.`
					: `${this.pathFor(target)} could not be read and its presence could not be confirmed; refusing to serve a possibly-wrong view.`,
			};
		}
		if (file.kind === "oversized") {
			return {
				entries: [],
				state: "oversized",
				status: "oversized",
				conflictWarning: `${this.pathFor(target)} is ${file.bytes.toLocaleString()} bytes, over the ${MAX_FILE_BYTES.toLocaleString()}-byte injection limit; refusing to serve it. Consolidate the file manually.`,
			};
		}
		if (file.kind === "absent" && this.observedExisting.has(target)) {
			return {
				entries: [],
				state: "unreadable",
				status: "unreadable",
				conflictWarning: `${this.pathFor(target)} existed earlier this session but has disappeared; refusing to serve an empty view. Restore it and retry.`,
			};
		}
		return {
			entries: file.kind === "ok" ? parseEntries(file.raw) : [],
			state: file.kind,
			raw: file.kind === "ok" ? file.raw : "",
		};
	}

	private async digestFile(path: string): Promise<string> {
		const handle = await open(path, "r");
		try {
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let total = 0;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) return hash.digest("base64url");
				total += bytesRead;
				if (total > MAX_FILE_BYTES) throw new Error(`${path} grew over the ${MAX_FILE_BYTES.toLocaleString()}-byte limit during mutation.`);
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			await handle.close();
		}
	}

	/**
	 * Returns file state: "absent" for a missing file, "unreadable" when it
	 * could not be read, and "oversized" when it exceeds MAX_FILE_BYTES.
	 * Unreadable states say whether this read proved the file existed. Callers
	 * must abort on unreadable/oversized rather than assume an empty store.
	 */
	private async readFileState(target: Target): Promise<FileState> {
		// Bounded, EOF-complete read: at most MAX_FILE_BYTES + 1 bytes leave the
		// filesystem (so a huge synced file can't exhaust memory), and we keep
		// reading until EOF so a short read from a network/synced filesystem can
		// never be mistaken for the whole file.
		let handle: import("node:fs/promises").FileHandle | undefined;
		let confirmedPresent = false;
		this.unreadableReasons.delete(target);
		try {
			// Symlinked store files are rejected before anything follows the link:
			// tmp+rename would replace the link itself and silently disconnect
			// writes from the intended synced target.
			const ls = await lstat(this.pathFor(target)).catch(() => undefined);
			if (ls) {
				confirmedPresent = true;
				this.observedExisting.add(target);
			}
			if (ls?.isSymbolicLink()) {
				this.unreadableReasons.set(target, `${this.pathFor(target)} is a symlink; symlinked store files are not supported because atomic rewrites replace the link. Point the memory directory at real files.`);
				return { kind: "unreadable", confirmedPresent: true };
			}
			handle = await open(this.pathFor(target), "r");
			confirmedPresent = true;
			this.observedExisting.add(target);
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
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
			// Fingerprint for the pre-rename change check: an external sync that
			// lands V2 between this read and persist must not be silently replaced
			// by V1-plus-mutation.
			try {
				const st = await (this.config.statFn ?? stat)(this.pathFor(target));
				this.loadedFingerprints.set(target, {
					mtimeMs: st.mtimeMs,
					size: st.size,
					digest: createHash("sha256").update(buffer.subarray(0, total)).digest("base64url"),
				});
			} catch {
				this.loadedFingerprints.delete(target);
			}
			return { kind: "ok", raw };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// ENOENT on the FILE is "absent" only if the configured directory
				// itself still exists — a vanished synced/mounted directory must not
				// be mistaken for an empty store and rewritten divergently.
				try {
					await stat(this.config.directory);
					return { kind: "absent" };
				} catch {
					return { kind: "unreadable", confirmedPresent };
				}
			}
			return { kind: "unreadable", confirmedPresent };
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
		if (file.kind !== "ok" && file.kind !== "absent") {
			if (file.kind === "unreadable" && !file.confirmedPresent) {
				this.unreadableReasons.set(target, `${this.pathFor(target)} could not be read and its presence could not be confirmed. Fix the path and retry — nothing was changed.`);
			}
			return false;
		}
		if (file.kind === "absent" && this.observedExisting.has(target)) {
			// The store existed earlier this session and has vanished (sync
			// conflict, cleanup, accident). Rewriting from the in-memory view would
			// create a divergent store that hides the original when it reappears.
			this.disappearanceDetected = true;
			return false;
		}
		this.entries.set(target, file.kind === "ok" ? parseEntries(file.raw) : []);
		return true;
	}

	private async persist(target: Target): Promise<void> {
		await mkdir(this.config.directory, { recursive: true });
		const path = this.pathFor(target);
		const backup = this.config.backupPath?.(target);
		if (backup) {
			// Recreate the backup parent so a cleaned-up backup directory can't be
			// misread as "source absent" and silently skip the promised backup.
			await mkdir(dirname(backup), { recursive: true });
			try {
				await copyFile(path, backup);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// Backup dir now exists, so ENOENT means the SOURCE vanished after
				// reloadTarget saw it — same divergence hazard as mid-session
				// disappearance; never proceed from the stale view.
				if (this.observedExisting.has(target)) {
					this.disappearanceDetected = true;
					throw new Error(`${path} vanished before its backup could be written; aborting to avoid a divergent store.`);
				}
			}
		}
		const content = this.entries.get(target)!.join(ENTRY_DELIMITER);
		const tmp = join(dirname(path), `.mem_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			// Preserve restrictive modes/ACLs across inode replacement: default
			// umask would otherwise turn a 0600 USER.md into 0644.
			let mode: number | undefined;
			try {
				mode = (await stat(path)).mode & 0o777;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await writeFile(tmp, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			// A creation-assumed write (reload saw the file absent) must not clobber
			// a file that appeared meanwhile (sync race): re-check just before the
			// rename, as close to it as possible.
			if (!this.observedExisting.has(target)) {
				try {
					await (this.config.statFn ?? stat)(path);
					throw new Error(`${path} appeared during this mutation (likely sync); retry to merge its content.`);
				} catch (error) {
					if (!(error as NodeJS.ErrnoException).code && (error as Error).message.includes("appeared during")) throw error;
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					// ENOENT: still absent, proceed.
				}
			}
			// An existing store must not be replaced if the on-disk version changed
			// since reload (external sync landed V2 after we read V1): compare
			// fingerprint immediately before the rename.
			if (this.observedExisting.has(target)) {
				const fingerprint = this.loadedFingerprints.get(target);
				if (fingerprint) {
					const current = await (this.config.statFn ?? stat)(path);
					if (current.mtimeMs !== fingerprint.mtimeMs || current.size !== fingerprint.size
						|| await this.digestFile(path) !== fingerprint.digest) {
						throw new Error(`${path} changed during this mutation (likely sync); retry to merge its content.`);
					}
				}
			}
			await (this.config.renameFn ?? rename)(tmp, path);
			// The store now exists on disk; a later mid-session disappearance is
			// unexpected and must abort, not rewrite from the in-memory view.
			this.observedExisting.add(target);
		} finally {
			await rm(tmp, { force: true }).catch(() => {});
		}
	}

	private static missingOldTextError(target: Target, action: "replace" | "remove", store: MemoryStore): Result {
		return {
			success: false,
			error: `'${action}' needs old_text -- a short unique substring of the entry to ${action}. None was provided. Reissue the ${action} with old_text set to part of one of the current_entries below.`,
			currentEntries: previews(store.entries.get(target)!),
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
		const contentError = validateEntryContent(content);
		if (contentError) return { success: false, error: contentError };
		const text = normalizeEntry(content);

		if (!(await this.reloadTarget(target))) {
			return this.unreadableAbort(target);
		}
		const entries = this.entries.get(target)!;

		if (entries.includes(text)) {
			return this.successResponse(target, "Entry already exists (no duplicate added).", [text]);
		}

		const newTotal = [...entries, text].join(ENTRY_DELIMITER).length;
		if (newTotal > this.limit(target)) {
			return this.consolidationFailure(
				`Memory at ${this.charCount(target).toLocaleString()}/${this.limit(target).toLocaleString()} chars. `
					+ `Adding this entry (${text.length} chars) would exceed the limit. Consolidate now: use 'replace' to merge `
					+ `overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), `
					+ `then retry this add — all in this turn.`,
				target,
			);
		}

		entries.push(text);
		await this.persist(target);
		return this.successResponse(target, "Entry added.", [text]);
	}

	private unreadableAbort(target: Target): Result {
		const unreadableReason = this.unreadableReasons.get(target);
		if (unreadableReason) {
			this.unreadableReasons.delete(target);
			return { success: false, error: unreadableReason };
		}
		if (this.disappearanceDetected) {
			this.disappearanceDetected = false;
			return {
				success: false,
				error: `${this.pathFor(target)} existed earlier this session but has disappeared (sync conflict, cleanup, or accident). Writing now would create a divergent store that hides the original when it returns. Restore the file (with the entries you want to keep) — once recreated, mutations work normally again.`,
			};
		}
		return {
			success: false,
			error: `${this.pathFor(target)} exists but could not be read (unreadable, or over the ${MAX_FILE_BYTES.toLocaleString()}-byte limit). The on-disk entries are unknown, so writing would `
				+ `risk wiping them. Fix the file and retry — nothing was changed.`,
		};
	}

	async replace(target: Target, oldText: string, newText: string): Promise<Result> {
		const contentError = validateEntryContent(newText);
		if (contentError) return { success: false, error: contentError };

		// Reload before validating old_text so failure results reflect DISK state.
		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);
		const trimmedOld = normalizeEntry(oldText ?? "");
		if (!trimmedOld) return MemoryStore.missingOldTextError(target, "replace", this);
		const entries = this.entries.get(target)!;

		const resolved = MemoryStore.resolveMatch(entries, trimmedOld);
		if (resolved[0] === "missing") {
			return this.consolidationFailure(
				`No entry matched '${trimmedOld}'. Check current_entries below and retry with the exact text of the entry you want to replace.`,
				target,
			);
		}
		if (resolved[0] === "ambiguous") return MemoryStore.ambiguousError(trimmedOld, resolved[1]);

		const text = normalizeEntry(newText);
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
				target,
			);
		}

		this.entries.set(target, deduped);
		await this.persist(target);
		return this.successResponse(target, "Entry replaced.", [text]);
	}

	async remove(target: Target, oldText: string): Promise<Result> {
		// Reload before validating old_text so failure results reflect DISK state.
		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);
		const trimmedOld = normalizeEntry(oldText ?? "");
		if (!trimmedOld) return MemoryStore.missingOldTextError(target, "remove", this);
		const entries = this.entries.get(target)!;

		const resolved = MemoryStore.resolveMatch(entries, trimmedOld);
		if (resolved[0] === "missing") {
			return this.consolidationFailure(
				`No entry matched '${trimmedOld}'. Check current_entries below and retry with the exact text of the entry you want to remove.`,
				target,
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
		if (operations.length > MAX_BATCH_OPERATIONS) {
			return { success: false, error: `operations cannot contain more than ${MAX_BATCH_OPERATIONS} items.` };
		}
		for (const op of operations) {
			const content = op.content ?? "";
			if ((op.action === "add" || op.action === "replace") && content) {
				const contentError = validateEntryContent(content);
				if (contentError) return { success: false, error: contentError };
			}
		}

		if (!(await this.reloadTarget(target))) return this.unreadableAbort(target);

		let working = [...this.entries.get(target)!];
		const writtenEntries = new Set<string>();
		const fail = (message: string): Result =>
			this.consolidationFailure(`${message} No operations were applied (batch is all-or-nothing).`, target);

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i] ?? {};
			const action = op.action;
			const content = normalizeEntry(op.content ?? "");
			const oldText = normalizeEntry(op.old_text ?? "");
			const pos = `Operation ${i + 1} (${action ?? "unknown"})`;

			if (action === "add") {
				if (!content) return fail(`${pos}: content is required.`);
				writtenEntries.add(content);
				if (working.includes(content)) continue; // idempotent duplicate
				working.push(content);
			} else if (action === "replace") {
				if (!oldText) return fail(`${pos}: old_text is required.`);
				if (!content) return fail(`${pos}: content is required (use action='remove' to delete).`);
				const resolved = MemoryStore.resolveMatch(working, oldText);
				if (resolved[0] === "missing") return fail(`${pos}: no entry matched '${oldText}'.`);
				if (resolved[0] === "ambiguous") return fail(`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`);
				working[resolved[0]] = content;
				writtenEntries.add(content);
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
				target,
				`${current.toLocaleString()}/${this.limit(target).toLocaleString()}`,
			);
		}

		this.entries.set(target, working);
		await this.persist(target);
		return this.successResponse(target, `Applied ${operations.length} operation(s).`, [...writtenEntries].filter((entry) => working.includes(entry)));
	}
}
