import { commandOutput, type CommandRunner } from "./command.ts";
import type { PullRequestIdentity } from "./model.ts";
import { nonEmptyString, object } from "./validate.ts";

export async function viewOpenPullRequest(
	mainWorktree: string,
	number: number,
	runner: CommandRunner,
): Promise<PullRequestIdentity> {
	const text = await commandOutput(runner, "gh", [
		"pr", "view", String(number), "--json", "number,url,headRefName,baseRefName,headRefOid,state",
	], mainWorktree);
	const value = object(JSON.parse(text), "gh pr view");
	if (value.state !== "OPEN") throw new Error(`Integration PR ${number} is not open`);
	return parsePullRequest(value, "gh pr view");
}

export function parsePullRequest(value: unknown, label: string): PullRequestIdentity {
	const input = object(value, label);
	const number = input.number;
	if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error(`${label}.number must be a positive integer`);
	return {
		number,
		url: nonEmptyString(input.url, `${label}.url`),
		head_ref: nonEmptyString(input.headRefName, `${label}.headRefName`),
		base_ref: nonEmptyString(input.baseRefName, `${label}.baseRefName`),
		head_oid: nonEmptyString(input.headRefOid, `${label}.headRefOid`),
	};
}

export function assertSamePullRequest(expected: PullRequestIdentity, actual: PullRequestIdentity, exactHead: boolean): void {
	if (
		expected.number !== actual.number
		|| expected.url !== actual.url
		|| expected.head_ref !== actual.head_ref
		|| expected.base_ref !== actual.base_ref
		|| (exactHead && expected.head_oid !== actual.head_oid)
	) throw new Error("Integration PR identity changed during recovery");
}
