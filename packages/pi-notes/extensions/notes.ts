import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const MAX_NOTES = 4;
const WIDGET_KEY = "pi-notes";

const notesPath = () => join(getAgentDir(), "config", "pi-notes.json");

/** Notes file is untrusted user data: validate on read, never rewrite on load. */
export function parseNotes(raw: string): string[] {
	try {
		const data: unknown = JSON.parse(raw);
		if (!Array.isArray(data)) return [];
		return data
			.filter((note): note is string => typeof note === "string")
			.map((note) => note.replace(/\s+/g, " ").trim())
			.filter(Boolean)
			.slice(0, MAX_NOTES);
	} catch {
		return [];
	}
}

function loadNotes(): string[] {
	try {
		return parseNotes(readFileSync(notesPath(), "utf8"));
	} catch {
		return [];
	}
}

export function renderNotes(notes: string[]): string[] {
	return notes.length ? notes.map((note, i) => `${i + 1}. ${note}`) : ["no notes"];
}

async function persist(notes: string[]): Promise<void> {
	const path = notesPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(notes, null, "\t")}\n`);
}

export default function notesExtension(pi: ExtensionAPI): void {
	const show = (ctx: ExtensionContext) => ctx.ui.setWidget(WIDGET_KEY, renderNotes(loadNotes()));

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
			if (!notes.length) {
				ctx.ui.notify("No notes to remove.", "info");
				return;
			}
			const choice = await ctx.ui.select("Remove note:", renderNotes(notes));
			if (!choice) return;
			notes.splice(notes.indexOf(choice.slice(3)), 1);
			await persist(notes);
			show(ctx);
		},
	});

	pi.registerCommand("note-clear", {
		description: "Clear all notes",
		handler: async (_args, ctx) => {
			await persist([]);
			show(ctx);
		},
	});
}
