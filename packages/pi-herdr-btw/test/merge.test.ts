import assert from "node:assert/strict";
import test from "node:test";
import type { BtwPayload } from "../internal/core.ts";
import {
	buildMergeMessageContent,
	buildMergeTranscript,
	hasMergedRequestId,
	hasSubmittedPromptRequestId,
	isMergeAck,
	isMergeRequest,
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	MERGE_SUBMISSION_CUSTOM_TYPE,
	MergeCoordinator,
	validateRequestAgainstPayload,
	type MergeAck,
	type MergeRequest,
	type MergeStorePort,
	type ParentSessionPort,
} from "../internal/merge.ts";
import { fixturePayload } from "./fixtures.ts";

function fixtureRequest(payload: BtwPayload, overrides: Partial<MergeRequest> = {}): MergeRequest {
	return {
		protocolVersion: MERGE_PROTOCOL_VERSION,
		requestId: "req-1",
		launchId: payload.launchId,
		parentSessionId: payload.parentSessionId,
		capability: payload.capability,
		createdAt: "2026-07-15T00:00:00.000Z",
		summary: "packaged side-thread transcript",
		prompt: "continue with the findings",
		...overrides,
	};
}

test("merge request and ack guards enforce protocol shape and bounds", () => {
	const payload = fixturePayload();
	const request = fixtureRequest(payload);
	assert.equal(isMergeRequest(request), true);
	assert.equal(isMergeRequest({ ...request, protocolVersion: 1 }), false);
	assert.equal(isMergeRequest({ ...request, capability: "short" }), false);
	assert.equal(isMergeRequest({ ...request, summary: "   " }), false);
	assert.equal(isMergeRequest({ ...request, summary: "x".repeat(64 * 1024 + 1) }), false);
	assert.equal(isMergeRequest({ ...request, prompt: "   " }), false);
	assert.equal(isMergeRequest({ ...request, prompt: "x".repeat(16 * 1024 + 1) }), false);
	assert.equal(isMergeRequest({ ...request, prompt: undefined }), false);

	const ack: MergeAck = {
		protocolVersion: MERGE_PROTOCOL_VERSION,
		requestId: "req-1",
		status: "accepted",
		processedAt: "2026-07-15T00:01:00.000Z",
	};
	assert.equal(isMergeAck(ack), true);
	assert.equal(isMergeAck({ ...ack, status: "maybe" }), false);
});

test("merge requests must echo the exact launch identity and session binding", () => {
	const payload = fixturePayload();
	assert.equal(validateRequestAgainstPayload(fixtureRequest(payload), payload), undefined);
	assert.match(
		validateRequestAgainstPayload(fixtureRequest(payload, { launchId: "other" }), payload) ?? "",
		/launch ID/,
	);
	assert.match(
		validateRequestAgainstPayload(fixtureRequest(payload, { capability: "0".repeat(64) }), payload) ?? "",
		/capability/,
	);
	assert.match(
		validateRequestAgainstPayload(
			fixtureRequest(payload, { parentSessionId: "other-session" }),
			payload,
		) ?? "",
		/session/,
	);
});

test("buildMergeTranscript packages text turns and skips tool payloads", () => {
	assert.equal(buildMergeTranscript([]), undefined);
	assert.equal(
		buildMergeTranscript([
			{ role: "toolResult", content: [{ type: "text", text: "tool noise" }], timestamp: 1 },
		] as never[]),
		undefined,
	);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }], timestamp: 2 },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 3 },
		{ role: "assistant", content: [{ type: "text", text: "the finding" }], timestamp: 4 },
	] as never[];
	assert.equal(
		buildMergeTranscript(messages),
		"User:\nside question\n\nAssistant:\nthe finding",
	);
	assert.equal(
		buildMergeTranscript([{ role: "user", content: "plain question", timestamp: 1 }] as never[]),
		"User:\nplain question",
	);
});

test("buildMergeTranscript drops whole turns from the head when over budget", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "old ".repeat(100) }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "answer one" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "latest question" }], timestamp: 3 },
		{ role: "assistant", content: [{ type: "text", text: "latest answer" }], timestamp: 4 },
	] as never[];
	const transcript = buildMergeTranscript(messages, 128) ?? "";
	assert.match(transcript, /^\[earlier side-thread turns omitted/);
	assert.match(transcript, /latest question/);
	assert.match(transcript, /latest answer/);
	assert.doesNotMatch(transcript, /old old/);

	// A single oversized turn keeps its tail.
	const oversized =
		buildMergeTranscript(
			[
				{
					role: "assistant",
					content: [{ type: "text", text: `start ${"x".repeat(300)}end` }],
					timestamp: 1,
				},
			] as never[],
			64,
		) ?? "";
	assert.match(oversized, /^\[earlier side-thread turns omitted/);
	assert.match(oversized, /xend$/);
	assert.doesNotMatch(oversized, /start/);
});

