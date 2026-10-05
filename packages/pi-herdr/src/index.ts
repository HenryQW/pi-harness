import { lock } from "proper-lockfile";

export interface HerdrExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

/** Mutable-array executor, compatible with a bound `pi.exec`. Args are copied by createHerdrClient. */
export type HerdrExecutor<Options> = (
	command: string,
	args: string[],
	options: Options,
) => Promise<HerdrExecResult>;

export interface HerdrClient<Options> {
	exec(args: readonly string[], options: Options): Promise<HerdrExecResult>;
	run(args: readonly string[], options: Options): Promise<string>;
	json(args: readonly string[], options: Options): Promise<Record<string, unknown>>;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const MAX_AGENT_START_ATTEMPTS = 5;
const AGENT_START_RETRY_DELAY_MS = 250;
const SHELL_PROMPT_TIMEOUT_MS = 20_000;
const SHELL_PROMPT_POLL_MS = 100;
const PANE_READ_LINES = "40";

/**
 * Whether `pane process-info` shows the pane shell still owning the foreground process group. Startup
 * file children share the shell's group, while a job started from the prompt (such as a Pi agent)
 * runs in its own group.
 */
function shellOwnsForeground(stdout: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("herdr pane process-info returned invalid JSON");
	}
	const info = (parsed as { result?: { process_info?: Record<string, unknown> } }).result?.process_info;
	if (!info || typeof info.shell_pid !== "number") throw new Error("herdr pane process-info returned malformed output");
	return info.foreground_process_group_id === info.shell_pid;
}

/** Whether the screen shows the probe token as its own output line with a prompt drawn after it. */
function shellPromptFollows(screen: string, token: string): boolean {
	const lines = screen.split("\n");
	const index = lines.findIndex((line) => line.trim() === token);
	return index >= 0 && lines.slice(index + 1).some((line) => line.trim());
}

/**
 * Prove the pane shell is reading input before `agent start` types a long command. A shell still
 * running its startup files or a prompt hook leaves the tty in canonical mode, where macOS caps one
 * pending input line at 1024 bytes and silently drops the Enter of a longer launch command. The
 * prompt is drawn only when the shell is about to read, so the probe waits for the token output and
 * a non-blank line after it. An occupied pane is left untouched so `agent start` reports
 * `agent_pane_busy` itself. Returns the failed Herdr result, or undefined when ready.
 */
async function awaitShellPrompt<Options>(
	client: Pick<HerdrClient<Options>, "exec">,
	pane: string,
	options: Options,
	wait: (milliseconds: number) => Promise<void>,
): Promise<HerdrExecResult | undefined> {
	const info = await client.exec(["pane", "process-info", "--pane", pane], options);
	if (info.code !== 0 || info.killed) return info;
	if (!shellOwnsForeground(info.stdout)) return undefined;
	const token = `pi-herdr-ready-${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`;
	const ran = await client.exec(["pane", "run", pane, `echo ${token}`], options);
	if (ran.code !== 0 || ran.killed) return ran;
	const deadline = Date.now() + SHELL_PROMPT_TIMEOUT_MS;
	for (;;) {
		const read = await client.exec(
			["pane", "read", pane, "--source", "recent-unwrapped", "--lines", PANE_READ_LINES, "--format", "text"],
			options,
		);
		if (read.code !== 0 || read.killed) return read;
		if (shellPromptFollows(read.stdout, token)) return undefined;
		if (Date.now() >= deadline) {
			return { code: 1, stdout: "", stderr: `pane ${pane} did not draw a shell prompt within ${SHELL_PROMPT_TIMEOUT_MS}ms after the readiness probe` };
		}
		await wait(SHELL_PROMPT_POLL_MS);
	}
}

export interface StartPiAgentOptions<Options> {
	name: string;
	pane: string;
	args: readonly string[];
	options: Options;
	delay?: (milliseconds: number) => Promise<void>;
	onPaneBusy?: () => Promise<string>;
	shouldRetry?: (result: HerdrExecResult) => boolean;
}

