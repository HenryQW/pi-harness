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

export interface StartPiAgentOptions<Options> {
	name: string;
	pane: string;
	args: readonly string[];
	options: Options;
	delay?: (milliseconds: number) => Promise<void>;
	onPaneBusy?: () => Promise<string>;
	shouldRetry?: (result: HerdrExecResult) => boolean;
}

/** Start a Pi agent in a Herdr pane, retrying only transient pane contention. */
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
		const args = ["agent", "start", name, "--kind", "pi", "--pane", pane, "--", ...piArgs];
		result = await client.exec(args, input.options);
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
