#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readTextFileBounded } from "@henryqw/pi-config-store";
import {
	collectPullRequestFeedback,
	feedbackEntries,
	parseFeedbackSnapshotText,
	showFeedbackItem,
	FEEDBACK_SNAPSHOT_MAX_BYTES,
} from "../../../extensions/pr-feedback.ts";
import {
	loadCurrentPullRequest,
	samePullRequestSnapshot,
} from "../../../extensions/pr-github.ts";
import {
	inspectWorktree,
	readHead,
	spawnBounded,
} from "../../../extensions/pr-execution.ts";

class UsageError extends Error {}

function usage() {
	const command = `node ${process.argv[1]}`;
	return `usage:
  ${command} fetch [--pr PR] (--out FILE | --json)
  ${command} show --snapshot FILE --id ID
  ${command} checks [--pr PR] --expected-head SHA
  ${command} self-test`;
}

function parse(command, args) {
	const allowed = {
		fetch: new Set(["--pr", "--out", "--json"]),
		show: new Set(["--snapshot", "--id"]),
		checks: new Set(["--pr", "--expected-head"]),
	}[command];
	if (!allowed) throw new UsageError(`unknown command: ${command}`);
	const values = {};
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (!allowed.has(flag)) throw new UsageError(`unsupported ${flag} for ${command}`);
		if (flag === "--json") {
			if (values.json) throw new UsageError("--json was supplied twice");
			values.json = true;
			continue;
		}
		const value = args[++index];
		if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
		const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (values[key] !== undefined) throw new UsageError(`${flag} was supplied twice`);
		values[key] = value;
	}
	if (command === "fetch" && (values.out === undefined) === !values.json) {
		throw new UsageError("fetch requires exactly one of --out or --json");
	}
	if (command === "show" && (!values.snapshot || !values.id)) throw new UsageError("show needs --snapshot and --id");
	if (command === "checks" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(values.expectedHead ?? "")) {
		throw new UsageError("checks needs a full --expected-head OID");
	}
	if (values.pr !== undefined && !/^[1-9][0-9]*$/.test(values.pr)) {
		let url;
		try {
			url = new URL(values.pr);
		} catch {
			throw new UsageError("--pr must be a positive number or canonical HTTPS pull request URL");
		}
		if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
			!/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(url.pathname)) {
			throw new UsageError("--pr must be a positive number or canonical HTTPS pull request URL");
		}
	}
	return values;
}

function execOptions(options) {
	return {
		cwd: options.cwd,
		signal: options.signal,
		timeoutMs: options.timeout,
	};
}

function pi(cwd, signal) {
	return {
		exec: (command, args, options) => spawnBounded(command, args, execOptions({ cwd: options?.cwd ?? cwd, signal: options?.signal ?? signal, timeout: options?.timeout })),
	};
}

async function current(cwd, signal, pr) {
	const discovery = await loadCurrentPullRequest(pi(cwd, signal), { cwd, signal });
	if (discovery.kind !== "current" || discovery.pullRequest.lifecycle !== "open" || discovery.pullRequest.target.provenance !== "configured") {
		throw new Error("current configured open pull request is unavailable");
	}
	const pullRequest = discovery.pullRequest;
	if (pr !== undefined) {
		const matches = /^[1-9][0-9]*$/.test(pr)
			? pullRequest.number === Number(pr)
			: pullRequest.url.href === new URL(pr).href;
		if (!matches) throw new Error("requested pull request does not match the current configured pull request");
	}
	return pullRequest;
}

async function requireCleanHead(cwd, signal, pullRequest, expectedHead = pullRequest.head.oid) {
	if (await inspectWorktree(spawnBounded, { cwd, signal }) !== "clean") throw new Error("worktree must be clean with no Git operation in progress");
	const head = await readHead(spawnBounded, { cwd, signal });
	if (head !== expectedHead || pullRequest.head.oid !== expectedHead || pullRequest.target.remoteOid !== expectedHead) {
		throw new Error("local, pull request, and remote heads must match the expected head");
	}
}

