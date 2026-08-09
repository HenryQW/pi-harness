import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { hashDeliveryGraph, readDeliveryGraph, writeDeliveryGraph } from "../src/graph.ts";
import { planningReviewPath, PLANNING_REVIEW_TOOL, writePlanningReviewPass } from "../src/planning-review.ts";
import { PLANNING_TOOLS, registerPlanning } from "../src/planning.ts";
import { createWorkerExtension } from "../src/worker.ts";

const execFile = promisify(execFileCallback);

const draft = {
	status: "draft" as const,
	id: "planned-delivery",
	goal: "Ship observable behavior.",
	constraints: ["Keep public API stable."],
	non_goals: ["No migration layer."],
	issues: [
		{
			id: "ship-behavior",
			title: "Ship behavior",
			profile: "backend" as const,
			objective: "Expose behavior end to end.",
			acceptance: ["Caller observes behavior."],
			testing: "npm test -- behavior",
			depends_on: [],
		},
	],
	final_check: { acceptance: ["Integrated suite passes."], testing: "npm test" },
};

test("planning tools validate and atomically approve exact draft without execution", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	const tools = new Map<string, { execute: Function }>();
	registerPlanning({
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
	} as never);

	const validate = tools.get(PLANNING_TOOLS.validate)!;
	const validation = await validate.execute("validate", {}, undefined, undefined, { cwd: project.root }) as { content: Array<{ text: string }>; details: { hash: string } };
	assert.match(validation.content[0].text, /is valid \(draft\)/);
	assert.equal(validation.details.hash, hashDeliveryGraph(await readDeliveryGraph(project.root)));

	let confirmation = "";
	const approve = tools.get(PLANNING_TOOLS.approve)!;
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: { confirm: async () => true },
	}), /reviewer PASS/);
	assert.equal((await readDeliveryGraph(project.root)).status, "draft");
	const reviewerTools = new Map<string, { execute: Function }>();
	createWorkerExtension({ environment: { PI_AUTO_DAG_PLANNING_ROOT: project.root } })({
		registerTool(tool: { name: string; execute: Function }) { reviewerTools.set(tool.name, tool); },
	} as never);
	assert.deepEqual([...reviewerTools.keys()], [PLANNING_REVIEW_TOOL]);
	const submitPass = reviewerTools.get(PLANNING_REVIEW_TOOL)!;
	const pass = await submitPass.execute("pass", {}, undefined, undefined, {}) as { details: { graph_hash: string }; terminate: boolean };
	assert.equal(pass.details.graph_hash, hashDeliveryGraph({ ...draft, status: "approved" }));
	assert.equal(pass.terminate, true);

	await writeDeliveryGraph(project.root, { ...draft, goal: "Stale review." });
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: { confirm: async () => true },
	}), /reviewer PASS/);
	await writeDeliveryGraph(project.root, draft);
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: { confirm: async () => {
			await writeDeliveryGraph(project.root, { ...draft, goal: "Changed during confirmation." });
			return true;
		} },
	}), /changed during approval/);
	assert.equal((await readDeliveryGraph(project.root)).status, "draft");
	await writeDeliveryGraph(project.root, draft);
	const result = await approve.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: { confirm: async (_title: string, message: string) => { confirmation = message; return true; } },
	}) as { content: Array<{ text: string }>; details: { graph: { status: string }; hash: string } };
	assert.equal(result.details.graph.status, "approved");
	assert.match(confirmation, new RegExp(result.details.hash));
	assert.match(confirmation, /\[ship-behavior\] -> final-check/);
	assert.equal((await readDeliveryGraph(project.root)).status, "approved");
	assert.equal((await readFile(join(project.root, ".context", "issues", "graph.json"), "utf8")).endsWith("\n"), true);
	await assert.rejects(readFile(planningReviewPath(project.root), "utf8"), /ENOENT/);
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, { cwd: project.root, mode: "rpc", ui: {} }), /requires interactive TUI/);
});

