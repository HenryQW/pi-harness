import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gateDecision, registerBouncer } from "../internal/bouncer.ts";
import { success, type ExecResult } from "./helper.ts";

const cases = [
	["git push", "block", "confirm"],
	["git -C x push origin y", "block", "confirm"],
	["git --git-dir x push", "block", "confirm"],
	["env -i -u TEST git push", "block", "confirm"],
	["sudo -n -u user gh pr create", "block", "confirm"],
	["command -v gh", "allow", "allow"],
	["gh --repo Owner/name pr create", "block", "confirm"],
	["gh pr -R Owner/name merge 3", "block", "confirm"],
	["FOO=1 git push", "block", "confirm"],
	['FOO="a b" env command exec sudo git -C "a b" -c key=value push', "block", "confirm"],
	["a && gh pr create", "block", "confirm"],
	["gh issue list", "block", "allow"],
	["gh pr merge 3", "block", "confirm"],
	["git status", "allow", "allow"],
	['git commit -m "push"', "allow", "allow"],
	["echo gh", "allow", "allow"],
	["git fetch", "allow", "allow"],
	['echo "git push; gh pr merge"', "allow", "allow"],
	["echo '$(git push) `gh pr create`'", "allow", "allow"],
	['echo "$(git -C "a b" push)"', "block", "confirm"],
	["echo `gh pr create`", "block", "confirm"],
	["a; b || c | d\ngit push", "block", "confirm"],
] as const;

test("gate selects policy per role and checks commands separately from quoted text", () => {
	for (const [command, bartender, bouncer] of cases) {
		assert.equal(gateDecision("bartender", "bash", { command }).action, bartender, command);
		assert.equal(gateDecision("bouncer", "bash", { command }).action, bouncer, command);
		assert.equal(gateDecision("other", "bash", { command }).action, "allow", command);
	}
	assert.deepEqual(gateDecision("bartender", "herdr_handoff", {}), {
		action: "block", reason: "Bartenders cannot use herdr_handoff.",
	});
	assert.equal(gateDecision("bouncer", "herdr_handoff", {}).action, "allow");
	assert.equal(gateDecision("other", "herdr_handoff", {}).action, "allow");
});

const interval = 5_000;
const details = {
	digest: "work",
	items: [{ kind: "question", repo: "Owner/name", number: 5, text: "Which branch?" }],
	failures: [{ step: "read", repo: "Owner/name", number: 6, message: "Issue unavailable" }],
};
const empty = { digest: "empty", items: [], failures: [] };

async function harness(t: TestContext, bouncer = true) {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const root = await mkdtemp(join(tmpdir(), "pi-bouncer-"));
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_BOUNCER: process.env.PI_BOUNCER };
	process.env.PI_CODING_AGENT_DIR = root;
	if (bouncer) process.env.PI_BOUNCER = "1";
	else delete process.env.PI_BOUNCER;
	t.after(async () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	const configDir = join(root, "config", "pi-herdr-tools");
	await mkdir(configDir, { recursive: true });
	const configPath = join(configDir, "bouncer.json");
	const tick = join(root, "tick");
	await writeFile(tick, "#!/bin/sh\n", { mode: 0o700 });
	const calls: Parameters<ExtensionAPI["exec"]>[] = [];
	const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const notices: { message: string; type: string }[] = [];
	const confirms: string[][] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const app = {
		idle: true,
		hasUI: true,
		approved: false,
		branch: success("main\n"),
		respond: (): ExecResult | Promise<ExecResult> => success(details),
		async configure(config: Record<string, unknown> = { tick, intervalMs: interval, scriptOnly: true }) {
			await writeFile(configPath, JSON.stringify(config));
		},
		async emit(name: string, event: unknown = {}) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
			return results.find((result) => result !== undefined);
		},
		async advance(ms = interval) {
			t.mock.timers.tick(ms);
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		calls, sent, notices, confirms, root, tick, configPath,
	};
	const ctx = {
		cwd: root,
		get hasUI() { return app.hasUI; },
		isIdle: () => app.idle,
		ui: {
			notify: (message: string, type: string) => notices.push({ message, type }),
			confirm: async (...args: string[]) => { confirms.push(args); return app.approved; },
		},
	};
	registerBouncer({
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		async exec(...args: Parameters<ExtensionAPI["exec"]>) {
			calls.push(args);
			return args[0] === "git" ? app.branch : app.respond();
		},
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => sent.push(args),
	} as unknown as ExtensionAPI);
	return app;
}

