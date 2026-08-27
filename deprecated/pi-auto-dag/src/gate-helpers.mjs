import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function processIdentity(pid) {
	if (process.platform === "linux") {
		try {
			const [bootId, stat] = await Promise.all([
				readFile("/proc/sys/kernel/random/boot_id", "utf8"),
				readFile(`/proc/${pid}/stat`, "utf8"),
			]);
			const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
			const started = fields[19];
			if (!started) throw new Error("Linux process stat lacks start time");
			return fields[0] === "Z" ? undefined : `linux:${bootId.trim()}:${started}`;
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes(error.code ?? "")) return undefined;
			throw error;
		}
	}
	try {
		const [{ stdout }, { stdout: status }] = await Promise.all([
			execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }),
			execFile("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }),
		]);
		const started = stdout.trim();
		return started && !status.trim().startsWith("Z") ? `${process.platform}:${started}` : undefined;
	} catch (error) {
		if (String(error.code) === "1") return undefined;
		throw error;
	}
}

export async function writeJson(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function exists(path) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

export async function removeFile(path) {
	await unlink(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
