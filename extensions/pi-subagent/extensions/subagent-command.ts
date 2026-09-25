import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Read-only branch records; the adapter groups all tabs of a direct workflow. */
export interface DirectTask {
	id: string;
	name: string;
	status: string;
	tabs: readonly { entryId: string; name: string; tabId: string; paneId: string; sessionFile: string }[];
}

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

/** Mutation adapters MUST check current() synchronously alongside their live ownership
 * validation and queue operation. They must not await between those operations. */
export interface SubagentCommandAdapter {
	direct(ctx: ExtensionContext): readonly DirectTask[];
	isolated(cwd: string): Promise<IsolatedInventory>;
	recover(cwd: string): Promise<string>;
	inspectInTab(root: string, requestId: string, ctx: ExtensionContext, current: () => boolean): Promise<{ tabId: string; name: string; sessionFile: string }>;
	canFollowup(root: string, requestId: string, taskId: string): boolean;
	enqueue(root: string, requestId: string, taskId: string, text: string, current: () => boolean): string;
	drain(root: string, requestId: string, taskId: string, current: () => boolean): readonly string[];
	/** Session start/shutdown epoch; prevents same-session reload after an awaited dialog. */
	epoch(): number;
}

const clean = (text: string, max = 110, multiline = false): string => [...text.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, max).join("");
const errorText = (error: unknown): string => clean(error instanceof Error ? error.message : String(error), 500);
const completed = (status: string) => ["completed", "success", "failed", "failure", "aborted", "integrated"].includes(status);
const priority = (status: string) => /attention|blocked|retained|failed/i.test(status) ? 0 : completed(status) ? 2 : 1;

type Pick<T> = { label: string; value: T };
async function choose<T>(ctx: ExtensionContext, title: string, items: readonly Pick<T>[]): Promise<T | undefined> {
	// Numeric suffixes are UI-only. Never parse display text into an identity.
	const labels = items.map((item, index) => `${clean(item.label, 145)} [${index + 1}]`);
	const selected = await ctx.ui.select(title, labels);
	const index = labels.indexOf(selected ?? "");
	return index < 0 ? undefined : items[index]!.value;
}

export function registerSubagentCommand(pi: ExtensionAPI, adapter: SubagentCommandAdapter): void {
	pi.registerCommand("subagent", {
		description: "Inspect direct and isolated work, or recover orphaned isolated requests with /subagent recover",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command && command !== "recover") throw new Error("Usage: /subagent [recover]");
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
			let history = false;
			for (;;) {
				if (!valid()) return;
				// Direct recovery is independent of Git and isolated config/inventory failures.
				const direct = adapter.direct(ctx);
				let inventory: IsolatedInventory | undefined;
				let unavailable: string | undefined;
				try { inventory = await adapter.isolated(ctx.cwd); }
				catch (error) { unavailable = errorText(error); }
				if (!valid()) return;
				if (unavailable) ctx.ui.notify(`Isolated inventory unavailable (${unavailable}). Direct branch recovery remains available; check the canonical Git checkout/configuration.`, "warning");
				if (inventory?.invalidIds.length) for (const id of inventory.invalidIds) ctx.ui.notify(`Unreadable isolated state ID: ${JSON.stringify(id)}. Preserve this file; inspect the state store before making changes.`, "warning");
				type Selection = { kind: "direct"; task: DirectTask } | { kind: "isolated"; request: IsolatedRequest; root: string } | { kind: "refresh" } | { kind: "history" } | { kind: "close" };
				const selections: Pick<Selection>[] = [
					...direct.filter((task) => history || !completed(task.status)).map((task) => ({ label: `Direct · ${task.name} · ${task.status} · ${task.id}`, value: { kind: "direct" as const, task } })),
					...(inventory?.requests ?? []).filter((request) => history || !completed(request.status) || /retained/i.test(request.status)).map((request) => ({ label: `Isolated · ${request.name} · ${request.status} · ${request.id}`, value: { kind: "isolated" as const, request, root: inventory!.root } })),
					{ label: "Refresh", value: { kind: "refresh" as const } },
					{ label: history ? "Active work" : "Completed / history (including retained work)", value: { kind: "history" as const } },
					{ label: "Close", value: { kind: "close" as const } },
				];
				const taskChoices = selections.splice(0, selections.length - 3);
				const rank = ({ value }: Pick<Selection>) => value.kind === "direct" ? priority(value.task.status)
					: value.kind === "isolated" ? priority(value.request.status) : 3;
				taskChoices.sort((a, b) => rank(a) - rank(b));
				selections.unshift(...taskChoices);
				if (!unavailable && !direct.length && !inventory?.requests.length && !inventory?.invalidIds.length) ctx.ui.notify("No direct tasks recorded on this session branch or isolated requests in this checkout. Ask Main to start delegation.", "info");
				const selected = await choose(ctx, history ? "Subagent · completed / history" : "Subagent · current work", selections);
				if (!valid() || !selected || selected.kind === "close") return;
				if (selected.kind === "refresh") continue;
				if (selected.kind === "history") { history = !history; continue; }
				if (selected.kind === "direct") {
					ctx.ui.notify(`Direct workflow ${clean(selected.task.name)} (${JSON.stringify(selected.task.id)}) · ${clean(selected.task.status)}`, "info");
					for (const tab of selected.task.tabs) {
						ctx.ui.notify(`Task ${JSON.stringify(tab.entryId)} · agent ${JSON.stringify(tab.name)} · tab ${JSON.stringify(tab.tabId)} · pane ${JSON.stringify(tab.paneId)} · session ${JSON.stringify(tab.sessionFile)}`, "info");
					}
					continue;
				}
				const { root, request } = selected;
				for (;;) {
					if (!valid()) return;
					type Action = "inspect" | "send" | "edit" | "back";
					const eligible = request.tasks.filter((task) => task.kind === "changeset" && adapter.canFollowup(root, request.id, task.id));
					const actions: Pick<Action>[] = [
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
							if (valid()) ctx.ui.notify(`Status inspection started in Herdr tab ${tab.tabId} · agent ${tab.name} · session ${tab.sessionFile}.`, "info");
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
