import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EphemeralSubagentExecutor, EphemeralSubagentRunInput } from "@henryqw/pi-subagent";
import { lock } from "proper-lockfile";
import cronExtension, { CRON_RESULT_TYPE } from "../extensions/cron.ts";
import type { Limits } from "../internal/config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Prepared = Awaited<ReturnType<EphemeralSubagentRunInput["prepare"]>>;

const SLOT = Date.parse("2026-10-02T23:30:00Z"); // 07:30 Asia/Hong_Kong
const agentDir = await mkdtemp(join(tmpdir(), "pi-cron-"));
after(() => rm(agentDir, { recursive: true, force: true }));

const model = {
	provider: "test", id: "text-model", name: "text-model", api: "anthropic-messages", baseUrl: "https://example.test",
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000,
	reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
} as unknown as NonNullable<ExtensionContext["model"]>;

await mkdir(join(agentDir, "config", "pi-task-models"), { recursive: true });
await writeFile(join(agentDir, "config", "pi-task-models", "config.json"), JSON.stringify({
	profiles: {
		fast: { primary: { model: "test/text-model", thinkingLevel: "low" } },
		balanced: { primary: { model: "test/text-model", thinkingLevel: "high" } },
	},
}));
await mkdir(join(agentDir, "config", "pi-cron"), { recursive: true });
const promptFile = join(agentDir, "preferences.md");
await writeFile(promptFile, "# Digest preferences\nSummarize unread items.\n");

async function writeJobs(jobs: unknown[]): Promise<void> {
	await writeFile(join(agentDir, "config", "pi-cron", "config.json"), JSON.stringify({ jobs }));
}

function harness(executor: (prepared: Prepared) => Promise<{ outcome: "success" | "failure"; output: string }>) {
	const handlers = new Map<string, Handler[]>();
	const notices: string[] = [];
	const messages: unknown[] = [];
	const prepared: Prepared[] = [];
	const policies: Required<Limits>[] = [];
	let command: Command | undefined;
	let selections: string[] = [];
	const events = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "cron") command = options.handler;
		},
		getCommands: () => [],
		sendMessage(message: unknown) {
			messages.push(message);
		},
		events: {
			on(name: string, listener: (payload: unknown) => void) {
				events.set(name, [...(events.get(name) ?? []), listener]);
				return () => undefined;
			},
			emit(name: string, payload: unknown) {
				for (const listener of events.get(name) ?? []) listener(payload);
			},
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		model, scopedModels: [], hasUI: true,
		modelRegistry: { getAvailable: () => [model] },
		isProjectTrusted: () => true,
		ui: {
			notify: (message: string) => { notices.push(message); },
			select: async (_title: string, options: string[]) => {
				const prefix = selections.shift();
				return prefix === undefined ? undefined : options.find((option) => option.startsWith(prefix));
			},
		},
	} as unknown as ExtensionCommandContext;
	let now = SLOT - 3_600_000;
	const fakeExecutor: EphemeralSubagentExecutor = {
		async run(input) {
			input.signal?.throwIfAborted();
			const value = await input.prepare();
			input.signal?.throwIfAborted();
			await writeFile(value.launch.args[value.launch.args.indexOf("--session") + 1]!, '{"type":"session"}\n');
			prepared.push(value);
			const result = await executor(value);
			return { ...result, exitCode: result.outcome === "success" ? 0 : 1, outputTruncated: false, stderr: "" };
		},
	};
	cronExtension(pi, { agentDir, executor: (limits) => { policies.push(limits); return fakeExecutor; }, now: () => now, tickMs: 3_600_000 });
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return {
		notices, messages, prepared, policies, emit, ctx, pi,
		command: (args: string) => command!(args, ctx),
		setNow: (value: number) => { now = value; },
		select: (...choices: string[]) => { selections = choices; },
		settle: () => new Promise((resolve) => setTimeout(resolve, 50)),
	};
}

