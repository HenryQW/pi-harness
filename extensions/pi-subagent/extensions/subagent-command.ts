import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { DiscardPlan } from "../dist/discard.js";
import type { PruneItem } from "../dist/prune.js";
import { compactCost } from "./result-transport.ts";

/** Saved before launch for user matching only; never ownership or mutation authority. */
export interface DirectDisplay {
	/** Session-local workflow number. */
	workflow: number;
	/** One-based original workflow entry index. */
	worker: number;
	workers: number;
	title: string;
	role: string;
}
export const directRef = ({ workflow, worker }: DirectDisplay): string => `D${workflow}.${worker}`;

/** Read-only branch records; the adapter groups all tabs of a direct workflow. */
export interface DirectTask {
	id: string;
	/** Legacy label: saved allocation label, otherwise the exact task ID. */
	name: string;
	status: string;
	canClose?: boolean;
	/** Entry IDs of running workers in a locally owned all-read workflow; each can be stopped alone. */
	stoppable?: readonly string[];
	recovery?: string;
	/** Request total cost from the delivered result; absent before delivery or when unmeasured. */
	cost?: number;
	/** Recorded workers by original index; empty for legacy records. */
	workers: readonly DirectDisplay[];
	tabs: readonly { entryId: string; name: string; tabId: string; paneId: string; sessionFile: string; display?: DirectDisplay; cost?: number }[];
}
const costSuffix = (cost: number | undefined) => compactCost(cost) === undefined ? "" : ` · ${compactCost(cost)}`;

const workerLabel = (display: DirectDisplay) => `${directRef(display)} · ${display.role} · ${display.title}`;
const directLabel = ({ name, workers: [first] }: DirectTask): string => !first ? name
	: first.workers === 1 ? workerLabel(first) : `D${first.workflow} · ${first.workers} workers`;

export interface IsolatedTask {
	id: string;
	name: string;
	status: string;
	kind: string;
}
export interface IsolatedRequest {
	id: string;
	/** Saved state address for a removed parent checkout. */
	directory?: string;
	root?: string;
	orphaned?: boolean;
	name: string;
	status: string;
	tasks: readonly IsolatedTask[];
}
export interface IsolatedInventory {
	root: string;
	/** A live productive run holds this root's lease; the lease does not name its request. */
	leaseLive: boolean;
	requests: readonly IsolatedRequest[];
	invalidIds: readonly string[];
}

export type { PruneItem };
export interface PrunePlan {
	root: string;
	items: readonly PruneItem[];
}

/** Mutation adapters MUST check current() synchronously alongside their live ownership
 * validation and queue operation. They must not await between those operations. */
export interface SubagentCommandAdapter {
	direct(ctx: ExtensionContext): readonly DirectTask[];
	closeDirect(task: DirectTask, current: () => boolean): Promise<string>;
	stopDirect(task: DirectTask, entryId: string, current: () => boolean): Promise<string>;
	isolated(cwd: string, current: () => boolean): Promise<IsolatedInventory>;
	recover(cwd: string): Promise<string>;
	/** Read-only review of pi-subagent worktrees and branches in the canonical repository. */
	prunePlan(cwd: string): Promise<PrunePlan>;
	discardPlan(cwd: string, request: IsolatedRequest): Promise<DiscardPlan>;
	discard(cwd: string, plan: DiscardPlan, current: () => boolean): Promise<CleanupReport>;
	/** Re-verify and remove reviewed prunable items, and with `force` reviewed forceable items; returns a bounded report. */
	prune(cwd: string, items: readonly PruneItem[], allowIgnored: boolean, force: boolean, current: () => boolean): Promise<CleanupReport>;
	/** Read-only Role catalog report with routes and per-file load errors. */
	roles(ctx: ExtensionContext): RolesReport;
	inspectInTab(root: string, requestId: string, ctx: ExtensionContext, current: () => boolean): Promise<{ ref: string; tabId: string; name: string; sessionFile: string }>;
	canFollowup(root: string, requestId: string, taskId: string): boolean;
	enqueue(root: string, requestId: string, taskId: string, text: string, current: () => boolean): string;
	drain(root: string, requestId: string, taskId: string, current: () => boolean): readonly string[];
	/** Session start/shutdown epoch; prevents same-session reload after an awaited dialog. */
	epoch(): number;
}

/** Bounded removal report with outcome counts, so retained resources never read as a normal completion. */
export interface CleanupReport { text: string; failed: number; skipped: number }
export interface RoleReport {
	name: string;
	source: string;
	/** Role modelClass, or undefined for the configured default route. */
	modelClass?: string;
	route: { model: string; thinking: string } | { error: string };
	tools: readonly string[];
	extensions: readonly string[];
	skills: readonly string[];
	mcps: readonly string[];
}
export type RolesReport = { roles: readonly RoleReport[]; errors: readonly string[] } | { unavailable: string };

type Tone = "info" | "success" | "warning" | "error";
/** `code` shows the value as inline code: IDs, paths, branches, model references, and session files. */
type Row = { label: string; value: string; tone?: Tone; code?: boolean } | { text: string; tone?: Tone; code?: boolean };
interface Section { heading?: string; note?: string; tone?: Tone; rows: readonly Row[] }
/** One /subagent output; every delivery mode renders it as Markdown. */
export interface Report { tone: Tone; title: string; sections: readonly Section[] }
const REPORT_ENTRY = "pi-subagent-report";
const RECOVERY_MESSAGE = "pi-subagent-recovery";

