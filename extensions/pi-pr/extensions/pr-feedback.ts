import { createHash } from "node:crypto";
import {
	runChecked,
	requiredOid,
	requiredText,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";
import type { CurrentPullRequest } from "./pr-github.ts";

export const FEEDBACK_API_PAGE_MAX_BYTES = 512 * 1024;
export const FEEDBACK_MAX_PAGES = 100;
export const FEEDBACK_MAX_RECORDS = 1_000;
export const FEEDBACK_SNAPSHOT_MAX_BYTES = 1024 * 1024;

const PAGE_SIZE = 100;
const READ_ATTEMPTS = 3;
const FEEDBACK_QUERY = `
query Feedback($owner:String!,$repo:String!,$number:Int!,$commentsCursor:String,$reviewsCursor:String,$threadsCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    comments(first:100,after:$commentsCursor){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
    reviews(first:100,after:$reviewsCursor){pageInfo{hasNextPage endCursor} nodes{id url state body submittedAt author{login}}}
    reviewThreads(first:100,after:$threadsCursor){pageInfo{hasNextPage endCursor} nodes{
      id isResolved isOutdated path line diffSide startLine startDiffSide originalLine originalStartLine
      comments(first:100){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
    }}
  }}
}`;
const THREAD_REPLIES_QUERY = `
query ThreadReplies($threadId:ID!,$cursor:String){node(id:$threadId){... on PullRequestReviewThread{
  comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
}}}`;
const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;

export type FeedbackAuthor = { login: string } | null;
export type FeedbackComment = {
	id: string;
	url: string;
	body: string;
	createdAt: string;
	author: FeedbackAuthor;
};
export type FeedbackReview = {
	id: string;
	url: string;
	state: string;
	body: string;
	submittedAt: string | null;
	author: FeedbackAuthor;
};
export type FeedbackThread = {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string | null;
	line: number | null;
	diffSide: string | null;
	startLine: number | null;
	startDiffSide: string | null;
	originalLine: number | null;
	originalStartLine: number | null;
	comments: FeedbackComment[];
};
export type FeedbackAuthority = {
	id: string;
	number: number;
	url: string;
	host: string;
	base: { repository: string; ref: string; oid: string };
	head: { repository: string; ref: string; oid: string };
};
export type FeedbackSnapshot = {
	pullRequest: FeedbackAuthority;
	conversationComments: FeedbackComment[];
	reviews: FeedbackReview[];
	reviewThreads: FeedbackThread[];
};
export type FeedbackKind = "conversation_comment" | "review" | "thread" | "thread_comment";
export type FeedbackEntry = {
	id: string;
	kind: FeedbackKind;
	node: FeedbackComment | FeedbackReview | FeedbackThread;
	thread?: FeedbackThread;
};
export type FeedbackItem =
	| (FeedbackComment & { kind: "conversation_comment" })
	| (FeedbackReview & { kind: "review" })
	| (Omit<FeedbackThread, "comments"> & { kind: "thread"; childIds: string[] })
	| (FeedbackComment & {
		kind: "thread_comment";
		parentThread: { id: string; isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null };
	});
export type FeedbackClientOptions = {
	exec: Exec;
	cwd: string;
	signal?: AbortSignal;
	pause?: (milliseconds: number) => Promise<void>;
};

type Connection = {
	nodes: unknown[];
	hasNextPage: boolean;
	endCursor: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainText(value: unknown, label: string): string {
	if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} must be a string without NUL bytes`);
	return value;
}

function nullableText(value: unknown, label: string): string | null {
	return value === null ? null : plainText(value, label);
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
}

function nullableInteger(value: unknown, label: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer or null`);
	}
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function repository(value: unknown, label: string): string {
	const parsed = requiredText(value, label);
	const parts = parsed.split("/");
	if (parts.length !== 2 || parts.some((part) => !part || /\s/.test(part))) throw new Error(`${label} is invalid`);
	return parsed;
}

