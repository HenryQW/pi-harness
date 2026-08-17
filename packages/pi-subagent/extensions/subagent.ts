import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, parseFrontmatter, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_TASK_ASSIGNMENTS,
	modelReference,
	orderedProfileRoutes,
	PROFILE_NAMES,
	readTaskModelsConfig,
	resolveTaskModelRoute,
	type ProfileName,
	type ResolvedTaskRoute,
} from "@henryqw/pi-task-models";
import { Type } from "typebox";

const MODEL_CLASSES = PROFILE_NAMES;
const SUBAGENT_TASK = "pi-subagent/delegateTask";
const DEFAULT_MODEL_CLASS = DEFAULT_TASK_ASSIGNMENTS[SUBAGENT_TASK];
const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MULTI_CODEX_EXTENSION = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_JSON_EVENT_BYTES = 1024 * 1024;
const CONSUMED_JSON_EVENTS = new Set(["message_start", "message_update", "message_end"]);
const JSON_EVENT_TYPE = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/;
const WIDGET_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 80;
const TERMINAL_DISPLAY_MS = 1_000;
const MAX_WIDGET_ROWS = 8;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type ModelClass = ProfileName;
type Role = {
	name: string;
	description: string;
	tools?: string[];
	extensions: string[];
	skills: string[];
	systemPrompt: string;
};
type ChildResult = {
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
};
type WidgetStatus = "working" | "success" | "failure" | "aborted";
type WidgetItem = {
	roleRoute: string;
	task: string;
	tokens: number;
	startedAt: number;
	status: WidgetStatus;
	finishedAt?: number;
	removeAt?: number;
};

const isModelClass = (value: unknown): value is ModelClass =>
	typeof value === "string" && MODEL_CLASSES.includes(value as ModelClass);
const isNumberedCodexProvider = (provider: string): boolean => CODEX_ALIAS.test(provider);

function resolveTaskRoute(ctx: ExtensionContext, modelClass?: ModelClass): ResolvedTaskRoute {
	let config;
	try {
		config = readTaskModelsConfig();
	} catch {
		throw new Error("Couldn't read task model config. Run /task-models.");
	}

	const profileName = modelClass ?? config.tasks[SUBAGENT_TASK] ?? DEFAULT_MODEL_CLASS;
	const profile = config.profiles[profileName];
	if (!profile) throw new Error(`No ${profileName} task model profile is configured. Run /task-models.`);
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route);
		if (resolved) return resolved;
	}
	throw new Error(`No usable ${profileName} task model route. Run /task-models.`);
}