const TONES: Record<Tone, { glyph: string; color: Parameters<Theme["fg"]>[0] }> = {
	info: { glyph: "●", color: "accent" }, success: { glyph: "✓", color: "success" },
	warning: { glyph: "⚠", color: "warning" }, error: { glyph: "✗", color: "error" },
};
const LEVEL = { info: "info", success: "info", warning: "warning", error: "error" } as const;
const field = (text: string) => clean(text, Number.MAX_SAFE_INTEGER);
/** Escapes inline and line-start Markdown. Brackets, parentheses, and `!` stay literal because Pi reads `\(` and `\[` as LaTeX. */
const escapeMarkdown = (text: string) => field(text).replace(/[\\`*_~<>&|$]/g, "\\$&").replace(/^(\s*)([#+-])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");
const inlineCode = (text: string) => {
	const value = field(text);
	const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	const pad = /^`|`$/.test(value) ? " " : "";
	return value ? `${fence}${pad}${value}${pad}${fence}` : "";
};
const glyphPrefix = (tone?: Tone) => tone ? `${TONES[tone].glyph} ` : "";

/** `### heading · note`, then one list item per row. */
function sectionMarkdown({ heading, note, tone, rows }: Section, bullet = "-"): string {
	const value = (text: string, row: Row) => row.code ? `${glyphPrefix(row.tone)}${inlineCode(text)}` : escapeMarkdown(`${glyphPrefix(row.tone)}${text}`);
	return [
		...(heading ? [`### ${glyphPrefix(tone)}${escapeMarkdown(heading)}${note ? ` · ${escapeMarkdown(note)}` : ""}`] : []),
		...rows.map((row) => `${bullet} ${"label" in row ? `**${escapeMarkdown(row.label)}:** ${value(row.value, row)}` : value(row.text, row)}`),
	].join("\n");
}
/** A headless section switches its bullet so Markdown does not merge it into the list above. */
function reportBody(sections: readonly Section[]): string {
	let bullet = "*";
	return sections.map((section) => sectionMarkdown(section, bullet = section.heading || bullet === "*" ? "-" : "*")).join("\n\n");
}
const titleText = ({ tone, title }: Report) => `${TONES[tone].glyph} ${field(title)}`;
/** Bold glyph and title, then the section body: the RPC and message form of the TUI entry. */
export function reportMarkdown(report: Report): string {
	return [`**${TONES[report.tone].glyph} ${escapeMarkdown(report.title)}**`, ...report.sections.length ? [reportBody(report.sections)] : []].join("\n\n");
}
/** Pi's custom-message look: a tone-colored bold title over a Markdown body. */
function reportComponent(report: Report, theme: Theme, paddingX: number): Box {
	const box = new Box(paddingX, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.bold(theme.fg(TONES[report.tone].color, titleText(report))), 0, 0));
	if (report.sections.length) {
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(clean(reportBody(report.sections), ROLES_REPORT_CODE_POINTS, true), 0, 0, getMarkdownTheme(),
			{ color: (text) => theme.fg("customMessageText", text) }));
	}
	return box;
}
/** Adapter text: the first line is the title unless one is given; other lines are rows. */
function textReport(tone: Tone, text: string, title?: string): Report {
	const lines = text.split("\n").filter((line) => line.trim());
	const head = title ?? lines.shift() ?? "";
	return { tone, title: head, sections: lines.length ? [{ rows: lines.map((line) => ({ text: line })) }] : [] };
}
const moreSection = (more: string | undefined): Section[] => more ? [{ rows: [{ text: more, tone: "warning" }] }] : [];

function rolesReport(report: RolesReport): Report {
	if ("unavailable" in report) return { tone: "error", title: `Role catalog unavailable: ${report.unavailable}`, sections: [] };
	return { tone: "info", title: `Roles (${report.roles.length})`, sections: [
		...report.roles.map((role): Section => ({ heading: role.name, note: role.source, rows: [
			{ label: "model class", value: role.modelClass ?? "default" },
			..."error" in role.route ? [{ label: "route", value: `error: ${role.route.error}`, tone: "error" as const }]
				: [{ label: "model", value: role.route.model, code: true }, { label: "thinking", value: role.route.thinking }],
			...(["tools", "skills", "extensions", "mcps"] as const).map((key) => ({ label: key, value: role[key].join(", ") || "none" })),
		] })),
		...(report.errors.length ? [{ heading: `Invalid Role files (${report.errors.length})`, tone: "error" as const, rows: report.errors.map((text) => ({ text })) }] : []),
	] };
}

const clean = (text: string, max = 110, multiline = false): string => [...text.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, max).join("");
const ROLES_REPORT_CODE_POINTS = 16_000;
const errorText = (error: unknown): string => clean(error instanceof Error ? error.message : String(error), 500);
/** One-line summary of free text such as a goal; the ellipsis marks a cut. */
const summary = (text: string, max = 60): string => {
	const chars = [...clean(text, Number.MAX_SAFE_INTEGER).replace(/\s+/g, " ").trim()];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};
// Identity and status first so clipping cuts only the goal summary.
const isolatedLabel = ({ id, status, name }: IsolatedRequest): string => `${id} · ${status} · ${summary(name)}`;
const completed = (status: string) => ["completed", "success", "failed", "failure", "aborted", "integrated"].includes(status);
const priority = (status: string) => /attention|blocked|retained|failed/i.test(status) ? 0 : completed(status) ? 2 : 1;
// Recorded-only and unverified work is uncertain, not active.
const statusTone = (status: string): Tone => /attention|blocked|retained|recorded only|unverified/i.test(status) ? "warning"
	: /failed|failure|aborted/i.test(status) ? "error" : completed(status) ? "success" : "info";
