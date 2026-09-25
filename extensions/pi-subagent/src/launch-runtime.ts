import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { EXECUTION_BUDGET_FLAG, resolveConfiguredRoleLaunch } from "./index.ts";
import type { EphemeralSubagentExecutionBudget } from "./ephemeral.ts";
import { registerModelTask } from "@henryqw/pi-task-models";
import type {
	CoordinatorRuntime,
	OperationContext,
	TransientLaunchHandle,
	VerifiedLaunch,
} from "./runner.ts";
import {
	type ExecuteRequest,
	type ModelClass,
	type WorkspaceIdentity,
} from "./schema.ts";

const PROMPT_FLAG = "--append-system-prompt";
const DIRECTORY_MODE = 0o700;
const PROMPT_MODE = 0o600;

export const ISOLATED_MODEL_TASK = {
	id: "pi-subagent/isolatedRoleLaunch",
	label: "Isolated Role launch",
	purpose: "Resolve one task-scoped isolated Role launch.",
	defaultProfile: "balanced",
} as const;

type LaunchPi = Pick<ExtensionAPI, "events" | "getCommands">;

type PreparedLaunch = {
	launch: VerifiedLaunch;
	prompt: string;
	promptArgIndex: number;
};

export interface LaunchRuntimeOptions {
	pi: LaunchPi;
	context(): ExtensionContext;
	resolveRoot(cwd: string, context: OperationContext): Promise<string>;
	preflightHost?(input: { request: ExecuteRequest; cwd: string; root: string }, context: OperationContext): Promise<void>;
	inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity>;
	executionBudget?: () => Omit<EphemeralSubagentExecutionBudget, "startedAt">;
	now?: () => number;
	randomToken?: () => string;
}

function abortIfNeeded(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function removeTransientLaunch(
	directory: string,
	promptPath: string,
	promptRequired: boolean,
): Promise<void> {
	const failures: unknown[] = [];
	try {
		await unlink(promptPath);
	} catch (error) {
		if (promptRequired || !isMissing(error)) {
			failures.push(new Error(`Could not remove transient Role prompt ${promptPath}.`, { cause: error }));
		}
	}
	try {
		await rmdir(directory);
	} catch (error) {
		failures.push(new Error(`Could not remove transient Role launch directory ${directory}.`, { cause: error }));
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Transient Role launch cleanup was incomplete.");
}

export async function materializeTransientLaunch<Launch extends { readonly args: readonly string[]; readonly role: string }>(
	prepared: { launch: Launch; prompt: string; promptArgIndex: number },
	signal?: AbortSignal,
): Promise<{ readonly launch: Launch; cleanup(): Promise<void> }> {
	abortIfNeeded(signal);
	const promptBytes = Buffer.from(prepared.prompt, "utf8");
	const created = await mkdtemp(join(tmpdir(), "pi-subagent-role-"));
	let directory = normalize(created);
	let promptPath = join(directory, "system-prompt");
	let promptCreated = false;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		directory = normalize(await realpath(created));
		promptPath = join(directory, "system-prompt");
		await chmod(directory, DIRECTORY_MODE);
		const directoryInfo = await lstat(directory);
		if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()
			|| (directoryInfo.mode & 0o7777) !== DIRECTORY_MODE
			|| !isWithin(normalize(await realpath(tmpdir())), directory)) {
			throw new Error("Transient Role launch directory is not unique canonical mode 0700 OS-temp storage.");
		}
		file = await open(
			promptPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			PROMPT_MODE,
		);
		promptCreated = true;
		await file.chmod(PROMPT_MODE);
		abortIfNeeded(signal);
		await file.writeFile(promptBytes, { signal });
		await file.sync();
		await file.close();
		file = undefined;
		const promptInfo = await lstat(promptPath);
		if (promptInfo.isSymbolicLink() || !promptInfo.isFile()
			|| (promptInfo.mode & 0o7777) !== PROMPT_MODE
			|| normalize(await realpath(promptPath)) !== promptPath) {
			throw new Error("Transient Role prompt is not a canonical mode 0600 regular file.");
		}
		const args = [...prepared.launch.args];
		args.splice(prepared.promptArgIndex, 0, PROMPT_FLAG, promptPath);
		const launch = Object.freeze({
			...prepared.launch,
			args: Object.freeze(args),
		}) as Launch;
		let cleanup: Promise<void> | undefined;
		return Object.freeze({
			launch,
			cleanup: async () => await (cleanup ??= removeTransientLaunch(directory, promptPath, true)),
		});
	} catch (error) {
		const failures: unknown[] = [error];
		if (file) {
			try {
				await file.close();
			} catch (closeError) {
				failures.push(closeError);
			}
		}
		try {
			await removeTransientLaunch(directory, promptPath, promptCreated);
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, `Transient Role prompt materialization for ${prepared.launch.role} failed and cleanup was incomplete.`);
		}
		throw error;
	}
}

