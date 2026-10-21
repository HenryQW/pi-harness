import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { canonicalWorktree, runChecked, validatePaths } from "./pr-execution.ts";

export type ConflictSide = "@ours" | "@theirs" | "@both" | "@base";
export type ConflictResolution = { block: number; id: string; side: ConflictSide };
export type ConflictBlock = {
	block: number;
	id: string;
	/** 0-based line indexes of the opening and closing markers. */
	start: number;
	end: number;
	oursLabel: string;
	theirsLabel: string;
	ours: string[];
	base?: string[];
	theirs: string[];
};

const SHOW_LIMIT = { maxLines: 300, maxBytes: 16 * 1024 };
const MAX_LIST_FILES = 100;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Keep a BOM, and refuse bytes that a lossy decode would rewrite.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Match a marker of exactly `width` characters, alone or followed by a space and label. */
function marker(line: string, char: string, width: number): string | undefined {
	if (!line.startsWith(char.repeat(width)) || (line.length > width && line[width] !== " ")) return undefined;
	return line.slice(width + 1);
}

/** A conflict this tool cannot address by block; the caller must resolve the whole file. */
export class WholeFileConflict extends Error {}

/**
 * Parse complete Git conflict blocks with markers of exactly `width` characters (Git's
 * `conflict-marker-size`, default 7); other widths stay content. Side lines keep any trailing `\r`
 * so a splice preserves CRLF files. The id covers the start line and the exact block text, so an
 * edited or shifted block gets a new id. A marker out of sequence, a closing marker outside a
 * block, or an unclosed block makes block extents uncertain, so the whole file is refused.
 */
export function parseConflicts(lines: readonly string[], path: string, width = 7): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let open: Omit<ConflictBlock, "block" | "id" | "end" | "theirsLabel"> | undefined;
	let phase: "ours" | "base" | "theirs" = "ours";
	const ambiguous = (index: number) => new WholeFileConflict(`${path} has ambiguous conflict markers at line ${index + 1}; resolve it as a whole file`);
	for (const [index, raw] of lines.entries()) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const oursLabel = marker(line, "<", width);
		const theirsLabel = marker(line, ">", width);
		if (!open) {
			if (theirsLabel !== undefined) throw ambiguous(index);
			if (oursLabel === undefined) continue;
			open = { start: index, oursLabel, ours: [], theirs: [] };
			phase = "ours";
			continue;
		}
		if (oursLabel !== undefined) throw ambiguous(index);
		if (marker(line, "|", width) !== undefined) {
			if (phase !== "ours") throw ambiguous(index);
			open.base = [];
			phase = "base";
			continue;
		}
		if (line === "=".repeat(width)) {
			if (phase === "theirs") throw ambiguous(index);
			phase = "theirs";
			continue;
		}
		if (theirsLabel !== undefined) {
			if (phase !== "theirs") throw ambiguous(index);
			const id = createHash("sha256").update(`${open.start}\0${lines.slice(open.start, index + 1).join("\n")}`).digest("hex").slice(0, 12);
			blocks.push({ ...open, block: blocks.length + 1, id, end: index, theirsLabel });
			open = undefined;
			continue;
		}
		(phase === "ours" ? open.ours : phase === "base" ? open.base! : open.theirs).push(raw);
	}
	if (open) throw ambiguous(open.start);
	return blocks;
}

function sideLines(block: ConflictBlock, side: ConflictSide, path: string): string[] {
	switch (side) {
		case "@ours": return block.ours;
		case "@theirs": return block.theirs;
		case "@both": return [...block.ours, ...block.theirs];
		case "@base":
			if (block.base) return block.base;
			throw new Error(`Conflict block ${block.block} in ${path} has no base section. @base needs diff3 or zdiff3 markers (|||||||): set git config merge.conflictStyle to zdiff3 or diff3 before the merge, or recreate this file's markers with git checkout --conflict=zdiff3 -- ${path} (this discards edits to that file).`);
	}
}

