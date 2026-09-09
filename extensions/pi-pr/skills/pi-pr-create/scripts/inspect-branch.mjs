#!/usr/bin/env node

import { spawn } from "node:child_process";

const SCHEMA_VERSION = 1;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_REFS = 1_000;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;
const SAFE_ROW = /^[^\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]+$/;

class InspectionBlocked extends Error {
	constructor(code, message, candidates) {
		super(message);
		this.code = code;
		this.candidates = candidates;
	}
}

let activeChild;
const lifetime = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => lifetime.abort(new Error(`received ${signal}`)));
}

function blocked(code, message, candidates) {
	throw new InspectionBlocked(code, message, candidates);
}

function validText(value, field, maxLength = 4_096) {
	if (typeof value !== "string" || !value || value.length > maxLength || !SAFE_TEXT.test(value) || value.trim() !== value) {
		blocked("invalid-input", `Invalid ${field}`);
	}
	return value;
}

function validOid(value, field) {
	validText(value, field, 64);
	if (!OID.test(value)) blocked("invalid-git-output", `Git returned an invalid ${field}`);
	return value.toLowerCase();
}

function oneLine(value, field) {
	const normalized = value.replace(/\r\n/g, "\n");
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	if (lines.length !== 1) blocked("invalid-git-output", `Git returned an invalid ${field}`);
	return validText(lines[0], field);
}

function rows(value, field) {
	const normalized = value.replace(/\r\n/g, "\n");
	if (!normalized) return [];
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	if (lines.some((line) => !line || !SAFE_ROW.test(line))) {
		blocked("invalid-git-output", `Git returned invalid ${field}`);
	}
	return lines;
}

async function git(args, { allow = [0], action } = {}) {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		blocked("invalid-input", "Invalid Git argument array");
	}
	return await new Promise((resolve, reject) => {
		const controller = new AbortController();
		const abort = () => controller.abort(lifetime.signal.reason);
		lifetime.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error("command timed out")), COMMAND_TIMEOUT_MS);
		const child = spawn("git", args, {
			cwd: process.cwd(),
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			signal: controller.signal,
		});
		activeChild = child;
		const stdout = [];
		const stderr = [];
		let bytes = 0;
		let overflow = false;
		const collect = (target) => (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				overflow = true;
				controller.abort(new Error("command output exceeded limit"));
				return;
			}
			target.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.once("error", (error) => {
			clearTimeout(timer);
			lifetime.signal.removeEventListener("abort", abort);
			activeChild = undefined;
			if (controller.signal.aborted) {
				reject(new InspectionBlocked(
					overflow ? "output-limit" : lifetime.signal.aborted ? "cancelled" : "timeout",
					overflow ? `${action} output exceeded the limit` : lifetime.signal.aborted ? `${action} was cancelled` : `${action} timed out`,
				));
				return;
			}
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			lifetime.signal.removeEventListener("abort", abort);
			activeChild = undefined;
			if (controller.signal.aborted) return;
			const status = code ?? (signal ? 128 : 1);
			if (!allow.includes(status)) {
				reject(new InspectionBlocked("git-command-failed", `${action} failed with exit code ${status}`));
				return;
			}
			resolve({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code: status,
			});
		});
	});
}

async function validateRef(ref, field, pattern = false) {
	validText(ref, field, 1_024);
	const args = ["check-ref-format", ...(pattern ? ["--refspec-pattern"] : []), ref];
	const checked = await git(args, { allow: [0, 1], action: `Validate ${field}` });
	if (checked.code !== 0 || checked.stdout !== "") blocked("invalid-ref", `Invalid ${field}`);
}

function parseArguments(argv) {
	if (argv.length !== 4 || argv[0] !== "--remote" || argv[2] !== "--fetch-source") {
		blocked("invalid-input", "Usage: inspect-branch.mjs --remote REMOTE --fetch-source SOURCE");
	}
	return {
		remote: validText(argv[1], "remote", 256),
		fetchSource: validText(argv[3], "fetch source"),
	};
}

