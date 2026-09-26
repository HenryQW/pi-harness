import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	Text,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildContextInjection,
	collectSkillPaths,
	dirExists,
	findFiles,
	resolveDir,
	scanDirContext,
	type AddedDir,
	type DirContext,
} from "./add-dir-helpers.ts";
import { createAddDirConfigStore } from "./add-dir-config.ts";

const STATE_TYPE = "add-dir:state";
const PROMPT_SECTION = "pi_add_dir";
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 1_000;
const PROJECT_CONFIG_KEY = "pi-add-dir.directory";
const PROJECT_CONFIG_RETRIES = 3;
const DIR_ADD_USAGE = "Usage: /dir-add [--project | --global] <path>";

type DirSource = "session" | "project" | "global";

interface ScopedDir extends AddedDir {
	source: DirSource;
	storedPath: string;
	inactiveReason?: string;
}

interface ExtensionOptions {
	agentDir?: string;
}

interface ParsedAddArgs {
	source: DirSource;
	path: string;
}

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
	return typeof dir.absolutePath === "string" && isAbsolute(dir.absolutePath) && typeof dir.label === "string";
}

function readState(data: unknown): AddedDir[] {
	if (!data || typeof data !== "object") return [];
	const dirs = (data as { dirs?: unknown }).dirs;
	return Array.isArray(dirs) ? dirs.filter(isAddedDir) : [];
}

function parseAddArgs(args: string | undefined): ParsedAddArgs {
	const input = args?.trim() ?? "";
	if (!input) return { source: "session", path: "" };
	for (const source of ["project", "global"] as const) {
		const flag = `--${source}`;
		if (input === flag) return { source, path: "" };
		if (input.startsWith(`${flag} `)) return { source, path: input.slice(flag.length).trim() };
	}
	if (input.startsWith("--")) throw new Error(DIR_ADD_USAGE);
	return { source: "session", path: input };
}

function validateStoredPaths(paths: string[], source: DirSource): void {
	if (
		paths.some(
			(path) => typeof path !== "string" || !isAbsolute(path) || /\p{C}/u.test(path),
		)
	) {
		throw new Error(`Invalid ${source} pi-add-dir configuration: expected absolute paths.`);
	}
}

