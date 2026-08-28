import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExecOptions, type ExtensionAPI, type ExtensionContext, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type {
	EphemeralSubagentActivityEvent,
	EphemeralSubagentExecutor,
	EphemeralSubagentResult,
	EphemeralSubagentRunInput,
	ResolvedRoleLaunch,
	Role,
} from "@henryqw/pi-subagent";
import {
	DelegateFlowContinueSchema,
	DelegateFlowSchema,
	parseDelegateFlow,
	parseDelegateFlowContinue,
	registerDelegateFlow,
} from "../extensions/delegate-flow.ts";
import { CHILD_EXCLUDED_TOOLS, loadBuiltinRole } from "../src/index.ts";

type Tool = {
	name: string;
	parameters: unknown;
	prepareArguments?: (value: unknown) => unknown;
	renderShell?: "default" | "self";
	renderCall?: (...args: any[]) => { render: (width: number) => string[] };
	renderResult?: (...args: any[]) => { render: (width: number) => string[] };
	execute: (...args: any[]) => Promise<any>;
};

type PreparedChild = Awaited<ReturnType<EphemeralSubagentRunInput["prepare"]>>;
type ChildHandler = (prepared: PreparedChild, input: EphemeralSubagentRunInput) => Promise<EphemeralSubagentResult> | EphemeralSubagentResult;

type ExecLog = {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
};

const model = {
	provider: "test",
	id: "flow-model",
	name: "Flow Model",
	api: "openai-responses",
	baseUrl: "https://example.test",
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 10_000,
	reasoning: true,
	thinkingLevelMap: { low: "low" },
} as const;

const success = (output = "done"): EphemeralSubagentResult => ({ outcome: "success", exitCode: 0, output, stderr: "" });
const failure = (message = "child failed"): EphemeralSubagentResult => ({
	outcome: "failure",
	exitCode: 1,
	output: "",
	stderr: message,
	errorMessage: message,
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitRaw(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repository(t: import("node:test").TestContext): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-flow-test-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Flow Test");
	git(repo, "config", "user.email", "flow@example.com");
	await writeFile(join(repo, "base.txt"), "base\n");
	await writeFile(join(repo, "shared.txt"), "base\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	return repo;
}

function runExec(command: string, args: string[], options?: ExecOptions): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	return new Promise((resolve) => {
		execFile(command, args, {
			cwd: options?.cwd,
			signal: options?.signal,
			timeout: options?.timeout,
		}, (error, stdout, stderr) => {
			resolve({
				stdout: String(stdout),
				stderr: String(stderr),
				code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
				killed: Boolean(error && "killed" in error && error.killed),
			});
		});
	});
}

function harness(cwd: string, handler: ChildHandler, overrideExec?: (
	command: string,
	args: string[],
	options: ExecOptions | undefined,
	next: () => ReturnType<typeof runExec>,
) => ReturnType<typeof runExec>, flowRoles = [loadBuiltinRole("implementer"), loadBuiltinRole("reviewer")]) {
	const tools = new Map<string, Tool>();
	const childCalls: PreparedChild[] = [];
	const roles: Role[] = [];
	const routes: Array<{ role: string; modelClass: string | undefined }> = [];
	const execLogs: ExecLog[] = [];
	const widgets: Array<{ action: "start" | "finish"; id: string; role?: string; status?: string; task?: string }> = [];
	const widgetActivity: Array<{ id: string; event: EphemeralSubagentActivityEvent }> = [];
	let sessionGeneration = 0;
	const executor: EphemeralSubagentExecutor = {
		async run(input) {
			const prepared = await input.prepare();
			childCalls.push(prepared);
			return await handler(prepared, input);
		},
	};
	const api = {
		registerTool(tool: Tool) { tools.set(tool.name, tool); },
		exec(command: string, args: string[], options?: ExecOptions) {
			execLogs.push({ command, args: [...args], options });
			const next = () => runExec(command, args, options);
			return overrideExec ? overrideExec(command, args, options, next) : next();
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const invalidateSession = registerDelegateFlow(api, {
		executor,
		maxRuntimeMs: 123_456,
		getSessionGeneration: () => sessionGeneration,
		loadRoles: () => flowRoles,
		resolveLaunch(role, modelClass) {
			roles.push(role);
			routes.push({ role: role.name, modelClass });
			return {
				args: [],
				env: { FLOW_ROLE: role.name, FLOW_MODEL_CLASS: modelClass ?? "assignment" },
				model,
				thinkingLevel: "low",
				missingSkills: [],
			} as unknown as ResolvedRoleLaunch;
		},
		startWidget(id, role, _model, _thinkingLevel, task) { widgets.push({ action: "start", id, role, task }); },
		updateWidgetTokens() {},
		updateWidgetActivity(id, event) { widgetActivity.push({ id, event }); },
		finishWidget(id, status) { widgets.push({ action: "finish", id, status }); },
	});
	return {
		tools,
		childCalls,
		roles,
		routes,
		execLogs,
		widgets,
		widgetActivity,
		ctx,
		async emitSession(_event: "session_start" | "session_shutdown") {
			sessionGeneration += 1;
			invalidateSession();
		},
	};
}

function flowTool(app: ReturnType<typeof harness>): Tool {
	return app.tools.get("delegate_flow")!;
}

function continueTool(app: ReturnType<typeof harness>): Tool {
	return app.tools.get("delegate_flow_continue")!;
}

const validation = (code = "process.exit(0)") => [{ command: process.execPath, args: ["-e", code] }];
const unit = (id: string, task = `Implement ${id}`, gate = validation()) => ({ id, task, validation: gate });
const reviewedUnit = (id: string, task = `Implement ${id}`, gate = validation()) => ({
	...unit(id, task, gate),
	review: "Confirm the change meets the stated requirements.",
});

function childRole(prepared: PreparedChild): string {
	return prepared.launch.env.FLOW_ROLE!;
}

function childModelClass(prepared: PreparedChild): string {
	return prepared.launch.env.FLOW_MODEL_CLASS!;
}

function unitId(task: string): string {
	const match = /(?:Flow Unit|Repair Flow Unit) "([^"]+)"/.exec(task);
	assert.ok(match, task);
	return match[1]!;
}

function reviewPacket(task: string): { base: string; tip: string; patchPath: string } {
	const match = /^Review Packet: (.+)$/m.exec(task);
	assert.ok(match, task);
	return JSON.parse(match[1]!);
}

async function commit(cwd: string, path: string, content: string, message = `change ${path}`): Promise<void> {
	const target = join(cwd, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, content);
	git(cwd, "add", path);
	git(cwd, "commit", "-qm", message);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Flow test state.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("Flow schemas enforce the small public boundary and child tools cannot recurse", async () => {
	assert.equal((DelegateFlowSchema as any).additionalProperties, false);
	assert.equal((DelegateFlowSchema as any).properties.units.minItems, 1);
	assert.equal((DelegateFlowSchema as any).properties.units.maxItems, 8);
	assert.equal((DelegateFlowContinueSchema as any).additionalProperties, false);
	assert.deepEqual(parseDelegateFlow({ units: [{
		id: " one ", task: " work ", validation: [{ command: " node ", args: ["", "x"] }], modelClass: "fast", review: " use judgment ",
	}] }), {
		units: [{ id: "one", task: "work", validation: [{ command: "node", args: ["", "x"] }], modelClass: "fast", review: "use judgment" }],
	});
	assert.deepEqual(parseDelegateFlowContinue({ guidance: " fix it ", modelClass: "balanced" }), { guidance: "fix it", modelClass: "balanced" });
	for (const value of [
		{},
		{ units: [] },
		{ units: Array.from({ length: 9 }, (_, index) => unit(String(index))) },
		{ units: [{ id: "x", task: "work", validation: [] }] },
		{ units: [{ ...unit("x"), extra: true }] },
		{ units: [{ id: "x", task: "work", validation: [{ command: "node", args: [], extra: true }] }] },
		{ units: [{ id: "x", task: "work", validation: [{ command: "node", args: ["bad\0arg"] }] }] },
		{ units: [{ ...unit("x"), modelClass: "slow" }] },
		{ units: [{ ...unit("x"), review: " \n " }] },
		{ units: [{ ...unit("x"), review: "bad\0review" }] },
	]) assert.throws(() => parseDelegateFlow(value));
	assert.throws(() => parseDelegateFlow({ units: [unit("same"), unit(" same ")] }), /unique/);
	assert.throws(() => parseDelegateFlowContinue({ guidance: " \n " }));
	assert.throws(() => parseDelegateFlowContinue({ guidance: "repair", modelClass: "slow" }));
	assert.throws(() => parseDelegateFlowContinue({ guidance: "repair", extra: true }));
	assert.deepEqual(CHILD_EXCLUDED_TOOLS.split(",").filter((name) => name.startsWith("delegate_")), [
		"delegate_task", "delegate_flow", "delegate_flow_continue",
	]);
	const manifest = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/subagent.ts"]);
});

test("Flow tool blocks are concise and bounded", async (t) => {
	const app = harness(await repository(t), () => success());
	const theme = { fg: (_color: string, value: string) => `\x1b[36m${value}\x1b[0m` };
	const hiddenTask = "FULL FLOW TASK";
	const hiddenValidation = "--validation-should-not-render";
	const hiddenGuidance = "FULL REPAIR GUIDANCE";
	const prohibited = /FULL FLOW TASK|--validation-should-not-render|FULL REPAIR GUIDANCE/;
	const tools = [
		{
			tool: flowTool(app),
			args: { units: [
				{ id: "one", task: hiddenTask, validation: [{ command: "hidden-validation", args: [hiddenValidation] }] },
				{ id: "two", task: hiddenTask, validation: [{ command: "hidden-validation", args: [hiddenValidation] }] },
			] },
			label: "delegate_flow · working: 2 units",
		},
		{
			tool: continueTool(app),
			args: { guidance: hiddenGuidance },
			label: "delegate_flow_continue · working: repair continuation",
		},
	] as const;
	const results = [
		{
			name: "completed",
			text: ["", "Flow completed.", "", 'Completed units: "one".', "Warnings:", "- cleanup warning", "Retained Flow state:", "- retained path"].join("\n"),
			diagnostic: undefined,
		},
		{
			name: "blocked",
			text: ["Flow blocked.", "Completed units: none.", 'Blocked unit: "one".', "Classification: validation.", "Repair available: true.", "", "Diagnostic:", "blocked diagnostic", "diagnostic continuation", "Call delegate_flow_continue."].join("\n"),
			diagnostic: "blocked diagnostic",
		},
		{
			name: "failed",
			text: ["Flow failed.", "Completed units: none.", "Classification: infrastructure.", "Diagnostic:", "failed diagnostic", "diagnostic continuation", "Retained Flow state:", "- retained path"].join("\n"),
			diagnostic: "failed diagnostic",
		},
	] as const;

	initTheme("dark");
	for (const { tool, args, label } of tools) {
		assert.equal(tool.renderShell, "self");
		const call = tool.renderCall!(args, theme, {}).render(100);
		assert.equal(call.length, 1);
		assert.match(call[0]!, new RegExp(label));
		assert.doesNotMatch(call.join("\n"), prohibited);
		for (const width of [100, 24, 1]) {
			const lines = tool.renderCall!(args, theme, {}).render(width);
			assert.equal(lines.length, 1);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}

		for (const { name, text, diagnostic } of results) {
			const result = { content: [{ type: "text", text }], details: {} };
			const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {}).render(100);
			const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {}).render(100);
			assert.deepEqual(expanded, collapsed, `${label} ${name}`);
			assert.ok(collapsed.length <= 3, `${label} ${name}`);
			assert.ok(call.length + collapsed.length <= 4, `${label} ${name}`);
			assert.ok(collapsed.every((line) => visibleWidth(line) <= 100), `${label} ${name}`);
			assert.match(collapsed.join("\n"), /… \d+ more/, `${label} ${name}`);
			if (diagnostic) assert.match(collapsed.join("\n"), new RegExp(`Diagnostic: ${diagnostic}`), `${label} ${name}`);
			for (const width of [100, 24, 1]) {
				const working = tool.renderCall!(args, theme, {}).render(width);
				for (const expanded of [false, true]) {
					const lines = tool.renderResult!(result, { expanded, isPartial: false }, theme, {}).render(width);
					assert.ok(lines.length <= 3, `${label} ${name} expanded=${expanded} width=${width}`);
					assert.ok(working.length + lines.length <= 4, `${label} ${name} expanded=${expanded} width=${width}`);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${label} ${name} expanded=${expanded} width=${width}`);
				}
			}

			const component = new ToolExecutionComponent(
				tool.name,
				`bounded-${tool.name}-${name}`,
				args,
				undefined,
				tool as never,
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			component.markExecutionStarted();
			component.setArgsComplete();
			assert.equal(component.render(100).length, 2);
			component.updateResult({ ...result, isError: false });
			for (const width of [100, 24, 1]) {
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const lines = component.render(width);
					assert.ok(lines.length <= 5, `${label} ${name} composed expanded=${expanded} width=${width}`);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${label} ${name} composed expanded=${expanded} width=${width}`);
					assert.doesNotMatch(lines.join("\n"), prohibited);
				}
			}
		}
	}
});

