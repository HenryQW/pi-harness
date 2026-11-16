import { join } from "node:path";

/** Replace the Role launch's single `--no-session` with a persisted session file so every run can be reopened. */
export function sessionLaunchArgs(args: readonly string[], sessionFile: string): string[] {
	const index = args.indexOf("--no-session");
	if (index < 0 || args.indexOf("--no-session", index + 1) >= 0) throw new Error("Role launch must contain exactly one --no-session option.");
	return [...args.slice(0, index), "--session", sessionFile, ...args.slice(index + 1)];
}

export function sessionFilePath(home: string, jobId: string, startedAt: number): string {
	return join(home, "sessions", jobId, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.jsonl`);
}

/** Bounded, control-character-free text for state and notifications. */
export function summarize(text: string, maxBytes: number): string {
	const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
	if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean;
	return `${Buffer.from(clean, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "")}…`;
}
