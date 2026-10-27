import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { withWorktreeLock, type HerdrClient } from "@henryqw/pi-herdr";

const MAX_BYTES = 65_536;
const TOKEN = "pi_harness_main_tab";
const SOURCE = "pi-herdr-tools";
type Client = HerdrClient<{ signal: AbortSignal }>;
type Entry = { socketPath: string; workspaceId: string; tabId: string; token: string };
type State = { version: 1; workspaces: Record<string, Entry> };
type Location = {
	paneId: string; tabId: string; workspaceId: string; tabLabel: string; paneCount: number;
	workspaceLabel: string; checkoutPath: string; isLinkedWorktree: boolean;
};
type Selection<T> = Location & (
	| { selection: "main"; mainTabId: string; value: T }
	| { selection: "other-tab" | "stale-token"; mainTabId: string }
	| { selection: "unselected"; mainTabId: undefined }
);

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid main-tab data: expected an object.");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid main-tab text.");
	return value;
}
function id(value: unknown): string {
	const result = text(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(result)) throw new Error("Invalid Herdr identity.");
	return result;
}
function path(value: unknown): string {
	const result = text(value);
	if (!isAbsolute(result)) throw new Error("Main-tab paths must be absolute.");
	return result;
}
function positive(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("Invalid Herdr pane count.");
	return Number(value);
}
function result(response: unknown, type: string): Record<string, unknown> {
	const value = object(object(response).result);
	if (value.type !== type) throw new Error(`Expected Herdr ${type}.`);
	return value;
}
function key(entry: Pick<Entry, "socketPath" | "workspaceId">): string {
	return JSON.stringify([entry.socketPath, entry.workspaceId]);
}
function keys(value: Record<string, unknown>, expected: string[]): void {
	if (Object.keys(value).length !== expected.length || expected.some((name) => !Object.hasOwn(value, name))) throw new Error("Invalid main-tab state fields; file preserved.");
}
function token(workspace: Record<string, unknown>): string | undefined {
	if (workspace.tokens === undefined) return undefined;
	const value = object(workspace.tokens)[TOKEN];
	return value === undefined ? undefined : text(value);
}
async function workspace(client: Client, workspaceId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
	const value = object(result(await client.json(["workspace", "get", workspaceId], { signal }), "workspace_info").workspace);
	if (value.workspace_id !== workspaceId) throw new Error("Herdr workspace identity changed.");
	return value;
}
async function location(client: Client, paneId: string, signal: AbortSignal): Promise<{ location: Location; token?: string }> {
	signal.throwIfAborted();
	const pane = object(result(await client.json(["pane", "get", paneId], { signal }), "pane_info").pane);
	if (pane.pane_id !== paneId) throw new Error("Herdr pane identity changed.");
	const tabId = id(pane.tab_id), workspaceId = id(pane.workspace_id);
	const tab = object(result(await client.json(["tab", "get", tabId], { signal }), "tab_info").tab);
	if (tab.tab_id !== tabId || tab.workspace_id !== workspaceId) throw new Error("Herdr tab identity changed.");
	const tabLabel = text(tab.label), paneCount = positive(tab.pane_count);
	const ws = await workspace(client, workspaceId, signal);
	const workspaceLabel = text(ws.label);
	let checkoutPath: string, isLinkedWorktree = false;
	if (ws.worktree !== undefined && ws.worktree !== null) {
		const worktree = object(ws.worktree);
		checkoutPath = path(worktree.checkout_path);
		if (typeof worktree.is_linked_worktree !== "boolean") throw new Error("Invalid Herdr worktree type.");
		isLinkedWorktree = worktree.is_linked_worktree;
	} else {
		const panes = result(await client.json(["pane", "list", "--workspace", workspaceId], { signal }), "pane_list").panes;
		if (!Array.isArray(panes) || !panes.length) throw new Error("Herdr workspace has no verified pane directory.");
		checkoutPath = path(pane.cwd);
		let found = false;
		const seen = new Set<string>();
		for (const raw of panes) {
			const item = object(raw), paneIdentity = id(item.pane_id);
			if (seen.has(paneIdentity) || item.workspace_id !== workspaceId || path(item.cwd) !== checkoutPath) throw new Error("Herdr workspace pane directories do not agree.");
			seen.add(paneIdentity);
			if (paneIdentity === paneId) found = item.tab_id === tabId;
		}
		if (!found) throw new Error("Current pane is absent from its Herdr workspace.");
		// Check repository markers without a Git executable. Refuse uncertain Git scope.
		if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) throw new Error("Herdr omitted the Git checkout; main-tab selection is disabled.");
		for (let directory = await realpath(checkoutPath); ; directory = dirname(directory)) {
			signal.throwIfAborted();
			const names = await readdir(directory);
			if (names.includes(".git") || ["HEAD", "objects", "refs"].every((name) => names.includes(name))) throw new Error("Herdr omitted the Git checkout; main-tab selection is disabled.");
			if (dirname(directory) === directory) break;
		}
	}
	return { location: { paneId, tabId, workspaceId, tabLabel, paneCount, workspaceLabel, checkoutPath: await realpath(checkoutPath), isLinkedWorktree }, token: token(ws) };
}
async function stateDirectory(checkout: string, create: boolean, signal: AbortSignal): Promise<string> {
	let directory = checkout;
	for (const component of [".context", "pi-harness", "pi-herdr-tools"]) {
		signal.throwIfAborted();
		directory = join(directory, component);
		if (create) {
			try { await mkdir(directory, { mode: 0o700 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		}
		// Never traverse a checkout-controlled symlink, including in a parent component.
		const info = await lstat(directory);
		if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error(`Unsafe main-tab state directory: ${directory}`);
		if (component === "pi-herdr-tools" && (info.mode & 0o077) !== 0) throw new Error("Main-tab state directory is not private.");
	}
	return directory;
}

async function readState(file: string, signal: AbortSignal): Promise<State> {
	let handle;
	try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: {} }; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Main-tab state must be a bounded regular file; file preserved.");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > MAX_BYTES) throw new Error("Main-tab state exceeds 65536 bytes; file preserved.");
		const state = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))));
		keys(state, ["version", "workspaces"]);
		if (state.version !== 1) throw new Error("Unsupported main-tab state version; file preserved.");
		const entries = object(state.workspaces);
		for (const [entryKey, raw] of Object.entries(entries)) {
			const entry = object(raw);
			keys(entry, ["socketPath", "workspaceId", "tabId", "token"]);
			path(entry.socketPath); id(entry.workspaceId); id(entry.tabId);
			if (typeof entry.token !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.token) || key(entry as Entry) !== entryKey) throw new Error("Invalid main-tab state identity; file preserved.");
		}
		return state as State;
	} catch (error) {
		signal.throwIfAborted();
		const detail = error instanceof SyntaxError ? "Invalid JSON." : error instanceof Error ? error.message : "Invalid data.";
		throw new Error(`Cannot read main-tab state at ${file}; file preserved. ${detail}`, { cause: error });
	} finally { await handle.close(); }
}