async function writeSnapshotAtomically(path, contents, signal) {
	signal.throwIfAborted();
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let file;
	let created = false;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		created = true;
		signal.throwIfAborted();
		if (process.platform !== "win32") await file.chmod(0o600);
		signal.throwIfAborted();
		await file.writeFile(contents, { encoding: "utf8", signal });
		signal.throwIfAborted();
		await file.sync();
		signal.throwIfAborted();
		await file.close();
		file = undefined;
		signal.throwIfAborted();
		await rename(temporaryPath, path);
	} catch (error) {
		try {
			await file?.close();
		} finally {
			if (created) await rm(temporaryPath, { force: true });
		}
		throw error;
	}
}

async function fetchFeedback(options) {
	const cwd = process.cwd();
	const signal = new AbortController().signal;
	const initial = await current(cwd, signal, options.pr);
	await requireCleanHead(cwd, signal, initial);
	const snapshot = await collectPullRequestFeedback({
		id: initial.id,
		number: initial.number,
		url: initial.url.href,
		host: initial.host,
		base: initial.base,
		head: initial.head,
	}, { exec: spawnBounded, cwd, signal });
	const fresh = await current(cwd, signal, initial.url.href);
	if (!samePullRequestSnapshot(initial, fresh) || initial.base.oid !== fresh.base.oid) {
		throw new Error("pull request authority changed during feedback fetch");
	}
	await requireCleanHead(cwd, signal, fresh);
	const text = `${JSON.stringify(snapshot)}\n`;
	if (options.json) {
		process.stdout.write(text);
		return;
	}
	const destination = resolve(options.out);
	await writeSnapshotAtomically(destination, text, signal);
	console.log(`snapshot=${destination}`);
	console.log(`feedback_records=${feedbackEntries(snapshot).length}`);
	for (const { kind, id } of feedbackEntries(snapshot)) console.log(`${kind}\t${id}`);
}

async function show(options) {
	const path = resolve(options.snapshot);
	const raw = await readTextFileBounded(path, FEEDBACK_SNAPSHOT_MAX_BYTES);
	console.log(JSON.stringify(showFeedbackItem(parseFeedbackSnapshotText(raw), options.id)));
}

async function checks(options) {
	const cwd = process.cwd();
	const signal = new AbortController().signal;
	const pullRequest = await current(cwd, signal, options.pr);
	const expectedHead = options.expectedHead.toLowerCase();
	await requireCleanHead(cwd, signal, pullRequest, expectedHead);
	console.log(`pr=${pullRequest.url.href}`);
	console.log(`head=${expectedHead}`);
	console.log(`ci=${pullRequest.conditions.ci} review=${pullRequest.conditions.review} policy=${pullRequest.conditions.policy}`);
}

async function selfTest() {
	assert.throws(() => parse("push", []), /unknown command/);
	assert.throws(() => parse("resolve", []), /unknown command/);
	assert.throws(() => parse("fetch", ["--json", "--out", "file"]), /exactly one/);
	assert.deepEqual(parse("show", ["--snapshot", "state.json", "--id", "C1"]), { snapshot: "state.json", id: "C1" });

	const directory = await mkdtemp(join(tmpdir(), "pi-pr-feedback-self-test-"));
	try {
		const destination = join(directory, "snapshot.json");
		await writeFile(destination, "old\n", { mode: 0o644 });
		if (process.platform !== "win32") await chmod(directory, 0o755);
		const parentMode = (await stat(directory)).mode & 0o777;
		await writeSnapshotAtomically(destination, "new\n", new AbortController().signal);
		assert.equal(await readFile(destination, "utf8"), "new\n");
		assert.deepEqual(await readdir(directory), ["snapshot.json"]);
		if (process.platform !== "win32") {
			assert.equal((await stat(destination)).mode & 0o777, 0o600);
			assert.equal((await stat(directory)).mode & 0o777, parentMode);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	console.log("pr-feedback self-test ok");
}

async function main(argv) {
	if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
		console.log(usage());
		return;
	}
	const [command, ...args] = argv;
	if (command === "self-test") {
		if (args.length) throw new UsageError("self-test takes no arguments");
		await selfTest();
		return;
	}
	const options = parse(command, args);
	if (command === "fetch") await fetchFeedback(options);
	else if (command === "show") await show(options);
	else await checks(options);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	if (error instanceof UsageError) console.error(usage());
	process.exitCode = error instanceof UsageError ? 2 : 1;
}
