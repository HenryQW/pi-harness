import type { Usage } from "@earendil-works/pi-ai";
import type { PiLaunch } from "./index.ts";
export interface EphemeralSubagentTimeout {
    idleMs: number;
    maxMs: number;
}
export interface EphemeralSubagentExecutorOptions {
    maxConcurrency: number;
    timeout: EphemeralSubagentTimeout;
}
export interface EphemeralSubagentRunInput {
    signal?: AbortSignal;
    onUpdate?: (text: string) => void;
    onTokens?: (tokens: number) => void;
    prepare: () => Promise<{
        launch: PiLaunch;
        task: string;
        cwd: string;
    }>;
}
interface EphemeralSubagentResultBase {
    exitCode: number;
    output: string;
    stderr: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: Usage;
}
export type EphemeralSubagentResult = (EphemeralSubagentResultBase & {
    outcome: "success";
}) | (EphemeralSubagentResultBase & {
    outcome: "failure";
});
export type EphemeralSubagentErrorCode = "aborted" | "timeout" | "spawn" | "protocol" | "prepare" | "callback";
export declare class EphemeralSubagentError extends Error {
    name: string;
    readonly code: EphemeralSubagentErrorCode;
    readonly usage?: Usage;
    constructor(code: EphemeralSubagentErrorCode, message: string, cause?: unknown, usage?: Usage);
}
export interface EphemeralSubagentExecutor {
    run(input: EphemeralSubagentRunInput): Promise<EphemeralSubagentResult>;
}
/**
 * Creates a bounded ephemeral executor for callers already running inside Pi.
 * It reuses the active Pi process invocation; it does not resolve a standalone Pi installation.
 */
export declare function createEphemeralSubagentExecutor(options: EphemeralSubagentExecutorOptions): EphemeralSubagentExecutor;
export declare function capEphemeralSubagentOutput(text: string): string;
export {};
