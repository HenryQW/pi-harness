import { spawnBounded } from "@henryqw/pi-process";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT_BYTES = 1 * 1024 * 1024;
const GIT_DIAGNOSTIC_LIMIT = 200;

export type GitResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type GitRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<GitResult>;

/** Run one ordinary Git command with bounded output; transport failures never throw. */
export const runGit: GitRunner = async (args, cwd, signal) => {
	try {
		const result = await spawnBounded("git", ["--no-pager", ...args], {
			cwd,
			signal,
			timeoutMs: GIT_TIMEOUT_MS,
			stdoutLimitBytes: GIT_OUTPUT_LIMIT_BYTES,
			stderrLimitBytes: GIT_OUTPUT_LIMIT_BYTES,
		});
		if (result.killed) {
			return {
				code: -1,
				stdout: "",
				stderr: result.stderr.trim().slice(0, GIT_DIAGNOSTIC_LIMIT) || "git was killed",
			};
		}
		return { code: result.code, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			code: -1,
			stdout: "",
			stderr: reason.slice(0, GIT_DIAGNOSTIC_LIMIT) || "git execution failed",
		};
	}
};