function httpsUrl(value: unknown, label: string, host?: string, allowSuffix = false): string {
	const text = requiredText(value, label);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		throw new Error(`${label} is invalid`);
	}
	if (
		parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.port ||
		(!allowSuffix && (parsed.search || parsed.hash))
	) throw new Error(`${label} is invalid`);
	if (host !== undefined && parsed.hostname.toLowerCase() !== host.toLowerCase()) throw new Error(`${label} host changed`);
	return parsed.href;
}

export function feedbackAuthorityFromCurrent(pullRequest: CurrentPullRequest): FeedbackAuthority {
	if (pullRequest.lifecycle !== "open") throw new Error("Feedback requires an open pull request");
	return parseAuthority({
		id: pullRequest.id,
		number: pullRequest.number,
		url: pullRequest.url.href,
		host: pullRequest.host,
		base: pullRequest.base,
		head: pullRequest.head,
	});
}

function parseAuthority(value: unknown): FeedbackAuthority {
	if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.head)) throw new Error("feedback pull request is invalid");
	const host = requiredText(value.host, "pull request host").toLowerCase();
	const number = positiveInteger(value.number, "pull request number");
	const baseRepository = repository(value.base.repository, "base repository");
	const url = httpsUrl(value.url, "pull request URL", host);
	const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(new URL(url).pathname);
	if (!match || Number(match[3]) !== number || `${match[1]}/${match[2]}`.toLowerCase() !== baseRepository.toLowerCase()) {
		throw new Error("pull request URL does not match its number and base repository");
	}
	return {
		id: requiredText(value.id, "pull request ID"),
		number,
		url,
		host,
		base: {
			repository: baseRepository,
			ref: requiredText(value.base.ref, "base ref"),
			oid: requiredOid(value.base.oid, "base OID"),
		},
		head: {
			repository: repository(value.head.repository, "head repository"),
			ref: requiredText(value.head.ref, "head ref"),
			oid: requiredOid(value.head.oid, "head OID"),
		},
	};
}

function parseAuthor(value: unknown, label: string): FeedbackAuthor {
	if (value === null) return null;
	if (!isRecord(value)) throw new Error(`${label} author is invalid`);
	return { login: requiredText(value.login, `${label} author login`) };
}

function parseComment(value: unknown, label: string): FeedbackComment {
	if (!isRecord(value)) throw new Error(`${label} is invalid`);
	return {
		id: requiredText(value.id, `${label} ID`),
		url: httpsUrl(value.url, `${label} URL`, undefined, true),
		body: plainText(value.body, `${label} body`),
		createdAt: requiredText(value.createdAt, `${label} createdAt`),
		author: parseAuthor(value.author, label),
	};
}

function parseReview(value: unknown, label: string): FeedbackReview {
	if (!isRecord(value)) throw new Error(`${label} is invalid`);
	return {
		id: requiredText(value.id, `${label} ID`),
		url: httpsUrl(value.url, `${label} URL`, undefined, true),
		state: requiredText(value.state, `${label} state`),
		body: plainText(value.body, `${label} body`),
		submittedAt: nullableText(value.submittedAt, `${label} submittedAt`),
		author: parseAuthor(value.author, label),
	};
}

function parseThread(value: unknown, label: string): FeedbackThread {
	if (!isRecord(value) || !Array.isArray(value.comments)) throw new Error(`${label} is invalid`);
	return {
		id: requiredText(value.id, `${label} ID`),
		isResolved: boolean(value.isResolved, `${label} isResolved`),
		isOutdated: boolean(value.isOutdated, `${label} isOutdated`),
		path: nullableText(value.path, `${label} path`),
		line: nullableInteger(value.line, `${label} line`),
		diffSide: nullableText(value.diffSide, `${label} diffSide`),
		startLine: nullableInteger(value.startLine, `${label} startLine`),
		startDiffSide: nullableText(value.startDiffSide, `${label} startDiffSide`),
		originalLine: nullableInteger(value.originalLine, `${label} originalLine`),
		originalStartLine: nullableInteger(value.originalStartLine, `${label} originalStartLine`),
		comments: value.comments.map((comment, index) => parseComment(comment, `${label} comment ${index + 1}`)),
	};
}

