import { basename, isAbsolute } from "node:path";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildContextInjection,
	collectSkillPaths,
	dirExists,
	findFiles,
	invalidateContextCache,
	resolveDir,
	scanDirContext,
	type AddedDir,
	type DirContext,
} from "./add-dir-helpers.ts";

const STATE_TYPE = "add-dir:state";
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 1_000;

const AddDirectoryParams = Type.Object({
	path: Type.String({ description: "Absolute or relative path to the directory to add", minLength: 1 }),
	reason: Type.Optional(Type.String({ description: "Why this directory is being added (shown to user)" })),
});

const SearchExternalFilesParams = Type.Object({
	pattern: Type.String({
		description: "File name or glob pattern to search for (for example, '*.ts' or 'src/**/*.test.ts')",
		minLength: 1,
	}),
	maxResults: Type.Optional(
		Type.Integer({
			description: `Maximum number of results (default: ${DEFAULT_MAX_RESULTS}, maximum: ${MAX_RESULTS})`,
			minimum: 1,
			maximum: MAX_RESULTS,
		}),
	),
});

interface AddDirectoryDetails {
	directory: string;
	hasAgentsMd: boolean;
	hasClaudeMd: boolean;
	skillCount: number;
	skillNames: string[];
}

interface SearchDetails {
	totalFound: number;
	pattern: string;
	dirCount: number;
}

function isAddedDir(value: unknown): value is AddedDir {
	if (!value || typeof value !== "object") return false;
	const dir = value as Partial<AddedDir>;
	return (
		typeof dir.absolutePath === "string" &&
		isAbsolute(dir.absolutePath) &&
		typeof dir.label === "string" &&
		typeof dir.addedAt === "number" &&
		Number.isFinite(dir.addedAt)
	);
}

function readState(data: unknown): AddedDir[] {
	if (!data || typeof data !== "object") return [];
	const dirs = (data as { dirs?: unknown }).dirs;
	return Array.isArray(dirs) ? dirs.filter(isAddedDir) : [];
}

function cleanPath(input: string): string {
	return input.trim().replace(/^@/, "").trim();
}

function maxResults(value: number | undefined): number {
	const limit = value ?? DEFAULT_MAX_RESULTS;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
		throw new Error(`maxResults must be an integer from 1 to ${MAX_RESULTS}.`);
	}
	return limit;
}

function contextDetails(dirCtx: DirContext, absolutePath: string): AddDirectoryDetails {
	return {
		directory: absolutePath,
		hasAgentsMd: dirCtx.agentsMd !== null,
		hasClaudeMd: dirCtx.claudeMd !== null,
		skillCount: dirCtx.skills.size,
		skillNames: [...dirCtx.skills.keys()],
	};
}

function contextSummary(dirCtx: DirContext): string {
	const found: string[] = [];
	if (dirCtx.agentsMd !== null) found.push("AGENTS.md");
	if (dirCtx.claudeMd !== null) found.push("CLAUDE.md");
	if (dirCtx.skills.size > 0) found.push(`${dirCtx.skills.size} skill(s)`);
	return found.length > 0 ? ` Found: ${found.join(", ")}.` : " No context files found.";
}

