import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { exists, processIdentity, removeFile, writeJson } from "./gate-helpers.mjs";

const OUTPUT_OVERFLOW_EXIT_CODE = 125;
const GATE_COMMAND_LAUNCHER = `
"$1" "$2" --mark-command "$3" "$4" "$$" || exit $?
while [ ! -e "$5" ]; do
	[ -e "$6" ] && exit 1
	sleep 0.005
done
rm -f "$5"
[ -e "$6" ] && exit 1
shift 6
exec "$@"
`;
const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--mark-command") await markCommand(...arguments_.slice(1));
else await runHost(arguments_);

async function runHost([recordPath, launchId, command, ...commandArguments]) {
	if (!recordPath || !launchId || !command) throw new Error("Required gate host arguments are incomplete");
	const control = await markReady(recordPath, launchId);
	while (true) {
		if (await exists(control.cancel)) await cancelLaunch(control.ready, control.cancel);
		if (await exists(control.release)) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await unlink(control.release);
	if (await exists(control.cancel)) await cancelLaunch(control.ready, control.cancel);

	const stdout = createWriteStream(control.output_files.stdout, { mode: 0o600 });
	const stderr = createWriteStream(control.output_files.stderr, { mode: 0o600 });
	const outputCompletion = Promise.all([finished(stdout), finished(stderr)]);
	let child;
	let outputBytes = 0;
	let overflowed = false;
	let timedOut = false;
	let commandCompleted = false;
	let cancelled = false;
	const terminate = () => {
		if (timedOut) return;
		if (!commandCompleted) timedOut = true;
		if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
	};
	const cancel = () => {
		cancelled = true;
		terminate();
	};
	process.once("SIGTERM", cancel);
	const timeout = control.timeout_ms === undefined ? undefined : setTimeout(terminate, control.timeout_ms);
	void outputCompletion.catch(() => {
		if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
	});

	try {
		const running = spawn("sh", ["-c", GATE_COMMAND_LAUNCHER, "pi-auto-dag-gate", process.execPath, process.argv[1], recordPath, launchId, control.command_release, control.cancel, command, ...commandArguments], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		child = running;
		running.stdout.pipe(stdout);
		running.stderr.pipe(stderr);
		const collect = (chunk) => {
			outputBytes += chunk.length;
			if (outputBytes > control.max_output_bytes && !overflowed) {
				overflowed = true;
				if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
			}
		};
		running.stdout.on("data", collect);
		running.stderr.on("data", collect);
		const outcome = new Promise((resolve) => {
			let settled = false;
			const settle = (result) => {
				if (settled) return;
				settled = true;
				commandCompleted = true;
				resolve(result);
			};
			running.once("error", (error) => settle({ code: 1, signal: null, error }));
			running.once("exit", (code, signal) => settle({ code, signal }));
		});
		await waitForCommand(control.command, launchId, running);
		if (await exists(control.cancel)) throw new Error("Required gate launch was cancelled");
		await writeFile(control.command_release, "run\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		const result = await outcome;
		if (result.error) stderr.write(`${result.error.message}\n`);
		if (running.pid !== undefined) await terminateGroup(running.pid);
		await outputCompletion;
		const exitCode = overflowed ? OUTPUT_OVERFLOW_EXIT_CODE : timedOut ? 124 : result.signal ? 1 : result.code ?? 1;
		await markCompleted(recordPath, launchId, exitCode, cancelled);
		process.exitCode = exitCode;
	} catch (error) {
		if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
		stdout.destroy();
		stderr.destroy();
		await outputCompletion.catch(() => undefined);
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		process.removeListener("SIGTERM", cancel);
	}
}

async function markCommand(recordPath, launchId, pidText) {
	if (!recordPath || !launchId || !pidText) throw new Error("Required gate command identity arguments are incomplete");
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Required gate command PID must be a positive integer");
	const cancel = `${recordPath}.${launchId}.cancel`;
	if (await exists(cancel)) throw new Error("Required gate launch was cancelled");
	const identity = await processIdentity(pid);
	if (!identity) throw new Error("Required gate command lacks a safe process identity");
	await writeJson(`${recordPath}.${launchId}.command`, { version: 1, launch_id: launchId, pid, identity });
	if (await exists(cancel)) throw new Error("Required gate launch was cancelled");
}

async function waitForCommand(path, launchId, child) {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		try {
			const record = JSON.parse(await readFile(path, "utf8"));
			if (record.version !== 1 || record.launch_id !== launchId || record.pid !== child.pid || typeof record.identity !== "string" || !record.identity) {
				throw new Error("Required gate command identity does not match launch intent");
			}
			return;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("Required gate command exited before recording its identity");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Required gate command did not record its identity");
}

async function markReady(path, expectedLaunchId) {
	const record = await readRecord(path);
	if (record.version !== 4 || record.phase !== "launching" || record.launch_id !== expectedLaunchId) {
		throw new Error("Required gate launch intent does not match gate host");
	}
	const cancel = `${path}.${expectedLaunchId}.cancel`;
	if (await exists(cancel)) throw new Error("Required gate launch was cancelled");
	if (!record.output_files || typeof record.output_files.stdout !== "string" || !record.output_files.stdout
		|| typeof record.output_files.stderr !== "string" || !record.output_files.stderr
		|| !Number.isSafeInteger(record.max_output_bytes) || record.max_output_bytes <= 0
		|| (record.timeout_ms !== undefined && (!Number.isSafeInteger(record.timeout_ms) || record.timeout_ms <= 0))) {
		throw new Error("Required gate launch intent lacks host output settings");
	}
	const control = {
		release: record.release,
		cancel,
		ready: `${path}.${expectedLaunchId}.host`,
		command: `${path}.${expectedLaunchId}.command`,
		command_release: `${path}.${expectedLaunchId}.command.release`,
		output_files: record.output_files,
		max_output_bytes: record.max_output_bytes,
		...(record.timeout_ms === undefined ? {} : { timeout_ms: record.timeout_ms }),
	};
	if (typeof control.release !== "string" || !control.release) throw new Error("Required gate launch intent does not match gate host");
	const identity = await processIdentity(process.pid);
	if (!identity) throw new Error("Required gate host lacks a safe process identity");
	if (await exists(control.cancel)) throw new Error("Required gate launch was cancelled");
	await writeJson(control.ready, { version: 1, launch_id: expectedLaunchId, pid: process.pid, identity });
	if (await exists(control.cancel)) {
		await removeFile(control.ready);
		throw new Error("Required gate launch was cancelled");
	}
	return control;
}

async function markCompleted(path, expectedLaunchId, exitCode, cancelled) {
	if (cancelled || await exists(`${path}.${expectedLaunchId}.cancelled`)) return;
	const record = await readRecord(path);
	if (record.version !== 4 || record.launch_id !== expectedLaunchId) {
		throw new Error("Required gate completion does not match launch intent");
	}
	if (record.phase === "completed") {
		if (record.exit_code !== exitCode) throw new Error("Required gate completion exit code changed");
		return;
	}
	if (record.phase !== "launching") throw new Error("Required gate completion does not match launch intent");
	await writeJson(path, { ...record, phase: "completed", exit_code: exitCode, cleanup_complete: false });
}

async function readRecord(path) {
	const record = JSON.parse(await readFile(path, "utf8"));
	if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Required gate process record must be an object");
	return record;
}

async function terminateGroup(pid) {
	if (!signalGroup(pid, "SIGTERM")) return;
	await new Promise((resolve) => setTimeout(resolve, 100));
	signalGroup(pid, "SIGKILL");
}

function signalGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

async function cancelLaunch(readyPath, cancelPath) {
	await Promise.all([removeFile(readyPath), removeFile(cancelPath)]);
	throw new Error("Required gate launch was cancelled");
}