test("Flow result renderers retain a recovery path beside long diagnostics", async (t) => {
	const app = harness(await repository(t), () => success());
	const theme = { fg: (_color: string, value: string) => value };
	const recovery = '- unit="x" path="/repo/.worktrees/retained" branch="pi-subagent/retained" base=abc123 worktree=true branch_ref=true';
	const result = {
		content: [{ type: "text" as const, text: [
			"Flow failed.",
			"Completed units: none.",
			"Classification: infrastructure.",
			"Diagnostic:",
			"x".repeat(160),
			"diagnostic continuation",
			"Retained Flow state:",
			recovery,
		].join("\n") }],
		details: {},
	};

	for (const [label, tool] of [["delegate_flow", flowTool(app)], ["delegate_flow_continue", continueTool(app)]] as const) {
		const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {}).render(100);
		const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {}).render(100);
		assert.deepEqual(expanded, collapsed, label);
		assert.equal(collapsed.length, 3, label);
		assert.match(collapsed[1]!, /^Diagnostic:/, label);
		assert.match(collapsed[2]!, /path="\/repo\/\.worktrees\/retained"/, label);
		assert.doesNotMatch(collapsed.join("\n"), /… \d+ more/, label);

		for (const width of [24, 1]) {
			const lines = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {}).render(width);
			assert.equal(lines.length, 3, `${label} width=${width}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${label} width=${width}`);
		}
		assert.match(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {}).render(24)[2]!, /path="\/rep/, label);
	}
});