export class RoleLaunchRuntime implements CoordinatorRuntime {
	private readonly options: LaunchRuntimeOptions;

	constructor(options: LaunchRuntimeOptions) {
		this.options = options;
		registerModelTask(options.pi, ISOLATED_MODEL_TASK);
	}

	now(): number {
		return this.options.now?.() ?? Date.now();
	}

	randomToken(): string {
		return this.options.randomToken?.() ?? randomBytes(12).toString("hex");
	}

	private async prepareLaunch(
		role: string,
		modelClass: ModelClass,
		context: OperationContext,
	): Promise<PreparedLaunch> {
		abortIfNeeded(context.signal);
		const input = { role, modelClass, task: ISOLATED_MODEL_TASK };
		const prepared = await resolveConfiguredRoleLaunch(this.options.pi, this.options.context(), input);
		if (prepared.missingSkills.length) {
			throw new Error(`Role ${role} requires missing Skills: ${prepared.missingSkills.join(", ")}.`);
		}
		const executionBudget = this.options.executionBudget?.();
		return Object.freeze({
			launch: Object.freeze({
				role: prepared.role,
				modelClass,
				model: `${prepared.model.provider}/${prepared.model.id}`,
				thinkingLevel: prepared.thinkingLevel,
				args: Object.freeze([
					...prepared.args,
					...(executionBudget === undefined ? [] : [
						`--${EXECUTION_BUDGET_FLAG}`,
						JSON.stringify({ ...executionBudget, startedAt: this.now() } satisfies EphemeralSubagentExecutionBudget),
					]),
				]),
				env: Object.freeze({ ...prepared.env }),
				tools: Object.freeze([...prepared.tools]),
			}),
			prompt: prepared.systemPrompt,
			promptArgIndex: prepared.promptArgIndex,
		});
	}

	async preflight(input: { request: ExecuteRequest; cwd: string }, context: OperationContext): Promise<{
		root: string;
		main: WorkspaceIdentity;
	}> {
		abortIfNeeded(context.signal);
		const resolvedRoot = await this.options.resolveRoot(input.cwd, context);
		if (typeof resolvedRoot !== "string" || !isAbsolute(resolvedRoot) || resolvedRoot.includes("\0")) {
			throw new Error("Pi Subagent root resolver must return an absolute canonical path.");
		}
		const root = await realpath(resolvedRoot);
		if (root !== resolvedRoot) throw new Error("Pi Subagent root resolver returned a non-canonical path.");
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory()) throw new Error("Pi Subagent root must be an existing local directory.");
		abortIfNeeded(context.signal);
		if (input.request.tasks.some((task) => task.kind === "changeset")) {
			await this.options.preflightHost?.({ request: input.request, cwd: input.cwd, root }, context);
		}
		const main = await this.options.inspectMain({ root }, context);
		const required = new Map<string, Set<ModelClass>>();
		const addRequired = (role: string, modelClass: ModelClass): void => {
			const modelClasses = required.get(role) ?? new Set<ModelClass>();
			modelClasses.add(modelClass);
			required.set(role, modelClasses);
		};
		for (const task of input.request.tasks) {
			addRequired(task.role, task.modelClass);
			if (task.kind === "changeset" && task.judgment) addRequired(task.judgment.role, task.judgment.modelClass);
		}
		if (input.request.finalJudgment) {
			addRequired(input.request.finalJudgment.role, input.request.finalJudgment.modelClass);
		}
		for (const [role, modelClasses] of required) {
			for (const modelClass of modelClasses) await this.prepareLaunch(role, modelClass, context);
		}
		return { root, main };
	}

	async acquireLaunch(
		role: string,
		modelClass: ModelClass,
		context: OperationContext,
	): Promise<TransientLaunchHandle<VerifiedLaunch>> {
		const prepared = await this.prepareLaunch(role, modelClass, context);
		return await materializeTransientLaunch(prepared, context.signal);
	}
}
