import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { relative } from "node:path";
import test from "node:test";
import { success, withPane } from "./helper.ts";
import { main, params, worktreeFixture } from "./worktree-fixture.ts";

const failure = { stdout: "", stderr: "", code: 1, killed: false };

test("herdr_handoff uses the explicit sibling's local main and native primary cwd, without changing focus", async () => {
	for (const folder of [false, true]) await withPane("pane-current", async () => {
		const app = await worktreeFixture("handoff", { folder, linked: true, busy: true });
		try {
			assert.equal(app.schema.type, "object");
			assert.ok(app.schema.properties.project);
			const result = await app.run(folder ? relative(app.contextCwd, app.selected) : undefined);
			const herdrArgs = app.calls.filter((call) => call.command === "herdr").map((call) => call.args);
			assert.deepEqual(herdrArgs.find((args) => args[0] === "worktree" && args[1] === "create"), [
				"worktree", "create", "--cwd", app.primary, "--branch", params.branch, "--base", main, "--label", params.label, "--no-focus",
			]);
			assert.deepEqual(herdrArgs.find((args) => args[1] === "start"), ["agent", "start", params.agentName, "--kind", "pi", "--pane", "pane-extra", "--"]);
			assert.deepEqual(herdrArgs.at(-1), ["agent", "prompt", params.agentName, params.prompt, "--wait", "--until", "working", "--timeout", "30000"]);
			assert.equal(herdrArgs.some((args) => args[1] === "focus" || args[1] === "close"), false);
			assert.equal(result.details.checkoutPath, app.checkout);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("herdr_handoff creates nothing when project, main, branch, native targeting, or cancellation checks fail", async () => {
	for (const mode of ["no-main", "existing-branch", "invalid-branch", "mismatch", "folder", "empty-project", "cancelled"] as const) await withPane("pane-current", async () => {
		const app = await worktreeFixture("handoff", { folder: mode === "folder" });
		let commonCalls = 0;
		try {
			app.setOverride(({ command, args }) => {
				if (command !== "git") return undefined;
				if (mode === "no-main" && args.includes("refs/heads/main^{commit}")) return failure;
				if (mode === "existing-branch" && args[0] === "show-ref") return success();
				if (mode === "invalid-branch" && args[0] === "check-ref-format") return failure;
				if (mode === "mismatch" && args.includes("--git-common-dir") && ++commonCalls === 2) return success("/other/.git");
				return undefined;
			});
			await assert.rejects(app.run(mode === "empty-project" ? " " : undefined, mode === "cancelled" ? AbortSignal.abort() : undefined));
			assert.equal(app.calls.some((call) => call.args[1] === "create"), false, mode);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("herdr_handoff retains allocations when branch verification, preparation, or prompt delivery fails", async () => {
	for (const mode of ["branch", "tab", "prompt"] as const) await withPane("pane-current", async () => {
		const app = await worktreeFixture("handoff", { busy: true });
		try {
			app.setOverride(({ args }) => {
				if (mode === "branch" && args[0] === "symbolic-ref") return success("refs/heads/unrelated\n");
				if (mode === "tab" && args[0] === "tab" && args[1] === "create") return { ...failure, stderr: "tab create failed" };
				if (mode === "prompt" && args[0] === "agent" && args[1] === "prompt") return { ...failure, stderr: "prompt delivery unknown" };
				return undefined;
			});
			await assert.rejects(app.run(), (error: Error) => {
				for (const text of ["retained", "workspace-new", app.checkout]) assert.ok(error.message.includes(text), error.message);
				return true;
			});
			assert.equal(app.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "create").length, 1);
			assert.equal(app.calls.some((call) => ["remove", "close", "focus"].includes(call.args[1]!)), false);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});
