import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const MAX_NOTES = 4;
const WIDGET_KEY = "pi-notes";

const notesPath = () => join(getAgentDir(), "config", "pi-notes.json");

/** Notes file is untrusted user data. Valid JSON parses to notes; anything else throws so callers can preserve the file. */
export function parseNotes(raw: string): string[] {
	const data: unknown = JSON.parse(raw);
	if (
		!Array.isArray(data)
		|| data.length > MAX_NOTES
		|| !data.every((note): note is string => typeof note === "string" && note.trim().length > 0)
	) {
		throw new TypeError(`notes config must be a JSON array of at most ${MAX_NOTES} non-empty strings`);
	}
	return data.map((note) => note.replace(/\s+/g, " ").trim());
}

let invalidConfig = false;

function loadNotes(): string[] {
	invalidConfig = false;
	try {
		return parseNotes(readFileSync(notesPath(), "utf8"));
	} catch (error) {
		// Missing file is fine; malformed content must not be silently overwritten.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalidConfig = true;
		return [];
	}
}

export function renderNotes(notes: string[]): string[] {
	return notes.length ? notes.map((note, i) => `${i + 1}. ${note}`) : ["no notes"];
}

async function persist(notes: string[]): Promise<void> {
	const path = notesPath();
	const temp = `${path}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(temp, `${JSON.stringify(notes, null, "\t")}\n`);
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true }).catch(() => {});
	}
}

export default function notesExtension(pi: ExtensionAPI): void {
	const show = (ctx: ExtensionContext) => ctx.ui.setWidget(WIDGET_KEY, renderNotes(loadNotes()));

	const MALFORMED = `pi-notes.json is malformed; fix or delete it, or run /note-clear to reset.`;

	pi.on("session_start", (_event, ctx) => show(ctx));

	pi.registerCommand("note", {
		description: `Add a note to the widget (max ${MAX_NOTES})`,
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(`Usage: /note <text> — /note-rm picks one to remove, /note-clear removes all`, "warning");
				return;
			}
			const notes = loadNotes();
			if (invalidConfig) {
				ctx.ui.notify(MALFORMED, "error");
				return;
			}
			if (notes.length >= MAX_NOTES) {
				ctx.ui.notify(`Widget full (${MAX_NOTES} notes). Remove one with /note-rm <n>.`, "warning");
				return;
			}
			notes.push(text);
			await persist(notes);
			show(ctx);
		},
	});

	pi.registerCommand("note-rm", {
		description: "Pick a note to remove",
		handler: async (_args, ctx) => {
			const notes = loadNotes();
			if (invalidConfig) {
				ctx.ui.notify(MALFORMED, "error");
				return;
			}
			if (!notes.length) {
				ctx.ui.notify("No notes to remove.", "info");
				return;
			}
			const choice = await ctx.ui.select("Remove note:", renderNotes(notes));
			if (!choice) return;
			// Re-read after the dialog: another Pi session may have written meanwhile.
			// ponytail: narrows the race to milliseconds; lockfile only if multi-session edit conflicts ever surface.
			const current = loadNotes();
			if (invalidConfig) {
				ctx.ui.notify(MALFORMED, "error");
				return;
			}
			const index = Number.parseInt(/^(\d+)\./.exec(choice)?.[1] ?? "", 10) - 1;
			if (!isDeepStrictEqual(current, notes) || !Number.isInteger(index) || index < 0 || index >= current.length) {
				ctx.ui.notify("Notes changed elsewhere; try /note-rm again.", "warning");
				return;
			}
			current.splice(index, 1);
			await persist(current);
			show(ctx);
		},
	});

	pi.registerCommand("note-clear", {
		description: "Clear all notes (also resets a malformed pi-notes.json)",
		handler: async (_args, ctx) => {
			await persist([]);
			show(ctx);
		},
	});
}