/** Uncolored: the selector colors each whole option, and inner ANSI resets break its highlight. */
const glyph = (status: string) => TONES[statusTone(status)].glyph;
const cleanupReport = ({ text, failed, skipped }: CleanupReport): Report => textReport(failed ? "error" : skipped ? "warning" : "success", text);

const PRUNE_IGNORED_CONFIRM_CODE_POINTS = 4_000;
const shortId = ({ branch }: PruneItem) => branch.replace(/^pi-subagent\/subagent-/, "").slice(0, 8);
const NOT_SHOWN = "they are not removed in this run; run /subagent prune again after this run.";

/** Fit whole item lines within `max` code points; never cut silently, and report exactly which items were shown. */
function fitItems<T>(header: string, items: readonly T[], line: (item: T) => string, max: number, omitted = NOT_SHOWN,
	count: (item: T) => number = () => 1): { text: string; shown: T[]; more?: string } {
	const lines = [header];
	const shown: T[] = [];
	let size = [...header].length;
	const reserve = [...omitted].length + 32;
	for (const item of items) {
		const text = line(item);
		const length = [...text].length + 1;
		if (size + length + reserve > max) break;
		lines.push(text);
		size += length;
		shown.push(item);
	}
	const hidden = items.slice(shown.length).reduce((sum, item) => sum + count(item), 0);
	const more = hidden ? `+${hidden} more not shown; ${omitted}` : undefined;
	if (more) lines.push(more);
	return { text: lines.join("\n"), shown, more };
}

/** Groups items by exact reason, prunable groups first, in lines of 10 IDs so a long list is cut at whole lines.
 * Only shown items may be removed. IDs are display-only; removal uses the reviewed items. */
function pruneReview({ root, items }: PrunePlan): { report: Report; shown: PruneItem[] } {
	if (!items.length) return { report: { tone: "info", title: `No pi-subagent worktrees or branches in ${root}.`, sections: [] }, shown: [] };
	const groups = new Map<string, PruneItem[]>();
	for (const item of [...items.filter((item) => item.prunable), ...items.filter((item) => !item.prunable)]) {
		const title = item.prunable ? `Prunable: ${item.reason}` : `Blocked: ${item.path ? item.reason : `${item.reason}; no checkout`}`;
		if (groups.has(title)) groups.get(title)!.push(item);
		else groups.set(title, [item]);
	}
	const rows = [...groups].flatMap(([title, group]) => {
		const section: Section = { heading: `${title} (${group.length})`, tone: group[0]!.prunable ? "success" : "error", rows: [] };
		return Array.from({ length: Math.ceil(group.length / 10) }, (_, index) => {
			const chunk = group.slice(index * 10, index * 10 + 10);
			return { section, index, items: chunk, row: { text: chunk.map(shortId).join(", "), code: true } };
		});
	});
	const prunable = items.filter((item) => item.prunable).length;
	const head: Report = { tone: "info", title: "Subagent prune review", sections: [{ rows: [
		{ label: "root", value: root, code: true }, { label: "prunable", value: String(prunable) }, { label: "blocked", value: String(items.length - prunable) },
		{ label: "IDs", value: "first 8 characters after pi-subagent/subagent-" },
	] }] };
	// Each line measures its exact Markdown, so the cap never cuts a shown item.
	const reviewed = fitItems(reportMarkdown(head), rows, ({ section, index, row }) => index ? sectionMarkdown({ rows: [row] }) : `\n${sectionMarkdown({ ...section, rows: [row] })}`,
		ROLES_REPORT_CODE_POINTS, NOT_SHOWN, (row) => row.items.length);
	const sections = [...new Set(reviewed.shown.map(({ section }) => section))]
		.map((section) => ({ ...section, rows: reviewed.shown.filter((row) => row.section === section).map(({ row }) => row) }));
	return { report: { ...head, sections: [...head.sections, ...sections, ...moreSection(reviewed.more)] }, shown: reviewed.shown.flatMap((row) => row.items) };
}

function discardReview(plan: DiscardPlan): { report: Report; shown: DiscardPlan["items"] } {
	if (!plan.items.length) return { report: { tone: "info", title: `No remaining owned resources for ${plan.requestId}.`, sections: [] }, shown: [] };
	const section = (item: DiscardPlan["items"][number]): Section => ({ heading: item.key, note: item.blockers.length ? "blocked" : "can delete",
		tone: item.blockers.length ? "error" : "warning", rows: [
			{ label: "path", value: item.path ?? "none", code: item.path !== undefined },
			{ label: "checkout", value: item.checkout ? "yes" : "no" },
			{ label: "branch", value: item.branch ?? "none", code: item.branch !== undefined },
			{ label: "tip", value: item.tip ?? "none", code: item.tip !== undefined },
			{ label: "commits ahead of recorded base", value: `${item.commits ?? "unknown"}` },
			{ label: "dirty", value: item.dirty === undefined ? "not inspected" : item.dirty ? "yes" : "no" },
			{ label: "ignored entries, deleted with all content inside them", value: item.ignored.join(", ") || "none", code: item.ignored.length > 0 },
			{ label: "Herdr resources", value: item.hosts.join("; ") || "none" },
			{ label: "blockers", value: item.blockers.join("; ") || "none", ...item.blockers.length ? { tone: "error" as const } : {} },
		] });
	const head: Report = { tone: "warning", title: `Close and delete request ${plan.requestId}`, sections: [] };
	const reviewed = fitItems(reportMarkdown(head), plan.items, (item) => `\n${sectionMarkdown(section(item))}`, ROLES_REPORT_CODE_POINTS,
		"they are not removed; reopen this request to review them.");
	return { report: { ...head, sections: [...reviewed.shown.map(section), ...moreSection(reviewed.more)] }, shown: reviewed.shown };
}