test("setup preserves a clean registered collision, cleans earlier allocations non-forcibly, and never falls back outside committed Git", async (t) => {
	const repo = await repository(t);
	let children = 0;
	const app = harness(repo, () => { children++; return success(); });
	const firstId = "partial:flow:0:one";
	const secondId = "partial:flow:1:two";
	const childName = (id: string) => `subagent-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
	const firstName = childName(firstId);
	const secondName = childName(secondId);
	const collisionPath = join(await realpath(repo), ".worktrees", secondName);
	const collisionBranch = `pi-subagent/${secondName}`;
	await writeFile(join(repo, ".git", "info", "exclude"), "/.worktrees/\n");
	await mkdir(join(repo, ".worktrees"), { recursive: true });
	git(repo, "worktree", "add", "-qb", collisionBranch, collisionPath);
	const collisionHead = git(collisionPath, "rev-parse", "HEAD");

	const partial = await flowTool(app).execute("partial", { units: [unit("one"), unit("two")] }, undefined, undefined, app.ctx);
	assert.equal(partial.details.outcome, "failed");
	assert.equal(partial.details.failure.classification, "setup");
	assert.equal(children, 0);
	assert.equal(existsSync(join(repo, ".worktrees", firstName)), false);
	assert.equal(git(repo, "branch", "--list", `pi-subagent/${firstName}`), "");
	assert.match(partial.content[0].text, /Attempted allocations preserved without cleanup/);
	assert.deepEqual(partial.details.retained, []);
	assert.equal(partial.details.setupRecoveries.length, 1);
	const recovery = partial.details.setupRecoveries[0];
	assert.deepEqual({ id: recovery.id, path: recovery.path, branch: recovery.branch, base: recovery.base }, {
		id: "two",
		path: collisionPath,
		branch: collisionBranch,
		base: collisionHead,
	});
	assert.match(recovery.diagnostic, /worktree add failed after attempting/);
	assert.equal(existsSync(collisionPath), true);
	assert.equal(git(collisionPath, "status", "--porcelain"), "");
	assert.equal(git(collisionPath, "rev-parse", "HEAD"), collisionHead);
	assert.equal(git(collisionPath, "branch", "--show-current"), collisionBranch);
	assert.match(gitRaw(repo, "worktree", "list", "--porcelain"), new RegExp(collisionPath));
	const cleanupCalls = app.execLogs.filter(({ command, args }) => command === "git" && args.includes("worktree") && args.includes("remove"));
	assert.ok(cleanupCalls.every(({ args }) => !args.includes("--force")));
	assert.ok(cleanupCalls.every(({ args }) => !args.includes(collisionPath)));
	assert.ok(app.execLogs
		.filter(({ command, args }) => command === "git" && args.includes("branch") && args.includes("-d"))
		.every(({ args }) => !args.includes(collisionBranch)));

	await writeFile(join(repo, "dirty-main.txt"), "dirty\n");
	const dirty = await flowTool(app).execute("dirty-main", { units: [unit("dirty")] }, undefined, undefined, app.ctx);
	assert.equal(dirty.details.failure.classification, "setup");
	assert.match(dirty.details.failure.diagnostic, /requires clean Git Main/);
	assert.equal(children, 0);

	const outside = await mkdtemp(join(tmpdir(), "pi-subagent-flow-nongit-"));
	t.after(async () => { await rm(outside, { recursive: true, force: true }); });
	const nonGit = harness(outside, () => { children++; return success(); });
	const missing = await flowTool(nonGit).execute("non-git", { units: [unit("none")] }, undefined, undefined, nonGit.ctx);
	assert.equal(missing.details.outcome, "failed");
	assert.equal(missing.details.failure.classification, "setup");
	assert.equal(children, 0);
	assert.equal(existsSync(join(outside, ".worktrees")), false);

	const unborn = await mkdtemp(join(tmpdir(), "pi-subagent-flow-unborn-"));
	t.after(async () => { await rm(unborn, { recursive: true, force: true }); });
	git(unborn, "init", "-q");
	const noHead = harness(unborn, () => { children++; return success(); });
	const unbornResult = await flowTool(noHead).execute("unborn", { units: [unit("none")] }, undefined, undefined, noHead.ctx);
	assert.equal(unbornResult.details.failure.classification, "setup");
	assert.equal(children, 0);
});

test("Main cleanliness rejects hidden tracked bytes at setup and integration while allowing ignored dependencies", async (t) => {
	const repo = await repository(t);
	let children = 0;
	let mutateAtReview = false;
	const app = harness(repo, async (prepared) => {
		children++;
		if (childRole(prepared) === "implementer") {
			await commit(prepared.cwd, "approved.txt", "approved\n");
			return success();
		}
		if (mutateAtReview) {
			git(repo, "update-index", "--skip-worktree", "base.txt");
			await writeFile(join(repo, "base.txt"), "hidden during review\n");
		}
		return success("PASS");
	});

	for (const [enable, disable] of [
		[["--assume-unchanged"], ["--no-assume-unchanged"]],
		[["--skip-worktree"], ["--no-skip-worktree"]],
	] as const) {
		git(repo, "update-index", ...enable, "base.txt");
		const flagged = await flowTool(app).execute(`flag-${enable[0]}`, { units: [unit("flagged")] }, undefined, undefined, app.ctx);
		assert.equal(flagged.details.failure.classification, "setup");
		assert.match(flagged.details.failure.diagnostic, /assume-unchanged or skip-worktree/);
		git(repo, "update-index", ...disable, "base.txt");
	}
	git(repo, "update-index", "--assume-unchanged", "base.txt");
	await writeFile(join(repo, "base.txt"), "hidden before Flow\n");
	const setup = await flowTool(app).execute("hidden-setup", { units: [unit("setup")] }, undefined, undefined, app.ctx);
	assert.equal(setup.details.failure.classification, "setup");
	assert.match(setup.details.failure.diagnostic, /requires clean Git Main/);
	assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "hidden before Flow\n");
	assert.equal(children, 0);
	assert.equal((gitRaw(repo, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? []).length, 1);

	git(repo, "update-index", "--no-assume-unchanged", "base.txt");
	git(repo, "checkout", "--", "base.txt");
	await writeFile(join(repo, ".gitignore"), "node_modules/\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore dependencies");
	await mkdir(join(repo, "node_modules", "dependency"), { recursive: true });
	await writeFile(join(repo, "node_modules", "dependency", "data"), "ordinary ignored dependency\n");
	const mainHead = git(repo, "rev-parse", "HEAD");
	mutateAtReview = true;

	const integration = await flowTool(app).execute("hidden-integration", { units: [reviewedUnit("integration")] }, undefined, undefined, app.ctx);
	assert.equal(integration.details.failure.classification, "main");
	assert.match(integration.details.failure.diagnostic, /changed outside the active Flow/);
	assert.equal(children, 2);
	assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
	assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "hidden during review\n");
	assert.equal(await readFile(join(repo, "node_modules", "dependency", "data"), "utf8"), "ordinary ignored dependency\n");
	assert.deepEqual(integration.details.retained.map(({ id }: any) => id), ["integration"]);
	assert.equal(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").length, 0);
	assert.ok(app.execLogs.some(({ command, args }) => command === "git" && args.slice(1).join(" ") === "update-index --really-refresh"));
});

test("Unit validation rejects hidden tracked changes without rejecting ignored generated files", async (t) => {
	for (const [enable, disable] of [
		["--assume-unchanged", "--no-assume-unchanged"],
		["--skip-worktree", "--no-skip-worktree"],
	] as const) {
		const repo = await repository(t);
		await writeFile(join(repo, ".gitignore"), "build/\n");
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-qm", "ignore generated output");
		let reviewers = 0;
		const app = harness(repo, async (prepared) => {
			if (childRole(prepared) === "reviewer") { reviewers++; return success("PASS"); }
			await commit(prepared.cwd, "approved.txt", "approved\n");
			await mkdir(join(prepared.cwd, "build"), { recursive: true });
			await writeFile(join(prepared.cwd, "build", "output"), "generated\n");
			return success();
		});
		const result = await flowTool(app).execute(`hidden-unit-${enable}`, {
			units: [reviewedUnit("hidden", "work", [{ command: "git", args: ["update-index", enable, "base.txt"] }])],
		}, undefined, undefined, app.ctx);
		assert.equal(result.details.outcome, "blocked");
		assert.equal(result.details.blocked.classification, "validation");
		assert.match(result.details.blocked.diagnostic, /assume-unchanged or skip-worktree/);
		assert.equal(reviewers, 0);
		assert.equal(await readFile(join(result.details.blocked.path, "build", "output"), "utf8"), "generated\n");
		git(result.details.blocked.path, "update-index", disable, "base.txt");
	}
});

test("a post-checkout setup failure preserves and reports the attempted allocation", async (t) => {
	const repo = await repository(t);
	const hook = join(repo, ".git", "hooks", "post-checkout");
	await writeFile(hook, "#!/bin/sh\necho post-checkout failed >&2\nexit 1\n");
	await chmod(hook, 0o755);
	let children = 0;
	const app = harness(repo, () => { children++; return success(); });
	const toolCallId = "post-create";
	const name = `subagent-${createHash("sha256").update(`${toolCallId}:flow:0:unit`).digest("hex").slice(0, 24)}`;

	const result = await flowTool(app).execute(toolCallId, { units: [unit("unit")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "setup");
	assert.match(result.details.failure.diagnostic, /post-checkout failed/);
	assert.equal(children, 0);
	const attemptedPath = join(await realpath(repo), ".worktrees", name);
	assert.equal(existsSync(attemptedPath), true);
	assert.match(git(repo, "branch", "--list", `pi-subagent/${name}`), new RegExp(name));
	assert.deepEqual(result.details.retained, []);
	assert.deepEqual(result.details.setupRecoveries.map(({ id, path, branch }: any) => ({ id, path, branch })), [{
		id: "unit",
		path: attemptedPath,
		branch: `pi-subagent/${name}`,
	}]);
});

test("Flow uses effective Implementer/Reviewer overrides in the caller-relative Unit cwd without nesting", async (t) => {
	const repo = await repository(t);
	const caller = join(repo, "packages", "feature");
	await mkdir(caller, { recursive: true });
	await writeFile(join(caller, "package.json"), "{}\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "add package");
	const childCwds: string[] = [];
	let patch = "";
	const flowRoles = [
		{ ...loadBuiltinRole("implementer"), description: "User Implementer override" },
		{ ...loadBuiltinRole("reviewer"), description: "User Reviewer override" },
	];
	const app = harness(caller, async (prepared) => {
		childCwds.push(prepared.cwd);
		if (childRole(prepared) === "implementer") {
			assert.equal((gitRaw(repo, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? []).length, 2);
			await commit(prepared.cwd, "change.txt", "implemented\n");
			return success("implemented");
		}
		const packet = reviewPacket(prepared.task);
		patch = await readFile(packet.patchPath, "utf8");
		assert.equal(git(prepared.cwd, "rev-parse", "HEAD"), packet.tip);
		return success("PASS\n");
	}, undefined, flowRoles);
	const result = await flowTool(app).execute("caller-cwd", { units: [reviewedUnit("feature")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "completed");
	assert.equal(childCwds.length, 2);
	assert.equal(childCwds[0], childCwds[1]);
	assert.ok(childCwds[0]!.replace(/\/$/, "").endsWith(join("packages", "feature")));
	assert.match(patch, /change\.txt/);
	assert.deepEqual(app.roles.map(({ name, description }) => ({ name, description })), [
		{ name: "implementer", description: "User Implementer override" },
		{ name: "reviewer", description: "User Reviewer override" },
	]);
	assert.equal((gitRaw(repo, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? []).length, 1);
	const validationCall = app.execLogs.find(({ command }) => command === process.execPath)!;
	assert.deepEqual(validationCall.args, ["-e", "process.exit(0)"]);
	assert.equal(validationCall.options?.cwd, childCwds[0]);
	assert.equal(validationCall.options?.timeout, 123_456);
});

test("validated units without review integrate mechanically without resolving a Reviewer", async (t) => {
	const repo = await repository(t);
	let tip = "";
	const app = harness(repo, async (prepared) => {
		assert.equal(childRole(prepared), "implementer");
		await commit(prepared.cwd, "mechanical.txt", "validated\n");
		tip = git(prepared.cwd, "rev-parse", "HEAD");
		return success();
	}, undefined, [loadBuiltinRole("implementer")]);

	const result = await flowTool(app).execute("mechanical", { units: [unit("mechanical")] }, undefined, undefined, app.ctx);

	assert.equal(result.details.outcome, "completed");
	assert.deepEqual(app.roles.map(({ name }) => name), ["implementer"]);
	assert.deepEqual(app.childCalls.map(childRole), ["implementer"]);
	assert.equal(app.execLogs.filter(({ command }) => command === process.execPath).length, 1);
	assert.deepEqual(app.execLogs
		.filter(({ command, args }) => command === "git" && args[1] === "merge")
		.map(({ args }) => args.slice(1)), [["merge", "--no-overwrite-ignore", "--ff-only", tip]]);
	assert.equal(git(repo, "rev-parse", "HEAD"), tip);
});

test("Flow routes each unit class to its Implementer and applicable Reviewer", async (t) => {
	const repo = await repository(t);
	const seen: Array<{ id: string; role: string; modelClass: string }> = [];
	const app = harness(repo, async (prepared) => {
		const id = unitId(prepared.task);
		seen.push({ id, role: childRole(prepared), modelClass: childModelClass(prepared) });
		if (childRole(prepared) === "implementer") {
			await commit(prepared.cwd, `${id}.txt`, `${id}\n`);
			return success();
		}
		reviewPacket(prepared.task);
		return success("PASS");
	});
	const result = await flowTool(app).execute("classes", { units: [
		{ ...reviewedUnit("assigned"), review: "Judge the assignment route." },
		{ ...reviewedUnit("fast"), modelClass: "fast" },
		{ ...reviewedUnit("balanced"), modelClass: "balanced" },
	] }, undefined, undefined, app.ctx);

	assert.equal(result.details.outcome, "completed");
	assert.deepEqual(seen.sort((left, right) => `${left.id}:${left.role}`.localeCompare(`${right.id}:${right.role}`)), [
		{ id: "assigned", role: "implementer", modelClass: "assignment" },
		{ id: "assigned", role: "reviewer", modelClass: "assignment" },
		{ id: "balanced", role: "implementer", modelClass: "balanced" },
		{ id: "balanced", role: "reviewer", modelClass: "balanced" },
		{ id: "fast", role: "implementer", modelClass: "fast" },
		{ id: "fast", role: "reviewer", modelClass: "fast" },
	]);
	assert.deepEqual(app.routes
		.map(({ role, modelClass }) => ({ role, modelClass: modelClass ?? "assignment" }))
		.sort((left, right) => `${left.role}:${left.modelClass}`.localeCompare(`${right.role}:${right.modelClass}`)), [
		{ role: "implementer", modelClass: "assignment" },
		{ role: "implementer", modelClass: "balanced" },
		{ role: "implementer", modelClass: "fast" },
		{ role: "reviewer", modelClass: "assignment" },
		{ role: "reviewer", modelClass: "balanced" },
		{ role: "reviewer", modelClass: "fast" },
	]);
});

test("parallel Implementers all settle before declared-order processing stops at the first failure", async (t) => {
	const repo = await repository(t);
	const base = git(repo, "rev-parse", "HEAD");
	const gates = [deferred<void>(), deferred<void>()];
	const started: string[] = [];
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			reviewers++;
			return success("PASS");
		}
		const id = unitId(prepared.task);
		started.push(id);
		await gates[id === "first" ? 0 : 1]!.promise;
		if (id === "first") return failure("first failed");
		await commit(prepared.cwd, "later.txt", "later completed\n");
		return success();
	});
	let settled = false;
	const running = flowTool(app).execute("settle", { units: [unit("first"), unit("later")] }, undefined, undefined, app.ctx)
		.then((value) => { settled = true; return value; });
	await waitFor(() => started.length === 2);
	gates[0]!.resolve();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(settled, false);
	gates[1]!.resolve();
	const result = await running;
	assert.equal(result.details.outcome, "blocked");
	assert.equal(result.details.blocked.id, "first");
	assert.equal(result.details.blocked.classification, "implementer");
	assert.equal(reviewers, 0);
	assert.equal(git(repo, "rev-parse", "HEAD"), base);
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["first", "later"]);
	const later = result.details.retained.find(({ id }: any) => id === "later");
	assert.equal(git(later.path, "status", "--porcelain"), "");
	assert.notEqual(git(later.path, "rev-parse", "HEAD"), base);
});

test("one continuation replaces the blocked Unit class in the same worktree and then clears the Flow", async (t) => {
	const repo = await repository(t);
	const criterion = "The repaired change must meet this deliberate review criterion.";
	let initialCwd = "";
	let repairCwd = "";
	let implementerRuns = 0;
	const classes: string[] = [];
	const app = harness(repo, async (prepared) => {
		classes.push(childModelClass(prepared));
		if (childRole(prepared) === "reviewer") return success("PASS");
		implementerRuns++;
		if (prepared.task.startsWith("Flow Unit")) {
			initialCwd = prepared.cwd;
			assert.ok(prepared.task.includes(criterion));
			return failure("implementation crashed");
		}
		repairCwd = prepared.cwd;
		assert.ok(prepared.task.includes(criterion));
		assert.match(prepared.task, /Previous implementer block:[\s\S]*implementation crashed/);
		assert.match(prepared.task, /Main guidance:\nCommit the requested file/);
		await commit(prepared.cwd, "repaired.txt", "fixed\n");
		return success();
	});
	const blocked = await flowTool(app).execute("repair", { units: [{ ...reviewedUnit("repairable"), review: criterion, modelClass: "fast" }] }, undefined, undefined, app.ctx);
	assert.equal(blocked.details.outcome, "blocked");
	await assert.rejects(
		flowTool(app).execute("blocked-concurrent", { units: [unit("other")] }, undefined, undefined, app.ctx),
		/another Flow is active/,
	);
	const completed = await continueTool(app).execute("continue", { guidance: "Commit the requested file", modelClass: "balanced" }, undefined, undefined, app.ctx);
	assert.equal(completed.details.outcome, "completed");
	assert.equal(initialCwd, repairCwd);
	assert.equal(implementerRuns, 2);
	assert.deepEqual(classes, ["fast", "balanced", "balanced"]);
	await assert.rejects(
		continueTool(app).execute("again", { guidance: "again" }, undefined, undefined, app.ctx),
		/requires an active blocked Flow/,
	);
});

test("Flow widgets use the original unit task for implementer, reviewer, and repair", async (t) => {
	const repo = await repository(t);
	const task = "Show the original unit task in the Flow widget";
	let implementationRuns = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			assert.match(prepared.task, /^Review Flow Unit /);
			return success("PASS");
		}
		if (++implementationRuns === 1) {
			assert.match(prepared.task, /^Flow Unit /);
			return failure("implementation crashed");
		}
		assert.match(prepared.task, /^Repair Flow Unit /);
		await commit(prepared.cwd, "repaired.txt", "fixed\n");
		return success();
	});

	const blocked = await flowTool(app).execute("widget-label", { units: [reviewedUnit("widget", task)] }, undefined, undefined, app.ctx);
	assert.equal(blocked.details.outcome, "blocked");
	const completed = await continueTool(app).execute("widget-label-continue", { guidance: "Commit the fix" }, undefined, undefined, app.ctx);
	assert.equal(completed.details.outcome, "completed");

	const starts = app.widgets.filter(({ action }) => action === "start");
	assert.deepEqual(starts.map(({ role, task: widgetTask }) => [role, widgetTask]), [
		["implementer", task],
		["implementer", task],
		["reviewer", task],
	]);
	for (const { task: widgetTask } of starts) assert.doesNotMatch(widgetTask!, /^(?:Flow Unit|Review Flow Unit|Repair Flow Unit)/);
});

test("Flow wires activity to each child widget without changing prompts", async (t) => {
	const repo = await repository(t);
	const prompts: string[] = [];
	const app = harness(repo, async (prepared, input) => {
		prompts.push(prepared.task);
		if (!input.onActivity) throw new Error("Flow child activity callback was not wired.");
		if (prepared.task.startsWith("Flow Unit")) {
			input.onActivity({ type: "tool_execution_start", toolCallId: "initial-read", toolName: "initial-tool", path: "src/private.ts" });
			return failure("implementation crashed");
		}
		if (prepared.task.startsWith("Repair Flow Unit")) {
			input.onActivity({ type: "tool_execution_start", toolCallId: "repair-write", toolName: "repair-tool" });
			await commit(prepared.cwd, "repaired.txt", "fixed\n");
			return success();
		}
		if (prepared.task.startsWith("Review Flow Unit")) {
			input.onActivity({ type: "message_end" });
			return success("PASS");
		}
		throw new Error(`Unexpected Flow child prompt: ${prepared.task}`);
	});

	const blocked = await flowTool(app).execute("activity-wire", { units: [reviewedUnit("activity", "Keep child prompts unchanged")] }, undefined, undefined, app.ctx);
	assert.equal(blocked.details.outcome, "blocked");
	const completed = await continueTool(app).execute("activity-wire-continue", { guidance: "Commit the fix" }, undefined, undefined, app.ctx);
	assert.equal(completed.details.outcome, "completed");

	assert.deepEqual(app.widgetActivity, [
		{
			id: "activity-wire:flow:0:implement",
			event: { type: "tool_execution_start", toolCallId: "initial-read", toolName: "initial-tool", path: "src/private.ts" },
		},
		{
			id: "activity-wire-continue:flow:0:repair",
			event: { type: "tool_execution_start", toolCallId: "repair-write", toolName: "repair-tool" },
		},
		{
			id: "activity-wire-continue:flow:0:review",
			event: { type: "message_end" },
		},
	]);
	assert.deepEqual(prompts.map((prompt) => prompt.match(/^(?:Flow Unit|Repair Flow Unit|Review Flow Unit)/)?.[0]), [
		"Flow Unit",
		"Repair Flow Unit",
		"Review Flow Unit",
	]);
	for (const prompt of prompts) assert.doesNotMatch(prompt, /initial-tool|repair-tool|src\/private\.ts/);
});

test("session reload invalidates blocked Flow state without persistence", async (t) => {
	const repo = await repository(t);
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") return success("PASS");
		const id = unitId(prepared.task);
		if (id === "blocked") return failure("needs guidance");
		await commit(prepared.cwd, `${id}.txt`, `${id}\n`);
		return success();
	});
	const blocked = await flowTool(app).execute("reload", { units: [unit("blocked")] }, undefined, undefined, app.ctx);
	assert.equal(blocked.details.outcome, "blocked");
	const retainedPath = blocked.details.blocked.path;

	await app.emitSession("session_shutdown");
	await app.emitSession("session_start");

	await assert.rejects(
		continueTool(app).execute("stale-continue", { guidance: "repair" }, undefined, undefined, app.ctx),
		/requires an active blocked Flow/,
	);
	assert.equal(existsSync(retainedPath), true);
	assert.equal((await flowTool(app).execute("fresh", { units: [unit("fresh")] }, undefined, undefined, app.ctx)).details.outcome, "completed");
});

test("an Implementer settling after session reload cannot reach review or integration", async (t) => {
	const repo = await repository(t);
	const base = git(repo, "rev-parse", "HEAD");
	const gate = deferred<void>();
	let started = false;
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			reviewers++;
			return success("PASS");
		}
		started = true;
		await gate.promise;
		await commit(prepared.cwd, "stale.txt", "stale\n");
		return success();
	});
	const running = flowTool(app).execute("stale", { units: [reviewedUnit("stale")] }, undefined, undefined, app.ctx);
	await waitFor(() => started);

	await app.emitSession("session_shutdown");
	await app.emitSession("session_start");
	gate.resolve();
	const result = await running;

	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "infrastructure");
	assert.match(result.details.failure.diagnostic, /session changed while work was in flight/);
	assert.equal(reviewers, 0);
	assert.equal(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").length, 0);
	assert.equal(git(repo, "rev-parse", "HEAD"), base);
	assert.equal(result.details.retained.length, 1);
	assert.equal(await readFile(join(result.details.retained[0].path, "stale.txt"), "utf8"), "stale\n");
});

test("successful units rebase in place onto exact expected Main, review final OIDs, and ff-only integrate", async (t) => {
	const repo = await repository(t);
	const initial = git(repo, "rev-parse", "HEAD");
	const packets: Array<{ base: string; tip: string; patchPath: string; cwd: string; patch: string }> = [];
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "implementer") {
			const id = unitId(prepared.task);
			await commit(prepared.cwd, `${id}.txt`, `${id}\n`);
			return success();
		}
		const packet = reviewPacket(prepared.task);
		packets.push({ ...packet, cwd: prepared.cwd, patch: await readFile(packet.patchPath, "utf8") });
		return success("PASS");
	});
	const result = await flowTool(app).execute("serial", { units: [reviewedUnit("first"), reviewedUnit("second")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "completed");
	assert.equal(packets.length, 2);
	assert.equal(packets[0]!.base, initial);
	assert.equal(packets[1]!.base, packets[0]!.tip);
	assert.equal(git(repo, "rev-parse", `${packets[1]!.tip}^`), packets[1]!.base);
	assert.match(packets[0]!.patch, /first\.txt/);
	assert.match(packets[1]!.patch, /second\.txt/);
	assert.doesNotMatch(packets[1]!.patch, /first\.txt/);
	assert.equal(git(repo, "rev-parse", "HEAD"), packets[1]!.tip);
	assert.equal(await readFile(join(repo, "first.txt"), "utf8"), "first\n");
	assert.equal(await readFile(join(repo, "second.txt"), "utf8"), "second\n");
	const merges = app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge");
	assert.deepEqual(merges.map(({ args }) => args.slice(1)), [
		["merge", "--no-overwrite-ignore", "--ff-only", packets[0]!.tip],
		["merge", "--no-overwrite-ignore", "--ff-only", packets[1]!.tip],
	]);
});

test("a killed merge reconciles only the exact clean reviewed tip", async (t) => {
	for (const dirty of [false, true]) {
		const repo = await repository(t);
		let approvedTip = "";
		const app = harness(repo, async (prepared) => {
			if (childRole(prepared) === "implementer") {
				await commit(prepared.cwd, "approved.txt", "approved\n");
				return success();
			}
			approvedTip = reviewPacket(prepared.task).tip;
			return success("PASS");
		}, (command, args, _options, next) => {
			if (command !== "git" || args[1] !== "merge") return next();
			return next().then(async () => {
				if (dirty) await writeFile(join(repo, "base.txt"), "dirty after merge\n");
				return { stdout: "", stderr: "post-merge hook stalled", code: -1, killed: true };
			});
		});

		const result = await flowTool(app).execute(`killed-merge-${dirty}`, { units: [reviewedUnit("approved")] }, undefined, undefined, app.ctx);

		assert.equal(git(repo, "rev-parse", "HEAD"), approvedTip);
		if (dirty) {
			assert.equal(result.details.outcome, "failed");
			assert.equal(result.details.failure.classification, "integration");
			assert.match(result.details.failure.diagnostic, /failed with exit -1 \(killed\)/);
			assert.match(result.details.failure.diagnostic, /did not reconcile to the approved clean state/);
			assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["approved"]);
			assert.notEqual(git(repo, "status", "--porcelain"), "");
		} else {
			assert.equal(result.details.outcome, "completed");
			assert.deepEqual(result.details.completed, [{ id: "approved", noOp: false }]);
			assert.deepEqual(result.details.retained, []);
			assert.equal(result.details.warnings.length, 1);
			assert.match(result.details.warnings[0], /integrated after merge reported failure/);
			assert.match(result.details.warnings[0], /post-merge hook stalled/);
		}
	}
});

test("pre-rebase dirty proof preserves a later Unit's ignored collision bytes", async (t) => {
	const repo = await repository(t);
	await writeFile(join(repo, ".gitignore"), "*.cache\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore cache files");
	let secondPath = "";
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") return success("PASS");
		if (unitId(prepared.task) === "first") {
			await writeFile(join(prepared.cwd, "collision.cache"), "first tracked bytes\n");
			git(prepared.cwd, "add", "-f", "collision.cache");
			git(prepared.cwd, "commit", "-qm", "track collision");
		} else {
			secondPath = prepared.cwd;
			await commit(prepared.cwd, "second.txt", "second commit\n");
			await writeFile(join(prepared.cwd, "collision.cache"), "second ignored bytes\n");
		}
		return success();
	});

	const result = await flowTool(app).execute("pre-rebase-dirty", { units: [unit("first"), unit("second")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "blocked");
	assert.equal(result.details.blocked.id, "second");
	assert.equal(result.details.blocked.classification, "implementer");
	assert.match(result.details.blocked.diagnostic, /rebase was refused/);
	assert.equal(await readFile(join(repo, "collision.cache"), "utf8"), "first tracked bytes\n");
	assert.equal(await readFile(join(secondPath, "collision.cache"), "utf8"), "second ignored bytes\n");
	assert.equal(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "rebase" && args[2] !== "--abort").length, 0);
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["second"]);
});

test("a rebase-dropped duplicate is validated and completes as a no-op without Reviewer", async (t) => {
	const repo = await repository(t);
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "implementer") {
			await commit(prepared.cwd, "duplicate.txt", "same\n", `duplicate ${unitId(prepared.task)}`);
			return success();
		}
		reviewers++;
		return success("PASS");
	});
	const result = await flowTool(app).execute("noop", { units: [reviewedUnit("one"), reviewedUnit("two")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "completed");
	assert.deepEqual(result.details.completed, [{ id: "one", noOp: false }, { id: "two", noOp: true }]);
	assert.equal(reviewers, 1);
	assert.deepEqual(result.details.retained, []);
	assert.equal(app.execLogs.filter(({ command }) => command === process.execPath).length, 2);
	assert.equal(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").length, 1);
});

test("a failed rebase aborts, reports infrastructure diagnostics, and retains the Unit", async (t) => {
	const repo = await repository(t);
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			reviewers++;
			return success("PASS");
		}
		const id = unitId(prepared.task);
		await commit(prepared.cwd, "shared.txt", `${id}\n`, `${id} overlap`);
		return success();
	});
	const result = await flowTool(app).execute("rebase-failure", { units: [reviewedUnit("first"), reviewedUnit("second")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "infrastructure");
	assert.match(result.details.failure.diagnostic, /Rebase failed; git rebase --abort restored the Unit Worktree for recovery/);
	assert.equal(reviewers, 1);
	assert.deepEqual(result.details.completed, [{ id: "first", noOp: false }]);
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["second"]);
	const retained = result.details.retained[0];
	assert.equal(existsSync(retained.path), true);
	assert.equal(git(retained.path, "status", "--porcelain"), "");
	assert.equal(git(retained.path, "branch", "--show-current"), retained.branch);
});

test("failed rebase abort during cancellation is exposed in terminal diagnostics", async (t) => {
	const repo = await repository(t);
	const controller = new AbortController();
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") { reviewers++; return success("PASS"); }
		const id = unitId(prepared.task);
		await commit(prepared.cwd, `${id}.txt`, `${id}\n`);
		return success();
	}, (command, args, _options, next) => {
		if (command === "git" && args[1] === "rebase" && args[2] !== "--abort") {
			controller.abort(new Error("cancelled by test"));
			return Promise.resolve({ stdout: "", stderr: "cancelled", code: -1, killed: false });
		}
		if (command === "git" && args[1] === "rebase" && args[2] === "--abort") {
			return Promise.resolve({ stdout: "", stderr: "cannot lock index", code: 1, killed: false });
		}
		return next();
	});

	const result = await flowTool(app).execute("cancel-rebase", { units: [reviewedUnit("first"), reviewedUnit("second")] }, controller.signal, undefined, app.ctx);
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "infrastructure");
	assert.match(result.details.failure.diagnostic, /cancelled by test/);
	assert.match(result.details.failure.diagnostic, /git rebase --abort failed with exit 1/);
	assert.match(result.details.failure.diagnostic, /cannot lock index/);
	assert.equal(reviewers, 1);
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["second"]);
});

test("validation-induced detached HEAD is a repairable validation block", async (t) => {
	const repo = await repository(t);
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") { reviewers++; return success("PASS"); }
		await commit(prepared.cwd, "change.txt", "change\n");
		return success();
	});
	const gate = [{ command: "git", args: ["checkout", "--detach", "-q"] }];

	const result = await flowTool(app).execute("detached-validation", { units: [reviewedUnit("detached", "work", gate)] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "blocked");
	assert.equal(result.details.blocked.classification, "validation");
	assert.equal(result.details.blocked.repairAvailable, true);
	assert.match(result.details.blocked.diagnostic, /off its Flow-owned branch/);
	assert.equal(reviewers, 0);
	assert.equal(git(result.details.blocked.path, "branch", "--show-current"), "");
});

test("validation, Reviewer findings, and Reviewer transport failures keep distinct classifications", async (t) => {
	const validationRepo = await repository(t);
	let validationReviewers = 0;
	const validationApp = harness(validationRepo, async (prepared) => {
		if (childRole(prepared) === "reviewer") { validationReviewers++; return success("PASS"); }
		await commit(prepared.cwd, "change.txt", "change\n");
		return success();
	});
	const skippedMarker = join(validationRepo, "must-not-run");
	const noisyGate = [
		...validation("process.stderr.write('x'.repeat(60000)); process.exit(3)"),
		{ command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", skippedMarker] },
	];
	const validationResult = await flowTool(validationApp).execute("validation", { units: [reviewedUnit("validation", "work", noisyGate)] }, undefined, undefined, validationApp.ctx);
	assert.equal(validationResult.details.outcome, "blocked");
	assert.equal(validationResult.details.blocked.classification, "validation");
	assert.equal(validationReviewers, 0);
	assert.ok(Buffer.byteLength(validationResult.details.blocked.diagnostic, "utf8") <= 50 * 1024);
	assert.match(validationResult.details.blocked.diagnostic, /exit 3/);
	assert.equal(existsSync(skippedMarker), false);
	const validationLines = flowTool(validationApp).renderResult!(
		validationResult,
		{ expanded: false, isPartial: false },
		{ fg: (_color: string, value: string) => value },
		{},
	).render(200);
	assert.equal(validationLines.length, 3);
	assert.ok(validationLines.some((line) => line.includes(validationResult.details.blocked.path)));

	const findingsRepo = await repository(t);
	let reviewerTaskText = "";
	let reviewedPatch = "";
	const findingsApp = harness(findingsRepo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			reviewerTaskText = prepared.task;
			reviewedPatch = await readFile(reviewPacket(prepared.task).patchPath, "utf8");
			return success("Finding: change.txt is wrong");
		}
		await commit(prepared.cwd, "change.txt", "change\n");
		return success();
	});
	const findings = await flowTool(findingsApp).execute("findings", { units: [{
		...unit("findings"), review: "Judge whether the changed name is clear.",
	}] }, undefined, undefined, findingsApp.ctx);
	assert.equal(findings.details.outcome, "blocked");
	assert.equal(findings.details.blocked.classification, "reviewer_findings");
	assert.match(findings.details.blocked.diagnostic, /change\.txt is wrong/);
	assert.match(reviewerTaskText, /explicit judgment criterion:\nJudge whether the changed name is clear\./);
	assert.match(reviewedPatch, /change\.txt/);
	assert.equal(findingsApp.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").length, 0);

	const infrastructureRepo = await repository(t);
	let truncated = false;
	const infrastructureApp = harness(infrastructureRepo, async (prepared) => {
		if (childRole(prepared) === "reviewer") {
			return truncated ? success("PASS\n\n[Output truncated: 1 bytes omitted]") : failure("reviewer crashed");
		}
		await commit(prepared.cwd, `${unitId(prepared.task)}.txt`, "change\n");
		return success();
	});
	const infrastructure = await flowTool(infrastructureApp).execute("infrastructure", { units: [reviewedUnit("infra")] }, undefined, undefined, infrastructureApp.ctx);
	assert.equal(infrastructure.details.outcome, "failed");
	assert.equal(infrastructure.details.failure.classification, "infrastructure");
	assert.match(infrastructure.details.failure.diagnostic, /reviewer crashed/);
	truncated = true;
	const malformed = await flowTool(infrastructureApp).execute("truncated", { units: [reviewedUnit("truncated")] }, undefined, undefined, infrastructureApp.ctx);
	assert.equal(malformed.details.outcome, "failed");
	assert.equal(malformed.details.failure.classification, "infrastructure");
	assert.match(malformed.details.failure.diagnostic, /transport output was truncated/);
});

test("missing commits and dirty repairs are implementer failures, with one repair retaining its class", async (t) => {
	const repo = await repository(t);
	const classes: string[] = [];
	const app = harness(repo, async (prepared) => {
		classes.push(childModelClass(prepared));
		if (childRole(prepared) === "reviewer") return success("PASS");
		if (prepared.task.startsWith("Repair")) await writeFile(join(prepared.cwd, "dirty.txt"), "dirty\n");
		return success();
	});
	const missing = await flowTool(app).execute("missing", { units: [{ ...unit("missing"), modelClass: "fast" }] }, undefined, undefined, app.ctx);
	assert.equal(missing.details.outcome, "blocked");
	assert.equal(missing.details.blocked.classification, "implementer");
	assert.match(missing.details.blocked.diagnostic, /no committed change/);
	const dirty = await continueTool(app).execute("dirty", { guidance: "finish the commit" }, undefined, undefined, app.ctx);
	assert.equal(dirty.details.outcome, "failed");
	assert.equal(dirty.details.failure.classification, "implementer");
	assert.match(dirty.details.failure.diagnostic, /Worktree is dirty/);
	assert.deepEqual(classes, ["fast", "fast"]);
});

test("a second same-Unit failure is terminal, clears active state, and permits a later Flow", async (t) => {
	const repo = await repository(t);
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") return success("PASS");
		const id = unitId(prepared.task);
		await commit(prepared.cwd, `${id}-${prepared.task.startsWith("Repair") ? "repair" : "initial"}.txt`, "change\n");
		return success();
	});
	const badGate = validation("process.exit(2)");
	const blocked = await flowTool(app).execute("twice", { units: [unit("twice", "work", badGate)] }, undefined, undefined, app.ctx);
	assert.equal(blocked.details.blocked.classification, "validation");
	const failed = await continueTool(app).execute("twice-continue", { guidance: "repair it" }, undefined, undefined, app.ctx);
	assert.equal(failed.details.outcome, "failed");
	assert.equal(failed.details.failure.classification, "validation");
	await assert.rejects(continueTool(app).execute("third", { guidance: "again" }, undefined, undefined, app.ctx), /requires an active blocked Flow/);

	const completed = await flowTool(app).execute("later", { units: [unit("later")] }, undefined, undefined, app.ctx);
	assert.equal(completed.details.outcome, "completed");
});

test("ignored Main collision rejects integration without overwriting data and retains the reported Unit", async (t) => {
	const repo = await repository(t);
	await writeFile(join(repo, ".gitignore"), "*.cache\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore cache files");
	const mainHead = git(repo, "rev-parse", "HEAD");
	const mainCache = join(repo, "result.cache");
	await writeFile(mainCache, "Main ignored bytes\n");
	let approvedTip = "";
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "implementer") {
			await writeFile(join(prepared.cwd, "result.cache"), "Unit reviewed bytes\n");
			git(prepared.cwd, "add", "-f", "result.cache");
			git(prepared.cwd, "commit", "-qm", "track result cache");
			return success();
		}
		approvedTip = reviewPacket(prepared.task).tip;
		return success("PASS");
	});

	const result = await flowTool(app).execute("ignored-collision", { units: [reviewedUnit("collision")] }, undefined, undefined, app.ctx);

	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "integration");
	assert.match(approvedTip, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
	assert.match(result.details.failure.diagnostic, /would be overwritten by merge/);
	assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
	assert.equal(await readFile(mainCache, "utf8"), "Main ignored bytes\n");
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["collision"]);
	const retained = result.details.retained[0];
	assert.equal(existsSync(retained.path), true);
	assert.equal(await readFile(join(retained.path, "result.cache"), "utf8"), "Unit reviewed bytes\n");
	assert.equal(git(retained.path, "rev-parse", "HEAD"), approvedTip);
	assert.equal(git(retained.path, "status", "--porcelain"), "");
	assert.deepEqual(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").map(({ args }) => args.slice(1)), [
		["merge", "--no-overwrite-ignore", "--ff-only", approvedTip],
	]);
});

test("cleanup refusal after exact integration preserves ignored work with a bounded warning", async (t) => {
	const repo = await repository(t);
	await writeFile(join(repo, ".gitignore"), "*.cache\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore cache files");
	let approvedTip = "";
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "implementer") {
			await commit(prepared.cwd, "integrated.txt", "integrated\n");
			await writeFile(join(prepared.cwd, "result.cache"), "retain\n");
			return success();
		}
		approvedTip = reviewPacket(prepared.task).tip;
		return success("PASS");
	});
	const result = await flowTool(app).execute("cleanup", { units: [reviewedUnit("cleanup")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "completed");
	assert.equal(git(repo, "rev-parse", "HEAD"), approvedTip);
	assert.equal(await readFile(join(repo, "integrated.txt"), "utf8"), "integrated\n");
	assert.equal(result.details.warnings.length, 1);
	assert.match(result.details.warnings[0], /integrated, but cleanup refused/);
	assert.ok(Buffer.byteLength(result.details.warnings[0], "utf8") <= 50 * 1024 + 200);
	assert.equal(result.details.retained.length, 1);
	assert.equal(await readFile(join(result.details.retained[0].path, "result.cache"), "utf8"), "retain\n");
	assert.equal(app.execLogs.filter(({ command, args }) => command === "git" && args[1] === "merge").length, 1);
});

test("cleanup retains a detached clean commit after approved integration", async (t) => {
	const repo = await repository(t);
	let approvedTip = "";
	let detachedTip = "";
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "implementer") {
			await commit(prepared.cwd, "approved.txt", "approved\n");
			return success();
		}
		approvedTip = reviewPacket(prepared.task).tip;
		git(prepared.cwd, "checkout", "--detach", "-q");
		await commit(prepared.cwd, "detached.txt", "retain detached bytes\n");
		detachedTip = git(prepared.cwd, "rev-parse", "HEAD");
		return success("PASS");
	});

	const result = await flowTool(app).execute("detached-cleanup", { units: [reviewedUnit("detached-cleanup")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "completed");
	assert.equal(git(repo, "rev-parse", "HEAD"), approvedTip);
	assert.equal(result.details.warnings.length, 1);
	assert.match(result.details.warnings[0], /cleanup refused: Unit Worktree no longer matches approved state/);
	assert.equal(result.details.retained.length, 1);
	const retained = result.details.retained[0];
	assert.equal(git(retained.path, "branch", "--show-current"), "");
	assert.equal(git(retained.path, "rev-parse", "HEAD"), detachedTip);
	assert.equal(await readFile(join(retained.path, "detached.txt"), "utf8"), "retain detached bytes\n");
	assert.equal(git(repo, "rev-parse", `refs/heads/${retained.branch}`), approvedTip);
});

test("external Main mutation fails terminally before review and all retained work is reported", async (t) => {
	const repo = await repository(t);
	let mutate = true;
	let reviewers = 0;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") { reviewers++; return success("PASS"); }
		await commit(prepared.cwd, `${unitId(prepared.task)}.txt`, "unit\n");
		if (mutate) {
			mutate = false;
			await commit(repo, "external.txt", "external\n", "external mutation");
		}
		return success();
	});
	const result = await flowTool(app).execute("external", { units: [reviewedUnit("unit")] }, undefined, undefined, app.ctx);
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failure.classification, "main");
	assert.equal(reviewers, 0);
	assert.deepEqual(result.details.retained.map(({ id }: any) => id), ["unit"]);
	assert.match(result.details.failure.diagnostic, /changed outside the active Flow/);
});

test("concurrent Flow calls reject immediately while later sequential Flow calls succeed", async (t) => {
	const repo = await repository(t);
	const gate = deferred<void>();
	let held = true;
	let started = false;
	const app = harness(repo, async (prepared) => {
		if (childRole(prepared) === "reviewer") return success("PASS");
		if (held) {
			started = true;
			await gate.promise;
			held = false;
		}
		await commit(prepared.cwd, `${unitId(prepared.task)}.txt`, "done\n");
		return success();
	});
	const first = flowTool(app).execute("concurrent-one", { units: [unit("one")] }, undefined, undefined, app.ctx);
	await waitFor(() => started);
	await assert.rejects(
		flowTool(app).execute("concurrent-two", { units: [unit("two")] }, undefined, undefined, app.ctx),
		/another Flow is active/,
	);
	await assert.rejects(
		continueTool(app).execute("concurrent-continue", { guidance: "not blocked" }, undefined, undefined, app.ctx),
		/not blocked/,
	);
	gate.resolve();
	assert.equal((await first).details.outcome, "completed");
	assert.equal((await flowTool(app).execute("sequential", { units: [unit("two")] }, undefined, undefined, app.ctx)).details.outcome, "completed");
});