function hasGitMarker(cwd: string): boolean {
	let directory = resolveDir(cwd, cwd);
	while (true) {
		try {
			lstatSync(join(directory, ".git"));
			return true;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
				throw error;
			}
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

function isWithinDir(dir: string, candidate: string): boolean {
	const relativePath = relative(dir, candidate);
	return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function contextDetails(dirCtx: DirContext, absolutePath: string): AddDirectoryDetails {
	return {
		directory: absolutePath,
		hasAgentsMd: dirCtx.agentsMd !== null,
		hasClaudeMd: dirCtx.claudeMd !== null,
		skillCount: dirCtx.skills.size,
		skillNames: [...dirCtx.skills],
	};
}

function contextSummary(dirCtx: DirContext): string {
	const found: string[] = [];
	if (dirCtx.agentsMd !== null) found.push("AGENTS.md");
	if (dirCtx.claudeMd !== null) found.push("CLAUDE.md");
	if (dirCtx.skills.size > 0) found.push(`${dirCtx.skills.size} skill(s)`);
	return found.length > 0 ? ` Found: ${found.join(", ")}.` : " No context files found.";
}

function extractAtToken(textBeforeCursor: string): string | undefined {
	return textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s"]*))$/)?.[1];
}

export function createExternalAutocompleteProvider(
	current: AutocompleteProvider,
	getAddedDirs: () => AddedDir[],
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = extractAtToken(line.slice(0, cursorCol));
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const quoted = token.startsWith('@"');
			const query = token.slice(quoted ? 2 : 1);
			if (isAbsolute(query) || query.startsWith("~/") || query.startsWith("./") || query.startsWith("../")) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const tokenStart = cursorCol - token.length;
			const sources = await Promise.all([
				current.getSuggestions(lines, cursorLine, cursorCol, options),
				...getAddedDirs().map(async (dir) => {
					const externalPath = join(dir.absolutePath, query);
					const externalToken = `${quoted || externalPath.includes(" ") ? '@"' : "@"}${externalPath}`;
					const externalLines = [...lines];
					externalLines[cursorLine] = `${line.slice(0, tokenStart)}${externalToken}${line.slice(cursorCol)}`;
					const suggestions = await current.getSuggestions(
						externalLines,
						cursorLine,
						tokenStart + externalToken.length,
						options,
					);
					return suggestions
						? {
							...suggestions,
							items: suggestions.items.map((item) => ({
								...item,
								description: `${dir.label}: ${item.description ?? item.value}`,
							})),
						}
						: null;
				}),
			]);

			const itemCount = Math.max(...sources.map((source) => source?.items.length ?? 0));
			const items = Array.from({ length: itemCount }, (_, index) =>
				sources.flatMap((source) => (source?.items[index] ? [source.items[index]] : [])),
			).flat();
			return items.length > 0 ? { prefix: token, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function addDirExtension(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
	const globalStore = createAddDirConfigStore(options.agentDir);
	let sessionDirs: AddedDir[] = [];
	let projectPaths: string[] = [];
	let globalPaths: string[] = [];
	let managedDirs: ScopedDir[] = [];
	let addedDirs: ScopedDir[] = [];
	let currentCwd = "";

	function globalConfigError(error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`Cannot load pi-add-dir global config at ${globalStore.path}: ${message}`, { cause: error });
	}

	function loadGlobalPaths(): string[] {
		try {
			return globalStore.loadSync().value.directories;
		} catch (error) {
			throw globalConfigError(error);
		}
	}

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

	function warn(ctx: ExtensionContext, message: string): void {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.error(`pi-add-dir: ${message.slice(0, 1_000)}`);
	}

	function rebuildDirs(ctx: ExtensionContext, showWarnings = false): boolean {
		const previous = addedDirs.map(({ absolutePath, source }) => `${source}\0${absolutePath}`);
		const cwdPath = resolveDir(ctx.cwd, ctx.cwd);
		const nextManaged: ScopedDir[] = [];
		const nextActive: ScopedDir[] = [];

		for (const dir of sessionDirs) {
			const absolutePath = resolveDir(dir.absolutePath, ctx.cwd);
			if (nextActive.some((existing) => existing.absolutePath === absolutePath)) continue;
			const scoped = {
				absolutePath,
				label: basename(absolutePath) || absolutePath,
				source: "session",
				storedPath: dir.absolutePath,
			} satisfies ScopedDir;
			nextManaged.push(scoped);
			nextActive.push(scoped);
		}

		for (const [source, paths] of [
			["project", projectPaths],
			["global", globalPaths],
		] as const) {
			for (const storedPath of paths) {
				let absolutePath = storedPath;
				let inactiveReason: string | undefined;
				try {
					absolutePath = resolveDir(storedPath, ctx.cwd);
					if (!dirExists(absolutePath)) inactiveReason = "directory does not exist";
				} catch (error) {
					inactiveReason = error instanceof Error ? error.message : String(error);
				}
				const duplicate = nextActive.find((dir) => dir.absolutePath === absolutePath);
				if (!inactiveReason && duplicate) inactiveReason = `shadowed by ${duplicate.source} scope`;
				if (
					!inactiveReason &&
					(isWithinDir(cwdPath, absolutePath) || isWithinDir(absolutePath, cwdPath))
				) {
					inactiveReason = "overlaps current working directory scope";
				}
				const overlap = !inactiveReason
					? nextActive.find(
							(dir) =>
								isWithinDir(dir.absolutePath, absolutePath) || isWithinDir(absolutePath, dir.absolutePath),
						)
					: undefined;
				if (overlap) inactiveReason = `overlaps ${overlap.source} directory ${overlap.absolutePath}`;
				const scoped = {
					absolutePath,
					label: basename(absolutePath) || absolutePath,
					source,
					storedPath,
					...(inactiveReason ? { inactiveReason } : {}),
				} satisfies ScopedDir;
				nextManaged.push(scoped);
				if (!inactiveReason) nextActive.push(scoped);
				else if (showWarnings) warn(ctx, `Skipped ${source} external directory ${storedPath}: ${inactiveReason}.`);
			}
		}

		managedDirs = nextManaged;
		addedDirs = nextActive;
		currentCwd = ctx.cwd;
		updateWidget(ctx);
		const next = addedDirs.map(({ absolutePath, source }) => `${source}\0${absolutePath}`);
		return previous.length !== next.length || previous.some((value, index) => value !== next[index]);
	}

	function reconstructState(ctx: ExtensionContext, showWarnings = false): boolean {
		const stateEntry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
		sessionDirs = stateEntry?.type === "custom" ? readState(stateEntry.data) : [];
		return rebuildDirs(ctx, showWarnings);
	}

	function persistState(): void {
		pi.appendEntry(STATE_TYPE, { dirs: sessionDirs.map((dir) => ({ ...dir })) });
	}

	async function readProjectPaths(cwd: string, required: boolean): Promise<string[]> {
		const probe = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		if (probe.killed) throw new Error("Git repository check was interrupted.");
		if (probe.code !== 0 || probe.stdout.trim() !== "true") {
			if (hasGitMarker(cwd)) {
				throw new Error(`Cannot inspect Git repository: ${probe.stderr.trim() || `git exited ${probe.code}`}`);
			}
			if (required) throw new Error("Project-persistent directories require a Git repository.");
			return [];
		}
		const result = await pi.exec("git", ["config", "--local", "-z", "--get-all", PROJECT_CONFIG_KEY], { cwd });
		if (result.killed) throw new Error("Reading project pi-add-dir configuration was interrupted.");
		if (result.code === 1 && result.stdout.length === 0) return [];
		if (result.code !== 0) {
			throw new Error(`Cannot read project pi-add-dir configuration: ${result.stderr.trim() || `git exited ${result.code}`}`);
		}
		const paths = result.stdout.split("\0").filter((path) => path.length > 0);
		validateStoredPaths(paths, "project");
		return [...new Set(paths)];
	}

	async function mutateProjectConfig(args: string[], cwd: string, action: string): Promise<void> {
		for (let attempt = 0; attempt < PROJECT_CONFIG_RETRIES; attempt += 1) {
			const result = await pi.exec("git", ["config", "--local", ...args], { cwd });
			if (!result.killed && result.code === 0) return;
			const lockContention = /could not lock config file|unable to create .*\.lock/i.test(result.stderr);
			if (result.killed || !lockContention || attempt === PROJECT_CONFIG_RETRIES - 1) {
				throw new Error(`Cannot ${action}: ${result.stderr.trim() || "git config was interrupted"}`);
			}
			await delay(25 * (attempt + 1));
		}
	}

	async function writePersistentPath(source: "project" | "global", absolutePath: string, ctx: ExtensionContext): Promise<void> {
		if (source === "global") {
			try {
				const config = await globalStore.update((current) => ({
					directories: current.directories.includes(absolutePath)
						? current.directories
						: [...current.directories, absolutePath],
				}));
				globalPaths = config.directories;
				return;
			} catch (error) {
				throw globalConfigError(error);
			}
		}
		projectPaths = await readProjectPaths(ctx.cwd, true);
		if (projectPaths.some((path) => resolveDir(path, ctx.cwd) === absolutePath)) return;
		await mutateProjectConfig(
			["--replace-all", "--fixed-value", PROJECT_CONFIG_KEY, absolutePath, absolutePath],
			ctx.cwd,
			"save project directory",
		);
		projectPaths = await readProjectPaths(ctx.cwd, true);
	}

	async function addDir(
		dirPath: string,
		source: DirSource,
		cwd: string,
		ctx: ExtensionContext,
	): Promise<{ ok: boolean; message: string; resourcesChanged: boolean; absolutePath?: string; context?: DirContext }> {
		const input = dirPath.trim();
		if (!input) return { ok: false, message: "Directory path must not be blank.", resourcesChanged: false };

		let absolutePath: string;
		try {
			absolutePath = resolveDir(input, cwd);
			if (!dirExists(absolutePath)) {
				return { ok: false, message: `Directory does not exist: ${absolutePath}`, resourcesChanged: false };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message: `Cannot access directory: ${message}`, resourcesChanged: false };
		}
		if (source !== "session" && /\p{C}/u.test(absolutePath)) {
			return { ok: false, message: "Persistent directory paths must not contain control characters.", resourcesChanged: false };
		}
		const exact = managedDirs.filter((dir) => dir.absolutePath === absolutePath);
		const sessionMatch = exact.find((dir) => dir.source === "session");
		const persistentMatch = exact.find((dir) => dir.source !== "session");
		if (persistentMatch || (source === "session" && sessionMatch)) {
			return {
				ok: false,
				message: `Already added in ${persistentMatch?.source ?? "session"} scope: ${absolutePath}`,
				resourcesChanged: false,
			};
		}
		const cwdPath = resolveDir(cwd, cwd);
		if (isWithinDir(cwdPath, absolutePath) || isWithinDir(absolutePath, cwdPath)) {
			return { ok: false, message: "Directory overlaps current working directory scope.", resourcesChanged: false };
		}
		const overlap = addedDirs.find(
			(dir) =>
				dir.absolutePath !== absolutePath &&
				(isWithinDir(dir.absolutePath, absolutePath) || isWithinDir(absolutePath, dir.absolutePath)),
		);
		if (overlap) {
			return {
				ok: false,
				message: `Directory overlaps already-added directory: ${overlap.absolutePath}`,
				resourcesChanged: false,
			};
		}

		const previousSkillPaths = collectSkillPaths(addedDirs);
		const context = scanDirContext(absolutePath);
		const label = basename(absolutePath) || absolutePath;
		try {
			if (source === "session") {
				sessionDirs.push({ absolutePath, label });
				persistState();
			} else {
				const previousSessionDirs = sessionDirs;
				if (sessionMatch) {
					sessionDirs = sessionDirs.filter((dir) => resolveDir(dir.absolutePath, ctx.cwd) !== absolutePath);
					try {
						persistState();
					} catch (error) {
						sessionDirs = previousSessionDirs;
						throw error;
					}
				}
				try {
					await writePersistentPath(source, absolutePath, ctx);
				} catch (error) {
					if (sessionMatch) {
						sessionDirs = previousSessionDirs;
						try {
							persistState();
						} catch (recoveryError) {
							const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
							throw new Error(`Persistent write failed and session recovery failed: ${recoveryMessage}`, { cause: error });
						}
					}
					throw error;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message, resourcesChanged: false };
		}
		rebuildDirs(ctx);
		const nextSkillPaths = new Set(collectSkillPaths(addedDirs));
		const resourcesChanged =
			previousSkillPaths.length !== nextSkillPaths.size || previousSkillPaths.some((path) => !nextSkillPaths.has(path));

		return {
			ok: true,
			message: `Added ${label} (${absolutePath}) to ${source} scope.${contextSummary(context)}`,
			resourcesChanged,
			absolutePath,
			context,
		};
	}

	async function removeDir(dir: ScopedDir, ctx: ExtensionContext): Promise<{ ok: boolean; message: string }> {
		try {
			if (dir.source === "session") {
				sessionDirs = sessionDirs.filter(
					(candidate) => resolveDir(candidate.absolutePath, ctx.cwd) !== dir.absolutePath,
				);
				persistState();
			} else if (dir.source === "global") {
				try {
					const config = await globalStore.update((current) => ({
						directories: current.directories.filter((path) => path !== dir.storedPath),
					}));
					globalPaths = config.directories;
				} catch (error) {
					throw globalConfigError(error);
				}
			} else {
				await mutateProjectConfig(
					["--unset-all", "--fixed-value", PROJECT_CONFIG_KEY, dir.storedPath],
					ctx.cwd,
					"remove project directory",
				);
				projectPaths = projectPaths.filter((path) => path !== dir.storedPath);
			}
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		rebuildDirs(ctx);
		return { ok: true, message: `Removed ${dir.label} (${dir.storedPath}) from ${dir.source} scope. Reloading resources...` };
	}

	pi.on("resources_discover", (event) => {
		if (event.cwd !== currentCwd || addedDirs.length === 0) return;
		const skillPaths = collectSkillPaths(addedDirs);
		return skillPaths.length > 0 ? { skillPaths } : undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		globalPaths = loadGlobalPaths();
		projectPaths = await readProjectPaths(ctx.cwd, false);
		reconstructState(ctx, true);
		ctx.ui.addAutocompleteProvider((current) => createExternalAutocompleteProvider(current, () => addedDirs));
	});
	pi.on("session_tree", async (_event, ctx) => {
		if (reconstructState(ctx)) pi.sendUserMessage("/dir-reload", { expandPromptTemplates: true });
	});

	pi.on("before_agent_start", (event) => {
		if (addedDirs.length === 0) return;
		event.systemPromptOptions.sections[PROMPT_SECTION] = buildContextInjection(addedDirs);
	});

	pi.registerCommand("dir-reload", {
		description: "Reload external directory resources",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("dir-add", {
		description: "Add an external directory to this session, project, or global scope",
		handler: async (args, ctx) => {
			let parsed: ParsedAddArgs;
			try {
				parsed = parseAddArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!parsed.path) {
				const prompted = await ctx.ui.input("Directory path:", "");
				if (!prompted) return;
				parsed.path = prompted;
			}

			const result = await addDir(parsed.path, parsed.source, ctx.cwd, ctx);
			const message = result.ok && result.resourcesChanged ? `${result.message} Reloading external skills...` : result.message;
			ctx.ui.notify(message, result.ok ? "info" : "error");
			if (result.ok && result.resourcesChanged) await ctx.reload();
		},
	});

	pi.registerCommand("dir-ls", {
		description: "List external directories and select one to remove",
		handler: async (_args, ctx) => {
			if (managedDirs.length === 0) {
				ctx.ui.notify("No external directories added. Use /dir-add <path> to add one.", "info");
				return;
			}

			const choices = managedDirs.map(
				(dir) => `[${dir.source}] ${dir.label} - ${dir.storedPath}${dir.inactiveReason ? ` (inactive: ${dir.inactiveReason})` : ""}`,
			);
			const selected = await ctx.ui.select("External directories — select one to remove:", choices);
			const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
			const dir = selectedIndex >= 0 ? managedDirs[selectedIndex] : undefined;
			if (!dir) return;

			const result = await removeDir(dir, ctx);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.ok) await ctx.reload();
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
			"The directory's AGENTS.md and CLAUDE.md are returned now and injected into future system prompts.",
			"After adding, you can read/edit/write files in the external directory using absolute paths.",
		],
		parameters: AddDirectoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputPath = params.path.trim();
			const result = await addDir(inputPath, "session", ctx.cwd, ctx);
			if (!result.ok) throw new Error(result.message);

			const absolutePath = result.absolutePath!;
			const context = result.context!;
			const response: string[] = [result.message];
			if (context.agentsMd !== null) {
				response.push(`\nAGENTS.md instructions from ${absolutePath}:\n${context.agentsMd}`);
			}
			if (context.claudeMd !== null) {
				response.push(`\nCLAUDE.md instructions from ${absolutePath}:\n${context.claudeMd}`);
			}
			if (context.skills.size > 0) {
				response.push(`\nDiscovered skills: ${[...context.skills].join(", ")}`);
			}
			if (result.resourcesChanged) response.push("Run /reload to update external skills.");
			response.push(`\nYou can now access files at: ${absolutePath}`);

			return {
				content: [{ type: "text", text: response.join("\n") }],
				details: contextDetails(context, absolutePath),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("add_directory "));
			text += theme.fg("accent", args.path.trim());
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

			const pattern = params.pattern.trim();
			const limit = params.maxResults ?? DEFAULT_MAX_RESULTS;
			const results: Array<{ dir: string; label: string; files: string[] }> = [];
			let totalFound = 0;

			for (const dir of addedDirs) {
				signal?.throwIfAborted();
				const remaining = limit - totalFound;
				if (remaining <= 0) break;

				const files = await findFiles(dir.absolutePath, pattern, remaining, signal);
				if (files.length > 0) {
					results.push({ dir: dir.absolutePath, label: dir.label, files });
					totalFound += files.length;
				}
			}

			signal?.throwIfAborted();
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
			text += theme.fg("accent", `"${args.pattern.trim()}"`);
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