function encoded(value: unknown, label: string, maxBytes = FEEDBACK_SNAPSHOT_MAX_BYTES): string {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error(`${label} is not JSON-serializable`);
	if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
	return json;
}

export function parseFeedbackSnapshot(value: unknown): FeedbackSnapshot {
	if (!isRecord(value) || !Array.isArray(value.conversationComments) || !Array.isArray(value.reviews) || !Array.isArray(value.reviewThreads)) {
		throw new Error("feedback snapshot is invalid");
	}
	const snapshot: FeedbackSnapshot = {
		pullRequest: parseAuthority(value.pullRequest),
		conversationComments: value.conversationComments.map((comment, index) => parseComment(comment, `conversation comment ${index + 1}`)),
		reviews: value.reviews.map((review, index) => parseReview(review, `review ${index + 1}`)),
		reviewThreads: value.reviewThreads.map((thread, index) => parseThread(thread, `review thread ${index + 1}`)),
	};
	feedbackEntries(snapshot);
	encoded(snapshot, "feedback snapshot");
	return snapshot;
}

export function parseFeedbackSnapshotText(raw: string): FeedbackSnapshot {
	if (Buffer.byteLength(raw, "utf8") > FEEDBACK_SNAPSHOT_MAX_BYTES) {
		throw new Error(`feedback snapshot exceeds ${FEEDBACK_SNAPSHOT_MAX_BYTES} bytes`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("feedback snapshot contains invalid JSON");
	}
	return parseFeedbackSnapshot(value);
}

export function feedbackEntries(snapshotInput: FeedbackSnapshot): FeedbackEntry[] {
	const snapshot = snapshotInput;
	const entries: FeedbackEntry[] = [];
	for (const node of snapshot.conversationComments) entries.push({ id: node.id, kind: "conversation_comment", node });
	for (const node of snapshot.reviews) entries.push({ id: node.id, kind: "review", node });
	for (const thread of snapshot.reviewThreads) {
		entries.push({ id: thread.id, kind: "thread", node: thread });
		for (const node of thread.comments) entries.push({ id: node.id, kind: "thread_comment", node, thread });
	}
	if (entries.length > FEEDBACK_MAX_RECORDS) throw new Error(`feedback exceeds ${FEEDBACK_MAX_RECORDS} records`);
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) throw new Error(`duplicate or ambiguous feedback ID: ${entry.id}`);
		ids.add(entry.id);
	}
	return entries;
}

export function showFeedbackItem(snapshot: FeedbackSnapshot, idInput: string): FeedbackItem {
	const id = requiredText(idInput, "feedback ID");
	const entry = feedbackEntries(snapshot).find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`feedback ID not found: ${id}`);
	let item: FeedbackItem;
	if (entry.kind === "thread") {
		const thread = entry.node as FeedbackThread;
		const { comments, ...metadata } = thread;
		item = { ...metadata, kind: "thread", childIds: comments.map((comment) => comment.id) };
	} else if (entry.kind === "thread_comment") {
		const comment = entry.node as FeedbackComment;
		const thread = entry.thread!;
		item = {
			...comment,
			kind: "thread_comment",
			parentThread: {
				id: thread.id,
				isResolved: thread.isResolved,
				isOutdated: thread.isOutdated,
				path: thread.path,
				line: thread.line ?? thread.originalLine,
			},
		};
	} else if (entry.kind === "review") {
		item = { ...(entry.node as FeedbackReview), kind: "review" };
	} else {
		item = { ...(entry.node as FeedbackComment), kind: "conversation_comment" };
	}
	encoded(item, "feedback item", FEEDBACK_API_PAGE_MAX_BYTES);
	return item;
}

export function feedbackFingerprint(snapshot: FeedbackSnapshot): string {
	return createHash("sha256").update(encoded(snapshot, "feedback snapshot")).digest("hex");
}

export function feedbackContentFingerprint(snapshot: FeedbackSnapshot): string {
	const content = {
		...snapshot,
		reviewThreads: snapshot.reviewThreads.map((thread) => ({ ...thread, isResolved: false })),
	};
	return createHash("sha256").update(encoded(content, "feedback content")).digest("hex");
}

