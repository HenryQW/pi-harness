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
	let reason: "cancelled" | "timeout" | "output_limit" | undefined;
	// A runner fault stops the command. The record names the stage and the error code.
	let fault: string | undefined;
	let stage = "start";
	let log: number | undefined;
	let heartbeat: Promise<void> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let closed: Promise<boolean> | undefined;
	let exited = false;
	let spawnFailed = false;
	const fail = (error: unknown, at = stage) => {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		fault ??= `runner_${at}_${typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "error"}`;
		process.stderr.write(`Command runner fault ${fault}: ${error instanceof Error ? error.message : String(error)}\n`);
	};
	const requestStop = (cause: NonNullable<typeof reason>) => { reason ??= cause; };
	const interrupt = () => requestStop("cancelled");
	for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, interrupt);
	// EPERM means that the group has members, but none accepts a signal now. macOS reports it for
	// members that are not reaped yet. It is not an error and not proof of termination: probe again.
	const absent = (error: unknown) => {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") stopped = true;
		else if (code !== "EPERM") throw error;
	};
	const exists = () => {
		if (!group || stopped) return false;
		try { process.kill(-group, 0); } catch (error) { absent(error); }
		return !stopped;
	};
	const kill = (name: NodeJS.Signals) => {
		if (!exists()) return;
		try { process.kill(-group!, name); } catch (error) { absent(error); }
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
	// Close proves exit and drained pipes. Escaped pipe owners must not hold the runner forever.
	const drain = async () => {
		if (!closed) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { return await Promise.race([closed, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 4000); })]); }
		finally { clearTimeout(timer); }
	};
	// Only the final record releases the checkout, so a busy record lock gets more attempts.
	const finish = async (state: CommandState, failure?: string) => {
		stage = "record";
		// A pending heartbeat must not replace the final state.
		await heartbeat;
		for (let attempt = 0; ; attempt++) {
			try { await save(state, failure); return; }
			catch (error) { if (attempt >= 2) throw error; await delay(1000); }
		}
	};
	const cancelled = () => cancellationRequested(dir, spec);
	try {
		await save("starting");
		if (reason || await cancelled()) { await finish("cancelled"); return; }
		const shell = await startUnreleased(dir, spec, () => {
			log = openSync(join(dir, "output.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			// Record the shell before the start lock is released. If that release fails, the fault path must still stop and prove this group.
			const started = child = spawn("/bin/sh", ["-c", spec.command], { cwd: spec.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			group = started.pid;
			closed = new Promise<boolean>((resolve) => started.once("close", () => resolve(true)));
			started.once("error", () => { spawnFailed = true; exited = true; });
			started.once("exit", (code, name) => { exitCode = code; signal = name; exited = true; });
			return started;
		});
		let bytes = 0, writeFailed = false;
		const output = (chunk: Buffer) => {
			if (writeFailed) return;
			const remaining = spec.outputBytes - bytes;
			try {
				const data = chunk.subarray(0, remaining);
				for (let offset = 0; offset < data.length;) offset += writeSync(log!, data, offset, data.length - offset);
				bytes += data.length;
				if (chunk.length > remaining) requestStop("output_limit");
			} catch (error) { writeFailed = true; fail(error, "output"); }
		};
		shell.stdout!.on("data", output);
		shell.stderr!.on("data", output);
		deadlineTimer = setTimeout(() => requestStop("timeout"), spec.runtimeMs);
		stage = "control";
		let lastSave = 0, controlFailures = 0;
		// The control loop never waits for a heartbeat or a record lock before stopping.
		while (!exited && !reason && !fault) {
			try { if (await cancelled()) requestStop("cancelled"); controlFailures = 0; }
			// One failed read must not stop a healthy command. About one second of failures does.
			catch (error) { if (++controlFailures >= 20) fail(error); }
			if (!reason && !fault && !heartbeat && Date.now() - lastSave >= 1000) {
				lastSave = Date.now();
				// A missed heartbeat only makes Pi report unknown until the next one. The command continues.
				heartbeat = save("running").catch(() => {}).finally(() => { heartbeat = undefined; });
			}
			if (!reason && !fault) await delay(50);
		}
		clearTimeout(deadlineTimer);
		stage = "stop";
		// Even a successful shell can leave ordinary descendants. They must stop before release.
		const proved = await stop();
		const drained = await drain();
		// Proved termination is a terminal result, also after a runner fault. Only missing proof keeps protection.
		await finish(!proved || !drained ? "unknown" : fault ? "failed" : reason ?? (spawnFailed || exitCode !== 0 || signal ? "failed" : "succeeded"),
			!drained ? "output_close_timeout" : !proved ? "termination_unproved" : fault);
	} catch (error) {
		// The final record already had its attempts. The saved heartbeat keeps protection.
		if (stage === "record") throw error;
		fail(error);
		let ended = false;
		try { ended = await stop() && await drain(); } catch (stopError) { fail(stopError); }
		// Without a shell, a sealed start is the cancellation that the user requested.
		const sealed = !child && (reason === "cancelled" || await cancelled().catch(() => false));
		await finish(!ended ? "unknown" : sealed ? "cancelled" : "failed", sealed ? undefined : fault);
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
