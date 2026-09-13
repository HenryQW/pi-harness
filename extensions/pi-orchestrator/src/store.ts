import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { lock } from "proper-lockfile";
import { parseRunState, type RunState } from "./schema.ts";

const INITIAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
/*
 * create() caps the complete initial serialization at 2 MiB. The immutable
 * request and launch records are checked against that same cap on load, so a
 * run cannot consume the space reserved below before productive work starts.
 *
 * The largest runtime-produced v1 state has 16 attempts (8 tasks * 2). Those
 * attempts can retain 2,112 check output streams (two task phases * 32 checks *
 * stdout/stderr, plus 32 final checks), 17 review verdicts, and 666 bounded
 * failure/resource strings. The last count allows, per attempt, 32 possible
 * resources, one allocation failure, two prompt failures, termination and
 * integration failures, and all four cleanup failures, plus 8 task and 2
 * top-level failures. bounded() retains 8 KiB; another 128 bytes covers its
 * marker and every fixed prefix. Sixfold worst-case JSON escaping therefore
 * keeps all 2,795 bounded strings below 134 MiB.
 *
 * Each attempt has at most 20 other mutable text slots for identity branches
 * and its worker ID. Runtime allocation can add at most five intents (the four
 * kinds plus one replacement after the sole generation retry); eight text slots
 * per intent cover its details, ID, worktree fields, and concrete resource
 * values. Thus 16 * 60 attempt slots, 8 wave branches, and 6 final-gate branches
 * total 974 schema strings. At 32,000 code units and six escaped bytes per code
 * unit, they occupy less than 179 MiB. Four extra copies of the 256 KiB request
 * cover every repeated task command/argv and review criterion, including both
 * attempts and the final gate.
 *
 * These bounds plus the initial state use less than 315 MiB. At maximum schema
 * cardinality there are 135,168 repeated argv elements; their deepest pretty
 * indentation adds less than 32 bytes each (4.2 MiB total). Fewer than 32,000
 * other runtime-added fields and elements need at most 256 bytes each for fixed
 * OIDs, hashes, tokens, keys, delimiters, and indentation (7.9 MiB). The 69 MiB
 * remainder therefore covers all structural overhead. Saves serialize and
 * reject atomically instead of dropping valid evidence. Reads use this same
 * finite ceiling and preserve rejected files.
 */
