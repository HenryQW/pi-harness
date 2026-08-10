import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

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

const child = spawn(command, arguments_, { cwd: process.cwd(), stdio: "inherit" });
child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
child.once("close", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});

async function markReady(path, expectedLaunchId) {
	const record = JSON.parse(await readFile(path, "utf8"));
	if (!record || typeof record !== "object" || Array.isArray(record)
		|| record.phase !== "launching" || record.launch_id !== expectedLaunchId
		|| typeof record.release !== "string" || !record.release) {
		throw new Error("Required gate launch intent does not match gate host");
	}
	const control = {
		release: record.release,
		cancel: `${path}.${expectedLaunchId}.cancel`,
		ready: `${path}.${expectedLaunchId}.host`,
	};
	if (await exists(control.cancel)) throw new Error("Required gate launch was cancelled");
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