function directReport(task: DirectTask): Report {
	const [first] = task.workers;
	const missing = first ? first.workers - task.workers.length : 0;
	const untabbed = task.workers.filter((worker) => !task.tabs.some((tab) => tab.display?.worker === worker.worker));
	return { tone: statusTone(task.status), title: `Direct workflow ${directLabel(task)} · ${task.status}${costSuffix(task.cost)}`, sections: [
		{ rows: [{ label: "ID", value: task.id, code: true }, ...(task.recovery ? [{ label: "recovery", value: clean(task.recovery, 4000), tone: "warning" as const }] : [])] },
		...task.tabs.map((tab): Section => ({ heading: tab.display ? workerLabel(tab.display) : tab.name, rows: [
			...([["task", tab.entryId], ["agent", tab.name], ["tab", tab.tabId], ["pane", tab.paneId], ["session", tab.sessionFile]] as const).map(([label, value]) => ({ label, value, code: true })),
			...(compactCost(tab.cost) === undefined ? [] : [{ label: "cost", value: compactCost(tab.cost)! }]),
		] })),
		...(untabbed.length || missing > 0 ? [{ rows: [
			...untabbed.map((worker) => ({ text: `${workerLabel(worker)} · no verified tab recorded` })),
			...(missing > 0 ? [{ text: `${missing} other worker(s) in D${first!.workflow} have no recorded tab.` }] : []),
		] }] : []),
	] };
}

const WORKING_REPORT_CODE_POINTS = 4_000;
/** Current work from local and saved evidence only. Recorded-only direct work and isolated work without a live lease never count as working. */
export function workingReport(direct: readonly DirectTask[], inventory: IsolatedInventory | undefined): Report {
	const working: Row[] = [];
	const attention: Row[] = [];
	const unverified: Row[] = [];
	for (const task of direct) {
		const text = `${directLabel(task)} · ${task.status}`;
		// Read workflows list their running workers; write workflows stay observed locally until their workers are proved stopped.
		if (task.status === "observed locally" && task.stoppable?.length !== 0) working.push({ text: task.stoppable ? `${directLabel(task)} · ${task.stoppable.length} running` : text });
		else if (/retained/.test(task.status)) attention.push({ text });
		else if (completed(task.status)) continue;
		else unverified.push({ text: task.status === "observed locally" ? `${text}; no running worker` : text });
	}
	for (const request of inventory?.requests ?? []) {
		const active = !request.orphaned && ["pending", "running"].includes(request.status);
		if (active && inventory!.leaseLive) working.push({ text: isolatedLabel(request) });
		else if (active) attention.push({ text: `${isolatedLabel(request)} · interrupted; run /subagent recover` });
		else if (!request.orphaned && request.status === "needs_attention") attention.push({ text: isolatedLabel(request) });
	}
	const sections: Section[] = [
		working.length ? { heading: `Working (${working.length})`, tone: "info", rows: working } : { rows: [{ text: "No subagents are working." }] },
		{ heading: `Needs attention (${attention.length})`, tone: "warning", rows: attention },
		{ heading: `Unverified (${unverified.length})`, note: "not proof of running or completion", tone: "warning", rows: unverified },
	];
	const head: Report = { tone: attention.length ? "warning" : "info", title: "Current subagent work", sections: [] };
	const items = sections.flatMap((section) => section.rows.map((row, index) => ({ section, index, row })));
	const fitted = fitItems(reportMarkdown(head), items, ({ section, index, row }) => index ? sectionMarkdown({ rows: [row] }) : `\n${sectionMarkdown({ ...section, rows: [row] })}`,
		WORKING_REPORT_CODE_POINTS, "open /subagent with interactive UI to see them.");
	return { ...head, sections: [...sections.flatMap((section) => {
		const rows = fitted.shown.filter((item) => item.section === section).map(({ row }) => row);
		return rows.length ? [{ ...section, rows }] : [];
	}), ...moreSection(fitted.more)] };
}

type Choice<T> = { label: string; value: T };
async function choose<T>(ctx: ExtensionContext, title: string, items: readonly Choice<T>[]): Promise<T | undefined> {
	// Numeric suffixes only tell duplicate labels apart. Never parse display text into an identity.
	const clipped = items.map((item) => clean(item.label, 145));
	const labels = clipped.map((label, index) => clipped.indexOf(label) === clipped.lastIndexOf(label) ? label : `${label} [${index + 1}]`);
	const selected = await ctx.ui.select(title, labels);
	const index = labels.indexOf(selected ?? "");
	return index < 0 ? undefined : items[index]!.value;
}

/** Multi-select on single-choice `select`: each pick toggles one row until Continue. Returns chosen values in
 * item order, or undefined on Cancel or a changed session. Only selectable rows are offered. */
