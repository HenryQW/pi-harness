import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isProcessLeaseIdentity } from "../dist/process-lease.js";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as herdr from "@henryqw/pi-herdr";
export { registerCheckoutAdmission } from "@henryqw/pi-herdr";

const JOURNAL = "subagent-direct-admission";
// An older installed package must still load this gate instead of failing a named import.
const checkoutToolCanWrite = herdr.checkoutToolCanWrite ?? ((name: string, input: unknown, direct: (input: unknown) => boolean) =>
	name === "delegate_task" ? direct(input) : !["read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "codemode"].includes(name));
type Record = { version: 1; sessionId: string; taskId: string; token: string; checkouts: string[]; state: "held" | "released";
	proof?: "not-dispatched" | "unproved" | "stopped"; resources?: unknown[]; release?: "proved" | "user-unproved";
	waiver?: { identity: string; evidence: string } };
const owner = (record: Record) => JSON.stringify([JOURNAL, record.sessionId, record.taskId, record.token]);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const parse = (value: unknown): Record => {
	const record = value as Record | undefined;
	if (!record || record.version !== 1 || !text(record.sessionId) || !text(record.taskId) || !text(record.token)
		|| (record.state !== "held" && record.state !== "released") || !Array.isArray(record.checkouts) || !record.checkouts.length
		|| record.checkouts.some((path) => !text(path) || !isAbsolute(path) || normalize(path) !== path)
		|| new Set(record.checkouts).size !== record.checkouts.length
		|| (record.resources !== undefined && !Array.isArray(record.resources))
		|| (record.proof !== undefined && (!["not-dispatched", "unproved", "stopped"].includes(record.proof) || !Array.isArray(record.resources)))
		|| (record.state === "released" ? !["proved", "user-unproved"].includes(record.release ?? "") : record.release !== undefined)
		|| (record.release === "proved" && !["not-dispatched", "stopped"].includes(record.proof ?? ""))
		|| (record.release === "user-unproved" ? !text(record.waiver?.identity) || !text(record.waiver?.evidence) : record.waiver !== undefined)) throw new Error("Malformed direct admission journal entry.");
	return record;
};
const sameSet = (a: Record, b: Record) => a.checkouts.length === b.checkouts.length && a.checkouts.every((path, index) => path === b.checkouts[index]);
const exactTab = (a: any, b: any) => ["taskId", "entryId", "name", "tabId", "paneId", "sessionFile"].every((key) => text(a[key]))
	&& ["taskId", "entryId", "name", "tabId", "paneId", "sessionFile", "leasePath", "turn", "cwd", "workspaceId"].every((key) => a[key] === b[key]);

const resourceEntries = (record: Record, entries: readonly SessionEntry[]) => entries.filter((entry) => entry.type === "custom"
	&& ["subagent-direct-tab", "subagent-direct-allocation"].includes(entry.customType) && (entry.data as any)?.taskId === record.taskId);
const hasProof = (record: Record, entries: readonly SessionEntry[]) => {
	const resources = record.resources as any[] | undefined;
	if (!resources) return false;
	if (record.proof === "not-dispatched") return !resources.length && !resourceEntries(record, entries).length;
	if (record.proof !== "stopped" || !resources.length) return false;
	const fields = ["entryId", "name", "sessionFile", "leasePath", "turn", "workspaceId", "cwd"];
	const tabFields = [...fields, "taskId", "tabId", "paneId"];
	const valid = (value: any, keys = fields) => value && typeof value === "object" && !Array.isArray(value)
		&& keys.every((key) => text(value[key])) && isProcessLeaseIdentity(value.leaseIdentity)
		&& ["sessionFile", "leasePath", "cwd"].every((key) => isAbsolute(value[key]) && normalize(value[key]) === value[key])
		&& value.sessionFile !== value.leasePath && dirname(value.sessionFile) === dirname(value.leasePath);
	const same = (left: any, right: any, keys = fields) => keys.every((key) => left[key] === right[key])
		&& Object.entries(left.leaseIdentity).every(([key, value]) => right.leaseIdentity[key] === value);
	const intents = resources.filter((resource) => resource?.kind === "allocation-intent");
	const tabs = resources.filter((resource) => resource?.kind === "verified-tab");
	// A pre-creation intent cannot establish the returned tab and pane identities.
	if (!intents.every((intent) => valid(intent) && text(intent.label))
		|| !tabs.every((tab) => valid(tab, tabFields) && tab.taskId === record.taskId)) return false;
	if (!["entryId", "name", "tabId", "paneId"].every((key) => new Set(tabs.map((tab) => tab[key])).size === tabs.length)) return false;
	const saved = entries.filter((entry) => entry.type === "custom" && entry.customType === "subagent-direct-tab")
		.map((entry) => (entry as { data: any }).data);
	return resources.every((resource) => {
		if (resource?.kind === "allocation-intent") return tabs.filter((tab) => same(resource, tab)).length === 1;
		if (resource?.kind === "verified-tab") return intents.filter((intent) => same(resource, intent)).length === 1;
		if (resource?.kind !== "continuation-sources" || !Array.isArray(resource.sources) || !resource.sources.length) return false;
		return resource.sources.every((source: any) => {
			if (!valid(source, tabFields)) return false;
			const originals = saved.filter((tab) => tab?.taskId === source.taskId && tab?.entryId === source.entryId);
			return originals.length > 0 && originals.every((tab) => valid(tab, tabFields) && same(source, tab, tabFields));
		});
	}) && resourceEntries(record, entries).every((entry) => {
		if (entry.type !== "custom" || entry.customType !== "subagent-direct-tab" || !valid(entry.data, tabFields)) return false;
		return tabs.some((tab) => same(tab, entry.data, tabFields));
	});
};

const identity = (record: Record) => `${record.sessionId}/${record.taskId}/${record.token}`;
const evidence = (record: Record, entries: readonly SessionEntry[]) => {
	const sources = (record.resources ?? []).flatMap((resource: any) => resource?.kind === "continuation-sources" && Array.isArray(resource.sources) ? resource.sources : []);
	return JSON.stringify({ admission: record, records: entries.filter((entry) => entry.type === "custom"
		&& ["subagent-direct-tab", "subagent-direct-allocation"].includes(entry.customType)
		&& ((entry.data as any)?.taskId === record.taskId || sources.some((source) => text(source?.taskId) && source.taskId === (entry.data as any)?.taskId && source.entryId === (entry.data as any)?.entryId)))
		// Native forks can change parent links and move labels; neither changes worker evidence.
		.map(({ id, customType, data }: any) => ({ id, customType, data })) });
};

function replay(entries: readonly SessionEntry[]): Map<string, Record> {
	const records = new Map<string, Record>();
	const held = new Set<string>();
	const tasks = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== JOURNAL) continue;
		const record = parse(entry.data), key = owner(record), previous = records.get(key);
		if (tasks.has(record.taskId) && tasks.get(record.taskId) !== key) throw new Error(`Direct task ${record.taskId} has conflicting reservation identities.`);
		tasks.set(record.taskId, key);
		if (previous && !sameSet(previous, record)) throw new Error(`Direct admission identity ${record.taskId} changed its checkout set.`);
		if (!previous && record.state === "released") throw new Error(`Direct release ${record.taskId} has no matching admission.`);
		// Release is terminal only for exact duplicates or an earlier saved hold.
		if (previous?.state === "released") {
			if (record.state === "released" ? !isDeepStrictEqual(previous, record) : !held.has(JSON.stringify(record))) {
				throw new Error("Direct admission evidence changed after release.");
			}
			continue;
		}
		if (previous && ((record.proof === "not-dispatched" && previous.proof !== "not-dispatched")
			|| (previous.resources && (!record.resources || previous.resources.some((resource, index) => JSON.stringify(resource) !== JSON.stringify(record.resources![index]))))
			|| (previous.proof === "stopped" && record.proof !== "stopped"))) throw new Error("Direct admission lost or changed its effect evidence.");
		if (record.state === "released") {
			const { release, waiver, ...checkpoint } = record;
			if (!isDeepStrictEqual({ ...checkpoint, state: "held" }, previous)
				|| (release === "proved" ? !hasProof(previous!, entries)
					: waiver!.identity !== identity(previous!) || waiver!.evidence !== evidence(previous!, entries))) {
				throw new Error("Direct release has incomplete or changed proof or user consent; protection retained.");
			}
		} else held.add(JSON.stringify(record));
		records.set(key, record);
	}
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "custom" || !["subagent-direct-tab", "subagent-direct-allocation"].includes(entry.customType)) continue;
		const tab = entry.data as any;
		if (!tab || !text(tab.taskId)) throw new Error("Malformed legacy direct worker record.");
		if (tasks.has(tab.taskId) || tab.access === "read") continue;
		const completed = entry.customType === "subagent-direct-tab" && entries.slice(index + 1).some((result) => {
			if (result.type !== "custom_message" || result.customType !== "subagent-direct-result") return false;
			const details = result.details as any;
			return details?.taskId === tab.taskId && ["completed", "failed"].includes(details.outcome) && details.recovery === undefined
				&& Array.isArray(details.tabs) && details.tabs.some((saved: any) => saved && exactTab(tab, saved))
				&& Array.isArray(details.entries) && details.entries.some((item: any) => item?.id === tab.entryId && ["succeeded", "rejected"].includes(item.status));
		});
		if (!completed) throw new Error(`Legacy direct task ${tab.taskId} has no admission journal or exact completed result. Its access and full checkout set cannot be proved; all writes and session switch/fork are blocked. Restore authoritative evidence; no scoped release is available.`);
	}
	return records;
}