function connection(value: unknown, label: string): Connection {
	if (!isRecord(value) || !Array.isArray(value.nodes) || value.nodes.length > PAGE_SIZE || !isRecord(value.pageInfo)) {
		throw new Error(`invalid ${label} connection`);
	}
	const hasNextPage = boolean(value.pageInfo.hasNextPage, `${label} hasNextPage`);
	const endCursor = value.pageInfo.endCursor;
	if (hasNextPage && (typeof endCursor !== "string" || !endCursor)) throw new Error(`missing pagination cursor for ${label}`);
	if (!hasNextPage && endCursor !== null && typeof endCursor !== "string") throw new Error(`invalid pagination cursor for ${label}`);
	return { nodes: value.nodes, hasNextPage, endCursor: typeof endCursor === "string" ? endCursor : null };
}

function transient(error: unknown): boolean {
	return /\b5\d\d\b|tls|ssl|x509|certificate|handshake/i.test(error instanceof Error ? error.message : String(error));
}

async function defaultPause(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class FeedbackClient {
	private pages = 0;
	private readonly options: FeedbackClientOptions;

	constructor(options: FeedbackClientOptions) {
		this.options = options;
	}

	private execOptions(query: string): ExecOptions {
		return {
			cwd: this.options.cwd,
			signal: this.options.signal,
			stdin: query,
			stdoutLimitBytes: FEEDBACK_API_PAGE_MAX_BYTES,
		};
	}

	private async request(query: string, variables: Record<string, string | number | null>, host: string, readOnly: boolean): Promise<Record<string, unknown>> {
		const args = ["api", "graphql", "--hostname", requiredText(host, "GitHub host"), "-F", "query=@-"];
		for (const [name, value] of Object.entries(variables)) if (value !== null) args.push("-F", `${name}=${value}`);
		for (let attempt = 0; ; attempt += 1) {
			try {
				this.pages += 1;
				if (this.pages > FEEDBACK_MAX_PAGES) throw new Error(`feedback pagination exceeds ${FEEDBACK_MAX_PAGES} pages`);
				const result = await runChecked(this.options.exec, "gh", args, this.execOptions(query));
				let value: unknown;
				try {
					value = JSON.parse(result.stdout);
				} catch {
					throw new Error("GitHub GraphQL returned invalid JSON");
				}
				if (!isRecord(value)) throw new Error("GitHub GraphQL returned invalid JSON");
				if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length)) {
					throw new Error("GitHub GraphQL returned errors");
				}
				if (!isRecord(value.data)) throw new Error("GitHub GraphQL response has no data");
				return value.data;
			} catch (error) {
				if (!readOnly || attempt === READ_ATTEMPTS - 1 || !transient(error)) throw error;
				await (this.options.pause ?? defaultPause)(250 * (attempt + 1));
			}
		}
	}

	async read(query: string, variables: Record<string, string | number | null>, host: string): Promise<Record<string, unknown>> {
		return await this.request(query, variables, host, true);
	}

	async mutate(query: string, variables: Record<string, string | number | null>, host: string): Promise<Record<string, unknown>> {
		return await this.request(query, variables, host, false);
	}
}

function pullRequest(data: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(data.repository) || !isRecord(data.repository.pullRequest)) throw new Error("pull request disappeared");
	return data.repository.pullRequest;
}

function rememberCursor(seen: Set<string>, page: Connection, label: string): void {
	if (!page.hasNextPage) return;
	if (seen.has(page.endCursor!)) throw new Error(`duplicate pagination cursor for ${label}`);
	seen.add(page.endCursor!);
}

