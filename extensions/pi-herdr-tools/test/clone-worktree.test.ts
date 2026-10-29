import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, relative } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { success, withPane } from "./helper.ts";
import { head, worktreeFixture } from "./worktree-fixture.ts";

test("/clone-worktree selects an explicit sibling from a folder workspace and copies only the active path", async () => {
	await withPane("pane-current", async () => {
		const app = await worktreeFixture("clone", { folder: true, busy: true });
		try {
			const before = await readFile(app.sessionFile, "utf8");
			await app.run(relative(app.contextCwd, app.selected));
			const create = app.calls.find((call) => call.args[1] === "create" && call.args[0] === "worktree");
			assert.deepEqual(create?.args, ["worktree", "create", "--cwd", app.primary, "--base", head, "--no-focus"]);
			assert.ok(app.calls.filter((call) => call.command === "git").every((call) => [app.selected, app.primary, app.checkout].includes(call.options.cwd)));
			assert.equal(app.calls.some((call) => call.args[0] === "workspace" && call.args[1] === "list"), false);
			const start = app.calls.find((call) => call.args[0] === "agent" && call.args[1] === "start")!;
			assert.deepEqual(start.args.slice(3, 9), ["--kind", "pi", "--pane", "pane-extra", "--", "--session"]);
			const clone = SessionManager.open(start.args[9]!);
			assert.equal(clone.getHeader()?.cwd, app.checkout);
			assert.equal(clone.getEntry(app.siblingId), undefined);
			assert.equal(clone.getEntries().filter((entry) => entry.type === "message").length, 2);
			assert.equal(app.manager.getLeafId(), app.activeId);
			assert.equal(await readFile(app.sessionFile, "utf8"), before);
			assert.deepEqual(app.calls.at(-1)?.args, ["tab", "focus", "tab-extra"]);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("/clone-worktree preserves the selected linked checkout HEAD and the root-pane launch", async () => {
	await withPane("pane-current", async () => {
		const app = await worktreeFixture("clone", { linked: true });
		try {
			await app.run();
			assert.deepEqual(app.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "create")?.args,
				["worktree", "create", "--cwd", app.primary, "--base", head, "--no-focus"]);
			assert.equal(app.calls.find((call) => call.args[1] === "start")?.args[6], "pane-root");
			assert.equal(app.calls.some((call) => call.args[0] === "tab" && call.args[1] === "create"), false);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("/clone-worktree never guesses a project or accepts wrong native repository targeting", async () => {
	for (const mode of ["omitted", "missing", "wrong-native"] as const) await withPane("pane-current", async () => {
		const app = await worktreeFixture("clone", { folder: true });
		try {
			if (mode === "wrong-native") app.setOverride(({ args }) => args[0] === "worktree" && args[1] === "list"
				? success({ result: { type: "worktree_list", source: { repo_key: "/other/.git", repo_root: "/other", source_checkout_path: "/other" }, worktrees: [] } }) : undefined);
			await assert.rejects(app.run(mode === "omitted" ? undefined : mode === "missing" ? "missing" : "project"), /nothing was created/);
			assert.equal(app.calls.some((call) => call.args[1] === "create"), false);
			assert.deepEqual(await readdir(app.sessionDir), [basename(app.sessionFile)]);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("/clone-worktree retains uncertain allocations without launch, replay, or deletion", async () => {
	for (const mode of ["killed", "failed-with-ids", "throw", "missing-id", "wrong-repo", "wrong-tab", "wrong-pane", "wrong-path", "wrong-common", "wrong-head", "existing-checkout", "live-pane", "live-workspace", "live-tab"] as const) await withPane("pane-current", async () => {
		const app = await worktreeFixture("clone", { busy: true });
		try {
			app.setOverride(({ command, args, options }) => {
				if (args[0] === "worktree" && args[1] === "create") {
					if (mode === "throw") throw new Error("transport lost");
					const response = app.allocation();
					if (mode === "missing-id") response.result.workspace.workspace_id = "";
					if (mode === "wrong-repo") response.result.workspace.worktree = { ...response.result.workspace.worktree, repo_key: "/other/.git" };
					if (mode === "wrong-tab") response.result.tab.workspace_id = "other";
					if (mode === "wrong-pane") response.result.root_pane.tab_id = "other";
					if (mode === "wrong-path") response.result.worktree.path = "/other";
					return { ...success(response), killed: mode === "killed", code: mode === "failed-with-ids" ? 1 : 0 };
				}
				if (command === "git" && args[0] === "worktree" && mode === "existing-checkout") return success(`worktree ${app.primary}\0\0worktree ${app.checkout}\0\0`);
				if (command === "git" && options.cwd === app.checkout && mode === "wrong-common" && args.includes("--git-common-dir")) return success("/other/.git");
				if (command === "git" && options.cwd === app.checkout && mode === "wrong-head" && args.includes("HEAD^{commit}")) return success("c".repeat(40));
				if (mode === "live-pane" && args[0] === "pane" && args[2] === "pane-root") return success({ result: { pane: { pane_id: "other", tab_id: "tab-new", workspace_id: "workspace-new", cwd: app.checkout } } });
				if (mode === "live-workspace" && args[0] === "workspace" && args[2] === "workspace-new") return success({ result: { workspace: { workspace_id: "workspace-new", worktree: null } } });
				if (mode === "live-tab" && args[0] === "tab" && args[1] === "get") return success({ result: { tab: { tab_id: "tab-new", workspace_id: "other" } } });
				return undefined;
			});
			await assert.rejects(app.run(), (error: Error) => {
				assert.match(error.message, /retained|uncertain/);
				if (mode !== "throw") assert.match(error.message, /pane-root/);
				return true;
			}, mode);
			assert.equal(app.calls.filter((call) => call.args[1] === "create").length, 1, mode);
			assert.equal(app.calls.some((call) => ["start", "remove", "close", "focus"].includes(call.args[1]!)), false, mode);
			assert.deepEqual(await readdir(app.sessionDir), [basename(app.sessionFile)]);
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});

test("/clone-worktree verifies an extra tab after a late busy root and retains failed launches", async () => {
	for (const mode of ["busy", "bad-extra", "failed-start", "incomplete-extra", "focus-failed"] as const) await withPane("pane-current", async () => {
		const app = await worktreeFixture("clone", { busy: mode !== "busy" });
		let starts = 0;
		try {
			app.setOverride(({ args }) => {
				if (args[0] === "agent") {
					starts++;
					if (mode === "failed-start") return { stdout: "", stderr: "timed out", code: 9, killed: true };
					if (mode === "busy" && starts === 1) return { ...success({ error: { code: "agent_pane_busy" } }), code: 1 };
				}
				if (mode === "bad-extra" && args[0] === "pane" && args[2] === "pane-extra") return success({ result: { pane: { pane_id: "pane-extra", tab_id: "unrelated", workspace_id: "workspace-new", cwd: app.checkout } } });
				if (mode === "incomplete-extra" && args[0] === "tab" && args[1] === "create") return success({ result: { tab: { tab_id: "tab-extra" }, root_pane: {} } });
				if (mode === "focus-failed" && args[1] === "focus") return { stdout: "", stderr: "focus failed", code: 1, killed: false };
				return undefined;
			});
			if (mode === "busy" || mode === "focus-failed") {
				await app.run();
				assert.equal(starts, mode === "busy" ? 2 : 1);
				if (mode === "focus-failed") assert.equal(app.notifications[0]?.type, "warning");
			} else {
				await assert.rejects(app.run(), /retained.*workspace-new.*tab-extra/s);
				assert.equal(starts, mode === "failed-start" ? 1 : 0);
				assert.equal(app.calls.some((call) => call.args[1] === "focus"), false);
			}
		} finally { await rm(app.root, { recursive: true, force: true }); }
	});
});