test("a new job waits for its slot, then runs once in a persisted session with the job env and prompt", async () => {
	await writeJobs([{
		id: "digest", at: "07:30", timezone: "Asia/Hong_Kong", role: "scout", modelClass: "balanced",
		cwd: agentDir, env: { MINIFLUX_URL: "https://reader.example.org" }, promptFile,
	}]);
	const h = harness(async () => ({ outcome: "success", output: "Digest sent." }));
	await h.emit("session_start");
	await h.settle();
	assert.equal(h.prepared.length, 0, "first sighting only records a baseline");

	h.setNow(SLOT + 60_000);
	await h.emit("session_start");
	await h.settle();
	assert.equal(h.prepared.length, 1);
	const [run] = h.prepared;
	assert.equal(run!.task, "# Digest preferences\nSummarize unread items.\n");
	assert.equal(run!.cwd, agentDir);
	assert.equal(run!.launch.env.MINIFLUX_URL, "https://reader.example.org");
	assert.ok(!run!.launch.args.includes("--no-session"));
	const sessionFile = run!.launch.args[run!.launch.args.indexOf("--session") + 1]!;
	assert.match(sessionFile, /config\/pi-cron\/sessions\/digest\/2026-10-02T23-31-00-000Z\.jsonl$/);
	assert.deepEqual(run!.launch.args.slice(run!.launch.args.indexOf("--model"), run!.launch.args.indexOf("--model") + 4), ["--model", "test/text-model", "--thinking", "high"]);
	assert.ok(h.notices.some((notice) => notice.includes("Scheduled job digest finished") && notice.includes(sessionFile)), h.notices.join("\n"));

	const state = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "state.json"), "utf8"));
	assert.equal(state.jobs.digest.lastOutcome, "success");
	assert.equal(state.jobs.digest.running, undefined);
	assert.equal(state.jobs.digest.lastSession, sessionFile);

	h.setNow(SLOT + 2 * 3_600_000);
	await h.emit("session_start");
	await h.settle();
	assert.equal(h.prepared.length, 1, "the same slot does not fire twice");
	await h.emit("session_shutdown");
});

test("/cron run forces a run, refuses a concurrent claim, and follow-up delivery goes through sendMessage", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await writeJobs([{ id: "digest", every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", notify: "followUp" }]);
	await rm(join(agentDir, "config", "pi-cron", "state.json"), { force: true });
	const h = harness(async () => { await gate; return { outcome: "failure", output: "boom" }; });
	await h.emit("session_start");
	await h.settle();
	await h.command("run digest");
	await h.settle();
	assert.equal(h.prepared.length, 1);
	assert.ok(h.notices.some((notice) => notice.startsWith("Started digest")), h.notices.join("\n"));
	await h.command("run digest");
	assert.ok(h.notices.some((notice) => notice.includes("already running")), h.notices.join("\n"));
	release();
	await h.settle();
	const message = h.messages[0] as { customType: string; content: string; details: { outcome: string } };
	assert.equal(message.customType, CRON_RESULT_TYPE);
	assert.equal(message.details.outcome, "failure");
	assert.match(message.content, /Scheduled job digest failed[\s\S]*boom/);
	await h.command("run missing");
	assert.ok(h.notices.some((notice) => notice.includes("No job missing")));
	await h.emit("session_shutdown");
});

test("the menu disables and re-enables a job by editing only its enabled flag", async () => {
	await writeJobs([{ id: "digest", every: "1d", role: "scout", cwd: agentDir, prompt: "Go." }]);
	const h = harness(async () => ({ outcome: "success", output: "" }));
	await h.emit("session_start");
	h.select("digest · next", "Disable");
	await h.command("");
	assert.ok(h.notices.some((notice) => notice === "digest disabled."), h.notices.join("\n"));
	const disabled = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "config.json"), "utf8"));
	assert.deepEqual(disabled, { jobs: [{ id: "digest", every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", enabled: false }] });
	h.select("digest · disabled", "Enable");
	await h.command("");
	const enabled = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "config.json"), "utf8"));
	assert.equal(enabled.jobs[0].enabled, undefined);
	await h.emit("session_shutdown");
});

test("busy local admission leaves other jobs unclaimed instead of queueing an aging claim", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await writeJobs(["first", "second"].map((id) => ({ id, every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", enabled: false })));
	await rm(join(agentDir, "config", "pi-cron", "state.json"), { force: true });
	const h = harness(async () => { await gate; return { outcome: "success", output: "done" }; });
	await h.emit("session_start");
	await h.command("run first");
	await h.settle();
	h.setNow(SLOT + 29 * 60_000);
	await h.command("run second");
	assert.ok(h.notices.some((notice) => notice.includes("already running in this Pi session")));
	const readState = async () => JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "state.json"), "utf8"));
	assert.equal((await readState()).jobs.second, undefined);
	release();
	await h.settle();
	await h.command("run second");
	await h.settle();
	assert.equal((await readState()).jobs.second.lastStartedAt, SLOT + 29 * 60_000);
	await h.emit("session_shutdown");
});