const STATE_MAX_BYTES = 384 * 1024 * 1024;
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: 0 } as const;

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function isAlreadyPresent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function canonicalPlannedPath(path: string): Promise<string> {
	let ancestor = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(ancestor), ...suffix.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

function serialize(state: RunState, maxBytes = STATE_MAX_BYTES): string {
	const validated = parseRunState(structuredClone(state));
	const contents = `${JSON.stringify(validated, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > maxBytes) {
		throw new Error(`pi-orchestrator state exceeds ${maxBytes} bytes.`);
	}
	return contents;
}

function assertPersistedBaseCapacity(state: RunState): void {
	const contents = JSON.stringify({
		version: state.version,
		request: state.request,
		root: state.root,
		requestStartMain: state.requestStartMain,
		deadlineStartedAt: state.deadlineStartedAt,
		deadline: state.deadline,
		launchRecords: state.launchRecords,
		createdAt: state.createdAt,
	}, null, 2);
	if (Buffer.byteLength(contents, "utf8") > INITIAL_STATE_MAX_BYTES) {
		throw new Error(`pi-orchestrator state exceeds ${INITIAL_STATE_MAX_BYTES} bytes.`);
	}
}

export class RunStateHandle {
	state: RunState;
	readonly path: string;
	private writes: Promise<void> = Promise.resolve();
	private readonly root: string;
	private readonly requestId: string;
	private readonly replace: (contents: string) => Promise<void>;

	constructor(state: RunState, path: string, replace: (contents: string) => Promise<void>) {
		this.state = state;
		this.path = path;
		this.root = state.root;
		this.requestId = state.request.id;
		this.replace = replace;
	}

	async save(): Promise<void> {
		if (this.state.root !== this.root || this.state.request.id !== this.requestId) {
			throw new Error("A state handle cannot change its owned repository or request ID.");
		}
		const contents = serialize(this.state);
		this.writes = this.writes.then(async () => await this.replace(contents));
		await this.writes;
	}
}

export class FileRunStore {
	private readonly agentDir?: string;

	constructor(agentDir?: string) {
		this.agentDir = agentDir;
	}

	stateDirectory(root: string): string {
		const canonicalRoot = realpathSync.native(root);
		const directory = join(
			extensionConfigDir("pi-orchestrator", this.agentDir),
			"state",
			createHash("sha256").update(canonicalRoot).digest("hex"),
		);
		if (isWithin(canonicalRoot, resolve(directory))) {
			throw new Error("Pi Orchestrator state directory must be outside the Git workspace.");
		}
		return directory;
	}

	statePath(root: string, id: string): string {
		return join(this.stateDirectory(root), `${id}.json`);
	}

	private lockPath(root: string): string {
		return join(this.stateDirectory(root), "lifecycle.lock");
	}

	private async assertSafeDestination(root: string, destination: string): Promise<void> {
		if (isWithin(realpathSync.native(root), await canonicalPlannedPath(destination))) {
			throw new Error("Pi Orchestrator state directory must be outside the Git workspace.");
		}
	}

	async withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = this.lockPath(root);
		const release = await lock(path, { ...LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	async assertAvailable(root: string, id: string): Promise<void> {
		const path = this.statePath(root, id);
		try {
			await lstat(path);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		throw new Error(`Pi Orchestrator request ${id} already exists.`);
	}

	async create(state: RunState): Promise<RunStateHandle> {
		const path = this.statePath(state.root, state.request.id);
		await this.assertSafeDestination(state.root, path);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const contents = serialize(state, INITIAL_STATE_MAX_BYTES);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(path, "wx", 0o600);
			await file.writeFile(contents, "utf8");
			await file.sync();
			await file.close();
			file = undefined;
		} catch (error) {
			await file?.close();
			if (isAlreadyPresent(error)) throw new Error(`Pi Orchestrator request ${state.request.id} already exists.`);
			throw error;
		}
		return this.handle(parseRunState(structuredClone(state)), path);
	}

	async load(root: string, id: string): Promise<RunStateHandle> {
		const path = this.statePath(root, id);
		let raw: string;
		try {
			if ((await lstat(path)).size > STATE_MAX_BYTES) {
				throw new Error(`Text file exceeds ${STATE_MAX_BYTES} bytes: ${path}`);
			}
			raw = await readTextFileBounded(path, STATE_MAX_BYTES);
		} catch (error) {
			if (error instanceof Error && error.message === `Text file exceeds ${STATE_MAX_BYTES} bytes: ${path}`) {
				throw new Error(`pi-orchestrator state exceeds ${STATE_MAX_BYTES} bytes.`);
			}
			throw error;
		}
		const state = parseRunState(JSON.parse(raw));
		assertPersistedBaseCapacity(state);
		if (state.root !== realpathSync.native(root) || state.request.id !== id) {
			throw new Error("pi-orchestrator state identity does not match its repository and filename.");
		}
		return this.handle(state, path);
	}

	async list(root: string): Promise<{ states: RunStateHandle[]; invalidIds: string[] }> {
		let entries;
		try {
			entries = await readdir(this.stateDirectory(root), { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return { states: [], invalidIds: [] };
			throw error;
		}
		const states: RunStateHandle[] = [];
		const invalidIds: string[] = [];
		for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
			const id = entry.name.slice(0, -5);
			try {
				states.push(await this.load(root, id));
			} catch {
				invalidIds.push(id);
			}
		}
		return { states, invalidIds };
	}

	private handle(state: RunState, path: string): RunStateHandle {
		return new RunStateHandle(state, path, async (contents) => {
			await this.assertSafeDestination(state.root, path);
			await writePrivateTextFileAtomically(path, contents);
		});
	}
}
