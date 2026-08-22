export interface HerdrExecResult {
    code: number;
    stdout: string;
    stderr: string;
    killed?: boolean;
}
export type HerdrExecutor<Options> = (command: string, args: readonly string[], options: Options) => Promise<HerdrExecResult>;
export interface HerdrClient<Options> {
    exec(args: readonly string[], options: Options): Promise<HerdrExecResult>;
    run(args: readonly string[], options: Options): Promise<string>;
    json(args: readonly string[], options: Options): Promise<Record<string, unknown>>;
}
export declare function createHerdrClient<Options>(execute: HerdrExecutor<Options>): HerdrClient<Options>;
export declare function herdrCommandFailure(args: readonly string[], result: HerdrExecResult): string;
export declare function hasHerdrErrorCode(result: Pick<HerdrExecResult, "stdout" | "stderr">, expected: string): boolean;
/** Lock a Herdr worktree checkout path while mutating it via the Herdr CLI. */
export declare function withWorktreeLock<T>(checkout: string, operation: () => Promise<T>): Promise<T>;