/** Apply every resolution to one parse, or throw before any change when a block is stale or invalid. */
export function resolveConflicts(text: string, path: string, resolutions: readonly ConflictResolution[], width = 7): string {
	const lines = text.split("\n");
	const blocks = parseConflicts(lines, path, width);
	if (new Set(resolutions.map(({ block }) => block)).size !== resolutions.length) throw new Error("Each conflict block can be resolved only once per call");
	const planned = resolutions.map(({ block, id, side }) => {
		const current = blocks[block - 1];
		if (current?.id !== id) {
			throw new Error(`Conflict block ${block} in ${path} changed: expected id ${id}, found ${current ? `id ${current.id}` : "no block"}. Run git_conflict list again; nothing was written.`);
		}
		return { block: current, replacement: sideLines(current, side, path) };
	}).sort((left, right) => right.block.start - left.block.start);
	for (const { block, replacement } of planned) lines.splice(block.start, block.end - block.start + 1, ...replacement);
	return lines.join("\n");
}

function summary(block: ConflictBlock) {
	return { block: block.block, id: block.id, lines: `${block.start + 1}-${block.end + 1}`, base: block.base !== undefined, ours: block.ours.length, theirs: block.theirs.length };
}

async function summaries(read: () => Promise<ConflictBlock[]>): Promise<{ blocks: ReturnType<typeof summary>[]; note?: string }> {
	try { return { blocks: (await read()).map(summary) }; }
	catch (error) {
		if (error instanceof WholeFileConflict) return { blocks: [], note: error.message };
		throw error;
	}
}

function withoutCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Stage lines with an index of where each line text occurs. */
type StageText = { lines: string[]; at: Map<string, number[]> };

function stageText(text: string): StageText {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const at = new Map<string, number[]>();
	lines.forEach((line, index) => {
		const list = at.get(line);
		if (list) list.push(index);
		else at.set(line, [index]);
	});
	return { lines, at };
}

/** Return the first line index at or after `from` where `run` starts, or -1. */
function findRun({ lines, at }: StageText, run: readonly string[], from: number): number {
	for (const start of at.get(run[0]!) ?? []) {
		if (start >= from && run.every((line, offset) => lines[start + offset] === line)) return start;
	}
	return -1;
}

function sideText(lines: readonly string[]) {
	const result = truncateHead(lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).join("\n"), SHOW_LIMIT);
	return { text: result.content, truncated: result.truncated };
}

/** `stages` maps each unmerged index stage (1 base, 2 ours, 3 theirs) to its blob id. */
type Unmerged = { root: string; path: string; absolute: string; stages: Map<string, string>; special: boolean; width: number; driver: "text" | "binary" | "custom" };

export class GitConflicts {
	private readonly exec: Exec;
	constructor(exec: Exec = spawnBounded) { this.exec = exec; }

	/**
	 * Read unmerged index stages, then the `merge` and `conflict-marker-size` attributes Git used,
	 * for `only` or for at most MAX_LIST_FILES paths.
	 */
	private async unmerged(cwd: string, only: string | undefined, signal?: AbortSignal): Promise<{ entries: Unmerged[]; total: number }> {
		const root = await canonicalWorktree(cwd, signal, this.exec);
		const options = { cwd: root, signal, stdoutLimitBytes: 4 * 1024 * 1024 };
		const output = (await runChecked(this.exec, "git", ["ls-files", "-u", "-z"], options)).stdout;
		if (output && !output.endsWith("\0")) throw new Error("Unmerged index listing returned malformed records");
		const stages = new Map<string, Map<string, string>>();
		// Paths with a gitlink or symlink stage; their stage ids are not text blobs.
		const special = new Set<string>();
		for (const record of output ? output.slice(0, -1).split("\0") : []) {
			const match = /^(\d{6}) ([0-9a-f]+) ([123])\t([^]+)$/.exec(record);
			if (!match) throw new Error("Unmerged index listing returned a malformed record");
			validatePaths([match[4]!], "Unmerged index listing");
			stages.set(match[4]!, (stages.get(match[4]!) ?? new Map()).set(match[3]!, match[2]!));
			if (match[1] !== "100644" && match[1] !== "100755") special.add(match[4]!);
		}
		if (only !== undefined && !stages.has(only)) throw new Error(`${only} is not an unmerged path; use a path from git_conflict list`);
		const paths = only !== undefined ? [only] : [...stages.keys()].slice(0, MAX_LIST_FILES);
		const attributes = new Map<string, string>();
		if (paths.length) {
			const fields = (await runChecked(this.exec, "git", ["check-attr", "-z", "merge", "conflict-marker-size", "--", ...paths], options)).stdout.split("\0");
			for (let index = 0; index + 2 < fields.length; index += 3) attributes.set(`${fields[index]}\0${fields[index + 1]}`, fields[index + 2]!);
		}
		const entries = paths.map((path) => {
			const size = Number(attributes.get(`${path}\0conflict-marker-size`));
			const merge = attributes.get(`${path}\0merge`);
			const driver = merge === "unset" || merge === "binary" ? "binary" as const
				: ["unspecified", "set", "text", "union"].includes(merge!) ? "text" as const : "custom" as const;
			return { root, path, absolute: join(root, path), stages: stages.get(path)!, special: special.has(path), width: Number.isSafeInteger(size) && size > 0 ? size : 7, driver };
		});
		return { entries, total: stages.size };
	}

