import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const MAX_NOTES = 4;
const WIDGET_KEY = "pi-notes";

interface WorktreeIdentity {
	repository: string;
	worktree: string;
	gitDir: string;
	generation: string;
}

interface NotesRecord extends WorktreeIdentity {
	notes: string[];
}

interface LoadedNotes {
	notes: string[];
	issue?: "malformed" | "stale";
}

const configDir = () => join(getAgentDir(), "config", "pi-notes");
const notesPath = (worktree: string) => join(configDir(), `${createHash("sha256").update(worktree).digest("hex")}.json`);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const isSafeNote = (note: unknown): note is string =>
	typeof note === "string" && note.trim().length > 0 && !CONTROL_CHARACTERS.test(note);

const recordIdentity = ({ repository, worktree, gitDir, generation }: NotesRecord): WorktreeIdentity =>
	({ repository, worktree, gitDir, generation });

async function worktreeGeneration(gitDir: string): Promise<string> {
	const metadata = await stat(gitDir, { bigint: true });
	return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
}

/** Notes files are untrusted user data. Invalid records throw so callers preserve them. */
export function parseNotes(raw: string): NotesRecord {
	const data: unknown = JSON.parse(raw);
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("notes config must be an object");
	const input = data as Record<string, unknown>;
	if (Object.keys(input).sort().join(",") !== "generation,gitDir,notes,repository,worktree"
		|| typeof input.repository !== "string" || !isAbsolute(input.repository)
		|| typeof input.worktree !== "string" || !isAbsolute(input.worktree)
		|| typeof input.gitDir !== "string" || !isAbsolute(input.gitDir)
		|| typeof input.generation !== "string" || !/^\d+:\d+:\d+$/.test(input.generation)
		|| !Array.isArray(input.notes)
		|| input.notes.length > MAX_NOTES
		|| !input.notes.every(isSafeNote)) {
		throw new TypeError(`notes config must identify one worktree and contain at most ${MAX_NOTES} safe non-empty strings`);
	}
	return {
		repository: input.repository,
		worktree: input.worktree,
		gitDir: input.gitDir,
		generation: input.generation,
		notes: input.notes.map((note) => note.replace(/\s+/g, " ").trim()),
	};
}

export function renderNotes(notes: string[]): string[] {
	return notes.map((note, i) => `${i + 1}. ${note}`);
}

export function renderNotesWidget(notes: string[], width: number): string[] {
	const renderWidth = Math.max(1, width);
	return renderNotes(notes).flatMap((note) => {
		const lines = wrapTextWithAnsi(note, renderWidth);
		return lines.length > 2
			? [lines[0]!, truncateToWidth(`${lines[1]}…`, renderWidth, "…")]
			: lines;
	});
}

function setNotesWidget(ctx: ExtensionContext, notes: string[]): void {
	if (!notes.length) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.setWidget(WIDGET_KEY, renderNotes(notes));
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, () => ({
		invalidate() {},
		render: (width) => renderNotesWidget(notes, width),
	}));
}

async function resolveWorktree(pi: ExtensionAPI, cwd: string): Promise<WorktreeIdentity> {
	const result = await pi.exec(
		"git",
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"],
		{ cwd },
	);
	if (result.code !== 0 || result.killed) throw new Error("pi-notes requires a Git worktree");
	const [worktree, repository, gitDir, ...extra] = result.stdout.trim().split(/\r?\n/);
	if (!worktree || !repository || !gitDir || extra.length) throw new Error("git returned an invalid worktree identity");
	const [canonicalWorktree, canonicalRepository, canonicalGitDir] = await Promise.all([
		realpath(worktree),
		realpath(repository),
		realpath(gitDir),
	]);
	return {
		worktree: canonicalWorktree,
		repository: canonicalRepository,
		gitDir: canonicalGitDir,
		generation: await worktreeGeneration(canonicalGitDir),
	};
}

async function loadNotes(identity: WorktreeIdentity): Promise<LoadedNotes> {
	let raw: string;
	try {
		raw = await readFile(notesPath(identity.worktree), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: [] };
		throw error;
	}
	let record: NotesRecord;
	try {
		record = parseNotes(raw);
	} catch {
		return { notes: [], issue: "malformed" };
	}
	return isDeepStrictEqual(recordIdentity(record), identity)
		? { notes: record.notes }
		: { notes: [], issue: "stale" };
}

async function persist(identity: WorktreeIdentity, notes: string[]): Promise<void> {
	const path = notesPath(identity.worktree);
	const temp = `${path}.${randomUUID()}.tmp`;
	await mkdir(configDir(), { recursive: true });
	try {
		await writeFile(temp, `${JSON.stringify({ ...identity, notes }, null, "\t")}\n`, { mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true }).catch(() => {});
	}
}