test("plan-delivery resolves the Git top-level and refuses its active execution", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	const subdirectory = join(project.root, "packages", "app");
	await mkdir(subdirectory, { recursive: true });
	const previousHerdr = process.env.HERDR_ENV;
	const previousPane = process.env.HERDR_PANE_ID;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "main-pane";
	t.after(() => {
		setEnvironment("HERDR_ENV", previousHerdr);
		setEnvironment("HERDR_PANE_ID", previousPane);
	});

	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const messages: string[] = [];
	registerPlanning({
		registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
		registerTool() {},
		sendUserMessage(message: string) { messages.push(message); },
	} as never);
	assert.ok(command);
	const notifications: string[] = [];
	const ctx = {
		cwd: subdirectory,
		mode: "tui",
		isIdle: () => true,
		ui: {
			select: async () => "Resume",
			notify: (message: string) => { notifications.push(message); },
		},
	};
	await command("preserve CLI contract", ctx);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /Planning mode: resume/);
	assert.match(messages[0], new RegExp(`Repository root: ${escapeRegExp(project.root)}`));
	assert.match(messages[0], new RegExp(`Delivery Graph: ${escapeRegExp(join(project.root, ".context", "issues", "graph.json"))}`));
	assert.match(messages[0], /Reviewer profile:/);
	assert.match(messages[0], /Additional user context: preserve CLI contract/);
	assert.match(messages[0], /do not start Auto DAG/);

	await mkdir(join(project.root, ".context", "pi-auto-dag"), { recursive: true });
	await writeFile(join(project.root, ".context", "pi-auto-dag", "active.json"), JSON.stringify({ run_id: "11111111-1111-4111-8111-111111111111" }));
	await command("", ctx);
	assert.equal(messages.length, 1);
	assert.match(notifications.at(-1)!, /Cannot plan while Auto DAG run is active/);
});

test("planning validation and approval require ignored untracked local context", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	await writePlanningReviewPass(project.root);
	const tools = new Map<string, { execute: Function }>();
	registerPlanning({
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
	} as never);
	const validate = tools.get(PLANNING_TOOLS.validate)!;
	const approve = tools.get(PLANNING_TOOLS.approve)!;
	const subdirectory = join(project.root, "packages", "app");
	await mkdir(subdirectory, { recursive: true });
	const ctx = { cwd: subdirectory, mode: "tui", ui: { confirm: async () => true } };

	assert.match((await validate.execute("validate", {}, undefined, undefined, ctx)).content[0].text, /is valid \(draft\)/);
	await writeFile(join(project.root, ".gitignore"), "");
	await assert.rejects(validate.execute("validate", {}, undefined, undefined, ctx), /.context\/ must be Git-ignored/);
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, ctx), /.context\/ must be Git-ignored/);
	assert.equal((await readDeliveryGraph(project.root)).status, "draft");

	await writeFile(join(project.root, ".gitignore"), ".context/\n");
	await git(project.root, "add", "-f", ".context/issues/graph.json");
	await assert.rejects(validate.execute("validate", {}, undefined, undefined, ctx), /.context\/issues\/graph.json must be untracked and Git-ignored/);
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, ctx), /.context\/issues\/graph.json must be untracked and Git-ignored/);
	assert.equal((await readDeliveryGraph(project.root)).status, "draft");
});

async function setup(t: TestContext): Promise<{ root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-planning-"));
	await git(root, "init", "-b", "main");
	await writeFile(join(root, ".gitignore"), ".context/\n");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-planning-agent-"));
	const reviewer = join(agentDir, "profiles", "reviewer");
	await mkdir(reviewer, { recursive: true });
	await mkdir(join(agentDir, "config"), { recursive: true });
	const profiles = { coder: reviewer, backend: reviewer, frontend: reviewer, reviewer };
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify({ version: 1, profiles }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		setEnvironment("PI_CODING_AGENT_DIR", previous);
		await rm(root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	return { root };
}

function setEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFile("git", args, { cwd });
	return result.stdout.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