	private async target(cwd: string, input: string, signal?: AbortSignal): Promise<Unmerged> {
		const [path] = validatePaths([input], "Conflict path");
		return (await this.unmerged(cwd, path, signal)).entries[0]!;
	}

	/**
	 * Git merges as binary, keeping ours without markers, when any stage is binary. A blob-to-blob
	 * numstat has no path, so attributes do not apply and it reports `-` only for binary content.
	 */
	private async binaryStage({ root, stages }: Unmerged, signal?: AbortSignal): Promise<boolean> {
		for (const [left, right] of [["1", "2"], ["2", "3"]] as const) {
			if (!stages.has(left)) continue;
			const output = (await runChecked(this.exec, "git", ["diff", "--numstat", stages.get(left)!, stages.get(right)!], { cwd: root, signal })).stdout;
			if (output.startsWith("-\t-\t")) return true;
		}
		return false;
	}

	/** Read strict UTF-8 text so a write never rewrites bytes the parse did not see; refuse markerless conflicts. */
	private async text(entry: Unmerged, signal?: AbortSignal): Promise<string> {
		const { path, absolute, stages, special, driver } = entry;
		if (!stages.has("2") || !stages.has("3")) throw new WholeFileConflict(`${path} is deleted or renamed on one side; resolve it as a whole file`);
		if (special) throw new WholeFileConflict(`${path} is a submodule or symlink conflict; resolve it as a whole file`);
		if (driver === "custom") throw new WholeFileConflict(`${path} uses a custom merge driver, so its markers are unknown; resolve it as a whole file`);
		if (driver === "binary" || await this.binaryStage(entry, signal)) throw new WholeFileConflict(`${path} is binary or uses a binary merge driver, so Git kept one side without markers; resolve it as a whole file`);
		const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
		if (!stat) throw new WholeFileConflict(`${path} is missing from the worktree; resolve it as a whole file`);
		if (!stat.isFile()) throw new WholeFileConflict(`${path} is not a regular file; resolve it as a whole file`);
		if (stat.size > MAX_FILE_BYTES) throw new WholeFileConflict(`${path} is larger than 8 MiB; resolve it as a whole file`);
		try { return UTF8.decode(await readFile(absolute)); }
		catch (error) {
			if (error instanceof TypeError) throw new WholeFileConflict(`${path} is not UTF-8 text; resolve it as a whole file`);
			throw error;
		}
	}

