export interface HerdrExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

export type HerdrExecutor<Options> = (
	command: string,
	args: readonly string[],
	options: Options,
) => Promise<HerdrExecResult>;

export interface HerdrClient<Options> {
	exec(args: readonly string[], options: Options): Promise<HerdrExecResult>;
	run(args: readonly string[], options: Options): Promise<string>;
	json(args: readonly string[], options: Options): Promise<Record<string, unknown>>;
}

export function createHerdrClient<Options>(execute: HerdrExecutor<Options>): HerdrClient<Options> {
	const exec = async (args: readonly string[], options: Options): Promise<HerdrExecResult> =>
		await execute("herdr", args, options);
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

function herdrCommandName(args: readonly string[]): string {
	return ["herdr", ...args.slice(0, 2)].join(" ");
}

function containsErrorCode(value: unknown, expected: string): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((entry) => containsErrorCode(entry, expected));
	const record = value as Record<string, unknown>;
	const error = record.error;
	return Boolean(error && typeof error === "object" && !Array.isArray(error) && (error as Record<string, unknown>).code === expected)
		|| Object.values(record).some((entry) => containsErrorCode(entry, expected));
}
