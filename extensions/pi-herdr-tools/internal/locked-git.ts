import { spawn } from "node:child_process";

export type GitMutation = { cwd: string } & ({ operation: "remove"; checkout: string; force: boolean } | { operation: "pull" });

// Only these two mutations need borrowed locks. Read-only commands still use Pi's executor.
export async function runLockedGit(mutation: GitMutation, descriptors: readonly number[]): Promise<void> {
	if (descriptors.length !== (mutation.operation === "remove" ? 2 : 1) || descriptors.some(fd => !Number.isInteger(fd) || fd < 0)) throw new Error("Required Git lock descriptors are unavailable; reload with the current Pi Herdr package.");
	const args = mutation.operation === "remove" ? ["worktree", "remove", ...(mutation.force ? ["--force"] : []), mutation.checkout] : ["pull", "--ff-only"];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("git", args, { cwd: mutation.cwd, stdio: ["ignore", "ignore", "pipe", ...descriptors] });
		let stderr = Buffer.alloc(0);
		child.stderr!.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(drainTimer);
			child.removeListener("close", finish);
			child.stderr!.destroy();
			if (code === 0 && !signal) resolve();
			else reject(new Error(`git ${mutation.operation === "remove" ? "worktree remove" : "pull"} failed (${signal ?? code}): ${stderr.toString("utf8").trim() || "no diagnostic output"}`));
		};
		child.once("error", reject);
		// Use Pi's 100 ms grace only after Git exits. Descendants cannot extend this drain.
		child.once("exit", (code, signal) => { drainTimer = setTimeout(() => finish(code, signal), 100); });
		child.once("close", finish);
	});
}
