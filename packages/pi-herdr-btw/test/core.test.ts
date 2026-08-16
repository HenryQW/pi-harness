import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../internal/config.ts";
import {
	buildAgentStartArgs,
	buildContextDocument,
	buildNativeBridgeMessage,
	buildPaneSplitArgs,
	buildParentContextMessage,
	classifyLaunchResult,
	createPayload,
	isBtwPayload,
	parsePaneSplitPaneId,
	isAgentStartReady,
	safeErrorText,
} from "../internal/core.ts";
import { fixturePayloadOptions } from "./fixtures.ts";

test("buildContextDocument preserves metadata and serialized conversation", () => {
	const document = buildContextDocument(
		{
			generatedAt: "2026-07-15T00:00:00.000Z",
			cwd: "/tmp/project with spaces",
			session: "/tmp/session.jsonl",
			model: "provider/model",
		},
		"User: hello\nAssistant: hi",
	);

	assert.match(document, /Parent cwd: \/tmp\/project with spaces/);
	assert.match(document, /Parent model: provider\/model/);
	assert.match(document, /<parent-conversation>\nUser: hello\nAssistant: hi\n<\/parent-conversation>/);
});

test("buildParentContextMessage creates one reference user message", () => {
	const message = buildParentContextMessage("# Snapshot");
	assert.equal(message.role, "user");
	assert.equal(message.timestamp, 0);
	assert.deepEqual(message.content, [
		{
			type: "text",
			text: "The following Markdown document is a read-only snapshot of the parent session. Use it as reference context for this side conversation.\n\n# Snapshot",
		},
	]);
});

test("buildPaneSplitArgs splits the parent pane with cwd only", () => {
	const args = buildPaneSplitArgs({
		paneName: "btw-abc123",
		cwd: "/tmp/project with spaces",
		parentPaneId: "w1:p1",
		payloadPath: "/tmp/pi-herdr-btw-1000/launch-abc/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "read-only",
		activeTools: ["read", "bash"],
		split: "right",
		projectTrusted: true,
	});

	assert.deepEqual(args, [
		"pane",
		"split",
		"--pane",
		"w1:p1",
		"--direction",
		"right",
		"--cwd",
		"/tmp/project with spaces",
		"--focus",
	]);
	assert.equal(args.some((arg) => arg.includes("secret question")), false);
});

test("buildPaneSplitArgs falls back to the current pane without a parent pane ID", () => {
	const args = buildPaneSplitArgs({
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "off",
		toolMode: "none",
		activeTools: [],
		split: "down",
		projectTrusted: true,
	});
	assert.equal(args.includes("--pane"), false);
	assert.equal(args.includes("--current"), true);
	assert.deepEqual(args.slice(args.indexOf("--direction"), args.indexOf("--direction") + 2), [
		"--direction",
		"down",
	]);
});

test("parsePaneSplitPaneId reads the pane ID from pane split JSON output", () => {
	const stdout = JSON.stringify({
		id: "cli:pane:split",
		result: { pane: { pane_id: "w29:p2", tab_id: "w29:t1" }, type: "pane_info" },
	});
	assert.equal(parsePaneSplitPaneId(stdout), "w29:p2");
	assert.equal(parsePaneSplitPaneId("not json"), null);
	assert.equal(parsePaneSplitPaneId("{}"), null);
	assert.equal(parsePaneSplitPaneId(JSON.stringify({ result: { pane: { pane_id: "" } } })), null);
});

test("isAgentStartReady validates Herdr agent identity and readiness", () => {
	const stdout = JSON.stringify({
		result: {
			type: "agent_started",
			agent: { name: "btw-abc123", pane_id: "w29:p2", interactive_ready: true },
		},
	});
	assert.equal(isAgentStartReady(stdout, { name: "btw-abc123", paneId: "w29:p2" }), true);
	assert.equal(isAgentStartReady(stdout, { name: "other", paneId: "w29:p2" }), false);
	assert.equal(
		isAgentStartReady(JSON.stringify({ result: { type: "agent_info", agent: {} } }), {
			name: "btw-abc123",
			paneId: "w29:p2",
		}),
		false,
	);
});

test("buildAgentStartArgs adopts pi into the split pane with launch flags", () => {
	const args = buildAgentStartArgs(
		{
			paneName: "btw-abc123",
			cwd: "/tmp/project",
			payloadPath: "/tmp/payload.json",
			model: "provider/model",
			thinkingLevel: "high",
			toolMode: "read-only",
			activeTools: ["read", "bash"],
			split: "right",
			projectTrusted: true,
		},
		"w29:p2",
	);

	assert.deepEqual(args, [
		"agent",
		"start",
		"btw-abc123",
		"--kind",
		"pi",
		"--pane",
		"w29:p2",
		"--",
		"--no-session",
		"--model",
		"provider/model",
		"--thinking",
		"high",
		"--approve",
		"--pi-herdr-btw-payload",
		"/tmp/payload.json",
		"--tools",
		"read,grep,find,ls",
	]);
	assert.equal(buildAgentStartArgs({
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "none",
		activeTools: [],
		split: "right",
		projectTrusted: false,
	}, "w29:p2").includes("--no-approve"), true);
});