export async function collectPullRequestFeedback(
	authorityInput: FeedbackAuthority,
	options: FeedbackClientOptions,
): Promise<FeedbackSnapshot> {
	const authority = parseAuthority(authorityInput);
	const [owner, name, extra] = authority.base.repository.split("/");
	if (!owner || !name || extra) throw new Error("base repository is invalid");
	const client = new FeedbackClient(options);
	const targets = [
		{ key: "conversationComments", field: "comments", cursor: "commentsCursor", label: "conversation comments" },
		{ key: "reviews", field: "reviews", cursor: "reviewsCursor", label: "reviews" },
		{ key: "reviewThreads", field: "reviewThreads", cursor: "threadsCursor", label: "review threads" },
	] as const;
	const results: Record<(typeof targets)[number]["key"], unknown[]> = {
		conversationComments: [], reviews: [], reviewThreads: [],
	};
	const cursors: Record<(typeof targets)[number]["key"], string | null> = {
		conversationComments: null, reviews: null, reviewThreads: null,
	};
	const seen = new Map(targets.map((target) => [target.key, new Set<string>()]));
	const pending = new Set<(typeof targets)[number]["key"]>(targets.map((target) => target.key));
	let records = 0;
	while (pending.size) {
		const data = await client.read(FEEDBACK_QUERY, {
			owner,
			repo: name,
			number: authority.number,
			commentsCursor: cursors.conversationComments,
			reviewsCursor: cursors.reviews,
			threadsCursor: cursors.reviewThreads,
		}, authority.host);
		const pr = pullRequest(data);
		for (const target of targets) {
			if (!pending.has(target.key)) continue;
			const page = connection(pr[target.field], target.label);
			rememberCursor(seen.get(target.key)!, page, target.label);
			records += page.nodes.length;
			if (target.key === "reviewThreads") {
				for (const [index, thread] of page.nodes.entries()) {
					if (!isRecord(thread)) throw new Error(`review thread ${results.reviewThreads.length + index + 1} is invalid`);
					records += connection(thread.comments, `comments for ${requiredText(thread.id, "review thread ID")}`).nodes.length;
				}
			}
			if (records > FEEDBACK_MAX_RECORDS) throw new Error(`feedback exceeds ${FEEDBACK_MAX_RECORDS} records`);
			results[target.key].push(...page.nodes);
			if (page.hasNextPage) cursors[target.key] = page.endCursor;
			else pending.delete(target.key);
		}
	}

	const threads: unknown[] = [];
	for (const [index, rawThread] of results.reviewThreads.entries()) {
		if (!isRecord(rawThread)) throw new Error(`review thread ${index + 1} is invalid`);
		const threadId = requiredText(rawThread.id, `review thread ${index + 1} ID`);
		let page = connection(rawThread.comments, `comments for ${threadId}`);
		const comments = [...page.nodes];
		const replyCursors = new Set<string>();
		rememberCursor(replyCursors, page, `comments for ${threadId}`);
		while (page.hasNextPage) {
			const data = await client.read(THREAD_REPLIES_QUERY, { threadId, cursor: page.endCursor }, authority.host);
			if (!isRecord(data.node)) throw new Error(`review thread disappeared: ${threadId}`);
			page = connection(data.node.comments, `comments for ${threadId}`);
			rememberCursor(replyCursors, page, `comments for ${threadId}`);
			records += page.nodes.length;
			if (records > FEEDBACK_MAX_RECORDS) throw new Error(`feedback exceeds ${FEEDBACK_MAX_RECORDS} records`);
			comments.push(...page.nodes);
		}
		threads.push({ ...rawThread, comments });
	}
	return parseFeedbackSnapshot({
		pullRequest: authority,
		conversationComments: results.conversationComments,
		reviews: results.reviews,
		reviewThreads: threads,
	});
}

export async function resolvePullRequestThread(
	authorityInput: FeedbackAuthority,
	threadIdInput: string,
	options: FeedbackClientOptions,
): Promise<void> {
	const authority = parseAuthority(authorityInput);
	const threadId = requiredText(threadIdInput, "review thread ID");
	const data = await new FeedbackClient(options).mutate(RESOLVE_THREAD_MUTATION, { threadId }, authority.host);
	if (!isRecord(data.resolveReviewThread) || !isRecord(data.resolveReviewThread.thread)) {
		throw new Error(`GitHub did not resolve ${threadId}`);
	}
	const thread = data.resolveReviewThread.thread;
	if (thread.id !== threadId || thread.isResolved !== true) throw new Error(`GitHub did not resolve ${threadId}`);
}