const cleanText = (value: unknown, field: string, file: string): string => {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${file}: ${field} must be non-empty text.`);
	}
	return value.trim();
};

const stringList = (value: unknown, field: string, file: string, required = false): string[] => {
	if (value === undefined) {
		if (required) throw new Error(`${file}: ${field} is required.`);
		return [];
	}
	const values = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
		throw new Error(`${file}: ${field} must be an array of strings.`);
	}
	return values.map((item) => item.trim());
};

const extensionList = (value: unknown, file: string): string[] => {
	const extensions = stringList(value, "extensions", file);
	for (const extension of extensions) {
		const packageSource = /^(?:npm|git|github|https?|ssh):/.test(extension);
		const userPath = isAbsolute(extension) || extension.startsWith("~/") || extension.startsWith("~\\") || extension.startsWith("file://");
		if (!packageSource && !userPath) {
			throw new Error(`${file}: extensions entries must be absolute paths or package sources.`);
		}
	}
	return extensions;
};

export function loadRoles(agentDir = getAgentDir()): Role[] {
	const dir = join(agentDir, "config", "pi-subagent");
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}

	const roles = entries
		.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry): Role => {
			const file = join(dir, entry.name);
			let parsed: ReturnType<typeof parseFrontmatter>;
			try {
				parsed = parseFrontmatter(readFileSync(file, "utf8"));
			} catch (error) {
				throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const frontmatter = parsed.frontmatter;
			return {
				name: cleanText(frontmatter.name, "name", file),
				description: cleanText(frontmatter.description, "description", file),
				tools: frontmatter.tools === undefined ? undefined : stringList(frontmatter.tools, "tools", file, true),
				extensions: extensionList(frontmatter.extensions, file),
				skills: stringList(frontmatter.skills, "skills", file),
				systemPrompt: cleanText(parsed.body, "system prompt", file),
			};
		});

	const names = new Set<string>();
	for (const role of roles) {
		if (names.has(role.name)) throw new Error(`Duplicate Subagent role: ${role.name}.`);
		names.add(role.name);
	}
	return roles;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function assistantText(message: unknown): string | undefined {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || !Array.isArray(record.content)) return;
	const text = record.content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && !Array.isArray(part)
				&& (part as Record<string, unknown>).type === "text"
				&& typeof (part as Record<string, unknown>).text === "string"))
		.map((part) => part.text)
		.join("\n");
	return text || undefined;
}

function utf8Prefix(text: string, maxBytes: number): string {
	let low = 0;
	let high = Math.min(text.length, maxBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	if (low > 0 && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low])) low--;
	return text.slice(0, low);
}

function cappedPrefix(text: string, totalBytes: number): string {
	if (totalBytes <= MAX_OUTPUT_BYTES) return text;
	const worstCaseMarker = `\n\n[Output truncated: ${totalBytes} bytes omitted]`;
	const prefix = utf8Prefix(text, MAX_OUTPUT_BYTES - Buffer.byteLength(worstCaseMarker, "utf8"));
	const omittedBytes = totalBytes - Buffer.byteLength(prefix, "utf8");
	return `${prefix}\n\n[Output truncated: ${omittedBytes} bytes omitted]`;
}

export function capOutput(text: string): string {
	return cappedPrefix(text, Buffer.byteLength(text, "utf8"));
}

type BoundedText = { prefix: string; totalBytes: number };

function appendBounded(target: BoundedText, text: string): void {
	target.totalBytes += Buffer.byteLength(text, "utf8");
	const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(target.prefix, "utf8");
	if (remaining > 0) target.prefix += utf8Prefix(text, remaining);
}

function boundedText(target: BoundedText): string {
	return cappedPrefix(target.prefix, target.totalBytes);
}

function taskSummary(task: string): string {
	return task.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().split(/\s+/).slice(0, 4).join(" ");
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatElapsed(startedAt: number, finishedAt = Date.now()): string {
	const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1_000));
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor(seconds % 3_600 / 60);
	return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function usageTokens(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const total = (value as Record<string, unknown>).totalTokens;
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.round(total) : undefined;
}

function statusGlyph(status: WidgetStatus, spinnerIndex: number, theme: Theme): string {
	switch (status) {
		case "working": return theme.fg("accent", SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]!);
		case "success": return theme.fg("success", "✓");
		case "failure": return theme.fg("error", "✗");
		case "aborted": return theme.fg("warning", "■");
	}
}

function leftColumn(value: string, width: number): string {
	return truncateToWidth(value, width, "…", true);
}

function rightColumn(value: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

function renderWidgetRows(
	items: WidgetItem[],
	width: number,
	now: number,
	spinnerIndex: number,
	theme: Theme,
): string[] {
	const visible = items.slice(0, MAX_WIDGET_ROWS);
	if (!visible.length) return [];
	const tokens = visible.map((item) => formatTokens(item.tokens));
	const elapsed = visible.map((item) => formatElapsed(item.startedAt, item.finishedAt ?? now));
	const tokenWidth = Math.max(...tokens.map(visibleWidth));
	const elapsedWidth = Math.max(...elapsed.map(visibleWidth));
	const fixedWidth = 1 + 8 + tokenWidth + elapsedWidth;
	if (width < fixedWidth) {
		return visible.map((item, index) => truncateToWidth(
			`${statusGlyph(item.status, spinnerIndex, theme)} ${tokens[index]} ${elapsed[index]}`,
			width,
			"",
		));
	}
	const contentWidth = width - fixedWidth;
	const naturalRoleWidth = Math.min(32, Math.max(...visible.map((item) => visibleWidth(item.roleRoute))));
	const roleWidth = Math.min(naturalRoleWidth, contentWidth);
	const taskWidth = contentWidth - roleWidth;
	const lines = visible.map((item, index) => [
		statusGlyph(item.status, spinnerIndex, theme),
		theme.fg("accent", leftColumn(item.roleRoute, roleWidth)),
		theme.fg("text", leftColumn(item.task, taskWidth)),
		theme.fg("muted", rightColumn(tokens[index]!, tokenWidth)),
		theme.fg("dim", rightColumn(elapsed[index]!, elapsedWidth)),
	].join("  "));
	if (items.length > visible.length) lines.push(theme.fg("muted", `… ${items.length - visible.length} more`));
	return lines;
}

async function runPi(
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((text: string) => void) | undefined,
	onTokens: ((tokens: number) => void) | undefined,
): Promise<ChildResult> {
	if (signal?.aborted) throw new Error("Subagent was aborted.");
	return await new Promise<ChildResult>((resolve, reject) => {
		const invocation = piInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let lineParts: string[] = [];
		let lineBytes = 0;
		let linePrefix = "";
		let ignoreLine = false;
		let output = "";
		const stderr = { prefix: "", totalBytes: 0 };
		const partial = { prefix: "", totalBytes: 0 };
		let hasPartialText = false;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let spawnError: Error | undefined;
		let protocolError: Error | undefined;
		let aborted = false;
		let completedTokens = 0;
		let currentTokens = 0;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!event || typeof event !== "object" || Array.isArray(event)) return;
			const record = event as Record<string, unknown>;
			if (record.type === "message_start") {
				partial.prefix = "";
				partial.totalBytes = 0;
				hasPartialText = false;
				return;
			}
			if (record.type === "message_update") {
				const tokens = usageTokens(record.usage);
				if (tokens !== undefined) {
					currentTokens = tokens;
					onTokens?.(completedTokens + currentTokens);
				}
				const update = record.assistantMessageEvent;
				if (update && typeof update === "object" && !Array.isArray(update)) {
					const assistantEvent = update as Record<string, unknown>;
					if (assistantEvent.type === "text_start" && hasPartialText) appendBounded(partial, "\n");
					if (assistantEvent.type === "text_start") hasPartialText = true;
					if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
						hasPartialText = true;
						appendBounded(partial, assistantEvent.delta);
						output = boundedText(partial);
						onUpdate?.(output);
					}
				}
				return;
			}
			if (record.type !== "message_end") return;
			const text = assistantText(record.message);
			if (text !== undefined) {
				output = capOutput(text);
				onUpdate?.(output);
			}
			if (record.message && typeof record.message === "object" && !Array.isArray(record.message)) {
				const message = record.message as Record<string, unknown>;
				if (message.role === "assistant") {
					completedTokens += usageTokens(message.usage) ?? currentTokens;
					currentTokens = 0;
					onTokens?.(completedTokens);
				}
				if (typeof message.stopReason === "string") stopReason = message.stopReason;
				if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
			}
		};

		const killTree = (force: boolean) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				spawn("taskkill", [...(force ? ["/F"] : []), "/T", "/PID", String(child.pid)], {
					stdio: "ignore",
					windowsHide: true,
				});
				return;
			}
			try {
				process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
			} catch {
				child.kill(force ? "SIGKILL" : "SIGTERM");
			}
		};

		child.stdout.on("data", (data: string) => {
			if (protocolError) return;
			let offset = 0;
			while (offset < data.length) {
				const newline = data.indexOf("\n", offset);
				const end = newline === -1 ? data.length : newline;
				const part = data.slice(offset, end);
				if (!ignoreLine) {
					linePrefix += part.slice(0, Math.max(0, 256 - linePrefix.length));
					const eventType = JSON_EVENT_TYPE.exec(linePrefix)?.[1];
					if (eventType && !CONSUMED_JSON_EVENTS.has(eventType)) {
						ignoreLine = true;
						lineParts = [];
						lineBytes = 0;
					} else {
						lineBytes += Buffer.byteLength(part, "utf8");
						if (lineBytes > MAX_JSON_EVENT_BYTES) {
							protocolError = new Error(`Subagent JSON event exceeds ${MAX_JSON_EVENT_BYTES} bytes.`);
							killTree(true);
							return;
						}
						if (part) lineParts.push(part);
					}
				}
				if (newline === -1) return;
				if (!ignoreLine) processLine(lineParts.join(""));
				lineParts = [];
				lineBytes = 0;
				linePrefix = "";
				ignoreLine = false;
				offset = newline + 1;
			}
		});
		child.stderr.on("data", (data: string) => appendBounded(stderr, data));
		child.on("error", (error) => { spawnError = error; });

		const abort = () => {
			aborted = true;
			killTree(false);
			killTimer = setTimeout(() => killTree(true), 5_000);
			killTimer.unref();
		};
		signal?.addEventListener("abort", abort, { once: true });

		child.on("close", (code) => {
			if (!protocolError && lineBytes) processLine(lineParts.join(""));
			if (aborted) killTree(true);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			if (aborted) reject(new Error("Subagent was aborted."));
			else if (protocolError) reject(protocolError);
			else if (spawnError) reject(spawnError);
			else resolve({ exitCode: code ?? 1, output, stderr: boundedText(stderr), stopReason, errorMessage });
		});
	});
}

const Parameters = Type.Object({
	role: Type.String({ description: "Configured Subagent role name" }),
	task: Type.String({ description: "One bounded task with needed context and expected result" }),
	modelClass: Type.Optional(StringEnum(MODEL_CLASSES, {
		description: "Classify task complexity: fast for narrow lookups or mechanical edits; balanced for normal bounded work; frontier for ambiguous, cross-cutting, or high-risk reasoning. Defaults to the shared pi-subagent/delegateTask assignment.",
	})),
});

const roleSummary = (): string => {
	try {
		const roles = loadRoles();
		return roles.length ? roles.map((role) => `${role.name}: ${role.description}`).join("; ") : "none configured";
	} catch (error) {
		return `configuration error: ${error instanceof Error ? error.message : String(error)}`;
	}
};

function resolveSkillPaths(pi: ExtensionAPI, names: string[]): { paths: string[]; missing: string[] } {
	const skills = new Map(pi.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => [command.name, command.sourceInfo.path]));
	const paths: string[] = [];
	const missing: string[] = [];
	for (const name of names) {
		const path = skills.get(`skill:${name}`);
		if (path) paths.push(path);
		else missing.push(name);
	}
	return { paths, missing };
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const widgetItems = new Map<string, WidgetItem>();
	let widgetInstalled = false;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;
	let activeTui: TUI | undefined;
	const stopWidgetTimer = () => {
		if (!widgetTimer) return;
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	};

	const requestWidgetRender = () => activeTui?.requestRender();

	const startWidgetTimer = () => {
		if (widgetTimer) return;
		widgetTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
			const now = Date.now();
			for (const [id, item] of widgetItems) {
				if (item.removeAt !== undefined && item.removeAt <= now) widgetItems.delete(id);
			}
			requestWidgetRender();
			if (!widgetItems.size) stopWidgetTimer();
		}, WIDGET_INTERVAL_MS);
		widgetTimer.unref();
	};

	const ensureWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || widgetInstalled) return;
		widgetInstalled = true;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme): Component => {
			activeTui = tui;
			return {
				invalidate() {},
				render: (width) => renderWidgetRows([...widgetItems.values()], width, Date.now(), spinnerIndex, theme),
			};
		});
	};

	const startWidgetItem = (
		id: string,
		role: string,
		model: string,
		thinkingLevel: string | undefined,
		task: string,
		ctx: ExtensionContext,
	) => {
		if (!ctx.hasUI) return;
		ensureWidget(ctx);
		widgetItems.set(id, {
			roleRoute: `${role}[${model}:${thinkingLevel ?? "default"}]`,
			task: taskSummary(task),
			tokens: 0,
			startedAt: Date.now(),
			status: "working",
		});
		startWidgetTimer();
		requestWidgetRender();
	};

	const updateWidgetTokens = (id: string, tokens: number) => {
		const item = widgetItems.get(id);
		if (!item) return;
		item.tokens = tokens;
		requestWidgetRender();
	};

	const finishWidgetItem = (id: string, status: Exclude<WidgetStatus, "working">) => {
		const item = widgetItems.get(id);
		if (!item) return;
		item.status = status;
		item.finishedAt = Date.now();
		item.removeAt = item.finishedAt + TERMINAL_DISPLAY_MS;
		startWidgetTimer();
		requestWidgetRender();
	};

	pi.on("session_start", (_event, ctx) => {
		ensureWidget(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopWidgetTimer();
		widgetItems.clear();
		activeTui = undefined;
		widgetInstalled = false;
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Subagent",
		description: `Delegate one bounded task to one isolated Pi Subagent. Roles: ${roleSummary()}. Choose fast for narrow work, balanced for normal work, or frontier for ambiguous and high-risk work; omit modelClass to use shared task-model settings. Request concise conclusions and file/line references; split broad scouting work.`,
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const task = cleanText(params.task, "task", "delegate_task");
			const roles = loadRoles();
			const role = roles.find((candidate) => candidate.name === params.role);
			if (!role) {
				throw new Error(`Unknown Subagent role: ${params.role}. Available roles: ${roles.map(({ name }) => name).join(", ") || "none"}.`);
			}

			if (params.modelClass !== undefined && !isModelClass(params.modelClass)) {
				throw new Error("delegate_task modelClass must be fast, balanced, or frontier.");
			}
			const resolvedRoute = resolveTaskRoute(ctx, params.modelClass);
			const model = resolvedRoute.model;
			const modelReferenceValue = modelReference(model);
			const thinkingLevel = resolvedRoute.thinkingLevel;

			const resolvedSkills = resolveSkillPaths(pi, role.skills);
			if (resolvedSkills.missing.length) {
				ctx.ui.notify(
					`Subagent role ${role.name} skipped unavailable Pi skills: ${resolvedSkills.missing.join(", ")}.`,
					"warning",
				);
			}

			const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
			const promptPath = join(tempDir, "system.md");
			let widgetStatus: Exclude<WidgetStatus, "working"> = "failure";
			try {
				await writeFile(promptPath, role.systemPrompt, { encoding: "utf8", mode: 0o600 });
				const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills"];
				const extensions = isNumberedCodexProvider(model.provider)
					? [...role.extensions, MULTI_CODEX_EXTENSION]
					: role.extensions;
				for (const extension of new Set(extensions)) args.push("--extension", extension);
				for (const skill of resolvedSkills.paths) args.push("--skill", skill);
				if (role.tools !== undefined) {
					if (role.tools.length) args.push("--tools", role.tools.join(","));
					else args.push("--no-tools");
				}
				args.push("--model", modelReferenceValue);
				if (thinkingLevel) args.push("--thinking", thinkingLevel);
				args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
				args.push("--append-system-prompt", promptPath, `Task: ${task}`);

				startWidgetItem(toolCallId, role.name, model.id, thinkingLevel, task, ctx);
				const details = { role: role.name, model: modelReferenceValue, thinkingLevel };
				const result = await runPi(
					args,
					ctx.cwd,
					signal,
					(text) => onUpdate?.({ content: [{ type: "text", text }], details }),
					(tokens) => updateWidgetTokens(toolCallId, tokens),
				);
				const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				widgetStatus = result.stopReason === "aborted" ? "aborted" : failed ? "failure" : "success";
				const text = capOutput(failed
					? result.errorMessage || result.stderr.trim() || result.output || `Subagent exited with code ${result.exitCode}.`
					: result.output || "(no output)");
				return { content: [{ type: "text" as const, text }], details, ...(failed ? { isError: true } : {}) };
			} catch (error) {
				if (signal?.aborted) widgetStatus = "aborted";
				throw error;
			} finally {
				try {
					await rm(tempDir, { recursive: true, force: true });
				} finally {
					finishWidgetItem(toolCallId, widgetStatus);
				}
			}
		},
	});
}
