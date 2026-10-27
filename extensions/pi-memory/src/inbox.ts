import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { createConfigStore, field } from "@henryqw/pi-config-store";
import type { Target } from "./store.ts";

export type MemoryMutation = {
	action?: "add" | "replace" | "remove";
	target?: Target;
	content?: string;
	old_text?: string;
	operations?: { action?: string; content?: string; old_text?: string }[];
};

export type InboxItem = {
	id: string;
	group: string;
	directory: string;
	mutation: MemoryMutation;
};

const exec = promisify(execFile);

/** The session's starting directory, not a later shell working directory. */
export async function reviewGroup(cwd: string): Promise<string> {
	const directory = await realpath(cwd);
	try {
		const { stdout: localVariables } = await exec("git", ["rev-parse", "--local-env-vars"], { cwd: directory, encoding: "utf8" });
		const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
		for (const name of localVariables.trim().split("\n")) delete env[name];
		const { stdout } = await exec("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env });
		return `git:${await realpath(stdout.replace(/\r?\n$/, ""))}`;
	} catch (error) {
		const failure = error as { code?: number; stderr?: string };
		if (failure.code === 128 && failure.stderr?.startsWith("fatal: not a git repository")) return `cwd:${directory}`;
		throw new Error("Cannot identify the memory review group.", { cause: error });
	}
}

/** Reject the whole inbox on invalid data; never drop a candidate during parsing. */
export function reviewInboxStore(validate: (mutation: MemoryMutation) => unknown, agentDir?: string) {
	const store = createConfigStore({
		extensionId: "pi-memory",
		agentDir,
		fileName: "review-inbox.json",
		fields: {
			items: field((raw): InboxItem[] => {
				if (!Array.isArray(raw)) throw new Error("items must be an array");
				const ids = new Set<string>();
				for (const item of raw) {
					if (!item || typeof item !== "object" || Object.keys(item).sort().join() !== "directory,group,id,mutation"
						|| typeof item.id !== "string" || !item.id || ids.has(item.id)
						|| typeof item.group !== "string" || !/^(git|cwd):/.test(item.group) || !isAbsolute(item.group.slice(4))
						|| typeof item.directory !== "string" || !isAbsolute(item.directory)) throw new Error("Invalid inbox item");
					const mutation = item.mutation;
					if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)
						|| !Object.keys(mutation).every((key) => ["target", "action", "content", "old_text", "operations"].includes(key))
						|| (mutation.target !== "memory" && mutation.target !== "user")
						|| (mutation.operations !== undefined && (!Array.isArray(mutation.operations) || mutation.operations.some((operation: unknown) =>
							!operation || typeof operation !== "object" || Array.isArray(operation) || !Object.keys(operation).every((key) => ["action", "content", "old_text"].includes(key)))))) throw new Error("Invalid inbox mutation");
					validate(mutation);
					if (!(mutation.action === "add" || mutation.operations?.some((operation: { action?: string }) => operation.action === "add"))) throw new Error("Inbox mutations must contain an addition");
					ids.add(item.id);
				}
				return raw;
			}, [], { onInvalid: "disable" }),
		},
	});
	// Parser messages and unknown keys can contain candidate text. Do not expose them.
	return {
		extensionId: store.extensionId,
		path: store.path,
		loadSync() {
			const loaded = store.loadSync();
			return { ...loaded, issues: loaded.issues.map(({ kind }) => ({ kind, key: "", message: `Review inbox problem (${kind}); preserve the file before repair.` })) };
		},
		async update(mutator: (value: { items: InboxItem[] }) => { items: InboxItem[] }) {
			try { return await store.update(mutator); }
			catch {
				throw new Error(`Cannot update review inbox (${store.path}). Check its format, 65,536-byte limit, permissions, and free space. No inbox update was confirmed.`);
			}
		},
	};
}
