import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { canonicalWorktree, parseNulPaths, runChecked, validatePaths } from "./pr-execution.ts";

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

function marker(line: string, prefix: string): string | undefined {
	if (!line.startsWith(prefix)) return undefined;
	if (line.length === prefix.length) return "";
	return line[prefix.length] === " " ? line.slice(prefix.length + 1) : undefined;
}

/**
 * Parse complete Git conflict blocks. Side lines keep any trailing `\r` so a splice preserves CRLF files.
 * The id covers the start line and the exact block text, so an edited or shifted block gets a new id.
 */
export function parseConflicts(lines: readonly string[]): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let open: Omit<ConflictBlock, "block" | "id" | "end" | "theirsLabel"> | undefined;
	let phase: "ours" | "base" | "theirs" = "ours";
	lines.forEach((raw, index) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const oursLabel = marker(line, "<<<<<<<");
		if (oursLabel !== undefined) {
			open = { start: index, oursLabel, ours: [], theirs: [] };
			phase = "ours";
			return;
		}
		if (!open) return;
		if (marker(line, "|||||||") !== undefined) {
			if (phase === "ours") { open.base = []; phase = "base"; } else open = undefined;
			return;
		}
		if (line === "=======") {
			if (phase === "theirs") open = undefined;
			else phase = "theirs";
			return;
		}
		const theirsLabel = marker(line, ">>>>>>>");
		if (theirsLabel !== undefined) {
			if (phase === "theirs") {
				const id = createHash("sha256").update(`${open.start}\0${lines.slice(open.start, index + 1).join("\n")}`).digest("hex").slice(0, 12);
				blocks.push({ ...open, block: blocks.length + 1, id, end: index, theirsLabel });
			}
			open = undefined;
			return;
		}
		(phase === "ours" ? open.ours : phase === "base" ? open.base! : open.theirs).push(raw);
	});
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
export function resolveConflicts(text: string, path: string, resolutions: readonly ConflictResolution[]): string {
	const lines = text.split("\n");
	const blocks = parseConflicts(lines);
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

function sideText(lines: readonly string[]) {
	const result = truncateHead(lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).join("\n"), SHOW_LIMIT);
	return { text: result.content, truncated: result.truncated };
}

export class GitConflicts {
	private readonly exec: Exec;
	constructor(exec: Exec = spawnBounded) { this.exec = exec; }

	private async unmerged(cwd: string, signal?: AbortSignal): Promise<{ root: string; paths: string[] }> {
		const root = await canonicalWorktree(cwd, signal, this.exec);
		const output = (await runChecked(this.exec, "git", ["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: root, signal })).stdout;
		return { root, paths: [...new Set(parseNulPaths(output, "Unmerged path listing"))] };
	}

	/** Return a regular unmerged file's text; reject paths Git does not report as unmerged. */
	private async target(cwd: string, input: string, signal?: AbortSignal): Promise<{ path: string; absolute: string }> {
		const [path] = validatePaths([input], "Conflict path");
		const { root, paths } = await this.unmerged(cwd, signal);
		if (!paths.includes(path!)) throw new Error(`${path} is not an unmerged path; use a path from git_conflict list`);
		const absolute = join(root, path!);
		if (!(await lstat(absolute)).isFile()) throw new Error(`${path} is not a regular file`);
		return { path: path!, absolute };
	}

	async list(cwd: string, signal?: AbortSignal) {
		const { root, paths } = await this.unmerged(cwd, signal);
		const files = [];
		for (const path of paths) {
			const stat = await lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
			if (!stat?.isFile()) { files.push({ path, blocks: [], note: stat ? "not a regular file" : "missing from the worktree" }); continue; }
			files.push({ path, blocks: parseConflicts((await readFile(join(root, path), "utf8")).split("\n")).map(summary) });
		}
		return { files };
	}

	async show(cwd: string, input: string, number: number, signal?: AbortSignal) {
		const { path, absolute } = await this.target(cwd, input, signal);
		const block = parseConflicts((await readFile(absolute, "utf8")).split("\n"))[number - 1];
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
		const { path, absolute } = await this.target(cwd, input, signal);
		return await withFileMutationQueue(absolute, async () => {
			const text = resolveConflicts(await readFile(absolute, "utf8"), path, resolutions);
			signal?.throwIfAborted();
			await writeFile(absolute, text, "utf8");
			return { path, resolved: resolutions.map(({ block }) => block), remaining: parseConflicts(text.split("\n")).map(summary) };
		});
	}
}