async function inspect() {
	const { remote, fetchSource } = parseArguments(process.argv.slice(2));
	if (remote.startsWith("-")) blocked("invalid-input", "Invalid remote");
	await validateRef(`refs/remotes/${remote}/__pi_pr__`, "remote");
	const remotes = rows((await git(["remote"], { action: "Read remotes" })).stdout, "remote list");
	if (new Set(remotes).size !== remotes.length || !remotes.includes(remote)) {
		blocked("invalid-input", "Remote is not configured exactly once");
	}

	const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
		allow: [0, 1],
		action: "Read current branch",
	});
	if (branchResult.code === 1 && branchResult.stdout === "") blocked("detached-head", "HEAD is detached");
	const branch = oneLine(branchResult.stdout, "current branch");
	const branchCheck = await git(["check-ref-format", "--branch", branch], { allow: [0, 1], action: "Validate current branch" });
	if (branchCheck.code !== 0 || branchCheck.stdout.replace(/\r\n/g, "\n") !== `${branch}\n`) {
		blocked("invalid-ref", "Current branch is invalid");
	}
	const head = validOid(oneLine((await git(["rev-parse", "--verify", "HEAD^{commit}"], {
		action: "Read HEAD",
	})).stdout, "HEAD"), "HEAD");

	const reflog = rows((await git([
		"reflog", "show", "--format=%H%x09%gs", `refs/heads/${branch}`,
	], { action: "Read branch creation reflog" })).stdout, "branch reflog");
	if (!reflog.length) blocked("missing-parent-evidence", "Branch creation reflog is missing");
	const creationParts = reflog.at(-1).split("\t");
	if (creationParts.length !== 2 || !/^branch: Created from .+$/.test(creationParts[1])) {
		blocked("missing-parent-evidence", "Branch creation reflog does not identify the creation point");
	}
	const creationOid = validOid(creationParts[0], "branch creation OID");
	if ((await git(["merge-base", "--is-ancestor", creationOid, head], {
		allow: [0, 1], action: "Validate branch creation ancestry",
	})).code !== 0) {
		blocked("missing-parent-evidence", "Branch creation point is not an ancestor of HEAD");
	}

	await validateRef("refs/heads/*", "fetch source refspec", true);
	await validateRef(`refs/remotes/${remote}/*`, "fetch destination refspec", true);
	const refspec = `+refs/heads/*:refs/remotes/${remote}/*`;
	await git([
		"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules",
		"--", fetchSource, refspec,
	], { action: "Fetch parent candidates" });

	const prefix = `refs/remotes/${remote}/`;
	const refRows = rows((await git([
		"for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", `refs/remotes/${remote}`,
	], { action: "Read parent candidates" })).stdout, "remote refs");
	if (refRows.length > MAX_REFS) blocked("too-many-parent-candidates", `More than ${MAX_REFS} remote parent candidates exist`);

	const candidates = [];
	for (const row of refRows) {
		const parts = row.split("\t");
		if (parts.length !== 3 || !parts[0].startsWith(prefix)) {
			blocked("invalid-git-output", "Git returned an invalid remote parent candidate");
		}
		const ref = parts[0].slice(prefix.length);
		if (!ref) blocked("invalid-git-output", "Git returned an empty remote parent ref");
		await validateRef(parts[0], "remote parent ref");
		const candidateOid = validOid(parts[1], "remote parent OID");
		if (parts[2] || ref === branch) continue;

		const mergeBaseResult = await git(["merge-base", head, candidateOid], {
			allow: [0, 1], action: "Read candidate merge-base",
		});
		if (mergeBaseResult.code === 1 && mergeBaseResult.stdout === "") continue;
		const mergeBase = validOid(oneLine(mergeBaseResult.stdout, "candidate merge-base"), "candidate merge-base");
		if ((await git(["merge-base", "--is-ancestor", creationOid, mergeBase], {
			allow: [0, 1], action: "Compare branch creation evidence",
		})).code !== 0) continue;
		const countOutput = (await git([
			"rev-list", "--left-right", "--count", `${head}...${candidateOid}`,
		], { action: "Measure parent candidate" })).stdout.replace(/\r\n/g, "\n");
		const counts = countOutput.endsWith("\n") ? countOutput.slice(0, -1) : countOutput;
		const match = /^(\d+)\s+(\d+)$/.exec(counts);
		if (!match) blocked("invalid-git-output", "Git returned an invalid candidate distance");
		const ahead = Number(match[1]);
		const behind = Number(match[2]);
		const score = ahead + behind;
		if (![ahead, behind, score].every(Number.isSafeInteger)) {
			blocked("invalid-git-output", "Git returned an unsafe candidate distance");
		}
		candidates.push({ ref, oid: candidateOid, mergeBase, ahead, score });
	}
	if (!candidates.length) blocked("missing-parent-evidence", "No remote parent matches the branch creation evidence");
	const minimum = Math.min(...candidates.map(({ score }) => score));
	const nearest = candidates.filter(({ score }) => score === minimum);
	if (nearest.length !== 1) {
		blocked(
			"ambiguous-parent",
			"More than one remote parent is equally nearest to HEAD",
			nearest.map(({ ref }) => `${remote}/${ref}`).sort(),
		);
	}
	const selected = nearest[0];
	return {
		schemaVersion: SCHEMA_VERSION,
		status: "ready",
		branch,
		head,
		base: {
			remote,
			ref: selected.ref,
			oid: selected.oid,
			mergeBase: selected.mergeBase,
		},
		ahead: selected.ahead,
	};
}

try {
	const output = await inspect();
	process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
	if (error instanceof InspectionBlocked) {
		process.stdout.write(`${JSON.stringify({
			schemaVersion: SCHEMA_VERSION,
			status: "blocked",
			blocker: {
				code: error.code,
				message: error.message,
				...(error.candidates === undefined ? {} : { candidates: error.candidates }),
			},
		})}\n`);
	} else {
		process.stdout.write(`${JSON.stringify({
			schemaVersion: SCHEMA_VERSION,
			status: "blocked",
			blocker: { code: "inspector-failed", message: "Branch inspection failed unexpectedly" },
		})}\n`);
		process.exitCode = 1;
	}
} finally {
	activeChild?.kill("SIGTERM");
}