test("a shutdown during claim preparation cannot adopt the next session's signal", async () => {
	await writeJobs([{ id: "restart", every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", enabled: false }]);
	await rm(join(agentDir, "config", "pi-cron", "state.json"), { force: true });
	const h = harness(async () => ({ outcome: "success", output: "unexpected" }));
	await h.emit("session_start");
	const home = join(agentDir, "config", "pi-cron");
	const release = await lock(home, { realpath: false, lockfilePath: join(home, "state.json.lock") });
	const pending = h.command("run restart");
	await h.emit("session_shutdown");
	await h.emit("session_start");
	await release();
	await pending;
	await h.settle();
	assert.equal(h.prepared.length, 0);
	assert.ok(h.notices.some((notice) => notice.includes("Pi session shut down")));
	await h.emit("session_shutdown");
});

test("pre-launch failures record no session and the menu explains its absence", async () => {
	await writeJobs([{ id: "missing-role", every: "1d", role: "not-configured", cwd: agentDir, prompt: "Go.", enabled: false }]);
	await rm(join(agentDir, "config", "pi-cron", "state.json"), { force: true });
	const h = harness(async () => ({ outcome: "success", output: "unexpected" }));
	await h.emit("session_start");
	await h.command("run missing-role");
	await h.settle();
	const record = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "state.json"), "utf8")).jobs["missing-role"];
	assert.equal(record.lastSession, undefined);
	assert.ok(h.notices.some((notice) => notice.includes("no session created") && notice.includes("not configured")));
	h.select("missing-role · disabled", "Show last run");
	await h.command("");
	assert.ok(h.notices.some((notice) => notice.includes("Session: none created")));
	await h.emit("session_shutdown");
});

test("later scheduled admissions reload edited jobs and limits, skipping disabled or removed jobs", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const jobs = ["first", "edited", "disabled", "removed"].map((id) => ({ id, every: "1m", role: "scout", cwd: agentDir, prompt: id }));
	await writeJobs(jobs);
	await rm(join(agentDir, "config", "pi-cron", "state.json"), { force: true });
	const h = harness(async (run) => {
		if (run.task === "first") await gate;
		return { outcome: "success", output: "done" };
	});
	await h.emit("session_start");
	await h.settle();
	h.setNow(SLOT);
	await h.emit("session_start");
	await h.settle();
	assert.equal(h.prepared.length, 1);
	await writeFile(join(agentDir, "config", "pi-cron", "config.json"), JSON.stringify({
		jobs: [jobs[0], { ...jobs[1], prompt: "edited-v2" }, { ...jobs[2], enabled: false }],
		limits: { maxTurns: 3 },
	}));
	release();
	await h.settle();
	assert.deepEqual(h.prepared.map((run) => run.task), ["first", "edited-v2"]);
	assert.deepEqual(h.policies.map((limits) => limits.maxTurns), [50, 3]);
	await h.emit("session_shutdown");
});

test("follow-up delivery failure reports recovery without changing the recorded success", async () => {
	await writeJobs([{ id: "delivery", every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", enabled: false, notify: "followUp" }]);
	const h = harness(async () => ({ outcome: "success", output: "Task completed." }));
	h.pi.sendMessage = () => { throw new Error("session unavailable"); };
	await h.emit("session_start");
	await h.command("run delivery");
	await h.settle();
	const record = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "state.json"), "utf8")).jobs.delivery;
	assert.equal(record.lastOutcome, "success");
	assert.ok(h.notices.some((notice) => notice.includes("Follow-up delivery failed: session unavailable") && notice.includes("/cron → Show last run") && notice.includes(record.lastSession)));
	assert.ok(!h.notices.some((notice) => notice.includes("could not run")));
	await h.emit("session_shutdown");
});

test("a result recorded after shutdown is not sent into a tearing-down session", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await writeJobs([{ id: "teardown", every: "1d", role: "scout", cwd: agentDir, prompt: "Go.", enabled: false, notify: "followUp" }]);
	const h = harness(async () => { await gate; return { outcome: "success", output: "Task completed." }; });
	await h.emit("session_start");
	await h.command("run teardown");
	await h.settle();
	await h.emit("session_shutdown");
	release();
	await h.settle();
	assert.equal(h.messages.length, 0);
	const record = JSON.parse(await readFile(join(agentDir, "config", "pi-cron", "state.json"), "utf8")).jobs.teardown;
	assert.equal(record.lastOutcome, "success");
});

test("an invalid config pauses jobs with one visible error", async () => {
	await writeFile(join(agentDir, "config", "pi-cron", "config.json"), JSON.stringify({ jobs: [{ id: "x" }] }));
	const h = harness(async () => ({ outcome: "success", output: "" }));
	await h.emit("session_start");
	await h.emit("session_start");
	assert.equal(h.notices.filter((notice) => notice.includes("is invalid; jobs are paused")).length, 1, h.notices.join("\n"));
	assert.equal(h.prepared.length, 0);
	await h.emit("session_shutdown");
});
