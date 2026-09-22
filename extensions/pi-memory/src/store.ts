import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ENTRY_DELIMITER: string = "\n§\n";
const RESERVED_FRAME_LINE = /^\s*(?:═{3,}|MEMORY \(your personal notes|USER PROFILE \(who the user is)/;

export function isReservedFrameLine(line: string): boolean {
	return RESERVED_FRAME_LINE.test(line);
}

export type Target = "memory" | "user";

export interface StoreConfig {
	directory: string;
	target: Target;
	limit: number;
	/** Called before every rewrite of an existing file; store copies the old file there. */
	backupPath?: string;
	/** Test seam: rename implementation. Defaults to fs.rename. */
	renameFn?: (from: string, to: string) => Promise<void>;
	/** Test seam: stat implementation for persistence-time checks. Defaults to fs.stat. */
	statFn?: (path: string) => Promise<import("node:fs").Stats>;
}

export type LoadResult =
	| { entries: string[]; state: "ok"; raw: string }
	| { entries: []; state: "absent"; raw: "" }
	| { entries: []; state: "unreadable"; conflictWarning: string }
	| { entries: []; state: "oversized"; conflictWarning: string };

/** An operation after the memory tool has validated its structure and content. */
export type MemoryOperation =
	| { action: "add"; content: string }
	| { action: "replace"; old_text: string; content: string }
	| { action: "remove"; old_text: string };

/** Refuse to inject snapshots or accept serialized mutations above this size. */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_BATCH_OPERATIONS = 100;

export type FileState =
	| { kind: "ok"; raw: string }
	| { kind: "absent" }
	| { kind: "unreadable"; confirmedPresent: boolean; reason?: string }
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
const MAX_PREVIEW_CHARS = 1500;

function isEnoent(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function previews(entries: string[]): string[] {
	let chars = 0;
	const shown: string[] = [];
	for (const entry of entries) {
		if (chars + PREVIEW_WIDTH > MAX_PREVIEW_CHARS) break;
		shown.push(entry.length > PREVIEW_WIDTH ? `${entry.slice(0, PREVIEW_WIDTH)}...` : entry);
		chars += PREVIEW_WIDTH;
	}
	return shown;
}

export function usage(current: number, limit: number): string {
	const pct = Math.min(100, Math.floor((current / limit) * 100));
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

function parseEntries(raw: string): string[] {
	const text = normalizeEntry(raw);
	if (!text) return [];
	// Deduplicate, preserving order and first occurrence.
	return [...new Set(text.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean))];
}

export class MemoryStore {
	readonly path: string;
	private readonly directory: string;
	private readonly limit: number;
	private readonly backupPath?: string;
	private readonly renameFn: NonNullable<StoreConfig["renameFn"]>;
	private readonly statFn: NonNullable<StoreConfig["statFn"]>;
	private entries: string[] = [];
	private consolidationFailures = 0;
	// The file was observed on disk this session — used to detect unexpected
	// mid-session disappearance before a mutation rewrites from an empty view.
	private observedExisting = false;
	// Metadata and content digest of the last successfully loaded file.
	private loadedFingerprint?: { mtimeMs: number; size: number; digest: string };

	constructor(config: StoreConfig) {
		this.directory = config.directory;
		this.path = join(config.directory, config.target === "user" ? "USER.md" : "MEMORY.md");
		this.limit = config.limit;
		this.backupPath = config.backupPath;
		this.renameFn = config.renameFn ?? rename;
		this.statFn = config.statFn ?? stat;
	}

	private charCount(): number {
		return this.entries.length ? this.entries.join(ENTRY_DELIMITER).length : 0;
	}

	private currentUsage(): string {
		return usage(this.charCount(), this.limit);
	}

	private successResponse(message?: string, writtenEntries: string[] = []): Result {
		this.resetOnSuccess();
		return {
			success: true,
			message,
			usage: this.currentUsage(),
			entryCount: this.entries.length,
			writtenEntries,
		};
	}

	private consolidationFailure(error: string, resultUsage?: string): Result {
		return {
			success: false,
			error,
			currentEntries: previews(this.entries),
			usage: resultUsage ?? this.currentUsage(),
		};
	}

	/**
	 * Track consecutive consolidation failures. After 3, the model is told to
	 * stop retrying ({ done: true }); a successful write resets the count.
	 */
	incrementFailure(): { done: boolean } {
		this.consolidationFailures += 1;
		return { done: this.consolidationFailures >= 3 };
	}

	resetOnSuccess(): void {
		this.consolidationFailures = 0;
	}

	async load(): Promise<LoadResult> {
		const file = await this.readFileState();
		if (file.kind === "unreadable") {
			return {
				entries: [],
				state: "unreadable",
				conflictWarning: file.reason ?? (file.confirmedPresent
					? `${this.path} exists but could not be read; refusing to serve a possibly-wrong view.`
					: `${this.path} could not be read and its presence could not be confirmed; refusing to serve a possibly-wrong view.`),
			};
		}
		if (file.kind === "oversized") {
			return {
				entries: [],
				state: "oversized",
				conflictWarning: `${this.path} is ${file.bytes.toLocaleString()} bytes, over the ${MAX_FILE_BYTES.toLocaleString()}-byte injection limit; refusing to serve it. Consolidate the file manually.`,
			};
		}
		if (file.kind === "absent" && this.observedExisting) {
			return {
				entries: [],
				state: "unreadable",
				conflictWarning: `${this.path} existed earlier this session but has disappeared; refusing to serve an empty view. Restore it and retry.`,
			};
		}
		if (file.kind === "ok") return { entries: parseEntries(file.raw), state: "ok", raw: file.raw };
		return { entries: [], state: "absent", raw: "" };
	}

	private async digestFile(): Promise<string> {
		const handle = await open(this.path, "r");
		try {
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let total = 0;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) return hash.digest("base64url");
				total += bytesRead;
				if (total > MAX_FILE_BYTES) throw new Error(`${this.path} grew over the ${MAX_FILE_BYTES.toLocaleString()}-byte limit during mutation.`);
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
	private async readFileState(): Promise<FileState> {
		// Bounded, EOF-complete read: at most MAX_FILE_BYTES + 1 bytes leave the
		// filesystem (so a huge synced file can't exhaust memory), and we keep
		// reading until EOF so a short read from a network/synced filesystem can
		// never be mistaken for the whole file.
		let handle: import("node:fs/promises").FileHandle | undefined;
		let confirmedPresent = false;
		try {
			// Symlinked store files are rejected before anything follows the link:
			// tmp+rename would replace the link itself and silently disconnect
			// writes from the intended synced target.
			let ls: import("node:fs").Stats | undefined;
			try {
				ls = await lstat(this.path);
			} catch (error) {
				if (!isEnoent(error)) return { kind: "unreadable", confirmedPresent: false };
			}
			if (ls) {
				confirmedPresent = true;
				this.observedExisting = true;
			}
			if (ls?.isSymbolicLink()) {
				return {
					kind: "unreadable",
					confirmedPresent: true,
					reason: `${this.path} is a symlink; symlinked store files are not supported because atomic rewrites replace the link. Point the memory directory at real files.`,
				};
			}
			handle = await open(this.path, "r");
			confirmedPresent = true;
			this.observedExisting = true;
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
				const st = await this.statFn(this.path);
				this.loadedFingerprint = {
					mtimeMs: st.mtimeMs,
					size: st.size,
					digest: createHash("sha256").update(buffer.subarray(0, total)).digest("base64url"),
				};
			} catch {
				this.loadedFingerprint = undefined;
			}
			return { kind: "ok", raw };
		} catch (error) {
			if (isEnoent(error)) {
				// ENOENT on the FILE is "absent" only if the configured directory
				// itself still exists — a vanished synced/mounted directory must not
				// be mistaken for an empty store and rewritten divergently.
				try {
					await stat(this.directory);
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

	/** Re-read from disk, returning the exact write-blocking failure directly. */
	private async reload(): Promise<Result | undefined> {
		const loaded = await this.load();
		if (loaded.state === "unreadable" || loaded.state === "oversized") {
			return { success: false, error: loaded.conflictWarning };
		}
		if (loaded.state === "ok" && !this.loadedFingerprint) {
			return {
				success: false,
				error: `${this.path} was read but could not be fingerprinted; refusing to write without change detection. Fix the file and retry — nothing was changed.`,
			};
		}
		this.entries = loaded.entries;
	}

	private async persist(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		if (this.backupPath) {
			// Recreate the backup parent so a cleaned-up backup directory can't be
			// misread as "source absent" and silently skip the promised backup.
			await mkdir(dirname(this.backupPath), { recursive: true });
			try {
				await copyFile(this.path, this.backupPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				// Backup dir now exists, so ENOENT means the SOURCE vanished after
				// reload saw it — same divergence hazard as mid-session disappearance;
				// never proceed from the stale view.
				if (this.observedExisting) {
					throw new Error(`${this.path} vanished before its backup could be written; aborting to avoid a divergent store.`);
				}
			}
		}
		const content = this.entries.join(ENTRY_DELIMITER);
		const tmp = join(dirname(this.path), `.mem_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		try {
			// Preserve restrictive modes/ACLs across inode replacement: default
			// umask would otherwise turn a 0600 USER.md into 0644.
			let mode: number | undefined;
			try {
				mode = (await stat(this.path)).mode & 0o777;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await writeFile(tmp, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			// A creation-assumed write (reload saw the file absent) must not clobber
			// a file that appeared meanwhile (sync race): re-check just before the
			// rename, as close to it as possible.
			if (!this.observedExisting) {
				try {
					await this.statFn(this.path);
					throw new Error(`${this.path} appeared during this mutation (likely sync); retry to merge its content.`);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			// An existing store must not be replaced if the on-disk version changed
			// since reload (external sync landed V2 after we read V1): compare
			// fingerprint immediately before the rename.
			if (this.observedExisting && this.loadedFingerprint) {
				try {
					const current = await this.statFn(this.path);
					if (current.mtimeMs !== this.loadedFingerprint.mtimeMs || current.size !== this.loadedFingerprint.size
						|| await this.digestFile() !== this.loadedFingerprint.digest) {
						throw new Error(`${this.path} changed during this mutation (likely sync); retry to merge its content.`);
					}
				} catch (error) {
					if (isEnoent(error)) {
						throw new Error(`${this.path} disappeared during this mutation; retry after restoring it.`);
					}
					throw error;
				}
			}
			try {
				await this.renameFn(tmp, this.path);
			} catch (error) {
				if (isEnoent(error)) throw new Error(`${this.path} disappeared during this mutation; retry after restoring it.`);
				throw error;
			}
			// The store now exists on disk; a later mid-session disappearance is
			// unexpected and must abort, not rewrite from the in-memory view.
			this.observedExisting = true;
		} finally {
			await rm(tmp, { force: true }).catch(() => {});
		}
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
			return ["ambiguous", matches.map((i) => entries[i]!)];
		}
		return [matches[0]!];
	}

	async apply(operation: MemoryOperation): Promise<Result> {
		const failure = await this.reload();
		if (failure) return failure;
		const entries = this.entries;

		if (operation.action === "add") {
			const text = normalizeEntry(operation.content);
			if (entries.includes(text)) {
				return this.successResponse("Entry already exists (no duplicate added).", [text]);
			}

			const newTotal = [...entries, text].join(ENTRY_DELIMITER).length;
			if (newTotal > this.limit) {
				return this.consolidationFailure(
					`Memory at ${this.charCount().toLocaleString()}/${this.limit.toLocaleString()} chars. `
						+ `Adding this entry (${text.length} chars) would exceed the limit. Consolidate now: use 'replace' to merge `
						+ `overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), `
						+ `then retry this add — all in this turn.`,
				);
			}

			entries.push(text);
			await this.persist();
			return this.successResponse("Entry added.", [text]);
		}

		const oldText = normalizeEntry(operation.old_text);
		const resolved = MemoryStore.resolveMatch(entries, oldText);
		if (resolved[0] === "missing") {
			return this.consolidationFailure(
				`No entry matched '${oldText}'. Check current_entries below and retry with the exact text of the entry you want to ${operation.action}.`,
			);
		}
		if (resolved[0] === "ambiguous") return MemoryStore.ambiguousError(oldText, resolved[1]);

		if (operation.action === "remove") {
			entries.splice(resolved[0], 1);
			await this.persist();
			return this.successResponse("Entry removed.");
		}

		const text = normalizeEntry(operation.content);
		const testEntries = [...entries];
		testEntries[resolved[0]] = text;
		// A replace can create a duplicate; dedupe order-preserving before budget.
		const deduped = [...new Set(testEntries)];
		const newTotal = deduped.join(ENTRY_DELIMITER).length;
		if (newTotal > this.limit) {
			return this.consolidationFailure(
				`Replacement would put memory at ${newTotal.toLocaleString()}/${this.limit.toLocaleString()} chars. `
					+ `Shorten the new content, or 'remove' other stale or less important entries to make room `
					+ `(see current_entries below), then retry — all in this turn.`,
			);
		}

		this.entries = deduped;
		await this.persist();
		return this.successResponse("Entry replaced.", [text]);
	}

	/**
	 * Apply validated add/replace/remove operations atomically against the FINAL
	 * budget: intermediate overflow is fine, only the end state is checked.
	 */
	async applyBatch(operations: [MemoryOperation, ...MemoryOperation[]]): Promise<Result> {
		const failure = await this.reload();
		if (failure) return failure;

		let working = [...this.entries];
		const writtenEntries = new Set<string>();
		const fail = (message: string): Result =>
			this.consolidationFailure(`${message} No operations were applied (batch is all-or-nothing).`);

		for (let i = 0; i < operations.length; i++) {
			const operation = operations[i]!;
			const pos = `Operation ${i + 1} (${operation.action})`;

			if (operation.action === "add") {
				const content = normalizeEntry(operation.content);
				writtenEntries.add(content);
				if (working.includes(content)) continue; // idempotent duplicate
				working.push(content);
				continue;
			}

			const oldText = normalizeEntry(operation.old_text);
			const resolved = MemoryStore.resolveMatch(working, oldText);
			if (resolved[0] === "missing") return fail(`${pos}: no entry matched '${oldText}'.`);
			if (resolved[0] === "ambiguous") return fail(`${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`);

			if (operation.action === "remove") {
				working.splice(resolved[0], 1);
				continue;
			}

			const content = normalizeEntry(operation.content);
			working[resolved[0]] = content;
			writtenEntries.add(content);
			// A replace can create a duplicate; dedupe order-preserving before later ops/budget.
			working = [...new Set(working)];
		}

		const newTotal = working.length ? working.join(ENTRY_DELIMITER).length : 0;
		if (newTotal > this.limit) {
			const current = this.charCount();
			return this.consolidationFailure(
				`After applying all ${operations.length} operations, memory would be at ${newTotal.toLocaleString()}/`
					+ `${this.limit.toLocaleString()} chars -- over the limit. Remove or shorten more entries in the same batch `
					+ `(see current_entries below), then retry.`,
				`${current.toLocaleString()}/${this.limit.toLocaleString()}`,
			);
		}

		this.entries = working;
		await this.persist();
		return this.successResponse(`Applied ${operations.length} operation(s).`, [...writtenEntries].filter((entry) => working.includes(entry)));
	}
}