/** Start a Pi agent in a Herdr pane once its shell is reading input, retrying only transient pane contention. */
export async function startPiAgent<Options>(
	client: Pick<HerdrClient<Options>, "exec">,
	input: StartPiAgentOptions<Options>,
): Promise<HerdrExecResult> {
	const name = nonEmptyString(input.name, "Herdr Pi agent name");
	let pane = nonEmptyString(input.pane, "Herdr Pi agent pane");
	if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
		throw new TypeError("Herdr Pi agent arguments must be an array of strings");
	}
	const piArgs = [...input.args];
	let onPaneBusy = input.onPaneBusy;
	let result: HerdrExecResult | undefined;
	for (let attempt = 1; attempt <= MAX_AGENT_START_ATTEMPTS; attempt += 1) {
		result = await awaitShellPrompt(client, pane, input.options, input.delay ?? delay)
			?? await client.exec(["agent", "start", name, "--kind", "pi", "--pane", pane, "--", ...piArgs], input.options);
		if (result.code === 0 && !result.killed) return result;
		if (
			!hasHerdrErrorCode(result, "agent_pane_busy")
			|| attempt === MAX_AGENT_START_ATTEMPTS
			|| input.shouldRetry?.(result) === false
		) return result;
		if (onPaneBusy) {
			pane = nonEmptyString(await onPaneBusy(), "Herdr Pi agent pane returned by onPaneBusy");
			onPaneBusy = undefined;
		} else {
			await (input.delay ?? delay)(AGENT_START_RETRY_DELAY_MS);
		}
		if (input.shouldRetry?.(result) === false) return result;
	}
	return result!;
}

export function createHerdrClient<Options>(execute: HerdrExecutor<Options>): HerdrClient<Options> {
	const exec = async (args: readonly string[], options: Options): Promise<HerdrExecResult> => {
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			throw new TypeError("Herdr command arguments must be an array of strings");
		}
		return await execute("herdr", [...args], options);
	};
	const run = async (args: readonly string[], options: Options): Promise<string> => {
		const result = await exec(args, options);
		if (result.code !== 0 || result.killed) throw new Error(herdrCommandFailure(args, result));
		return result.stdout;
	};
	return {
		exec,
		run,
		async json(args, options) {
			const stdout = await run(args, options);
			try {
				const value: unknown = JSON.parse(stdout);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
				return value as Record<string, unknown>;
			} catch {
				throw new Error(`${herdrCommandName(args)} returned invalid JSON`);
			}
		},
	};
}

export function herdrCommandFailure(args: readonly string[], result: HerdrExecResult): string {
	const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "killed" : `exit ${result.code}`);
	return `${herdrCommandName(args)} failed: ${detail}`;
}

export function hasHerdrErrorCode(result: Pick<HerdrExecResult, "stdout" | "stderr">, expected: string): boolean {
	return [result.stdout, result.stderr].some((text) => {
		try {
			return containsErrorCode(JSON.parse(text), expected);
		} catch {
			return false;
		}
	});
}

/** Lock a Herdr worktree checkout path while mutating it via the Herdr CLI. */
export async function withWorktreeLock<T>(checkout: string, operation: () => Promise<T>): Promise<T> {
	const release = await lock(checkout);
	try {
		return await operation();
	} finally {
		await release();
	}
}

function herdrCommandName(args: readonly string[]): string {
	return ["herdr", ...args.slice(0, 2)].join(" ");
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function containsErrorCode(value: unknown, expected: string): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((entry) => containsErrorCode(entry, expected));
	const record = value as Record<string, unknown>;
	const error = record.error;
	return Boolean(error && typeof error === "object" && !Array.isArray(error) && (error as Record<string, unknown>).code === expected)
		|| Object.values(record).some((entry) => containsErrorCode(entry, expected));
}
