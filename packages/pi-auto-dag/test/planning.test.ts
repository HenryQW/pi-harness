import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { runCommand, type CommandRunner } from "../src/command.ts";
import { hashDeliveryGraph, readDeliveryGraph, writeDeliveryGraph } from "../src/graph.ts";
import { planningReviewPath, PLANNING_REVIEW_TOOL, writePlanningReviewPass } from "../src/planning-review.ts";
import { PLANNING_TOOLS, registerPlanning } from "../src/planning.ts";
import { createWorkerExtension } from "../src/worker.ts";
import { createTestProfiles, createTestSkills, testProfileConfig, testSkills } from "./support/profiles.ts";

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
	await writeFile(join(project.root, "change.txt"), "planned change\n");
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
	const notifications: string[] = [];
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
		ui: {
			confirm: async (title: string, message: string) => {
				if (title === "Approve Delivery Graph?") confirmation = message;
				else {
					assert.equal(title, "Commit current branch changes?");
					assert.equal(message, "?? change.txt");
				}
				return true;
			},
			input: async () => "feat: ship behavior",
			notify: (message: string) => { notifications.push(message); },
		},
	}) as { content: Array<{ text: string }>; details: { graph: { status: string }; hash: string } };
	assert.equal(result.details.graph.status, "approved");
	assert.equal(await git(project.root, "log", "-1", "--format=%s"), "feat: ship behavior");
	assert.equal(await git(project.root, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.deepEqual(notifications, ["Next step: Start Auto DAG for approved graph."]);
	assert.match(confirmation, new RegExp(result.details.hash));
	assert.match(confirmation, /\[ship-behavior\] -> final-check/);
	assert.equal((await readDeliveryGraph(project.root)).status, "approved");
	assert.equal((await readFile(join(project.root, ".context", "issues", "graph.json"), "utf8")).endsWith("\n"), true);
	await assert.rejects(readFile(planningReviewPath(project.root), "utf8"), /ENOENT/);
	await assert.rejects(approve.execute("approve", {}, undefined, undefined, { cwd: project.root, mode: "rpc", ui: {} }), /requires interactive TUI/);
});

for (const position of ["default branch", "detached HEAD"] as const) {
	test(`approval does not offer commits or advertise start on ${position}`, async (t) => {
		const project = await setup(t);
		await git(project.root, "switch", position === "default branch" ? "main" : "--detach");
		await writeDeliveryGraph(project.root, draft);
		await writePlanningReviewPass(project.root);
		await writeFile(join(project.root, "change.txt"), "uncommitted\n");
		const head = await git(project.root, "rev-parse", "HEAD");
		const tools = new Map<string, { execute: Function }>();
		registerPlanning({
			registerCommand() {},
			registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
		} as never);
		const notifications: string[] = [];
		const result = await tools.get(PLANNING_TOOLS.approve)!.execute("approve", {}, undefined, undefined, {
			cwd: project.root,
			mode: "tui",
			ui: {
				confirm: async (title: string) => {
					assert.equal(title, "Approve Delivery Graph?");
					return true;
				},
				notify: (message: string) => { notifications.push(message); },
			},
		}) as { details: { graph: { status: string } } };

		assert.equal(result.details.graph.status, "approved");
		assert.equal(await git(project.root, "rev-parse", "HEAD"), head);
		assert.equal(await git(project.root, "status", "--porcelain=v1", "--untracked-files=all"), "?? change.txt");
		assert.deepEqual(notifications, [position === "default branch"
			? "Auto DAG cannot start: Main integration worktree must not use the default branch: main"
			: "Auto DAG cannot start: Main integration worktree is detached"]);
	});
}

test("approval warns when integration branch misses the current default ref", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	await writePlanningReviewPass(project.root);
	const advancedMain = await git(project.root, "commit-tree", "main^{tree}", "-p", "main", "-m", "advance default");
	await git(project.root, "update-ref", "refs/heads/main", advancedMain);
	const tools = new Map<string, { execute: Function }>();
	registerPlanning({
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
	} as never);
	const notifications: string[] = [];

	await tools.get(PLANNING_TOOLS.approve)!.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: {
			confirm: async () => true,
			notify: (message: string) => { notifications.push(message); },
		},
	});

	assert.deepEqual(notifications, [
		"Auto DAG cannot start: Integration branch integration has an unsuitable base; it must contain refs/heads/main",
	]);
});

test("approval survives a rejected post-approval Git operation", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	await writePlanningReviewPass(project.root);
	const runner: CommandRunner = async (command, args, options) => {
		if (command === "git" && args[0] === "status") throw new Error("simulated rejection");
		return runCommand(command, args, options);
	};
	const tools = new Map<string, { execute: Function }>();
	registerPlanning({
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
	} as never, runner);
	const notifications: string[] = [];
	const result = await tools.get(PLANNING_TOOLS.approve)!.execute("approve", {}, undefined, undefined, {
		cwd: project.root,
		mode: "tui",
		ui: {
			confirm: async () => true,
			notify: (message: string) => { notifications.push(message); },
		},
	}) as { details: { graph: { status: string } } };

	assert.equal(result.details.graph.status, "approved");
	assert.equal((await readDeliveryGraph(project.root)).status, "approved");
	assert.deepEqual(notifications, ["Post-approval Git operation failed: simulated rejection"]);
});

test("dag-plan resolves the Git top-level and refuses its active execution", async (t) => {
	const project = await setup(t);
	await writeDeliveryGraph(project.root, draft);
	await createTestSkills(project.agentDir);
	await writeFile(join(project.agentDir, "config", "pi-auto-dag.json"), JSON.stringify(testProfileConfig(project.root, {
		profileSkills: { reviewer: ["shared"] },
	})));
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
	let commandName: string | undefined;
	const messages: string[] = [];
	registerPlanning({
		registerCommand(name: string, options: { handler: typeof command }) {
			commandName = name;
			command = options.handler;
		},
		registerTool() {},
		sendUserMessage(message: string) { messages.push(message); },
	} as never);
	assert.equal(commandName, "dag-plan");
	assert.ok(command);
	const notifications: string[] = [];
	const ctx = {
		cwd: subdirectory,
		mode: "tui",
		isIdle: () => true,
		getSystemPromptOptions: () => ({ skills: testSkills(project.agentDir) }),
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
	assert.match(messages[0], /Implementation profiles:.*backend test profile/);
	assert.match(messages[0], /Reviewer launch environment:.*PI_CODING_AGENT_DIR/);
	assert.match(messages[0], /Reviewer Pi arguments:.*--no-skills.*--skill.*shared.*SKILL.md.*auto_dag_submit_plan_review/);
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

async function setup(t: TestContext): Promise<{ root: string; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-planning-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Planning Test");
	await git(root, "config", "user.email", "planning@example.com");
	await writeFile(join(root, ".gitignore"), ".context/\n");
	await git(root, "add", ".gitignore");
	await git(root, "commit", "-m", "initial");
	await git(root, "switch", "-c", "integration");
	await createTestProfiles(root);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-planning-agent-"));
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify(testProfileConfig(root)));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		setEnvironment("PI_CODING_AGENT_DIR", previous);
		await rm(root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	return { root, agentDir };
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
