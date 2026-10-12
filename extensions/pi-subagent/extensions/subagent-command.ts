import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	/** Recorded workers by original index; empty for legacy records. */
	workers: readonly DirectDisplay[];
	tabs: readonly { entryId: string; name: string; tabId: string; paneId: string; sessionFile: string; display?: DirectDisplay }[];
}

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
	name: string;
	status: string;
	tasks: readonly IsolatedTask[];
}
export interface IsolatedInventory {
	root: string;
	requests: readonly IsolatedRequest[];
	invalidIds: readonly string[];
}

/** One pi-subagent branch and its checkout as reviewed by /subagent prune. */
export interface PruneItem {
	branch: string;
	tip: string;
	path?: string;
	prunable: boolean;
	/** Why the item is prunable, or every exact blocker. */
	reason: string;
	/** Ignored entries that removing the checkout deletes. */
	ignored: readonly string[];
}
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
	/** Re-verify and remove reviewed prunable items; returns a bounded report. */
	prune(cwd: string, items: readonly PruneItem[], allowIgnored: boolean, current: () => boolean): Promise<string>;
	/** Read-only Role catalog report with routes and per-file load errors. */
	roles(ctx: ExtensionContext): string;
	inspectInTab(root: string, requestId: string, ctx: ExtensionContext, current: () => boolean): Promise<{ ref: string; tabId: string; name: string; sessionFile: string }>;
	canFollowup(root: string, requestId: string, taskId: string): boolean;
	enqueue(root: string, requestId: string, taskId: string, text: string, current: () => boolean): string;
	drain(root: string, requestId: string, taskId: string, current: () => boolean): readonly string[];
	/** Session start/shutdown epoch; prevents same-session reload after an awaited dialog. */
	epoch(): number;
}

const clean = (text: string, max = 110, multiline = false): string => [...text.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, max).join("");
const ROLES_REPORT_CODE_POINTS = 16_000;
const errorText = (error: unknown): string => clean(error instanceof Error ? error.message : String(error), 500);
const completed = (status: string) => ["completed", "success", "failed", "failure", "aborted", "integrated"].includes(status);
const priority = (status: string) => /attention|blocked|retained|failed/i.test(status) ? 0 : completed(status) ? 2 : 1;

const ignoredSummary = ({ ignored }: PruneItem) => !ignored.length ? "none"
	: `${ignored.length} (${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? `, +${ignored.length - 5} more` : ""})`;
const PRUNE_IGNORED_CONFIRM_CODE_POINTS = 4_000;
const NOT_SHOWN = "they are not removed in this run; run /subagent prune again after this run.";

/** Fit whole item lines within `max` code points; never cut silently, and report exactly which items were shown. */
function fitItems<T>(header: string, items: readonly T[], line: (item: T) => string, max: number): { text: string; shown: T[] } {
	const lines = [header];
	const shown: T[] = [];
	let size = [...header].length;
	const reserve = [...NOT_SHOWN].length + 32;
	for (const item of items) {
		const text = line(item);
		const length = [...text].length + 1;
		if (size + length + reserve > max) break;
		lines.push(text);
		size += length;
		shown.push(item);
	}
	if (shown.length < items.length) lines.push(`+${items.length - shown.length} more not shown; ${NOT_SHOWN}`);
	return { text: lines.join("\n"), shown };
}

/** Prunable items come first so a long blocked list cannot hide them; only shown items may be removed. */
function pruneReview({ root, items }: PrunePlan): { text: string; shown: PruneItem[] } {
	if (!items.length) return { text: `No pi-subagent worktrees or branches in ${root}.`, shown: [] };
	const prunable = items.filter((item) => item.prunable).length;
	return fitItems(`Subagent prune review in ${root}: ${prunable} prunable, ${items.length - prunable} blocked.`,
		[...items.filter((item) => item.prunable), ...items.filter((item) => !item.prunable)],
		(item) => clean(`${item.prunable ? "✓ prunable" : "✗ blocked"} · ${item.path ?? "(no checkout)"} · ${item.branch} · ${item.tip.slice(0, 12)} · ${item.reason} · ignored: ${ignoredSummary(item)}`, 600),
		ROLES_REPORT_CODE_POINTS);
}

type Choice<T> = { label: string; value: T };
async function choose<T>(ctx: ExtensionContext, title: string, items: readonly Choice<T>[]): Promise<T | undefined> {
	// Numeric suffixes are UI-only. Never parse display text into an identity.
	const labels = items.map((item, index) => `${clean(item.label, 145)} [${index + 1}]`);
	const selected = await ctx.ui.select(title, labels);
	const index = labels.indexOf(selected ?? "");
	return index < 0 ? undefined : items[index]!.value;
}