async function chooseMany<T>(ctx: ExtensionContext, title: string, items: readonly Choice<T>[], preselected: readonly T[],
	valid: () => boolean): Promise<T[] | undefined> {
	type Pick = { kind: "toggle"; value: T } | { kind: "all" } | { kind: "clear" } | { kind: "continue" } | { kind: "cancel" };
	const chosen = new Set(preselected);
	for (;;) {
		const picked = await choose<Pick>(ctx, title, [
			...items.map((item) => ({ label: `${chosen.has(item.value) ? "[x]" : "[ ]"} ${item.label}`, value: { kind: "toggle" as const, value: item.value } })),
			{ label: "Select all", value: { kind: "all" } }, { label: "Clear", value: { kind: "clear" } },
			{ label: `Continue (${chosen.size} selected)`, value: { kind: "continue" } }, { label: "Cancel", value: { kind: "cancel" } },
		]);
		if (!valid() || !picked || picked.kind === "cancel") return undefined;
		if (picked.kind === "continue") return items.map(({ value }) => value).filter((value) => chosen.has(value));
		if (picked.kind === "all") for (const { value } of items) chosen.add(value);
		else if (picked.kind === "clear") chosen.clear();
		else if (!chosen.delete(picked.value)) chosen.add(picked.value);
	}
}

// The owner is named once, so clipping keeps the other blockers.
const pruneLabel = (item: PruneItem) => item.override === "discard"
	? [`${shortId(item)} · delete whole request ${item.owner!.id} (${item.owner!.status})`, ...item.blockers.filter(({ kind }) => kind !== "owner").map(({ text }) => text)].join(" · ")
	: `${shortId(item)} · ${item.prunable ? "" : "force · "}${item.reason}`;

