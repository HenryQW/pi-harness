import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";

const OUTPUT_OVERFLOW_EXIT_CODE = 125;
const [recordPath, launchId, command, ...arguments_] = process.argv.slice(2);
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
let completedBeforeCancellation = false;
const terminate = () => {
	if (timedOut) return;
	if (!commandCompleted) timedOut = true;
	if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
};
process.once("SIGTERM", terminate);
const timeout = control.timeout_ms === undefined ? undefined : setTimeout(terminate, control.timeout_ms);
void outputCompletion.catch(() => {
	if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
});

try {
	const running = spawn(command, arguments_, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true });
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
	const outcome = await new Promise((resolve) => {
		let settled = false;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			commandCompleted = true;
			completedBeforeCancellation = !existsSync(control.cancel);
			resolve(result);
		};
		running.once("error", (error) => settle({ code: 1, signal: null, error }));
		running.once("exit", (code, signal) => settle({ code, signal }));
	});
	if (outcome.error) stderr.write(`${outcome.error.message}\n`);
	if (running.pid !== undefined) await terminateGroup(running.pid);
	await outputCompletion;
	const exitCode = overflowed ? OUTPUT_OVERFLOW_EXIT_CODE : timedOut ? 124 : outcome.signal ? 1 : outcome.code ?? 1;
	await markCompleted(recordPath, launchId, exitCode, completedBeforeCancellation);
	process.exitCode = exitCode;
} catch (error) {
	if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
	stdout.destroy();
	stderr.destroy();
	await outputCompletion.catch(() => undefined);
	throw error;
} finally {
	if (timeout) clearTimeout(timeout);
	process.removeListener("SIGTERM", terminate);
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

async function markCompleted(path, expectedLaunchId, exitCode, completedBeforeCancellation) {
	if (!completedBeforeCancellation && await exists(`${path}.${expectedLaunchId}.cancel`)) return;
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

async function processIdentity(pid) {
	if (process.platform === "linux") {
		try {
			const [bootId, stat] = await Promise.all([
				readFile("/proc/sys/kernel/random/boot_id", "utf8"),
				readFile(`/proc/${pid}/stat`, "utf8"),
			]);
			const started = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
			if (!started) throw new Error("Linux process stat lacks start time");
			return `linux:${bootId.trim()}:${started}`;
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes(error.code ?? "")) return undefined;
			throw error;
		}
	}
	try {
		const { stdout } = await promisify(execFileCallback)("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		const started = stdout.trim();
		return started ? `${process.platform}:${started}` : undefined;
	} catch (error) {
		if (String(error.code) === "1") return undefined;
		throw error;
	}
}

async function writeJson(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

async function cancelLaunch(readyPath, cancelPath) {
	await Promise.all([removeFile(readyPath), removeFile(cancelPath)]);
	throw new Error("Required gate launch was cancelled");
}

async function removeFile(path) {
	await unlink(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
