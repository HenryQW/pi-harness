import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sweepTool, { ROUTE_RUN_ID as sweepRunId, specPath } from "./pi-pr-comment-sweep/sweep-tool.ts";
import routeTools, { collectFile, ROUTE_RUN_ID as ciRunId } from "./pi-pr-fix-ci/route-tools.ts";
import ciCases from "./pi-pr-fix-ci/cases.ts";
import sweepCases from "./pi-pr-comment-sweep/cases.ts";
import type { Trace } from "./types.ts";

test("launch prompts receive the canonical trial projectPath, including through a temporary-directory alias", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-eval-target-"));
	try {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"));
		const pi = join(root, "pi");
		writeFileSync(pi, `#!${process.execPath}\nconsole.log(JSON.stringify({type: "agent_settled", aborted: false}));\n`);
		chmodSync(pi, 0o755);
		execFileSync(process.execPath, ["--input-type=module", "-e", `
			const { runTrial } = await import(${JSON.stringify(new URL("./harness.ts", import.meta.url).href)});
			await runTrial("probe", { id: "target", kind: "safety", skill: "extensions/pi-pr/skills/git-commit",
				prompt: '/skill:git-commit projectPath={{projectPath}}',
				grade: () => ({ pass: true, reasons: [] }) }, 1,
				{ root: ${JSON.stringify(join(root, "alias"))}, resultsDir: ${JSON.stringify(root)} });
		`], { env: { ...process.env, PI_BIN: pi }, stdio: "pipe" });
		const result = JSON.parse(readFileSync(join(root, "probe/target.t1.json"), "utf8"));
		assert.equal(result.grade.pass, true);
		assert.match(result.args.at(-1), new RegExp(`^/skill:git-commit projectPath="${realpathSync(root)}/real/trial-[^/]+/cwd"$`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture tools accept optional worktree paths but reject a different repository before use", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-eval-target-")));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const cwd = join(root, "cwd");
		const sibling = join(root, "sibling");
		mkdirSync(cwd);
		mkdirSync(sibling);
		mkdirSync(join(cwd, "src"));
		mkdirSync(join(cwd, "nested"));
		symlinkSync(cwd, join(root, "alias"));
		for (const dir of [cwd, sibling, join(cwd, "nested")]) {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync("git", ["-c", "user.name=Pi Eval", "-c", "user.email=pi-eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init"], { cwd: dir });
		}
		writeFileSync(join(cwd, ".git/info/exclude"), "nested/\n");
		writeFileSync(specPath(cwd), JSON.stringify({ start: [{ fixture: "sweep" }] }));
		writeFileSync(join(cwd, collectFile), JSON.stringify({ fixture: "ci" }));
		const tools: any[] = [];
		const pi = { registerTool: (tool: unknown) => tools.push(tool) };
		sweepTool(pi as never);
		routeTools(pi as never);
		for (const [name, params] of [
			["pi_pr_sweep", { action: "start", runId: sweepRunId }],
			["pi_pr_fix_ci", { action: "collect", runId: ciRunId }],
			["pi_git_commit", { action: "inspect", target: "HEAD" }],
		] as const) {
			const tool = tools.find((tool) => tool.name === name);
			assert.equal(tool.parameters.properties.projectPath?.type, "string", name);
			assert.equal(tool.parameters.required.includes("projectPath"), false, name);
			for (const projectPath of [sibling, "../sibling", "nested"]) {
				await assert.rejects(tool.execute("probe", { ...params, projectPath }, undefined, undefined, { cwd }), /projectPath.*fixture/);
			}
			for (const projectPath of [undefined, cwd, ".", "src", join(cwd, "src"), "../alias/src"]) {
				const args = projectPath === undefined ? params : { ...params, projectPath };
				const reply = await tool.execute("probe", args, undefined, undefined, { cwd });
				assert.ok(reply.content[0].text, `${name}: ${projectPath}`);
			}
		}
	} finally {
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("route graders require canonical projectPath on every route and commit call", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-eval-target-")));
	try {
		for (const [c, tool, action, runId, extra] of [
			[ciCases.find((c) => c.id === "stale-collect-stops")!, "pi_pr_fix_ci", "collect", ciRunId, "pi_git_commit"],
			[sweepCases.find((c) => c.id === "pending-scope-unrelated-blocks")!, "pi_pr_sweep", "resume", sweepRunId, "pi_pr_sweep"],
		] as const) {
			const cwd = join(root, tool);
			mkdirSync(cwd);
			await c.setup!(cwd);
			const call = { name: tool, args: { action, runId, projectPath: cwd }, result: "", isError: false };
			const trace: Trace = { calls: [call], finalText: "Stopped: unrelated work is a blocker." };
			assert.deepEqual(await c.grade(trace, cwd), { pass: true, reasons: [] }, tool);
			for (const projectPath of [undefined, ".", join(cwd, "src")]) {
				const args = { action, runId, ...(projectPath === undefined ? {} : { projectPath }) };
				const grade = await c.grade({ ...trace, calls: [{ ...call, args }] }, cwd);
				assert.equal(grade.pass, false, `${tool}: ${projectPath}`);
				assert.match(grade.reasons.join("; "), /projectPath/);
			}
			const grade = await c.grade({ ...trace, calls: [...trace.calls, { ...call, name: extra, args: { action: "inspect" }, isError: true }] }, cwd);
			assert.equal(grade.pass, false, `${tool}: later call without projectPath`);
			assert.match(grade.reasons.join("; "), /projectPath/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
