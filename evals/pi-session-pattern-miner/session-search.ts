// Session-search tool for evals. The real `session_search` reads the user's Pi session index.
// This tool serves the case's synthetic sessions from sessionsPath with the result shapes and
// errors of extensions/pi-session-recall/extensions/session-recall.ts (OUTPUT_SCHEMA): preparation returns the
// prepared corpus, `query` returns one discovery hit per hit session, `sessionId` reads or scrolls a known session,
// and an unknown session or anchor gets the real error. Paths under /home/eval do not exist.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The data lives in the trial directory, the parent of the fixture cwd, so tools in cwd cannot find it. */
export const sessionsPath = (cwd: string) => join(dirname(cwd), "pi-eval-sessions.json");

export type Message = [entryId: string, role: "user" | "assistant", content: string];
export interface Session {
	path: string;
	name: string;
	startedAt: string;
	lineageId: string;
	messages: Message[];
}
/** `prepared` is the preparation corpus; `hits` answer every `query`, on their first message that names capture.mjs. */
export interface SessionSpec {
	prepared: Session[];
	hits: Session[];
}

type Params = { operation?: string; scope?: string; query?: string; sessionId?: string; aroundMessageId?: string; branchTip?: string; window?: number; limit?: number };

const minute = (startedAt: string, index: number) => new Date(Date.parse(startedAt) + (index + 1) * 60_000).toISOString();
const windowMessages = (s: Session) => s.messages.map(([entryId, role, content], index) => ({ entryId, role, content, timestamp: minute(s.startedAt, index) }));

function prepare(sessions: Session[], scope: string, cwd: string) {
	return {
		mode: "prepare-pattern-miner",
		scope: { kind: scope, gitRoot: cwd, requestedLimit: 10, sampledCount: sessions.length },
		sync: { walkComplete: true, backlogRemaining: 0, complete: true },
		sessions: sessions.map((s) => ({
			path: s.path,
			cwd,
			name: s.name,
			startedAt: s.startedAt,
			lineageId: s.lineageId,
			branchTip: s.messages.at(-1)![0],
			totalMessages: s.messages.length,
			truncated: false,
			contentTruncated: false,
			messages: windowMessages(s),
		})),
		inventory: {
			available: true,
			provenance: { packageScripts: "git-index", executableScripts: "git-index", agentInstructions: "git-index", skills: "pi-effective-registry" },
			worktreeVerified: false,
			packageScripts: [
				{ path: "package.json", name: "build", command: "tsc -p ." },
				{ path: "package.json", name: "test", command: "node --test" },
			],
			executableScripts: [],
			skills: [{ name: "skill:release-notes", description: "Draft release notes from merged changes.", sourcePath: ".agents/skills/release-notes/SKILL.md" }],
			agentInstructions: [],
			truncated: false,
			omittedCounts: { packageScripts: 0, executableScripts: 0, skills: 0, agentInstructions: 0 },
		},
		contentTruncated: false,
	};
}

function discovery(sessions: Session[], query: string, cwd: string) {
	return {
		mode: "discovery",
		query,
		results: sessions.map((s, rank) => {
			const index = s.messages.findIndex(([, , content]) => content.includes("capture.mjs"));
			const [entryId, role, content] = s.messages[index];
			return {
				path: s.path,
				snippet: `…${content.slice(0, 90).replace("capture.mjs", "[capture.mjs]")}…`,
				rank,
				matchMessageId: entryId,
				role,
				timestamp: minute(s.startedAt, index),
				cwd,
				name: s.name,
				startedAt: s.startedAt,
			};
		}),
		backlogRemaining: 0,
	};
}

function read(params: Params, sessions: Session[]) {
	const sessionId = params.sessionId!.trim();
	const s = sessions.find((candidate) => candidate.path === sessionId);
	if (!s) throw new Error(`session file not found: ${sessionId}`);
	const messages = windowMessages(s);
	const tip = s.messages.at(-1)![0];
	const anchor = params.aroundMessageId?.trim();
	if (!anchor) return { mode: "read", sessionId, messages, totalMessages: messages.length, truncated: false, branchTip: tip };
	const index = messages.findIndex((message) => message.entryId === anchor);
	if (index < 0) throw new Error(`anchor entry ${anchor} not found in session`);
	const radius = Math.min(Math.max(Math.trunc(params.window ?? 5), 1), 20);
	return {
		mode: "scroll",
		sessionId,
		branchTip: tip,
		messagesBefore: index,
		messagesAfter: messages.length - 1 - index,
		messages: messages.slice(Math.max(0, index - radius), index + radius + 1).map((message) =>
			message.entryId === anchor ? { ...message, anchor: true } : message),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description: "Search past Pi sessions. operation: prepare-pattern-miner + scope prepares one bounded corpus and repository inventory; query discovers matches; sessionId + aroundMessageId scrolls; sessionId alone reads.",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: ["prepare-pattern-miner"] },
				scope: { type: "string", enum: ["repository", "all"] },
				query: { type: "string" },
				sessionId: { type: "string" },
				aroundMessageId: { type: "string" },
				branchTip: { type: "string" },
				window: { type: "number" },
				limit: { type: "number" },
			},
			additionalProperties: false,
		} as never,
		async execute(_id, raw, _signal, _onUpdate, ctx) {
			const params = raw as Params;
			const spec: SessionSpec = JSON.parse(readFileSync(sessionsPath(ctx.cwd), "utf8"));
			const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
			if (params.scope !== undefined && params.operation === undefined) throw new Error("scope requires operation: prepare-pattern-miner.");
			if (params.operation === "prepare-pattern-miner") {
				const incompatible = (["query", "sessionId", "aroundMessageId", "branchTip", "window"] as const).filter((key) => params[key] !== undefined);
				if (incompatible.length) throw new Error(`prepare-pattern-miner does not accept: ${incompatible.join(", ")}.`);
				if (params.scope !== "repository" && params.scope !== "all") throw new Error("prepare-pattern-miner requires scope: repository or all.");
				return reply(prepare(spec.prepared, params.scope, ctx.cwd));
			}
			if (params.sessionId?.trim()) return reply(read(params, [...spec.prepared, ...spec.hits]));
			if (params.query?.trim()) return reply(discovery(spec.hits, params.query, ctx.cwd));
			return reply({ mode: "browse", sessions: spec.prepared.map((s) => ({ cwd: ctx.cwd, name: s.name, path: s.path, startedAt: s.startedAt })) });
		},
	});
}