/**
 * Run operation only for the verified main tab, under the shared state-directory lock.
 * The client must use HERDR_SOCKET_PATH. Missing scope, invalid data, and input/output errors throw.
 * On first use, auto selects Herdr's first-created tab, numbered 1.
 * Existing stale tokens or an unmatched live token require explicit selection.
 * select returns the selected location, including its validated tab label and pane count.
 * Call revalidate immediately before EACH workspace or branch mutation while the lock is held.
 * Workspace metadata resets on server restart. The random token is not authentication.
 * Other clients can clear it after a read; Herdr has no atomic token-check-and-mutate call.
 */
export async function withMainTab<T>(
	client: Client, paneId: string, signal: AbortSignal, action: "auto" | "select",
	operation: (location: Location, revalidate: () => Promise<void>) => Promise<T>,
): Promise<Selection<T>> {
	id(paneId);
	if (action !== "auto" && action !== "select") throw new Error("Invalid main-tab action.");
	if (typeof operation !== "function") throw new TypeError("Main-tab operation must be a function.");
	signal.throwIfAborted();
	const socketPath = resolve(path(process.env.HERDR_SOCKET_PATH));
	const initial = (await location(client, paneId, signal)).location;
	const directory = await stateDirectory(initial.checkoutPath, true, signal);
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		let entered = false;
		try {
			return await withWorktreeLock(directory, async () => {
				entered = true;
				signal.throwIfAborted();
				await stateDirectory(initial.checkoutPath, false, signal);
				const file = join(directory, "state.json"), state = await readState(file, signal);
				const live = await location(client, paneId, signal), current = live.location;
				if (current.checkoutPath !== initial.checkoutPath || current.workspaceId !== initial.workspaceId || current.tabId !== initial.tabId || resolve(path(process.env.HERDR_SOCKET_PATH)) !== socketPath) throw new Error("Herdr main-tab scope changed; try again.");
				const entryKey = key({ socketPath, workspaceId: current.workspaceId });
				let entry = state.workspaces[entryKey];
				let initialTab: string | undefined;
				if (!entry && action === "auto") {
					if (live.token) return { ...current, selection: "unselected", mainTabId: undefined };
					const tabs = result(await client.json(["tab", "list", "--workspace", current.workspaceId], { signal }), "tab_list").tabs;
					if (!Array.isArray(tabs)) throw new Error("Invalid Herdr tab list.");
					const first = tabs.map(object).filter((tab) => tab.workspace_id === current.workspaceId && tab.number === 1);
					if (first.length > 1) throw new Error("Herdr returned more than one first tab.");
					if (!first.length) return { ...current, selection: "unselected", mainTabId: undefined };
					initialTab = id(first[0].tab_id);
				}
				if (entry && entry.token !== live.token && action === "auto") return { ...current, selection: "stale-token", mainTabId: entry.tabId };
				if (action === "select" || initialTab) {
					const needsToken = !entry || entry.token !== live.token;
					entry = { socketPath, workspaceId: current.workspaceId, tabId: initialTab ?? current.tabId, token: needsToken ? randomUUID() : entry.token };
					state.workspaces[entryKey] = entry;
					const contents = `${JSON.stringify(state, null, 2)}\n`;
					if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("Main-tab state exceeds 65536 bytes; file preserved.");
					// Save first: an uncertain metadata write must leave a stale record, not permit auto recovery.
					await stateDirectory(initial.checkoutPath, false, signal);
					await writePrivateTextFileAtomically(file, contents, { signal });
					// --source identifies this writer; --token sets one named metadata value.
					if (needsToken) await client.run(["workspace", "report-metadata", current.workspaceId, "--source", SOURCE, "--token", `${TOKEN}=${entry.token}`], { signal });
				}
				const revalidate = async () => {
					signal.throwIfAborted();
					if (token(await workspace(client, current.workspaceId, signal)) !== entry.token) throw new Error("Herdr main-tab token changed; run /main-tab again.");
					signal.throwIfAborted();
				};
				await revalidate();
				if (entry.tabId !== current.tabId) return { ...current, selection: "other-tab", mainTabId: entry.tabId };
				return { ...current, selection: "main", mainTabId: entry.tabId, value: await operation(current, revalidate) };
			});
		} catch (error) {
			// Retry acquisition only. Never repeat the callback, write, or lock release.
			if (entered || (error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 400) throw error;
		}
		await delay(25, undefined, { signal });
	}
}