export default function addDirExtension(pi: ExtensionAPI): void {
	let addedDirs: AddedDir[] = [];
	let currentCwd = "";

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (addedDirs.length === 0) {
			ctx.ui.setWidget("add-dir", undefined);
			return;
		}

		ctx.ui.setWidget("add-dir", (_tui, theme) => ({
			dispose() {},
			invalidate() {},
			render(width: number): string[] {
				const renderWidth = Math.max(1, width);
				const prefix = theme.fg("accent", "📂");
				const count = theme.fg("muted", ` ${addedDirs.length} external dir${addedDirs.length === 1 ? "" : "s"}`);
				const separator = theme.fg("dim", " | ");
				const suffix = theme.fg("dim", "  (/dir-ls to manage)");
				const labels = addedDirs.map((dir) => theme.fg("text", dir.label)).join(theme.fg("dim", ", "));
				const fullLine = ` ${prefix}${count}${separator}${labels}${suffix}`;

				if (visibleWidth(fullLine) <= renderWidth) return [fullLine];
				const withoutLabels = ` ${prefix}${count}${separator}`;
				const available = renderWidth - visibleWidth(withoutLabels) - visibleWidth(suffix);
				if (available > 5) return [`${withoutLabels}${truncateToWidth(labels, available, "…")}${suffix}`];
				return [truncateToWidth(` ${prefix}${count}`, renderWidth, "…")];
			},
		}));
	}

	function reconstructState(ctx: ExtensionContext): void {
		currentCwd = ctx.cwd;
		const stateEntry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
		addedDirs = stateEntry?.type === "custom" ? readState(stateEntry.data) : [];
		invalidateContextCache();
		updateWidget(ctx);
	}

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, { dirs: addedDirs.map((dir) => ({ ...dir })) });
	}

	function addDir(
		dirPath: string,
		cwd: string,
		ctx: ExtensionContext,
	): { ok: boolean; message: string; hasNewSkills: boolean; absolutePath?: string; context?: DirContext } {
		const input = cleanPath(dirPath);
		if (!input) return { ok: false, message: "Directory path must not be blank.", hasNewSkills: false };

		const absolutePath = resolveDir(input, cwd);
		if (!dirExists(absolutePath)) {
			return { ok: false, message: `Directory does not exist: ${absolutePath}`, hasNewSkills: false };
		}
		if (addedDirs.some((dir) => dir.absolutePath === absolutePath)) {
			return { ok: false, message: `Already added: ${absolutePath}`, hasNewSkills: false };
		}
		if (absolutePath === resolveDir(cwd, cwd)) {
			return {
				ok: false,
				message: "That's the current working directory - already in scope.",
				hasNewSkills: false,
			};
		}

		const context = scanDirContext(absolutePath);
		const label = basename(absolutePath) || absolutePath;
		addedDirs.push({ absolutePath, label, addedAt: Date.now() });
		invalidateContextCache();
		persistState();
		updateWidget(ctx);

		const hasNewSkills = context.skills.size > 0;
		let message = `Added ${label} (${absolutePath}).${contextSummary(context)}`;
		if (hasNewSkills) message += " Reloading to register skills as /skill:name commands...";
		return { ok: true, message, hasNewSkills, absolutePath, context };
	}

	function removeDir(
		absolutePath: string,
		ctx: ExtensionContext,
	): { ok: boolean; message: string; hadSkills: boolean } {
		const index = addedDirs.findIndex((dir) => dir.absolutePath === absolutePath);
		if (index < 0) return { ok: false, message: `Not found: ${absolutePath}`, hadSkills: false };

		const hadSkills = scanDirContext(absolutePath).skills.size > 0;
		const [removed] = addedDirs.splice(index, 1);
		invalidateContextCache();
		persistState();
		updateWidget(ctx);

		let message = `Removed ${removed!.label} (${removed!.absolutePath}).`;
		if (hadSkills) message += " Reloading to unregister skills...";
		return { ok: true, message, hadSkills };
	}

	pi.on("resources_discover", (event) => {
		if (event.cwd !== currentCwd || addedDirs.length === 0) return;
		const skillPaths = collectSkillPaths(addedDirs);
		return skillPaths.length > 0 ? { skillPaths } : undefined;
	});

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.on("before_agent_start", async (event) => {
		if (addedDirs.length === 0) return;
		return { systemPrompt: event.systemPrompt + buildContextInjection(addedDirs) };
	});

	pi.registerCommand("dir-add", {
		description: "Add an external directory to this session",
		handler: async (args, ctx) => {
			let inputPath = args?.trim();
			if (!inputPath) {
				const prompted = await ctx.ui.input("Directory path:", "");
				if (!prompted) return;
				inputPath = prompted;
			}

			const result = addDir(inputPath, ctx.cwd, ctx);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.ok && result.hasNewSkills) await ctx.reload();
		},
	});

	pi.registerCommand("dir-ls", {
		description: "List external directories and select one to remove",
		handler: async (_args, ctx) => {
			if (addedDirs.length === 0) {
				ctx.ui.notify("No external directories added. Use /dir-add <path> to add one.", "info");
				return;
			}

			const choices = addedDirs.map((dir) => `${dir.label} - ${dir.absolutePath}`);
			const selected = await ctx.ui.select("External directories — select one to remove:", choices);
			const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
			const absolutePath = selectedIndex >= 0 ? addedDirs[selectedIndex]?.absolutePath : undefined;
			if (!absolutePath) return;

			const result = removeDir(absolutePath, ctx);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.ok && result.hadSkills) await ctx.reload();
		},
	});

	pi.registerTool({
		name: "add_directory",
		label: "Add Directory",
		description:
			"Add an external directory to this session so its AGENTS.md, CLAUDE.md, and skills are loaded into context. " +
			"Use this when you need to reference or work with code outside the current working directory.",
		promptSnippet: "Add an external directory to this session (loads its AGENTS.md, skills, etc.)",
		promptGuidelines: [
			"Use add_directory when you need context from another project or directory outside cwd.",
			"The directory's AGENTS.md and CLAUDE.md are injected into the system prompt automatically.",
			"After adding, you can read/edit/write files in the external directory using absolute paths.",
		],
		parameters: AddDirectoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputPath = cleanPath(params.path);
			const result = addDir(inputPath, ctx.cwd, ctx);
			if (!result.ok) throw new Error(result.message);

			const absolutePath = result.absolutePath!;
			const context = result.context!;
			const response: string[] = [result.message];
			if (context.agentsMd !== null) response.push("\nAGENTS.md content has been injected into system context.");
			if (context.claudeMd !== null) response.push("CLAUDE.md content has been injected into system context.");
			if (context.skills.size > 0) {
				response.push(`\nDiscovered skills: ${[...context.skills.keys()].join(", ")}`);
				response.push("Run /reload to register skills as /skill:name commands.");
			}
			response.push(`\nYou can now access files at: ${absolutePath}`);

			return {
				content: [{ type: "text", text: response.join("\n") }],
				details: contextDetails(context, absolutePath),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("add_directory "));
			text += theme.fg("accent", cleanPath(args.path));
			if (args.reason) text += theme.fg("dim", ` (${args.reason})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as AddDirectoryDetails | undefined;
			if (!details) {
				const content = result.content[0];
				const text = content?.type === "text" ? content.text : "Done";
				return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
			}

			const parts = [theme.fg("success", `✓ Added ${basename(details.directory)}`)];
			const badges: string[] = [];
			if (details.hasAgentsMd) badges.push(theme.fg("accent", "AGENTS.md"));
			if (details.hasClaudeMd) badges.push(theme.fg("accent", "CLAUDE.md"));
			if (details.skillCount > 0) badges.push(theme.fg("warning", `${details.skillCount} skills`));
			if (badges.length > 0) parts.push(theme.fg("dim", " | ") + badges.join(theme.fg("dim", ", ")));
			if (expanded && details.skillNames.length > 0) {
				parts.push("\n" + theme.fg("muted", "  Skills: ") + details.skillNames.map((name) => theme.fg("text", name)).join(", "));
			}
			return new Text(parts.join(""), 0, 0);
		},
	});

	pi.registerTool({
		name: "search_external_files",
		label: "Search External Files",
		description:
			"Search for files across all external directories added to this session. " +
			"Use this when you need to find files outside the current working directory.",
		promptSnippet: "Search for files across all added external directories by name pattern",
		promptGuidelines: [
			"Use search_external_files when you need to find a file in an external directory but do not know its exact path.",
			"Supports glob-style patterns like '*.ts', '**/*.test.js', and 'src/**/*.rb'.",
			"Returns matching file paths with their parent directory labels.",
		],
		parameters: SearchExternalFilesParams,

		async execute(_toolCallId, params, signal) {
			if (addedDirs.length === 0) {
				throw new Error("No external directories added. Use /dir-add or add_directory first.");
			}

			const pattern = cleanPath(params.pattern);
			const limit = maxResults(params.maxResults);
			const results: Array<{ dir: string; label: string; files: string[] }> = [];
			let totalFound = 0;

			for (const dir of addedDirs) {
				if (signal?.aborted) break;
				if (!dirExists(dir.absolutePath)) continue;
				const remaining = limit - totalFound;
				if (remaining <= 0) break;

				const files = await findFiles(dir.absolutePath, pattern, remaining, signal);
				if (files.length > 0) {
					results.push({ dir: dir.absolutePath, label: dir.label, files });
					totalFound += files.length;
				}
			}

			if (totalFound === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No files matching "${pattern}" found in ${addedDirs.length} external director${addedDirs.length === 1 ? "y" : "ies"}.`,
						},
					],
					details: { totalFound: 0, pattern, dirCount: 0 } satisfies SearchDetails,
				};
			}

			const lines = [`Found ${totalFound} file(s) matching "${pattern}":\n`];
			for (const result of results) {
				lines.push(`📂 ${result.label} (${result.dir}):`);
				for (const file of result.files) lines.push(`  ${file}`);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { totalFound, pattern, dirCount: results.length } satisfies SearchDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("search_external_files "));
			text += theme.fg("accent", `"${cleanPath(args.pattern)}"`);
			text += theme.fg("dim", ` across ${addedDirs.length} dir(s)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SearchDetails | undefined;
			if (!details || details.totalFound === 0) {
				const content = result.content[0];
				const text = content?.type === "text" ? content.text : "No results";
				return new Text(theme.fg("muted", text), 0, 0);
			}

			let text = theme.fg("success", `✓ ${details.totalFound} file(s)`);
			text += theme.fg("dim", ` matching "${details.pattern}" in ${details.dirCount} dir(s)`);
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += `\n${theme.fg("muted", content.text)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