test("merge message content wraps the transcript in a clear provenance envelope", () => {
	const content = buildMergeMessageContent("  the transcript  ");
	assert.match(content, /^Merged from \/btw \(side-thread transcript\)/);
	assert.match(content, /<btw-merge>\nthe transcript\n<\/btw-merge>/);
});

type LaunchState = {
	payload: BtwPayload;
	request?: unknown;
	ack?: MergeAck;
};

class FakeMergeStore implements MergeStorePort {
	readonly launches = new Map<string, LaunchState>();

	async listLaunchPayloadPaths(): Promise<string[]> {
		return [...this.launches.keys()];
	}
	async read(payloadPath: string): Promise<BtwPayload> {
		const launch = this.launches.get(payloadPath);
		if (!launch) throw new Error("missing payload");
		return launch.payload;
	}
	async readMergeRequest(payloadPath: string): Promise<unknown> {
		return this.launches.get(payloadPath)?.request;
	}
	async readMergeAck(payloadPath: string): Promise<unknown> {
		return this.launches.get(payloadPath)?.ack;
	}
	async writeMergeAck(payloadPath: string, ack: MergeAck): Promise<void> {
		const launch = this.launches.get(payloadPath);
		if (!launch) throw new Error("missing launch");
		launch.ack = ack;
	}
}

function fakeSession(sessionId: string) {
	const sent: Array<{ content: string; details: { requestId: string; launchId: string } }> = [];
	const submitted: string[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const entries: Array<{ type: string; customType?: string; details?: unknown; data?: unknown }> = [];
	let idle = true;
	let promptReady = true;
	let submitError: Error | undefined;
	const session: ParentSessionPort = {
		getSessionId: () => sessionId,
		isIdle: () => idle,
		getEntries: () => entries,
		canSubmitPrompt: async () => promptReady,
		sendMergeMessage: (content, details) => {
			sent.push({ content, details });
			entries.push({ type: "custom_message", customType: MERGE_CUSTOM_TYPE, details });
		},
		submitPrompt: (prompt) => {
			if (submitError) throw submitError;
			submitted.push(prompt);
		},
		markPromptSubmitted: (requestId, launchId) =>
			entries.push({
				type: "custom",
				customType: MERGE_SUBMISSION_CUSTOM_TYPE,
				data: { requestId, launchId },
			}),
		notify: (message, type) => notifications.push({ message, type }),
	};
	return {
		session,
		sent,
		submitted,
		notifications,
		entries,
		setIdle: (value: boolean) => (idle = value),
		setPromptReady: (value: boolean) => (promptReady = value),
		setSubmitError: (value: Error | undefined) => (submitError = value),
	};
}

test("coordinator delivers a valid merge exactly once, submits its prompt, and acknowledges it", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request: fixtureRequest(payload) });
	const { session, sent, submitted } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	const first = await coordinator.scan();
	assert.deepEqual(first, { delivered: 1, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /packaged side-thread transcript/);
	assert.deepEqual(submitted, ["continue with the findings"]);
	assert.equal(store.launches.get("/launch/payload.json")?.ack?.status, "accepted");

	// acked requests are never re-delivered or re-submitted
	const second = await coordinator.scan();
	assert.deepEqual(second, { delivered: 0, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 1);
	assert.deepEqual(submitted, ["continue with the findings"]);
});

test("a second merge is delivered even when a stale ack from the first remains", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	const launch: LaunchState = { payload, request: fixtureRequest(payload, { requestId: "req-1" }) };
	store.launches.set("/launch/payload.json", launch);
	const { session, sent } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	assert.deepEqual(await coordinator.scan(), { delivered: 1, deferred: 0, rejected: 0 });
	assert.equal(launch.ack?.requestId, "req-1");

	// Child publishes a second merge; the old ack must not mask it.
	launch.request = fixtureRequest(payload, { requestId: "req-2", summary: "second summary" });
	assert.deepEqual(await coordinator.scan(), { delivered: 1, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 2);
	assert.match(sent[1]?.content ?? "", /second summary/);
	assert.equal(launch.ack?.requestId, "req-2");

	// And the matching ack now stops re-delivery.
	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 2);
});