function issueMessage(issue: LoadedNotes["issue"]): string | undefined {
	if (issue === "malformed") return "Worktree notes file is malformed; fix it or run /note-clear to reset.";
	if (issue === "stale") return "Worktree notes belong to an old worktree; run /note-prune or /note-clear.";
	return undefined;
}

async function loadCurrent(pi: ExtensionAPI, cwd: string) {
	const identity = await resolveWorktree(pi, cwd);
	const loaded = await loadNotes(identity);
	return { identity, notes: loaded.notes, message: issueMessage(loaded.issue) };
}

async function readCurrent(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ identity: WorktreeIdentity; notes: string[] } | undefined> {
	try {
		const { identity, notes, message } = await loadCurrent(pi, ctx.cwd);
		if (message) {
			ctx.ui.notify(message, "error");
			return undefined;
		}
		return { identity, notes };
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

async function refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const { notes, message } = await loadCurrent(pi, ctx.cwd);
		if (message) ctx.ui.setWidget(WIDGET_KEY, [message]);
		else setNotesWidget(ctx, notes);
	} catch {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

async function pruneStale(pi: ExtensionAPI): Promise<void> {
	let entries;
	try {
		entries = await readdir(configDir(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(configDir(), entry.name);
		let record: NotesRecord;
		try {
			record = parseNotes(await readFile(path, "utf8"));
		} catch {
			continue;
		}
		if (path !== notesPath(record.worktree)) continue;
		let stale = false;
		try {
			const [worktree, repository, gitDir] = await Promise.all([
				realpath(record.worktree),
				realpath(record.repository),
				realpath(record.gitDir),
			]);
			stale = worktree !== record.worktree
				|| repository !== record.repository
				|| gitDir !== record.gitDir
				|| await worktreeGeneration(gitDir) !== record.generation;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") stale = true;
			else continue;
		}
		if (!stale) {
			let current: WorktreeIdentity;
			try {
				current = await resolveWorktree(pi, record.worktree);
			} catch {
				continue;
			}
			stale = !isDeepStrictEqual(current, recordIdentity(record));
		}
		if (stale) await rm(path, { force: true });
	}
}

async function pruneStaleNotes(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		await pruneStale(pi);
	} catch (error) {
		ctx.ui.notify(`Failed to prune stale notes: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function notesExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await pruneStaleNotes(pi, ctx);
		await refresh(pi, ctx);
	});

	pi.registerCommand("note", {
		description: `Add a note to this Git worktree (max ${MAX_NOTES})`,
		handler: async (args, ctx) => {
			const text = args.replace(/\s+/g, " ").trim();
			if (!text) {
				ctx.ui.notify("Usage: /note <text>", "warning");
				return;
			}
			if (!isSafeNote(text)) {
				ctx.ui.notify("Notes cannot contain terminal control characters.", "warning");
				return;
			}
			const current = await readCurrent(pi, ctx);
			if (!current) return;
			if (current.notes.length >= MAX_NOTES) {
				ctx.ui.notify(`Widget full (${MAX_NOTES} notes). Remove one with /note-rm.`, "warning");
				return;
			}
			current.notes.push(text);
			await persist(current.identity, current.notes);
			setNotesWidget(ctx, current.notes);
			await pruneStaleNotes(pi, ctx);
		},
	});

	pi.registerCommand("note-rm", {
		description: "Remove a note from this Git worktree",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /note-rm", "warning");
				return;
			}
			const snapshot = await readCurrent(pi, ctx);
			if (!snapshot) return;
			if (!snapshot.notes.length) {
				ctx.ui.notify("No notes to remove.", "info");
				return;
			}
			const choice = await ctx.ui.select("Remove note:", renderNotes(snapshot.notes));
			if (!choice) return;
			const current = await readCurrent(pi, ctx);
			if (!current) return;
			const index = Number.parseInt(/^(\d+)\./.exec(choice)?.[1] ?? "", 10) - 1;
			if (!isDeepStrictEqual(current, snapshot) || !Number.isInteger(index) || index < 0 || index >= current.notes.length) {
				ctx.ui.notify("Notes changed elsewhere; try /note-rm again.", "warning");
				return;
			}
			current.notes.splice(index, 1);
			await persist(current.identity, current.notes);
			setNotesWidget(ctx, current.notes);
			await pruneStaleNotes(pi, ctx);
		},
	});

	pi.registerCommand("note-clear", {
		description: "Clear notes for this Git worktree",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /note-clear", "warning");
				return;
			}
			try {
				const identity = await resolveWorktree(pi, ctx.cwd);
				await rm(notesPath(identity.worktree), { force: true });
				setNotesWidget(ctx, []);
				await pruneStaleNotes(pi, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