/** Replay restores protection, not process-control authority. */
export function registerDirectAdmission(pi: ExtensionAPI, canWrite: (input: unknown) => boolean,
	select: (input: unknown, ctx: { cwd: string }) => Promise<readonly string[]>,
) {
	const admission = herdr.checkoutAdmission(pi);
	const compatible = admission.supportsDirectJournal === true && admission.supportsCheckoutSets === true
		&& [admission.beginReplacement, admission.admittedCheckouts, admission.restoreSet, admission.complete, admission.guard, admission.hold, admission.install, admission.classifyDirect].every((method) => typeof method === "function");
	let failure = compatible ? "Direct admission journal has not loaded; writes are blocked." : "The active checkout coordinator cannot replay direct admission journals. Load the current Pi Herdr package in every extension; writes are blocked.";
	let loadedSession: string | undefined;
	let initialized = false;
	let records = new Map<string, Record>();
	const claims = new Set<string>();
	const requireReady = () => { if (failure) throw new Error(failure); };
	const restore = (ctx: ExtensionContext) => {
		initialized = true;
		if (!compatible) throw new Error(failure);
		failure = "Direct admission journal restore failed; writes are blocked.";
		try {
			records = replay(ctx.sessionManager.getEntries());
			for (const [key, record] of records) {
				if (record.state === "released") admission.complete(key);
				else admission.restoreSet(key, record.checkouts);
			}
			loadedSession = ctx.sessionManager.getSessionId();
			failure = "";
		} catch (error) {
			failure = `${error instanceof Error ? error.message : String(error)} Writes are blocked.`;
			throw new Error(failure, { cause: error });
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("tool_call", (event, ctx) => {
		if (!checkoutToolCanWrite(event.toolName, event.input, canWrite)) return;
		if (!initialized && compatible) { try { restore(ctx); } catch { /* Pi swallows lifecycle errors; keep this gate closed. */ } }
		if (failure) return { block: true, reason: failure };
	});
	const beforeReplace = (event: { type: string; entryId?: string; position?: string }, ctx: ExtensionContext) => {
		try {
			restore(ctx);
			if ([...records.values()].some(({ state }) => state === "held")) throw new Error("Direct writer admission is unresolved. Use /subagent before session switch or fork.");
			if (event.type === "session_before_fork") {
				const selected = ctx.sessionManager.getEntry(event.entryId!);
				if (!selected) throw new Error("Fork target is unavailable.");
				const leaf = event.position === "at" ? selected.id : selected.parentId;
				const copied = replay(leaf ? ctx.sessionManager.getBranch(leaf) : []);
				if ([...copied.values()].some(({ state }) => state === "held")) throw new Error("This fork path omits a direct admission release. Select a path with complete admission evidence.");
			}
			// Synchronous with the final check: cover admitted preflight and refuse later direct calls.
			if (!admission.beginReplacement()) throw new Error("A direct writer is in preflight or still owns admission; session replacement is blocked.");
		} catch (error) {
			try { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); } catch { /* Notification cannot authorize replacement. */ }
			return { cancel: true };
		}
	};
	pi.on("session_before_switch", beforeReplace);
	pi.on("session_before_fork", beforeReplace);
	if (typeof admission.classifyDirect === "function") admission.classifyDirect(canWrite, select);
	if (compatible) {
		admission.guard(JOURNAL, async () => requireReady());
		admission.install(pi);
	}
	const save = (record: Record) => { pi.appendEntry(JOURNAL, record); records.set(owner(record), record); };

	return {
		hasProof: (record: Record, ctx: ExtensionContext) => hasProof(record, ctx.sessionManager.getEntries()),
		evidence: (record: Record, ctx: ExtensionContext) => evidence(record, ctx.sessionManager.getEntries()),
		inventory(ctx: ExtensionContext) {
			try { restore(ctx); } catch { /* Show the failure without granting release authority. */ }
			return { failure, records: [...records.values()].filter((record) => record.state === "held" || record.release === "user-unproved") };
		},
		claim(reviewed: Record, ctx: ExtensionContext, current: () => boolean) {
			restore(ctx);
			const key = owner(reviewed), snapshot = JSON.stringify(reviewed), savedEvidence = evidence(reviewed, ctx.sessionManager.getEntries());
			const valid = () => current() && loadedSession === ctx.sessionManager.getSessionId()
				&& JSON.stringify(replay(ctx.sessionManager.getEntries()).get(key)) === snapshot
				&& evidence(reviewed, ctx.sessionManager.getEntries()) === savedEvidence;
			if (!valid() || reviewed.state !== "held" || claims.has(key)) throw new Error("Direct reservation changed or recovery is already active; reopen /subagent.");
			claims.add(key); // Claim before the first dialog, not after confirmation.
			return {
				close: () => { claims.delete(key); },
				release(kind: "proved" | "user-unproved", typedIdentity?: string) {
					requireReady();
					if (!claims.has(key) || !valid()) throw new Error("Direct recovery scope or evidence changed; protection retained.");
					if (kind === "proved" && !hasProof(reviewed, ctx.sessionManager.getEntries())) throw new Error("Worker termination is unproved; protection retained.");
					if (kind === "user-unproved" && typedIdentity !== identity(reviewed)) throw new Error("Exact typed reservation identity is required; protection retained.");
					save({ ...reviewed, state: "released", release: kind, ...(kind === "user-unproved"
						? { waiver: { identity: typedIdentity!, evidence: savedEvidence } } : {}) });
					admission.complete(key);
				},
			};
		},
		canUseRecordedTask(ctx: ExtensionContext) {
			if (!initialized && compatible) { try { restore(ctx); } catch { return false; } }
			return !failure && !claims.size && ![...records.values()].some((record) => record.state === "held");
		},
		hold(toolCallId: string, taskId: string, ctx: ExtensionContext) {
			requireReady();
			if (loadedSession !== ctx.sessionManager.getSessionId() || !ctx.sessionManager.getSessionFile()
				|| !ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role))) {
				throw new Error("Direct writes require the current saved Pi conversation; setup-only or in-memory sessions cannot persist admission.");
			}
			let record: Record = { version: 1, sessionId: loadedSession, taskId, token: randomUUID(),
				checkouts: [...admission.admittedCheckouts(toolCallId)].sort(), state: "held", proof: "not-dispatched", resources: [] };
			const release = admission.hold(toolCallId);
			try { save(record); } catch (error) { release(); throw error; }
			const key = owner(record);
			admission.restoreSet(key, record.checkouts);
			// Only this live handle retains observed tabs whose journal write failed.
			const pendingTabs = new Set<unknown>();
			const effect = (resource: unknown) => {
				if ((resource as { kind?: string })?.kind === "verified-tab") pendingTabs.add(resource);
				const next: Record = { ...record, proof: "unproved", resources: [...record.resources!, resource] };
				save(next); // Persist uncertainty BEFORE the external effect can start.
				record = next;
				pendingTabs.delete(resource);
			};
			return Object.assign(() => {
				if (records.get(key)?.state === "released") return;
				if (ctx.sessionManager.getSessionId() !== record.sessionId) throw new Error("Direct release requires its original Pi session; admission retained.");
				// Only the local finalizer calls this after all effects are stopped or proved absent.
				if (pendingTabs.size) {
					requireReady();
					if (loadedSession !== record.sessionId || !isDeepStrictEqual(replay(ctx.sessionManager.getEntries()).get(key), record)) {
						throw new Error("Direct reservation changed before local evidence retry; protection retained.");
					}
					for (const tab of pendingTabs) effect(tab);
				}
				const checkpoint: Record = record.proof === "not-dispatched" ? record : { ...record, proof: "stopped" };
				if (!hasProof(checkpoint, ctx.sessionManager.getEntries())) throw new Error("Complete saved termination evidence is required; protection retained.");
				if (record.proof !== checkpoint.proof) { save(checkpoint); record = checkpoint; }
				save({ ...record, state: "released", release: "proved" });
				admission.complete(key);
				release();
			}, { effect });
		},
	};
}