test("coordinator defers while the parent is busy and delivers after it settles", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request: fixtureRequest(payload) });
	const { session, sent, submitted, setIdle } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	setIdle(false);
	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 1, rejected: 0 });
	assert.equal(sent.length, 0);
	assert.deepEqual(submitted, []);
	assert.equal(store.launches.get("/launch/payload.json")?.ack, undefined);

	setIdle(true);
	assert.deepEqual(await coordinator.scan(), { delivered: 1, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 1);
	assert.deepEqual(submitted, ["continue with the findings"]);
});

test("coordinator keeps merge pending when parent prompt cannot be submitted", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request: fixtureRequest(payload) });
	const { session, sent, submitted, setPromptReady } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	setPromptReady(false);
	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 1, rejected: 0 });
	assert.equal(sent.length, 0);
	assert.deepEqual(submitted, []);
	assert.equal(store.launches.get("/launch/payload.json")?.ack, undefined);

	setPromptReady(true);
	assert.deepEqual(await coordinator.scan(), { delivered: 1, deferred: 0, rejected: 0 });
	assert.deepEqual(submitted, ["continue with the findings"]);
	assert.equal(store.launches.get("/launch/payload.json")?.ack?.status, "accepted");
});

test("coordinator ignores merges bound to other sessions", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request: fixtureRequest(payload) });
	const { session, sent } = fakeSession("another-session-id");
	const coordinator = new MergeCoordinator(store, session);

	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 0);
	assert.equal(store.launches.get("/launch/payload.json")?.ack, undefined);
});

test("coordinator rejects forged or malformed merge requests", async () => {
	const payload = fixturePayload();
	const store = new FakeMergeStore();
	store.launches.set("/forged/payload.json", {
		payload,
		request: fixtureRequest(payload, { capability: "f".repeat(64) }),
	});
	store.launches.set("/malformed/payload.json", { payload, request: { nonsense: true } });
	const { session, sent, notifications } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 0, rejected: 2 });
	assert.equal(sent.length, 0);
	assert.equal(store.launches.get("/forged/payload.json")?.ack?.status, "rejected");
	assert.equal(store.launches.get("/malformed/payload.json")?.ack?.status, "rejected");
	assert.equal(notifications.filter((n) => n.type === "warning").length, 2);
});

test("coordinator retries prompt after a persisted merge message when submission failed", async () => {
	const payload = fixturePayload();
	const request = fixtureRequest(payload);
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request });
	const { session, sent, submitted, entries, setSubmitError } = fakeSession(payload.parentSessionId);
	const coordinator = new MergeCoordinator(store, session);

	setSubmitError(new Error("prompt failed"));
	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 1);
	assert.deepEqual(submitted, []);
	assert.equal(store.launches.get("/launch/payload.json")?.ack, undefined);
	assert.equal(hasSubmittedPromptRequestId(entries, request.requestId), false);

	setSubmitError(undefined);
	assert.deepEqual(await coordinator.scan(), { delivered: 1, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 1);
	assert.deepEqual(submitted, [request.prompt]);
	assert.equal(store.launches.get("/launch/payload.json")?.ack?.status, "accepted");
});

test("coordinator re-acks after a durable prompt-submission marker", async () => {
	const payload = fixturePayload();
	const request = fixtureRequest(payload);
	const store = new FakeMergeStore();
	store.launches.set("/launch/payload.json", { payload, request });
	const { session, sent, submitted, entries } = fakeSession(payload.parentSessionId);
	entries.push({
		type: "custom_message",
		customType: MERGE_CUSTOM_TYPE,
		details: { requestId: request.requestId },
	});
	entries.push({
		type: "custom",
		customType: MERGE_SUBMISSION_CUSTOM_TYPE,
		data: { requestId: request.requestId, launchId: request.launchId },
	});
	const coordinator = new MergeCoordinator(store, session);

	assert.deepEqual(await coordinator.scan(), { delivered: 0, deferred: 0, rejected: 0 });
	assert.equal(sent.length, 0);
	assert.deepEqual(submitted, []);
	assert.equal(store.launches.get("/launch/payload.json")?.ack?.status, "accepted");
	assert.equal(hasMergedRequestId(entries, request.requestId), true);
	assert.equal(hasSubmittedPromptRequestId(entries, request.requestId), true);
});
