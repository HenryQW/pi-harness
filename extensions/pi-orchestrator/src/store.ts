import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { check, lock } from "proper-lockfile";
import { parseRunState, type RunState } from "./schema.ts";

const INITIAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
/*
 * create() caps the complete initial serialization at 2 MiB. Loaded requests
 * are independently bounded by parseExecuteRequest.
 *
 * Saves validate and reject atomically instead of dropping valid evidence.
 * Reads use the same finite ceiling and preserve rejected files.
 */
const STATE_MAX_BYTES = 128 * 1024 * 1024;
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: 0 } as const;
const LOCK_REACQUIRE_DELAY_MS = 25;

type ReleaseLock = Awaited<ReturnType<typeof lock>>;
const productiveRunLeaseBrand: unique symbol = Symbol("productiveRunLease");

export interface ProductiveRunLease {
	readonly [productiveRunLeaseBrand]: true;
}

export type LifecycleLockOptions =
	| { readonly purpose?: "productive"; readonly productiveRunLease?: ProductiveRunLease }
	| { readonly purpose: "status" | "abort"; readonly productiveRunLease?: never };

export interface LifecycleLock {
	readonly productiveRunLeaseActive: boolean;
	waitUnlocked<T>(operation: () => Promise<T>): Promise<T>;
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function isAlreadyPresent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isLocked(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED");
}

async function reacquire(path: string): Promise<ReleaseLock> {
	for (;;) {
		try {
			return await lock(path, { ...LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		} catch (error) {
			if (!isLocked(error)) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, LOCK_REACQUIRE_DELAY_MS));
		}
	}
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
	private readonly onStateSaved?: (state: RunState) => void;
	private readonly productiveRunLeases = new WeakMap<ProductiveRunLease, string>();

	constructor(agentDir?: string, onStateSaved?: (state: RunState) => void) {
		this.agentDir = agentDir;
		this.onStateSaved = onStateSaved;
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

	private productiveRunPath(root: string): string {
		return join(this.stateDirectory(root), "productive-run");
	}

	private async assertSafeDestination(root: string, destination: string): Promise<void> {
		if (isWithin(realpathSync.native(root), await canonicalPlannedPath(destination))) {
			throw new Error("Pi Orchestrator state directory must be outside the Git workspace.");
		}
	}

	async withProductiveRunLease<T>(
		root: string,
		operation: (lease: ProductiveRunLease) => Promise<T>,
	): Promise<T> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = this.productiveRunPath(root);
		let release: ReleaseLock;
		try {
			release = await lock(path, { ...LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		} catch (error) {
			if (isLocked(error)) {
				throw new Error("Another Pi Orchestrator productive request is active in this repository.");
			}
			throw error;
		}
		const lease: ProductiveRunLease = { [productiveRunLeaseBrand]: true };
		this.productiveRunLeases.set(lease, path);
		try {
			return await operation(lease);
		} finally {
			this.productiveRunLeases.delete(lease);
			await release();
		}
	}

	async hasProductiveRunLease(root: string): Promise<boolean> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		const path = this.productiveRunPath(root);
		return await check(path, { realpath: false, stale: LOCK_OPTIONS.stale, lockfilePath: `${path}.lock` });
	}

	async withLock<T>(
		root: string,
		operation: (lifecycle: LifecycleLock) => Promise<T>,
		options: LifecycleLockOptions = {},
	): Promise<T> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = this.lockPath(root);
		let release: ReleaseLock | undefined = await lock(path, { ...LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		try {
			const productiveRunLeaseActive = await this.hasProductiveRunLease(root);
			const ownedProductiveRunPath = options.productiveRunLease
				? this.productiveRunLeases.get(options.productiveRunLease)
				: undefined;
			if (productiveRunLeaseActive
				&& (options.purpose ?? "productive") === "productive"
				&& ownedProductiveRunPath !== this.productiveRunPath(root)) {
				throw new Error("Another Pi Orchestrator productive request is active in this repository.");
			}
			let waitingUnlocked = false;
			const lifecycle: LifecycleLock = {
				productiveRunLeaseActive,
				waitUnlocked: async <Value>(operation: () => Promise<Value>): Promise<Value> => {
					if (waitingUnlocked || !release) throw new Error("Lifecycle lock already has an unlocked waiter.");
					waitingUnlocked = true;
					await release();
					release = undefined;
					try {
						return await operation();
					} finally {
						release = await reacquire(path);
						waitingUnlocked = false;
					}
				},
			};
			return await operation(lifecycle);
		} finally {
			await release?.();
		}
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
		const saved = parseRunState(structuredClone(state));
		this.onStateSaved?.(structuredClone(saved));
		return this.handle(saved, path);
	}

	async load(root: string, id: string): Promise<RunStateHandle> {
		const path = this.statePath(root, id);
		let raw: string;
		try {
			raw = await readTextFileBounded(path, STATE_MAX_BYTES);
		} catch (error) {
			if (error instanceof Error && error.message === `Text file exceeds ${STATE_MAX_BYTES} bytes: ${path}`) {
				throw new Error(`pi-orchestrator state exceeds ${STATE_MAX_BYTES} bytes.`);
			}
			throw error;
		}
		const state = parseRunState(JSON.parse(raw));
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
			this.onStateSaved?.(parseRunState(JSON.parse(contents)));
		});
	}
}
