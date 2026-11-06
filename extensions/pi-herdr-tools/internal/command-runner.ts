// Standalone Node entry point. Only the runner can signal its live child process group.
import { spawn } from "node:child_process";
import { constants, closeSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicState, cancellationRequested, claimRunner, parseSpec, privateDirectory, readPrivate, startUnreleased, type CommandState, type RunnerIdentity } from "./command-state.ts";

async function run(dir: string): Promise<void> {
	await privateDirectory(dir);
	const spec = parseSpec(await readPrivate(join(dir, "spec.json")));
	if (dir.split("/").at(-1) !== spec.id) throw new Error("Runner directory identity mismatch.");
	const { HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: tabId, HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socketPath } = process.env;
	if (workspaceId !== spec.workspaceId || !tabId || !paneId || socketPath !== spec.socketPath) throw new Error("Runner terminal identity mismatch.");
	const identity: RunnerIdentity = { id: spec.id, token: spec.token, runnerId: randomUUID(), workspaceId, tabId, paneId };
	// An existing claim is never replaced, including after a crash or duplicate dispatch.
	await claimRunner(dir, identity);
	let exitCode: number | null = null;
	let signal: string | null = null;
	const save = (state: CommandState, failure?: string) => atomicState(dir, { ...identity, state, updatedAt: Date.now(), exitCode, signal, ...(failure ? { failure } : {}) });
	let child: ReturnType<typeof spawn> | undefined;
	let group: number | undefined;
	let stopped = false;
	let reason: "cancelled" | "timeout" | "output_limit" | "unknown" | undefined;
	let log: number | undefined;
	let heartbeat: Promise<void> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const interrupt = () => requestStop("cancelled");
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
	const requestStop = (cause: NonNullable<typeof reason>) => {
		if (cause === "unknown") reason = cause; else reason ??= cause;
		// The control loop never waits for a heartbeat or a record lock before stopping.
	};
	const stop = async () => {
		if (!exists()) return true;
		for (const name of ["SIGTERM", "SIGKILL"] as const) {
			kill(name);
			for (let i = 0; i < 20; i++) {
				// Let exit handlers run before probing the group after a signal.
				await delay(100);
				if (!exists()) return true;
			}
		}
		return false;
	};
	const cancelled = () => cancellationRequested(dir, spec);
	try {
		await save("starting");
		if (reason || await cancelled()) { await save(reason ?? "cancelled"); return; }
		child = await startUnreleased(dir, spec, () => {
			log = openSync(join(dir, "output.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			return spawn("/bin/sh", ["-c", spec.command], { cwd: spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		});
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
				if (chunk.length > remaining) requestStop("output_limit");
			} catch { requestStop("unknown"); }
		};
		child.stdout!.on("data", output);
		child.stderr!.on("data", output);
		deadlineTimer = setTimeout(() => requestStop("timeout"), spec.runtimeMs);
		let lastSave = 0;
		while (!exited && !reason) {
			if (await cancelled()) requestStop("cancelled");
			if (!reason && !heartbeat && Date.now() - lastSave >= 1000) {
				lastSave = Date.now();
				heartbeat = save("running").catch(() => { requestStop("unknown"); }).finally(() => { heartbeat = undefined; });
			}
			if (!reason) await delay(50);
		}
		clearTimeout(deadlineTimer);
		// Even a successful shell can leave ordinary descendants. They must stop before release.
		const proved = await stop();
		// Close proves exit and drained pipes. Escaped pipe owners must not hold the runner forever.
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let drained: boolean;
		try {
			drained = await Promise.race([closed, new Promise<boolean>((resolve) => { drainTimer = setTimeout(() => resolve(false), 4000); })]);
		} finally { clearTimeout(drainTimer); }
		// A pending heartbeat must finish before the final state, but never before stopping the child.
		await heartbeat;
		await save(!proved || !drained ? "unknown" : reason ?? (spawnFailed || exitCode !== 0 || signal ? "failed" : "succeeded"),
			!drained ? "output_close_timeout" : undefined);
	} catch {
		await stop().catch(() => false);
		await heartbeat;
		await save("unknown", "runner_io");
		process.exitCode = 1;
	} finally {
		clearTimeout(deadlineTimer);
		child?.stdout?.destroy(); child?.stderr?.destroy();
		if (log !== undefined) closeSync(log);
		for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(name, interrupt);
	}
}

if (process.argv.length !== 3) throw new Error("Usage: node command-runner.js <private-job-directory>");
await run(process.argv[2]!).catch(() => { process.stderr.write("Command runner stopped without verified completion; inspect /commands.\n"); process.exitCode = 1; });
