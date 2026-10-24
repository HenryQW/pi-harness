// Standalone Node entry point. Only the runner can signal its live child process group.
import { spawn } from "node:child_process";
import { constants, closeSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicState, parseSpec, privateDirectory, readPrivate, writePrivate, type CommandState, type RunnerIdentity } from "./command-state.ts";

async function run(dir: string): Promise<void> {
	await privateDirectory(dir);
	const spec = parseSpec(await readPrivate(join(dir, "spec.json")));
	if (dir.split("/").at(-1) !== spec.id) throw new Error("Runner directory identity mismatch.");
	const { HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: tabId, HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socketPath } = process.env;
	if (workspaceId !== spec.workspaceId || !tabId || !paneId || socketPath !== spec.socketPath) throw new Error("Runner terminal identity mismatch.");
	const identity: RunnerIdentity = { id: spec.id, token: spec.token, runnerId: randomUUID(), workspaceId, tabId, paneId };
	// An existing claim is never replaced, including after a crash or duplicate dispatch.
	await writePrivate(join(dir, "claim.json"), identity);
	let exitCode: number | null = null;
	let signal: string | null = null;
	const save = (state: CommandState, failure?: string) => atomicState(dir, { ...identity, state, updatedAt: Date.now(), exitCode, signal, ...(failure ? { failure } : {}) });
	let child: ReturnType<typeof spawn> | undefined;
	let group: number | undefined;
	let stopped = false;
	let reason: "cancelled" | "timeout" | "output_limit" | "unknown" | undefined;
	let log: number | undefined;
	const interrupt = () => { reason ??= "cancelled"; };
	for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, interrupt);
	const exists = () => {
		if (!group || stopped) return false;
		try { process.kill(-group, 0); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { stopped = true; return false; } throw error; }
	};
	const kill = (name: NodeJS.Signals) => {
		if (!exists()) return;
		try { process.kill(-group!, name); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stopped = true; else throw error; }
	};
	const stop = async () => {
		if (!exists()) return true;
		kill("SIGTERM");
		for (let i = 0; i < 20 && exists(); i++) await delay(100);
		if (exists()) kill("SIGKILL");
		for (let i = 0; i < 20 && exists(); i++) await delay(100);
		return !exists();
	};
	const cancelled = async () => {
		const raw = await readPrivate(join(dir, "cancel.json"));
		if (raw === undefined) return false;
		const value = raw as { id?: unknown; token?: unknown } | null;
		if (!value || value.id !== spec.id || value.token !== spec.token) throw new Error("Runner cancellation identity mismatch.");
		return true;
	};
	try {
		await save("starting");
		if (await cancelled()) { await save("cancelled"); return; }
		log = openSync(join(dir, "output.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		child = spawn("/bin/sh", ["-c", spec.command], { cwd: spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		group = child.pid;
		const closed = new Promise<boolean>((resolve) => child!.once("close", () => resolve(true)));
		let exited = false;
		let spawnFailed = false;
		child.once("error", () => { spawnFailed = true; exited = true; });
		child.once("exit", (code, name) => { exitCode = code; signal = name; exited = true; });
		let bytes = 0;
		const output = (chunk: Buffer) => {
			const remaining = spec.outputBytes - bytes;
			try {
				const data = chunk.subarray(0, remaining);
				for (let offset = 0; offset < data.length;) offset += writeSync(log!, data, offset, data.length - offset);
				bytes += data.length;
				if (chunk.length > remaining) reason ??= "output_limit";
			} catch { reason = "unknown"; }
		};
		child.stdout!.on("data", output);
		child.stderr!.on("data", output);
		const deadline = Date.now() + spec.runtimeMs;
		let lastSave = 0;
		while (!exited && !reason) {
			if (await cancelled()) reason = "cancelled";
			else if (Date.now() >= deadline) reason = "timeout";
			if (Date.now() - lastSave >= 1000) { await save(reason ? "cancelling" : "running"); lastSave = Date.now(); }
			if (!reason) await delay(50);
		}
		// Even a successful shell can leave ordinary descendants. They must stop before release.
		if (reason) await save("cancelling");
		const proved = await stop();
		// Close proves exit and drained pipes. Escaped pipe owners must not hold the runner forever.
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let drained: boolean;
		try {
			drained = await Promise.race([closed, new Promise<boolean>((resolve) => { drainTimer = setTimeout(() => resolve(false), 4000); })]);
		} finally { clearTimeout(drainTimer); }
		await save(!proved || !drained ? "unknown" : reason ?? (spawnFailed || exitCode !== 0 || signal ? "failed" : "succeeded"),
			!drained ? "output_close_timeout" : undefined);
	} catch (error) {
		await stop().catch(() => false);
		await save("unknown", (error as NodeJS.ErrnoException).code ?? "runner_io");
		process.exitCode = 1;
	} finally {
		child?.stdout?.destroy(); child?.stderr?.destroy();
		if (log !== undefined) closeSync(log);
		for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(name, interrupt);
	}
}

if (process.argv.length !== 3) throw new Error("Usage: node command-runner.js <private-job-directory>");
await run(process.argv[2]!).catch(() => { process.stderr.write("Command runner stopped without verified completion; inspect /commands.\n"); process.exitCode = 1; });
