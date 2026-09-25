import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { collectPullRequestFeedback, feedbackAuthorityFromCurrent, feedbackEntries, type FeedbackSnapshot } from "./pr-feedback.ts";
import { loadCurrentPullRequest, samePullRequestSnapshot, type CurrentPullRequest } from "./pr-github.ts";
import { extensionExecApi, isRecord, parseSingleOutputLine, runChecked } from "./pr-execution.ts";

function fingerprint(snapshot: FeedbackSnapshot, blockedIds: ReadonlySet<string> = new Set()): string {
	const entries = feedbackEntries(snapshot).filter(({ id }) => !blockedIds.has(id)).map(({ id, kind, node }) => ({
		id, kind, body: "body" in node ? node.body : null,
	})).sort((a, b) => a.id.localeCompare(b.id));
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function markerPath(cwd: string, agentDir?: string, signal?: AbortSignal, exec: Exec = spawnBounded): Promise<string> {
	const root = parseSingleOutputLine((await runChecked(exec, "git", ["rev-parse", "--show-toplevel"], { cwd, signal })).stdout, "worktree root");
	const identity = createHash("sha256").update(await realpath(root)).digest("hex");
	return join(extensionConfigDir("pi-pr", agentDir), "feedback", `${identity}.json`);
}

async function readMarker(path: string, signal?: AbortSignal): Promise<{ url: string; fingerprint: string } | null> {
	let raw: string;
	try {
		raw = await readTextFileBounded(path, 2_048, { signal });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let marker: unknown;
	try { marker = JSON.parse(raw); } catch { throw new Error(`Invalid feedback attention marker is preserved at ${path}`); }
	if (!isRecord(marker) || Object.keys(marker).sort().join(",") !== "fingerprint,url,version" ||
		marker.version !== 1 || typeof marker.url !== "string" || typeof marker.fingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(marker.fingerprint)) {
		throw new Error(`Invalid feedback attention marker is preserved at ${path}`);
	}
	return { url: marker.url, fingerprint: marker.fingerprint };
}

export async function needsFeedbackAttention(
	current: CurrentPullRequest,
	options: { cwd: string; agentDir?: string; signal?: AbortSignal; exec?: Exec; load?: typeof loadCurrentPullRequest },
): Promise<boolean> {
	const { cwd, agentDir, signal } = options;
	const exec = options.exec ?? spawnBounded;
	const snapshot = await collectPullRequestFeedback(feedbackAuthorityFromCurrent(current), { exec, cwd, signal });
	const discovery = await (options.load ?? loadCurrentPullRequest)(extensionExecApi(exec, cwd, signal),
		{ cwd, signal: signal ?? new AbortController().signal });
	if (discovery.kind !== "current" || !samePullRequestSnapshot(current, discovery.pullRequest) ||
		current.base.oid !== discovery.pullRequest.base.oid) {
		throw new Error("Feedback discovery cancelled: pull request authority changed");
	}
	const marker = await readMarker(await markerPath(cwd, agentDir, signal, exec), signal);
	const entries = feedbackEntries(snapshot);
	if (!entries.length) return false;
	return !marker || marker.url !== current.url.href || marker.fingerprint !== fingerprint(snapshot);
}

export async function markFeedbackHandled(
	snapshot: FeedbackSnapshot,
	options: { cwd: string; agentDir?: string; signal?: AbortSignal; exec?: Exec; blockedIds?: readonly string[] },
): Promise<void> {
	const path = await markerPath(options.cwd, options.agentDir, options.signal, options.exec);
	await readMarker(path, options.signal);
	await writePrivateTextFileAtomically(path, `${JSON.stringify({ version: 1, url: snapshot.pullRequest.url, fingerprint: fingerprint(snapshot, new Set(options.blockedIds)) })}\n`, {
		signal: options.signal,
	});
}