test("the default interval starts after an immediate tick and the same digest sends one follow-up", async (t) => {
	const app = await harness(t);
	await app.configure({ tick: app.tick });
	assert.deepEqual(app.calls, []);
	await app.emit("session_start");
	assert.deepEqual(app.calls, [[app.tick, ["--json"], { timeout: 120_000 }]]);
	assert.deepEqual(app.sent, [[{
		customType: "bouncer", display: true, details,
		content: "question Owner/name#5: Which branch?\nread failed for Owner/name#6: Issue unavailable",
	}, { triggerTurn: true, deliverAs: "followUp" }]]);
	await app.advance(59_999);
	assert.equal(app.calls.length, 1);
	await app.advance(1);
	assert.equal(app.calls.length, 2);
	assert.equal(app.sent.length, 1);
	assert.deepEqual(app.notices, []);
});

test("a busy session keeps the digest pending and an empty result updates it without waking Pi", async (t) => {
	const app = await harness(t);
	await app.configure();
	app.idle = false;
	await app.emit("session_start");
	assert.equal(app.sent.length, 0);
	app.idle = true;
	await app.advance();
	assert.equal(app.sent.length, 1);
	app.respond = () => success(empty);
	await app.advance();
	assert.equal(app.sent.length, 1);
	app.respond = () => success(details);
	await app.advance();
	assert.equal(app.sent.length, 2);
});

test("failed, killed, malformed and invalid ticks notify once per distinct error and keep the last digest", async (t) => {
	const app = await harness(t);
	await app.configure();
	await app.emit("session_start");
	for (const error of [
		{ ...success(), code: 1, stderr: "failed" },
		{ ...success(), code: 1, stderr: "different failure" },
		{ ...success(details), killed: true },
		success("{"),
		success({ digest: "work", items: [null], failures: [] }),
	]) {
		app.respond = () => error;
		await app.advance();
		await app.advance();
	}
	assert.equal(app.notices.length, 5);
	assert.ok(app.notices.every(({ type }) => type === "error"));
	assert.equal(app.sent.length, 1);
	app.respond = () => success(details);
	await app.advance();
	assert.equal(app.sent.length, 1);
});

test("an in-flight tick prevents overlap and cannot deliver after shutdown", async (t) => {
	const app = await harness(t);
	await app.configure();
	let finish!: (result: ExecResult) => void;
	app.respond = () => new Promise((resolve) => { finish = resolve; });
	await app.emit("session_start");
	await app.advance(interval * 2);
	assert.equal(app.calls.length, 1);
	let stopped = false;
	const shutdown = app.emit("session_shutdown").then(() => { stopped = true; });
	await app.advance(interval * 2);
	assert.equal(stopped, false);
	assert.equal(app.calls.length, 1);
	finish(success(details));
	await shutdown;
	await app.emit("session_shutdown");
	await app.advance(interval * 2);
	assert.equal(app.calls.length, 1);
	assert.deepEqual(app.sent, []);
});

test("missing or invalid Bouncer config reports one error and starts no tick", async (t) => {
	const app = await harness(t);
	for (const contents of [undefined, "{", JSON.stringify({ tick: app.tick, intervalMs: 4_999 }), JSON.stringify({ tick: app.root })]) {
		if (contents !== undefined) await writeFile(app.configPath, contents);
		await app.emit("session_start", { contents });
		await app.advance(60_000);
		assert.equal(app.notices.length, 1, contents ?? "missing config");
		assert.equal(app.notices.pop()?.type, "error");
		assert.deepEqual(app.calls, []);
	}
});

test("branch output selects Bartender only for numbered branch names and no role reads Bouncer config unless enabled", async (t) => {
	const app = await harness(t, false);
	for (const [branch, bartender] of [["bouncer/42-fix\n", true], ["bouncer/42\n", true], ["bouncer/42abc\n", false], ["main\n", false], ["", false]] as const) {
		app.branch = branch ? success(branch) : { ...success(), code: 1 };
		await app.emit("session_start");
		assert.equal(Boolean(await app.emit("tool_call", { toolName: "herdr_handoff", input: {} })), bartender, branch);
		assert.deepEqual(app.calls.pop(), ["git", ["-C", app.root, "symbolic-ref", "--short", "-q", "HEAD"]]);
	}
	await app.advance(60_000);
	assert.deepEqual(app.calls, []);
	assert.deepEqual(app.notices, []);
});

test("Bouncer confirmation uses the exact command and blocks denial or a missing interface", async (t) => {
	const app = await harness(t);
	await app.configure();
	await app.emit("session_start");
	const command = "git -C 'some path' push origin main";
	const event = { toolName: "bash", input: { command } };
	const blocked = { block: true, reason: `The owner did not confirm: ${command}` };
	assert.deepEqual(await app.emit("tool_call", event), blocked);
	app.approved = true;
	assert.equal(await app.emit("tool_call", event), undefined);
	app.hasUI = false;
	assert.deepEqual(await app.emit("tool_call", event), blocked);
	assert.deepEqual(app.confirms, [["Bouncer gate", command], ["Bouncer gate", command]]);
});