export function registerSubagentCommand(pi: ExtensionAPI, adapter: SubagentCommandAdapter): void {
	pi.registerEntryRenderer<Report>(REPORT_ENTRY, (entry, _options, theme) => entry.data && reportComponent(entry.data, theme, 1));
	pi.registerMessageRenderer(RECOVERY_MESSAGE, (message, { outputPad }, theme) => reportComponent(textReport("info", typeof message.content === "string"
		? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"), "Recovery report"), theme, outputPad));
	/** The TUI gets a themed transcript entry that stays out of model context; other modes get the same capped Markdown. */
	const deliver = (ctx: ExtensionContext, report: Report, customType = REPORT_ENTRY) => {
		if (ctx.hasUI && ctx.mode === "tui") return pi.appendEntry(REPORT_ENTRY, report);
		const text = clean(reportMarkdown(report), ROLES_REPORT_CODE_POINTS, true);
		if (ctx.hasUI) ctx.ui.notify(text, LEVEL[report.tone]);
		else pi.sendMessage({ customType, content: text, display: true });
	};
	pi.registerCommand("subagent", {
		description: "Inspect direct and isolated work, list Roles with /subagent roles, recover orphaned isolated requests with /subagent recover, or remove merged leftover worktrees with /subagent prune",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command && !["prune", "recover", "roles"].includes(command)) throw new Error("Usage: /subagent [prune|recover|roles]");
			if (command === "roles") {
				deliver(ctx, rolesReport(adapter.roles(ctx)), "pi-subagent-roles");
				return;
			}

			const manager = ctx.sessionManager;
			const session = manager.getSessionId();
			const file = manager.getSessionFile();
			const branch = manager.getBranch().map((entry) => entry.id);
			// A branch may grow during a dialog, but navigating to a descendant that
			// already existed when it opened must not retarget its pending actions.
			const existing = new Set(manager.getEntries().map((entry) => entry.id));
			const epoch = adapter.epoch();
			const current = () => {
				if (adapter.epoch() !== epoch || manager.getSessionId() !== session || manager.getSessionFile() !== file) return false;
				const now = manager.getBranch();
				return now.length >= branch.length && branch.every((id, index) => now[index]?.id === id)
					&& now.slice(branch.length).every((entry) => !existing.has(entry.id));
			};
			if (command === "recover") {
				const report = await adapter.recover(ctx.cwd);
				if (!current()) return;
				pi.sendMessage({ customType: RECOVERY_MESSAGE, content: report, display: true },
					{ triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			const valid = () => {
				if (current()) return true;
				ctx.ui.notify("Session or branch changed; reopen /subagent in the current context.", "warning");
				return false;
			};
			/** Review each request's discard plan, then one confirmation covers every shown unblocked group.
			 * `whole` states that a request is deleted although only some of its resources were selected. Returns false when stale. */
			const discardRequests = async (requests: readonly IsolatedRequest[], whole = false): Promise<boolean> => {
				const plans: DiscardPlan[] = [];
				for (const request of requests) {
					try {
						const plan = await adapter.discardPlan(ctx.cwd, request);
						const reviewed = discardReview(plan);
						if (!valid()) return false;
						deliver(ctx, reviewed.report);
						const items = reviewed.shown.filter((item) => !item.blockers.length);
						if (items.length) plans.push({ ...plan, items });
					} catch (error) {
						if (!valid()) return false;
						ctx.ui.notify(`Close and delete failed for ${request.id}: ${errorText(error)}`, "error");
					}
				}
				if (!plans.length) return true;
				const groups = plans.reduce((sum, plan) => sum + plan.items.length, 0);
				const confirmed = await ctx.ui.confirm("Close and delete worktrees (discard work)", clean(`${whole
					? `This closes and deletes each whole owning request (${plans.map(({ requestId }) => requestId).join(", ")}), not only the selected worktrees. ` : ""}`
					+ `Stop the listed workers and delete the ${groups} unblocked resource group(s) shown above${plans.length > 1 ? ` across ${plans.length} requests` : ""}? Committed, uncommitted, and ignored content in the listed checkouts is permanently deleted. Their listed branches, Herdr tabs, and workspaces are removed. Items not shown or blocked are kept.`,
				PRUNE_IGNORED_CONFIRM_CODE_POINTS));
				if (!valid()) return false;
				if (!confirmed) return true;
				for (const plan of plans) {
					try {
						const report = await adapter.discard(ctx.cwd, plan, current);
						if (!valid()) return false;
						deliver(ctx, cleanupReport(report));
					} catch (error) {
						if (!valid()) return false;
						ctx.ui.notify(`Close and delete failed for ${plan.requestId}: ${errorText(error)}`, "error");
					}
				}
				return true;
			};
			if (command === "prune") {
				const plan = await adapter.prunePlan(ctx.cwd);
				const reviewed = pruneReview(plan);
				if (!ctx.hasUI) {
					deliver(ctx, { ...reviewed.report, sections: [...reviewed.report.sections, { rows: [{ text: "Report only: removal requires interactive confirmation." }] }] }, "pi-subagent-prune");
					return;
				}
				if (!valid()) return;
				deliver(ctx, reviewed.report);
				const options = reviewed.shown.filter((item) => item.prunable || item.override);
				if (!options.length) return;
				// Continue confirms prunable items; each is re-verified first. Blocked items need their own confirmation below.
				const picked = await chooseMany(ctx, "Prune subagent worktrees · prunable items are selected", options.map((item) => ({ label: pruneLabel(item), value: item })),
					options.filter((item) => item.prunable), valid);
				if (!picked?.length) return;
				const forceable = picked.filter((item) => item.override === "force");
				const forceList = fitItems(`Force remove ${forceable.length} blocked item(s)? This permanently deletes their unique commits, tracked and untracked changes, in-progress Git operations, and initialized submodules, as listed. Each is re-verified first and kept if a new kind of blocker appears:`,
					forceable, (item) => `${shortId(item)}: ${item.reason}`, PRUNE_IGNORED_CONFIRM_CODE_POINTS);
				const force = forceList.shown.length > 0 && await ctx.ui.confirm("Force remove blocked worktrees",
					clean(forceList.text.replace(`Force remove ${forceable.length} blocked`, `Force remove ${forceList.shown.length} blocked`), PRUNE_IGNORED_CONFIRM_CODE_POINTS, true));
				if (!valid()) return;
				if (forceable.length && !force) ctx.ui.notify(`Kept ${forceable.length} blocked item(s); force removal was not approved.`, "info");
				const prunable = [...picked.filter((item) => item.prunable), ...force ? forceList.shown : []];
				const ignored = prunable.filter((item) => item.ignored.length);
				// The header uses the full count's width so the shown count always fits.
				const ignoredList = fitItems(`Also remove ${ignored.length} checkout(s) with ignored files? This permanently deletes these ignored entries and everything inside them:`,
					// Approval names every ignored entry; a checkout whose full list does not fit is left out of this run.
					ignored, (item) => clean(`${item.path}: ${item.ignored.join(", ")}`, Number.MAX_SAFE_INTEGER), PRUNE_IGNORED_CONFIRM_CODE_POINTS);
				const approvable = ignoredList.shown;
				const allowIgnored = approvable.length > 0 && await ctx.ui.confirm("Delete ignored content",
					clean(ignoredList.text.replace(`Also remove ${ignored.length} checkout(s)`, `Also remove ${approvable.length} checkout(s)`), PRUNE_IGNORED_CONFIRM_CODE_POINTS, true));
				if (!valid()) return;
				const kept = ignored.length - (allowIgnored ? approvable.length : 0);
				if (kept) ctx.ui.notify(`Kept ${kept} checkout(s) with ignored content; their deletion was not approved.`, "info");
				const selected = prunable.filter((item) => !item.ignored.length || (allowIgnored && approvable.includes(item)));
				if (selected.length) {
					try {
						const report = await adapter.prune(ctx.cwd, selected, allowIgnored, force, current);
						if (!valid()) return;
						deliver(ctx, cleanupReport(report));
					} catch (error) {
						if (!valid()) return;
						ctx.ui.notify(`Prune failed: ${errorText(error)}`, "error");
					}
				}
				// Discard owns request-owned items: it closes the request's own workers and panes, then removes its resources.
				const owners = new Map(picked.flatMap((item) => item.override === "discard" ? [[`${item.owner!.directory}\0${item.owner!.id}`, item.owner!] as const] : []));
				await discardRequests([...owners.values()].map((owner) => ({ ...owner, tasks: [] })), true);
				return;
			}
			if (!ctx.hasUI) {
				const inventory = await adapter.isolated(ctx.cwd, current);
				deliver(ctx, workingReport(adapter.direct(ctx), inventory));
				const head: Report = { tone: "info", title: "Isolated requests (report only)", sections: [] };
				const row = (request: IsolatedRequest): Row => ({ text: `${glyph(request.status)} ${request.orphaned ? "orphaned · " : ""}${isolatedLabel(request)}` });
				const listed = fitItems(`${reportMarkdown(head)}\n`, inventory.requests, (request) => sectionMarkdown({ rows: [row(request)] }), ROLES_REPORT_CODE_POINTS,
					"open /subagent with interactive UI to inspect them.");
				deliver(ctx, { ...head, sections: [
					...(listed.shown.length ? [{ rows: listed.shown.map(row) }] : []), ...moreSection(listed.more),
					{ rows: [{ text: `Unreadable state files preserved: ${inventory.invalidIds.length}.` }, { text: "Removal requires interactive confirmation." }] },
				] }, "pi-subagent-discard");
				return;
			}
			let history = false;
			// The working report shows on open and on each Refresh, not after other menu actions.
			let report = true;
			for (;;) {
				if (!valid()) return;
				// Direct recovery is independent of Git and isolated config/inventory failures.
				const direct = adapter.direct(ctx);
				let inventory: IsolatedInventory | undefined;
				let unavailable: string | undefined;
				try { inventory = await adapter.isolated(ctx.cwd, current); }
				catch (error) { unavailable = errorText(error); }
				if (!valid()) return;
				if (report) deliver(ctx, workingReport(direct, inventory));
				report = false;
				if (unavailable) ctx.ui.notify(`Isolated inventory unavailable (${unavailable}). Direct branch recovery remains available; check the canonical Git checkout/configuration.`, "warning");
				if (inventory?.invalidIds.length) for (const id of inventory.invalidIds) ctx.ui.notify(`Unreadable isolated state ID: ${JSON.stringify(id)}. Preserve this file; inspect the state store before making changes.`, "warning");
				type Selection = { kind: "direct"; task: DirectTask } | { kind: "isolated"; request: IsolatedRequest; root: string } | { kind: "refresh" } | { kind: "history" } | { kind: "many" } | { kind: "close" };
				// A header row selects Refresh; rows sort by status priority within their group.
				const group = <T extends { status: string }>(title: string, items: readonly T[], choice: (item: T) => Choice<Selection>): Choice<Selection>[] =>
					items.length ? [{ label: `── ${title} (${items.length}) ──`, value: { kind: "refresh" } },
						...[...items].sort((a, b) => priority(a.status) - priority(b.status)).map(choice)] : [];
				const requests = inventory?.requests ?? [];
				const isolatedChoice = (request: IsolatedRequest): Choice<Selection> => ({ label: `  ${glyph(request.status)} ${isolatedLabel(request)}`, value: { kind: "isolated", request, root: inventory!.root } });
				// One row per workflow; new records keep opaque IDs in details. Status is last so clipping preserves the reference.
				const directChoice = (task: DirectTask): Choice<Selection> => ({ label: `  ${glyph(task.status)} ${directLabel(task)} · ${task.status}${costSuffix(task.cost)}${task.workers.length || task.name === task.id ? "" : ` · ${task.id}`}`, value: { kind: "direct", task } });
				const groups = [
					group("Direct", direct.filter((task) => history || !completed(task.status)), directChoice),
					group("Isolated", requests.filter((request) => !request.orphaned && (history || !completed(request.status) || /retained/i.test(request.status))), isolatedChoice),
					group("Orphaned · parent checkout removed", requests.filter((request) => request.orphaned), isolatedChoice),
				].flat();
				const rows = groups.filter(({ value }) => value.kind === "direct" || value.kind === "isolated");
				const selections: Choice<Selection>[] = [
					...groups,
					...(rows.length ? [{ label: "Select multiple…", value: { kind: "many" as const } }] : []),
					{ label: "Refresh", value: { kind: "refresh" } },
					{ label: history ? "Active work" : "Completed / history (including retained work)", value: { kind: "history" } },
					{ label: "Close", value: { kind: "close" } },
				];
				if (!unavailable && !direct.length && !inventory?.requests.length && !inventory?.invalidIds.length) ctx.ui.notify("No direct tasks recorded on this session branch or isolated requests in this checkout. Ask Main to start delegation.", "info");
				const selected = await choose(ctx, history ? "Subagent · completed / history" : "Subagent · current work", selections);
				if (!valid() || !selected || selected.kind === "close") return;
				if (selected.kind === "refresh") { report = true; continue; }
				if (selected.kind === "history") { history = !history; continue; }
				if (selected.kind === "many") {
					const picked = await chooseMany(ctx, "Subagent · select work", rows.map(({ label, value }) => ({ label: label.trim(), value })), [], valid);
					if (!picked?.length) { if (!valid()) return; continue; }
					const isolated = picked.flatMap((item) => item.kind === "isolated" ? [item.request] : []);
					const closable = picked.flatMap((item) => item.kind === "direct" && item.task.canClose ? [item.task] : []);
					type Batch = "discard" | "close" | "back";
					const action = await choose<Batch>(ctx, `Subagent · ${picked.length} selected`, [
						...(isolated.length ? [{ label: `Close and delete worktrees (discard work) of ${isolated.length} isolated request(s)`, value: "discard" as const }] : []),
						...(closable.length ? [{ label: `Close/cancel-and-release ALL owned workers in ${closable.length} direct workflow(s) (preserve files and commits)`, value: "close" as const }] : []),
						{ label: "Back / refresh", value: "back" },
					]);
					if (!valid()) return;
					if (!action || action === "back") continue;
					const skipped = picked.length - (action === "discard" ? isolated.length : closable.length);
					if (skipped) ctx.ui.notify(`Skipped ${skipped} selected item(s) that this action does not apply to.`, "info");
					if (action === "discard") { if (!await discardRequests(isolated)) return; continue; }
					for (const task of closable) {
						try {
							const report = await adapter.closeDirect(task, current);
							if (!valid()) return;
							deliver(ctx, textReport("success", report));
						} catch (error) {
							if (!valid()) return;
							ctx.ui.notify(`Admission retained for ${clean(directLabel(task))}: ${errorText(error)}. Inspect the exact tab/session; retry Close/cancel-and-release after resolving termination.`, "error");
						}
					}
					continue;
				}
				if (selected.kind === "direct") {
					const { task } = selected;
					const label = clean(directLabel(task));
					deliver(ctx, directReport(task));
					const stoppable = task.tabs.filter((tab) => task.stoppable?.includes(tab.entryId));
					if (task.canClose || stoppable.length) {
						const action = await choose<{ kind: "close" | "back" } | { kind: "stop"; entryId: string }>(ctx, `Direct · ${label}`, [
							...(task.canClose ? [{ label: "Close/cancel-and-release ALL owned workers in this workflow (preserve files and commits)", value: { kind: "close" as const } }] : []),
							...stoppable.map((tab) => ({ label: `Stop this worker: ${tab.display ? workerLabel(tab.display) : tab.name} (other workers continue)`, value: { kind: "stop" as const, entryId: tab.entryId } })),
							{ label: "Back / refresh", value: { kind: "back" as const } },
						]);
						if (!valid()) return;
						if (action?.kind === "stop") {
							try {
								const report = await adapter.stopDirect(task, action.entryId, current);
								if (valid()) deliver(ctx, textReport("success", report));
							} catch (error) { if (valid()) ctx.ui.notify(`Worker stop failed: ${errorText(error)}. Inspect the exact tab/session before retrying.`, "error"); }
						}
						if (action?.kind === "close") {
							try {
								const report = await adapter.closeDirect(task, current);
								if (valid()) deliver(ctx, textReport("success", report));
							} catch (error) { if (valid()) ctx.ui.notify(`Admission retained: ${errorText(error)}. Inspect the exact tab/session; retry Close/cancel-and-release after resolving termination.`, "error"); }
						}
					}
					continue;
				}
				const { root, request } = selected;
				for (;;) {
					if (!valid()) return;
					type Action = "inspect" | "send" | "edit" | "discard" | "back";
					const eligible = request.tasks.filter((task) => task.kind === "changeset" && adapter.canFollowup(root, request.id, task.id));
					const actions: Choice<Action>[] = [
						...(!request.orphaned ? [{ label: "Inspect status and recovery", value: "inspect" as const }] : []),
						{ label: "Close and delete worktrees (discard work)", value: "discard" },
						...(eligible.length ? [{ label: "Send follow-up instructions", value: "send" as const }, { label: "Edit queued instructions (withdraw ALL pending; Cancel leaves withdrawn)", value: "edit" as const }] : []),
						{ label: "Back / refresh", value: "back" },
					];
					const action = await choose(ctx, `${request.orphaned ? "Orphaned" : "Isolated"} · ${request.id} · ${summary(request.name)}`, actions);
					if (!valid() || !action) return;
					if (action === "back") break;
					if (action === "discard") {
						if (!await discardRequests([request])) return;
						break;
					}
					if (action === "inspect") {
						try {
							const tab = await adapter.inspectInTab(root, request.id, ctx, current);
							if (valid()) deliver(ctx, { tone: "success", title: `Status inspection ${tab.ref} started`, sections: [{ rows: [
								{ label: "tab", value: tab.tabId, code: true }, { label: "agent", value: tab.name, code: true }, { label: "session", value: tab.sessionFile, code: true }] }] });
						}
						catch (error) { if (valid()) ctx.ui.notify(`Inspection failed: ${errorText(error)}`, "error"); }
						continue;
					}
					const live = request.tasks.filter((task) => task.kind === "changeset" && adapter.canFollowup(root, request.id, task.id));
					if (!live.length) { ctx.ui.notify("No locally active unsealed changeset remains. Refresh to see current status.", "warning"); continue; }
					const task = await choose(ctx, `Select task for ${action === "edit" ? "withdrawal and edit" : "follow-up"}`, live.map((item) => ({ label: `${item.id} · ${item.status} · ${summary(item.name)}`, value: item })));
					if (!valid() || !task) return;
					let prefill = "";
					if (action === "edit") {
						try {
							const withdrawn = adapter.drain(root, request.id, task.id, current);
							if (!withdrawn.length) { ctx.ui.notify("No pending instructions remain for this task; already-claimed instructions cannot be recalled.", "info"); continue; }
							prefill = withdrawn.join("\n\n");
						} catch (error) { if (valid()) ctx.ui.notify(`Cannot withdraw: ${errorText(error)}`, "error"); continue; }
					}
					for (;;) {
						const text = await ctx.ui.editor(action === "edit" ? "Edit withdrawn instructions · submit ONE replacement; Cancel leaves originals withdrawn" : "Send follow-up instructions", prefill);
						if (!valid() || text === undefined) return;
						try {
							ctx.ui.notify(adapter.enqueue(root, request.id, task.id, text, current), "info");
							break;
						} catch (error) {
							if (!valid()) return;
							ctx.ui.notify(`Not queued: ${errorText(error)}. Submitted text will reopen in this editor for editing or copying; Cancel does not queue it.`, "error");
							prefill = text;
						}
					}
				}
			}
		},
	});
}