	/**
	 * Parse the worktree file and require each block side to be a contiguous run of its index stage
	 * (ours 2, theirs 3, base 1), so a literal marker line inside a side cannot move a block boundary.
	 */
	private async parse(entry: Unmerged, signal?: AbortSignal): Promise<{ text: string; blocks: ConflictBlock[] }> {
		const { root, path, stages, width } = entry;
		const text = await this.text(entry, signal);
		const lines = text.split("\n");
		const blocks = parseConflicts(lines, path, width);
		const plain = lines.map(withoutCr);
		const blobs = new Map<string, StageText>();
		const blob = async (stage: string) => {
			if (!blobs.has(stage)) {
				// spawnBounded rejects stdout over the limit or not valid UTF-8.
				const result = await this.exec("git", ["cat-file", "blob", stages.get(stage)!], { cwd: root, signal, stdoutLimitBytes: MAX_FILE_BYTES })
					.catch(() => { signal?.throwIfAborted(); return undefined; });
				if (!result || result.code !== 0 || result.killed) throw new WholeFileConflict(`${path} has an index stage that is not UTF-8 text of 8 MiB or less; resolve it as a whole file`);
				blobs.set(stage, stageText(result.stdout));
			}
			return blobs.get(stage)!;
		};
		// Sides of successive blocks appear in order in each stage, so one cursor per stage keeps the pass linear.
		const cursors = new Map<string, number>();
		for (const block of blocks) {
			for (const [stage, side] of [["2", block.ours], ["3", block.theirs], ["1", block.base ?? []]] as const) {
				if (!side.length) continue;
				const run = side.map(withoutCr);
				const at = stages.has(stage) ? findRun(await blob(stage), run, cursors.get(stage) ?? 0) : -1;
				if (at < 0) throw new WholeFileConflict(`${path} conflict block ${block.block} does not match the index stages; resolve it as a whole file`);
				cursors.set(stage, at + run.length);
			}
			// Git writes real markers; a marked span already present in a side is inherited file content.
			const span = plain.slice(block.start, block.end + 1);
			for (const stage of ["2", "3"]) {
				if (findRun(await blob(stage), span, 0) >= 0) throw new WholeFileConflict(`${path} conflict block ${block.block} is marker text already in a merge side; resolve it as a whole file`);
			}
		}
		return { text, blocks };
	}

	async list(cwd: string, input?: string, signal?: AbortSignal) {
		const { entries, total } = await this.unmerged(cwd, input === undefined ? undefined : validatePaths([input], "Conflict path")[0], signal);
		const files = [];
		for (const entry of entries) files.push({ path: entry.path, ...await summaries(async () => (await this.parse(entry, signal)).blocks) });
		return input === undefined && total > files.length
			? { files, omitted: total - files.length, note: "Pass path to list blocks of an omitted file; git diff --name-only --diff-filter=U lists every path" }
			: { files };
	}

	async show(cwd: string, input: string, number: number, signal?: AbortSignal) {
		const entry = await this.target(cwd, input, signal);
		const { path } = entry;
		const block = (await this.parse(entry, signal)).blocks[number - 1];
		if (!block) throw new Error(`${path} has no conflict block ${number}; run git_conflict list`);
		const sides = { ours: sideText(block.ours), ...(block.base ? { base: sideText(block.base) } : {}), theirs: sideText(block.theirs) };
		const truncated = Object.values(sides).some((side) => side.truncated);
		return {
			path, ...summary(block), oursLabel: block.oursLabel, theirsLabel: block.theirsLabel,
			...Object.fromEntries(Object.entries(sides).map(([name, side]) => [name, side.text])),
			...(truncated ? { truncated: `Sides were truncated; read lines ${block.start + 1}-${block.end + 1} of ${path} for full text` } : {}),
		};
	}

	async resolve(cwd: string, input: string, resolutions: readonly ConflictResolution[], signal?: AbortSignal) {
		const entry = await this.target(cwd, input, signal);
		const { path, absolute } = entry;
		return await withFileMutationQueue(absolute, async () => {
			const text = resolveConflicts((await this.parse(entry, signal)).text, path, resolutions, entry.width);
			signal?.throwIfAborted();
			await writeFile(absolute, text, "utf8");
			const { blocks, note } = await summaries(async () => parseConflicts(text.split("\n"), path, entry.width));
			return { path, resolved: resolutions.map(({ block }) => block), remaining: blocks, ...(note ? { note } : {}) };
		});
	}
}
