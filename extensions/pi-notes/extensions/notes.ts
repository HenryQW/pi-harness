import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extensionConfigDir, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
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

const configDir = () => extensionConfigDir("pi-notes");
const notesPath = (worktree: string) => join(configDir(), `${createHash("sha256").update(worktree).digest("hex")}.json`);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const isSafeNote = (note: unknown): note is string =>
	typeof note === "string" && note.trim().length > 0 && !CONTROL_CHARACTERS.test(note);

async function worktreeGeneration(gitDir: string): Promise<string> {
	const metadata = await stat(gitDir, { bigint: true });
	return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
}

/** Notes files are untrusted user data. Invalid records throw so callers preserve them. */
export function parseNotes(raw: string): NotesRecord {
	const data: unknown = JSON.parse(raw);
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
	return { ...input, notes: input.notes.map((note) => note.replace(/\s+/g, " ").trim()) } as NotesRecord;
}

function renderNotes(notes: string[]): string[] {
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

async function loadNotes(identity: WorktreeIdentity): Promise<{ notes: string[]; message?: string }> {
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
		return { notes: [], message: "Worktree notes file is malformed; fix it or run /note-clear to reset." };
	}
	const { notes, ...recordIdentity } = record;
	return isDeepStrictEqual(recordIdentity, identity)
		? { notes }
		: { notes: [], message: "Worktree notes belong to an old worktree; run /note-clear to reset." };
}

async function persist(identity: WorktreeIdentity, notes: string[]): Promise<void> {
	await writePrivateTextFileAtomically(notesPath(identity.worktree), `${JSON.stringify({ ...identity, notes }, null, "\t")}\n`);
}

function noteTarget(args: string, cwd: string, withText: boolean): { cwd: string; text: string; explicit: boolean } {
	const input = args.trim();
	if (!/^--project(?:\s|$)/.test(input)) {
		if (!withText && input) throw new Error("Unexpected note command arguments.");
		return { cwd, text: input, explicit: false };
	}
	const match = withText ? /^--project\s+(.+?)\s+--\s+([\s\S]+)$/.exec(input) : /^--project\s+(.+)$/.exec(input);
	if (!match || !match[1]!.trim()) throw new Error("A project path is required.");
	return { cwd: resolve(cwd, match[1]!.trim()), text: match[2] ?? "", explicit: true };
}

async function showNotes(pi: ExtensionAPI, ctx: ExtensionContext, identity: WorktreeIdentity, notes: string[], explicit: boolean): Promise<void> {
	if (!explicit) setNotesWidget(ctx, notes);
	else {
		await refresh(pi, ctx);
		ctx.ui.notify(`Notes for ${identity.worktree}:\n${renderNotes(notes).join("\n") || "No notes."}`, "info");
	}
}

async function readCurrent(pi: ExtensionAPI, ctx: ExtensionContext, cwd = ctx.cwd): Promise<{ identity: WorktreeIdentity; notes: string[] } | undefined> {
	try {
		const identity = await resolveWorktree(pi, cwd);
		const { notes, message } = await loadNotes(identity);
		if (message) {
			ctx.ui.notify(cwd === ctx.cwd ? message : message.replace("/note-clear", `/note-clear --project ${identity.worktree}`), "error");
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
		const { notes, message } = await loadNotes(await resolveWorktree(pi, ctx.cwd));
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
			const { notes, ...identity } = record;
			stale = !isDeepStrictEqual(current, identity);
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
			let target: ReturnType<typeof noteTarget>;
			try { target = noteTarget(args, ctx.cwd, true); }
			catch {
				ctx.ui.notify("Usage: /note <text> or /note --project <path> -- <text>", "warning");
				return;
			}
			const text = target.text.replace(/\s+/g, " ").trim();
			if (!text) {
				ctx.ui.notify("Usage: /note <text> or /note --project <path> -- <text>", "warning");
				return;
			}
			if (!isSafeNote(text)) {
				ctx.ui.notify("Notes cannot contain terminal control characters.", "warning");
				return;
			}
			const current = await readCurrent(pi, ctx, target.cwd);
			if (!current) return;
			if (current.notes.length >= MAX_NOTES) {
				ctx.ui.notify(`Widget full (${MAX_NOTES} notes). Remove one with /note-rm${target.explicit ? ` --project ${current.identity.worktree}` : ""}.`, "warning");
				return;
			}
			current.notes.push(text);
			await persist(current.identity, current.notes);
			await showNotes(pi, ctx, current.identity, current.notes, target.explicit);
			await pruneStaleNotes(pi, ctx);
		},
	});

	pi.registerCommand("note-rm", {
		description: "Remove a note from this Git worktree",
		handler: async (args, ctx) => {
			let target: ReturnType<typeof noteTarget>;
			try { target = noteTarget(args, ctx.cwd, false); }
			catch {
				ctx.ui.notify("Usage: /note-rm [--project <path>]", "warning");
				return;
			}
			const snapshot = await readCurrent(pi, ctx, target.cwd);
			if (!snapshot) return;
			if (!snapshot.notes.length) {
				ctx.ui.notify("No notes to remove.", "info");
				return;
			}
			const options = renderNotes(snapshot.notes);
			const choice = await ctx.ui.select(`Remove note from ${snapshot.identity.worktree}:`, options);
			if (!choice) return;
			const current = await readCurrent(pi, ctx, target.cwd);
			if (!current) return;
			const index = options.indexOf(choice);
			if (!isDeepStrictEqual(current, snapshot)) {
				ctx.ui.notify(`Notes changed elsewhere; try /note-rm${target.explicit ? ` --project ${snapshot.identity.worktree}` : ""} again.`, "warning");
				return;
			}
			current.notes.splice(index, 1);
			await persist(current.identity, current.notes);
			await showNotes(pi, ctx, current.identity, current.notes, target.explicit);
			await pruneStaleNotes(pi, ctx);
		},
	});

	pi.registerCommand("note-clear", {
		description: "Clear notes for this Git worktree",
		handler: async (args, ctx) => {
			let target: ReturnType<typeof noteTarget>;
			try { target = noteTarget(args, ctx.cwd, false); }
			catch {
				ctx.ui.notify("Usage: /note-clear [--project <path>]", "warning");
				return;
			}
			try {
				const identity = await resolveWorktree(pi, target.cwd);
				await rm(notesPath(identity.worktree), { force: true });
				await showNotes(pi, ctx, identity, [], target.explicit);
				await pruneStaleNotes(pi, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