export function registerSubagentCommand(pi: ExtensionAPI, adapter: SubagentCommandAdapter): void {
	pi.registerCommand("subagent", {
		description: "Inspect direct and isolated work, list Roles with /subagent roles, recover orphaned isolated requests with /subagent recover, or remove merged leftover worktrees with /subagent prune",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command && !["prune", "recover", "roles"].includes(command)) throw new Error("Usage: /subagent [prune|recover|roles]");
			if (command === "roles") {
				const report = clean(adapter.roles(ctx), ROLES_REPORT_CODE_POINTS, true);
				if (ctx.hasUI) ctx.ui.notify(report, "info");
				else pi.sendMessage({ customType: "pi-subagent-roles", content: report, display: true });
				return;
			}
			if (!command && !ctx.hasUI) throw new Error("/subagent requires interactive UI (TUI or RPC); use the subagent agent tools in non-interactive mode.");
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
				pi.sendMessage({ customType: "pi-subagent-recovery", content: report, display: true },
					{ triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			const valid = () => {
				if (current()) return true;
				ctx.ui.notify("Session or branch changed; reopen /subagent in the current context.", "warning");
				return false;
			};
			if (command === "prune") {
				const plan = await adapter.prunePlan(ctx.cwd);
				const reviewed = pruneReview(plan);
				const review = clean(reviewed.text, ROLES_REPORT_CODE_POINTS, true);
				if (!ctx.hasUI) {
					pi.sendMessage({ customType: "pi-subagent-prune", content: `${review}\nReport only: removal requires interactive confirmation.`, display: true });
					return;
				}
				if (!valid()) return;
				ctx.ui.notify(review, "info");
				const prunable = reviewed.shown.filter((item) => item.prunable);
				if (!prunable.length) return;
				const confirmed = await ctx.ui.confirm("Prune subagent worktrees", `Remove all ${prunable.length} prunable item(s) listed above? Each is re-verified first; unique commits, tracked or untracked changes, and unlisted items are never removed.`);
				if (!valid() || !confirmed) return;
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
				if (!selected.length) return;
				try {
					const report = await adapter.prune(ctx.cwd, selected, allowIgnored, current);
					if (valid()) ctx.ui.notify(clean(report, ROLES_REPORT_CODE_POINTS, true), "info");
				} catch (error) { if (valid()) ctx.ui.notify(`Prune failed: ${errorText(error)}`, "error"); }
				return;
			}
			let history = false;
			for (;;) {
				if (!valid()) return;
				// Direct recovery is independent of Git and isolated config/inventory failures.
				const direct = adapter.direct(ctx);
				let inventory: IsolatedInventory | undefined;
				let unavailable: string | undefined;
				try { inventory = await adapter.isolated(ctx.cwd, current); }
				catch (error) { unavailable = errorText(error); }
				if (!valid()) return;
				if (unavailable) ctx.ui.notify(`Isolated inventory unavailable (${unavailable}). Direct branch recovery remains available; check the canonical Git checkout/configuration.`, "warning");
				if (inventory?.invalidIds.length) for (const id of inventory.invalidIds) ctx.ui.notify(`Unreadable isolated state ID: ${JSON.stringify(id)}. Preserve this file; inspect the state store before making changes.`, "warning");
				type Selection = { kind: "direct"; task: DirectTask } | { kind: "isolated"; request: IsolatedRequest; root: string } | { kind: "refresh" } | { kind: "history" } | { kind: "close" };
				const selections: Choice<Selection>[] = [
					// One row per workflow; new records keep opaque IDs in details. Status is last so clipping preserves the reference.
					...direct.filter((task) => history || !completed(task.status)).map((task) => ({ label: `Direct · ${directLabel(task)} · ${task.status}${task.workers.length || task.name === task.id ? "" : ` · ${task.id}`}`, value: { kind: "direct" as const, task } })),
					...(inventory?.requests ?? []).filter((request) => history || !completed(request.status) || /retained/i.test(request.status)).map((request) => ({ label: `Isolated · ${request.name} · ${request.status} · ${request.id}`, value: { kind: "isolated" as const, request, root: inventory!.root } })),
					{ label: "Refresh", value: { kind: "refresh" as const } },
					{ label: history ? "Active work" : "Completed / history (including retained work)", value: { kind: "history" as const } },
					{ label: "Close", value: { kind: "close" as const } },
				];
				const taskChoices = selections.splice(0, selections.length - 3);
				const rank = ({ value }: Choice<Selection>) => value.kind === "direct" ? priority(value.task.status)
					: value.kind === "isolated" ? priority(value.request.status) : 3;
				taskChoices.sort((a, b) => rank(a) - rank(b));
				selections.unshift(...taskChoices);
				if (!unavailable && !direct.length && !inventory?.requests.length && !inventory?.invalidIds.length) ctx.ui.notify("No direct tasks recorded on this session branch or isolated requests in this checkout. Ask Main to start delegation.", "info");
				const selected = await choose(ctx, history ? "Subagent · completed / history" : "Subagent · current work", selections);
				if (!valid() || !selected || selected.kind === "close") return;
				if (selected.kind === "refresh") continue;
				if (selected.kind === "history") { history = !history; continue; }
				if (selected.kind === "direct") {
					const { task } = selected;
					const label = clean(directLabel(task));
					ctx.ui.notify(`Direct workflow ${label} · ${clean(task.status)} · ID ${JSON.stringify(task.id)}`, "info");
					if (task.recovery) ctx.ui.notify(clean(task.recovery, 4000), "warning");
					for (const tab of task.tabs) {
						ctx.ui.notify(`${tab.display ? `${clean(workerLabel(tab.display))} · ` : ""}task ${JSON.stringify(tab.entryId)} · agent ${JSON.stringify(tab.name)} · tab ${JSON.stringify(tab.tabId)} · pane ${JSON.stringify(tab.paneId)} · session ${JSON.stringify(tab.sessionFile)}`, "info");
					}
					const untabbed = task.workers.filter((worker) => !task.tabs.some((tab) => tab.display?.worker === worker.worker));
					for (const worker of untabbed) ctx.ui.notify(`${clean(workerLabel(worker))} · no verified tab recorded`, "info");
					if (task.workers[0] && task.workers.length < task.workers[0].workers) ctx.ui.notify(`${task.workers[0].workers - task.workers.length} other worker(s) in D${task.workers[0].workflow} have no recorded tab.`, "info");
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
								if (valid()) ctx.ui.notify(report, "info");
							} catch (error) { if (valid()) ctx.ui.notify(`Worker stop failed: ${errorText(error)}. Inspect the exact tab/session before retrying.`, "error"); }
						}
						if (action?.kind === "close") {
							try {
								const report = await adapter.closeDirect(task, current);
								if (valid()) ctx.ui.notify(report, "info");
							} catch (error) { if (valid()) ctx.ui.notify(`Admission retained: ${errorText(error)}. Inspect the exact tab/session; retry Close/cancel-and-release after resolving termination.`, "error"); }
						}
					}
					continue;
				}
				const { root, request } = selected;
				for (;;) {
					if (!valid()) return;
					type Action = "inspect" | "send" | "edit" | "back";
					const eligible = request.tasks.filter((task) => task.kind === "changeset" && adapter.canFollowup(root, request.id, task.id));
					const actions: Choice<Action>[] = [
						{ label: "Inspect status and recovery", value: "inspect" },
						...(eligible.length ? [{ label: "Send follow-up instructions", value: "send" as const }, { label: "Edit queued instructions (withdraw ALL pending; Cancel leaves withdrawn)", value: "edit" as const }] : []),
						{ label: "Back / refresh", value: "back" },
					];
					const action = await choose(ctx, `Isolated · ${clean(request.name)} · ${request.id}`, actions);
					if (!valid() || !action) return;
					if (action === "back") break;
					if (action === "inspect") {
						try {
							const tab = await adapter.inspectInTab(root, request.id, ctx, current);
							if (valid()) ctx.ui.notify(`Status inspection ${tab.ref} started in Herdr tab ${tab.tabId} · agent ${tab.name} · session ${tab.sessionFile}.`, "info");
						}
						catch (error) { if (valid()) ctx.ui.notify(`Inspection failed: ${errorText(error)}`, "error"); }
						continue;
					}
					const live = request.tasks.filter((task) => task.kind === "changeset" && adapter.canFollowup(root, request.id, task.id));
					if (!live.length) { ctx.ui.notify("No locally active unsealed changeset remains. Refresh to see current status.", "warning"); continue; }
					const task = await choose(ctx, `Select task for ${action === "edit" ? "withdrawal and edit" : "follow-up"}`, live.map((item) => ({ label: `${item.name} · ${item.status} · ${item.id}`, value: item })));
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
