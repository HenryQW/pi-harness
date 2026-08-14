import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isBtwPayload, type BtwPayload } from "./core.ts";
import {
	ackMatchesRequest,
	isMergeAck,
	isMergeRequest,
	MERGE_ACK_FILE,
	MERGE_REQUEST_FILE,
	type MergeAck,
	type MergeRequest,
} from "./merge.ts";

const PAYLOAD_FILE = "payload.json";
const LAUNCH_PREFIX = "launch-";
const MAX_MAILBOX_FILE_BYTES = 128 * 1024;
const MAX_PAYLOAD_FILE_BYTES = 64 * 1024 * 1024;

export const DEFAULT_STALE_CONTEXT_MS = 24 * 60 * 60 * 1000;

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
	const expectedUid = currentUid();
	if (expectedUid !== undefined && uid !== expectedUid) {
		throw new Error(`Refusing /btw context path not owned by the current user: ${path}`);
	}
}

function assertPrivateMode(mode: number, path: string): void {
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new Error(`Refusing /btw context path with group or other permissions: ${path}`);
	}
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function defaultContextRoot(): string {
	const uid = currentUid();
	return join(tmpdir(), uid === undefined ? "pi-herdr-btw" : `pi-herdr-btw-${uid}`);
}

export class ContextStore {
	readonly root: string;
	private canonicalRoot: string | undefined;

	constructor(root = defaultContextRoot()) {
		this.root = resolve(root);
	}

