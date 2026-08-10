import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runDirectory, type Uuid } from "./state.ts";
import { exactKeys, nonEmptyString, object } from "./validate.ts";

export type ReviewKind = "implementation" | "final_check" | "final_repair" | "pr_health_repair";
export type ReviewTicketScope = "implementation" | "lifecycle" | "pr_health";

export interface ReviewIdentity {
	run_id: string;
	kind: ReviewKind;
	issue_id: string;
	commit: string;
	attempt: number;
	review_round: number;
}

export function reviewId(identity: ReviewIdentity): string {
	return createHash("sha256").update(JSON.stringify([
		identity.run_id,
		identity.kind,
		identity.issue_id,
		identity.commit,
		identity.attempt,
		identity.review_round,
	])).digest("hex");
}

export function reviewTicketPath(mainWorktree: string, runId: string, issueId: string, scope: ReviewTicketScope): string {
	return join(runDirectory(mainWorktree, runId), "review-tickets", `${issueId}-${scope}.json`);
}

export async function writeReviewTicket(path: string, id: string, uuid: Uuid): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${uuid()}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ review_id: id })}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

export async function readReviewTicket(path: string): Promise<string> {
	const input = object(JSON.parse(await readFile(path, "utf8")), "review ticket");
	exactKeys(input, ["review_id"], "review ticket");
	return nonEmptyString(input.review_id, "review ticket review_id");
}
