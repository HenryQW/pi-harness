import { lstat } from "node:fs/promises";
import type { HerdrExecResult } from "@henryqw/pi-herdr";

export async function assertPrivateLease(path: string, allowMissing: boolean): Promise<boolean> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`Exact process lease cannot be inspected: ${path}`, { cause: error });
	}
	const uid = process.getuid?.();
	if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) {
		throw new Error("Exact process lease must be a current-user regular non-symlink mode-0600 file.");
	}
	return true;
}

/** Shared exact process-lease evidence for direct and isolated workers. */
export async function scanProcessLease(path: string, execute: (args: string[]) => Promise<HerdrExecResult>, pid?: number, allowMissing = false): Promise<number[]> {
	if (!await assertPrivateLease(path, allowMissing)) return [];
	// -w: host-wide warnings (for example an unreachable network mount) are not lease evidence; real errors still reach stderr.
	const args = ["-w", "-nP", "-a", ...(pid === undefined ? [] : ["-p", String(pid)]), "-F", "p", "--", path];
	const result = await execute(args);
	if (result.killed || ![0, 1].includes(result.code) || (result.code === 1 && (result.stdout.trim() || result.stderr.trim()))) {
		throw new Error("Exact process lease lsof scan failed or was ambiguous.");
	}
	if (result.code === 1) return [];
	if (result.stderr.trim()) throw new Error("Exact process lease lsof scan returned unexpected diagnostics.");
	// lsof always selects the file descriptor field, so `-F p` also emits `f<fd>` lines.
	const lines = result.stdout.trim().split(/\r?\n/).filter((line) => line && !/^f\w+$/.test(line));
	if (!lines.length || lines.some((line) => !/^p[1-9]\d*$/.test(line))) {
		throw new Error("Exact process lease lsof scan returned malformed PID fields.");
	}
	const holders = [...new Set(lines.map((line) => Number(line.slice(1))))];
	if (holders.some((holder) => !Number.isSafeInteger(holder) || holder <= 0) || (pid !== undefined && holders.some((holder) => holder !== pid))) {
		throw new Error("Exact process lease lsof scan returned an unexpected PID.");
	}
	return holders;
}