test("buildAgentStartArgs appends the launch-draft sentinel as the child's initial message", () => {
	const options = {
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "none" as const,
		activeTools: [],
		split: "right" as const,
		projectTrusted: true,
	};
	// The sentinel must be the final positional argument, after every flag,
	// so pi treats it as the initial message processed after initial render.
	const args = buildAgentStartArgs({ ...options, initialMessage: "/btw --launch-draft" }, "w1:p2");
	assert.equal(args.at(-1), "/btw --launch-draft");
	assert.equal(args.at(-2), "--no-tools");
	assert.deepEqual(args.slice(args.indexOf("--pi-herdr-btw-payload"), args.indexOf("--pi-herdr-btw-payload") + 2), [
		"--pi-herdr-btw-payload",
		"/tmp/payload.json",
	]);
	// Without an initial message nothing is appended.
	assert.equal(buildAgentStartArgs(options, "w1:p2").at(-1), "--no-tools");
});

test("buildAgentStartArgs passes the exact parent tool set for inherit mode", () => {
	const options = {
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "inherit" as const,
		activeTools: ["read", "bash", "edit"],
		split: "right" as const,
		projectTrusted: true,
	};
	const args = buildAgentStartArgs(options, "w1:p2");
	assert.deepEqual(args.slice(-2), ["--tools", "read,bash,edit"]);
	assert.equal(buildAgentStartArgs({ ...options, activeTools: [] }, "w1:p2").at(-1), "--no-tools");
	assert.deepEqual(args.slice(args.indexOf("--pi-herdr-btw-payload"), args.indexOf("--pi-herdr-btw-payload") + 2), [
		"--pi-herdr-btw-payload",
		"/tmp/payload.json",
	]);
});

test("buildNativeBridgeMessage keeps side-pane policy in the suffix", () => {
	const message = buildNativeBridgeMessage("instructions here");
	assert.equal(message.role, "user");
	const text = (message.content as Array<{ text: string }>)[0]?.text ?? "";
	assert.match(text, /read-only snapshot of the parent session/);
	assert.match(text, /instructions here/);
});

test("payload creation and validation are versioned", () => {
	const payload = createPayload(fixturePayloadOptions());
	assert.equal(isBtwPayload(payload), true);
	assert.ok(payload.launchId.length > 0);
	assert.ok(payload.capability.length >= 64);
	assert.notEqual(createPayload(fixturePayloadOptions()).capability, payload.capability);
	assert.equal(isBtwPayload({ ...payload, version: 2 }), false);
	assert.equal(isBtwPayload({ ...payload, parentPaneId: 5 }), false);
	assert.equal(isBtwPayload({ ...payload, parentPaneId: null }), true);
	assert.equal(isBtwPayload({ ...payload, draftQuestion: null }), false);
	assert.equal(isBtwPayload({ ...payload, capability: "short" }), false);
	assert.equal(isBtwPayload({ ...payload, messages: [{ notRole: true }] }), false);
	assert.equal(isBtwPayload({ ...payload, config: { ...payload.config, tools: "write-only" } }), false);
});

test("launch result classification keeps killed launches ambiguous", () => {
	assert.equal(classifyLaunchResult({ code: 0 }), "success");
	assert.equal(classifyLaunchResult({ code: 1 }), "failed");
	assert.equal(classifyLaunchResult({ code: 1, killed: true }), "ambiguous");
	assert.equal(classifyLaunchResult({ code: 0, killed: true }), "ambiguous");
});

test("safeErrorText prefers stderr and limits output", () => {
	assert.equal(safeErrorText("stdout", "stderr"), "stderr");
	assert.equal(safeErrorText("stdout", ""), "stdout");
	assert.equal(safeErrorText("", ""), "Herdr failed to create the side pane");
	assert.equal(safeErrorText("", "x".repeat(600)).length, 500);
});

test("safeErrorText extracts the message from Herdr JSON error responses", () => {
	const jsonError = JSON.stringify({
		id: "cli:agent:start",
		error: { code: "agent_pane_busy", message: "agent target pane w1:p9 is not an available shell" },
	});
	assert.equal(safeErrorText("", jsonError), "agent target pane w1:p9 is not an available shell");
	// JSON without an error message falls back to the raw text
	assert.equal(safeErrorText("", '{"result":{}}'), '{"result":{}}');
});
