import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";

/** Internal descriptor access lets local commands retain the lock if their parent exits. */
export async function withPathLock<T>(target: string, operation: (descriptor: number) => Promise<T>): Promise<T> {
	const command = process.platform === "darwin" ? "/usr/bin/lockf" : process.platform === "linux" ? "flock" : undefined;
	if (!command) throw new Error(`Path locks require macOS lockf or Linux util-linux flock; unsupported platform: ${process.platform}`);
	const path = `${realpathSync(target)}.lock`;
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EISDIR") {
			throw Object.assign(new Error(`Legacy lock directory blocks ${path}; stop old holders before manual removal.`, { cause: error }), { code: "ELOCKED" });
		}
		throw error;
	}
	let failed = false;
	let failure: unknown;
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`Path lock is not a regular file: ${path}`);
		// -t sets the timeout; -n disables waiting; -E selects the contention exit code.
		const args = process.platform === "darwin" ? ["-t", "0", "3"] : ["-n", "-E", "75", "3"];
		const result = spawnSync(command, args, {
			stdio: ["ignore", "ignore", "pipe", descriptor], encoding: "utf8", timeout: 5_000, maxBuffer: 8_192,
		});
		if (result.error) throw Object.assign(new Error(`Cannot acquire path lock with ${command}: ${result.error.message}`, { cause: result.error }), { code: (result.error as NodeJS.ErrnoException).code });
		if (result.status === 75) throw Object.assign(new Error(`Lock file is already being held: ${path}`), { code: "ELOCKED" });
		if (result.status !== 0) throw new Error(`${command} descriptor lock failed (${result.signal ?? result.status}): ${result.stderr.trim()}`);
		// The short child shares this open-file description. Its exit does not release our lock.
		return await operation(descriptor);
	} catch (error) {
		failed = true;
		failure = error;
		throw error;
	} finally {
		try { closeSync(descriptor); }
		catch (error) {
			if (failed) throw new AggregateError([failure, error], "Operation or acquisition failed and lock release failed.");
			throw error;
		}
	}
}