	async create(payload: BtwPayload): Promise<string> {
		const root = await this.ensureRoot();
		const launchDir = await mkdtemp(join(root, LAUNCH_PREFIX));
		try {
			await chmod(launchDir, 0o700);

			const payloadPath = join(launchDir, PAYLOAD_FILE);
			await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(payloadPath, 0o600);
			return payloadPath;
		} catch (error) {
			await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async read(payloadPath: string): Promise<BtwPayload> {
		const canonicalPath = await this.validateLaunchFile(payloadPath, PAYLOAD_FILE);
		if (!canonicalPath) throw new Error(`Missing /btw context payload: ${payloadPath}`);
		const parsed: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
		if (!isBtwPayload(parsed)) {
			throw new Error("Invalid or unsupported /btw context payload");
		}
		return parsed;
	}

	/** List payload paths for every launch directory currently in the private root. */
	async listLaunchPayloadPaths(): Promise<string[]> {
		const root = await this.ensureRoot();
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(LAUNCH_PREFIX))
			.map((entry) => join(root, entry.name, PAYLOAD_FILE));
	}

	async writeMergeRequest(payloadPath: string, request: MergeRequest): Promise<void> {
		if (!isMergeRequest(request)) throw new Error("Invalid /btw merge request");
		await this.writeLaunchFile(payloadPath, MERGE_REQUEST_FILE, request);
	}

	async readMergeRequest(payloadPath: string): Promise<unknown> {
		return this.readLaunchFile(payloadPath, MERGE_REQUEST_FILE);
	}

	async writeMergeAck(payloadPath: string, ack: MergeAck): Promise<void> {
		if (!isMergeAck(ack)) throw new Error("Invalid /btw merge acknowledgement");
		await this.writeLaunchFile(payloadPath, MERGE_ACK_FILE, ack);
	}

	async readMergeAck(payloadPath: string): Promise<unknown> {
		return this.readLaunchFile(payloadPath, MERGE_ACK_FILE);
	}

	/**
	 * Acknowledgement-aware cleanup: remove the launch directory unless it
	 * still holds an unacknowledged merge request. Stale-TTL cleanup remains
	 * the backstop for crashed parents.
	 */
	async removeIfNoPendingMerge(payloadPath: string): Promise<boolean> {
		const request = await this.readMergeRequest(payloadPath).catch(() => undefined);
		if (request !== undefined) {
			const ack = await this.readMergeAck(payloadPath).catch(() => undefined);
			// A stale ack from an earlier merge must not allow deleting a newer,
			// still-undelivered request.
			if (!ackMatchesRequest(ack, request)) return false;
		}
		await this.remove(payloadPath);
		return true;
	}

	async remove(payloadPath: string): Promise<void> {
		const launchDir = await this.validateLaunchDir(payloadPath, true);
		if (launchDir) await rm(launchDir, { recursive: true, force: true });
	}

	async removeStale(
		maxAgeMs = DEFAULT_STALE_CONTEXT_MS,
		now = Date.now(),
	): Promise<void> {
		const root = await this.ensureRoot();
		const entries = await readdir(root, { withFileTypes: true });
		// One unsafe or foreign entry must not abort cleanup of the others.
		await Promise.allSettled(
			entries.map(async (entry) => {
				if (!entry.name.startsWith(LAUNCH_PREFIX) || !entry.isDirectory()) return;
				const launchDir = join(root, entry.name);
				const info = await lstat(launchDir).catch(() => undefined);
				if (!info?.isDirectory() || info.isSymbolicLink()) return;
				assertOwnedByCurrentUser(info.uid, launchDir);
				if (info.mtimeMs < now - maxAgeMs) {
					await rm(launchDir, { recursive: true, force: true });
				}
			}),
		);
	}

	private async ensureRoot(): Promise<string> {
		if (this.canonicalRoot) return this.canonicalRoot;

		try {
			await mkdir(this.root, { mode: 0o700 });
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}

		const info = await lstat(this.root);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw context root: ${this.root}`);
		}
		assertOwnedByCurrentUser(info.uid, this.root);
		await chmod(this.root, 0o700);
		const canonicalRoot = await realpath(this.root);
		const canonicalInfo = await lstat(canonicalRoot);
		assertOwnedByCurrentUser(canonicalInfo.uid, canonicalRoot);
		assertPrivateMode(canonicalInfo.mode, canonicalRoot);
		this.canonicalRoot = canonicalRoot;
		return canonicalRoot;
	}

	private async writeLaunchFile(payloadPath: string, fileName: string, data: unknown): Promise<void> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error(`Missing /btw launch directory: ${payloadPath}`);
		const targetPath = join(launchDir, fileName);
		const temporaryPath = join(launchDir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
		try {
			await writeFile(temporaryPath, `${JSON.stringify(data)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, targetPath);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async readLaunchFile(payloadPath: string, fileName: string): Promise<unknown> {
		const canonicalPath = await this.validateLaunchFile(payloadPath, fileName);
		if (!canonicalPath) return undefined;
		return JSON.parse(await readFile(canonicalPath, "utf8")) as unknown;
	}

	private async validateLaunchFile(
		payloadPath: string,
		fileName: string,
	): Promise<string | undefined> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error(`Missing /btw context payload: ${payloadPath}`);

		const candidate = join(launchDir, fileName);
		let info;
		try {
			info = await lstat(candidate);
		} catch (error) {
			if (fileName !== PAYLOAD_FILE && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw context payload: ${candidate}`);
		}
		assertOwnedByCurrentUser(info.uid, candidate);
		assertPrivateMode(info.mode, candidate);
		const maxBytes = fileName === PAYLOAD_FILE ? MAX_PAYLOAD_FILE_BYTES : MAX_MAILBOX_FILE_BYTES;
		if (info.size > maxBytes) {
			throw new Error(`Refusing oversized /btw mailbox file: ${candidate}`);
		}

		const canonicalPath = await realpath(candidate);
		const root = await this.ensureRoot();
		if (!isInside(root, canonicalPath)) {
			throw new Error(`Refusing /btw context payload outside the private root: ${payloadPath}`);
		}
		return canonicalPath;
	}

	private async validateLaunchDir(
		payloadPath: string,
		allowMissing: boolean,
	): Promise<string | undefined> {
		const root = await this.ensureRoot();
		const absolutePayload = resolve(payloadPath);
		const launchDir = dirname(absolutePayload);
		if (basename(absolutePayload) !== PAYLOAD_FILE || !basename(launchDir).startsWith(LAUNCH_PREFIX)) {
			throw new Error(`Refusing invalid /btw context payload path: ${payloadPath}`);
		}
		if (!isInside(root, launchDir)) {
			throw new Error(`Refusing /btw context payload outside the private root: ${payloadPath}`);
		}

		let info;
		try {
			info = await lstat(launchDir);
		} catch (error) {
			if (allowMissing && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw launch directory: ${launchDir}`);
		}
		assertOwnedByCurrentUser(info.uid, launchDir);
		assertPrivateMode(info.mode, launchDir);

		const canonicalLaunchDir = await realpath(launchDir);
		if (!isInside(root, canonicalLaunchDir)) {
			throw new Error(`Refusing /btw launch directory outside the private root: ${launchDir}`);
		}
		return canonicalLaunchDir;
	}
}
