import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_JSON_EVENT_BYTES = 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PI_JSON_EVENTS = {
    agent_start: true,
    agent_end: true,
    agent_settled: true,
    turn_start: true,
    turn_end: true,
    message_start: true,
    message_update: true,
    message_end: true,
    tool_execution_start: true,
    tool_execution_update: true,
    tool_execution_end: true,
    queue_update: true,
    compaction_start: true,
    compaction_end: true,
    entry_appended: true,
    session_info_changed: true,
    thinking_level_changed: true,
    auto_retry_start: true,
    auto_retry_end: true,
    summarization_retry_scheduled: true,
    summarization_retry_attempt_start: true,
    summarization_retry_finished: true,
    bash_execution_update: true,
};
const CONSUMED_JSON_EVENTS = new Set(["message_start", "message_update", "message_end"]);
const JSON_EVENT_TYPE = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/;
export class EphemeralSubagentError extends Error {
    name = "EphemeralSubagentError";
    code;
    usage;
    constructor(code, message, cause, usage) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.usage = usage;
    }
}
function positiveDelay(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`${field} must be a positive number no greater than ${MAX_TIMER_DELAY_MS}.`);
    }
    return value;
}
function validateOptions(options) {
    if (!options || typeof options !== "object")
        throw new TypeError("Ephemeral Subagent executor options are required.");
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
        throw new RangeError("maxConcurrency must be a positive safe integer.");
    }
    if (!options.timeout || typeof options.timeout !== "object")
        throw new TypeError("timeout is required.");
    const timeout = {
        idleMs: positiveDelay(options.timeout.idleMs, "timeout.idleMs"),
        maxMs: positiveDelay(options.timeout.maxMs, "timeout.maxMs"),
    };
    if (timeout.maxMs <= timeout.idleMs)
        throw new RangeError("timeout.maxMs must be greater than timeout.idleMs.");
    return { maxConcurrency: options.maxConcurrency, timeout };
}
function abortError(signal, cause = signal?.reason, usage) {
    return new EphemeralSubagentError("aborted", "Subagent was aborted.", cause, usage);
}
function validateRunInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Ephemeral Subagent run input must be an object.");
    }
    const input = value;
    if (typeof input.prepare !== "function")
        throw new TypeError("run.prepare must be a function.");
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
        throw new TypeError("run.signal must be an AbortSignal.");
    }
    if (input.onUpdate !== undefined && typeof input.onUpdate !== "function") {
        throw new TypeError("run.onUpdate must be a function.");
    }
    if (input.onTokens !== undefined && typeof input.onTokens !== "function") {
        throw new TypeError("run.onTokens must be a function.");
    }
    return {
        signal: input.signal,
        prepare: input.prepare,
        onUpdate: input.onUpdate,
        onTokens: input.onTokens,
    };
}
function record(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(`${field} must be an object.`);
    return value;
}
function preparedText(value, field) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new TypeError(`${field} must be non-empty text without NUL bytes.`);
    }
    return value;
}
function validatePrepared(value) {
    const prepared = record(value, "Prepared Subagent output");
    const launch = record(prepared.launch, "Prepared Subagent launch");
    if (!Array.isArray(launch.args))
        throw new TypeError("Prepared Subagent launch args must be an array of strings.");
    const args = [];
    for (const [index, arg] of launch.args.entries()) {
        if (typeof arg !== "string" || arg.includes("\0")) {
            throw new TypeError(`Prepared Subagent launch arg ${index} must be a string without NUL bytes.`);
        }
        args.push(arg);
    }
    const launchEnv = record(launch.env, "Prepared Subagent launch env");
    const env = Object.create(null);
    for (const [name, value] of Object.entries(launchEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new TypeError(`Invalid prepared launch environment name: ${name}`);
        if (typeof value !== "string" || value.includes("\0")) {
            throw new TypeError(`Invalid prepared launch environment value: ${name}`);
        }
        env[name] = value;
    }
    return {
        launch: { args, env },
        task: preparedText(prepared.task, "Prepared Subagent task"),
        cwd: preparedText(prepared.cwd, "Prepared Subagent cwd"),
    };
}
/**
 * Creates a bounded ephemeral executor for callers already running inside Pi.
 * It reuses the active Pi process invocation; it does not resolve a standalone Pi installation.
 */
export function createEphemeralSubagentExecutor(options) {
    const validated = validateOptions(options);
    if (process.env.PI_CODING_AGENT !== "true" || (process.title !== "pi" && process.title !== "pi-rpc")) {
        const cause = new Error("Ephemeral Subagent executor requires active Pi (PI_CODING_AGENT=true and process title pi or pi-rpc).");
        throw new EphemeralSubagentError("prepare", cause.message, cause);
    }
    const invocation = piInvocation();
    let active = 0;
    const queue = [];
    const acquire = (signal) => {
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        if (active < validated.maxConcurrency) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const abort = () => {
                const index = queue.indexOf(grant);
                if (index < 0)
                    return;
                queue.splice(index, 1);
                signal?.removeEventListener("abort", abort);
                reject(abortError(signal));
            };
            const grant = () => {
                signal?.removeEventListener("abort", abort);
                resolve();
            };
            queue.push(grant);
            signal?.addEventListener("abort", abort, { once: true });
        });
    };
    const release = () => {
        const grant = queue.shift();
        if (grant)
            grant();
        else
            active -= 1;
    };
    return {
        async run(value) {
            const input = validateRunInput(value);
            await acquire(input.signal);
            try {
                if (input.signal?.aborted)
                    throw abortError(input.signal);
                let prepared;
                try {
                    prepared = validatePrepared(await input.prepare());
                }
                catch (cause) {
                    if (input.signal?.aborted)
                        throw abortError(input.signal, cause);
                    throw new EphemeralSubagentError("prepare", cause instanceof Error ? cause.message : String(cause), cause);
                }
                if (input.signal?.aborted)
                    throw abortError(input.signal);
                return await runPi(prepared, input, validated.timeout, invocation);
            }
            finally {
                release();
            }
        },
    };
}
function piInvocation() {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript] };
    }
    if (isBunVirtualScript)
        return { command: process.execPath, args: [] };
    const executable = basename(process.execPath).toLowerCase();
    if (!/^(node|bun)(\.exe)?$/.test(executable))
        return { command: process.execPath, args: [] };
    const cause = new Error("Ephemeral Subagent executor cannot reuse the active Pi process invocation.");
    throw new EphemeralSubagentError("prepare", cause.message, cause);
}
function assistantText(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
        return;
    const record = message;
    if (record.role !== "assistant" || !Array.isArray(record.content))
        return;
    const text = record.content
        .filter((part) => Boolean(part && typeof part === "object" && !Array.isArray(part)
        && part.type === "text"
        && typeof part.text === "string"))
        .map((part) => part.text)
        .join("\n");
    return text || undefined;
}
function utf8Prefix(text, maxBytes) {
    return new StringDecoder().write(Buffer.from(text).subarray(0, maxBytes));
}
function cappedPrefix(text, totalBytes) {
    if (totalBytes <= MAX_OUTPUT_BYTES)
        return text;
    const worstCaseMarker = `\n\n[Output truncated: ${totalBytes} bytes omitted]`;
    const prefix = utf8Prefix(text, MAX_OUTPUT_BYTES - Buffer.byteLength(worstCaseMarker, "utf8"));
    const omittedBytes = totalBytes - Buffer.byteLength(prefix, "utf8");
    return `${prefix}\n\n[Output truncated: ${omittedBytes} bytes omitted]`;
}
export function capEphemeralSubagentOutput(text) {
    return cappedPrefix(text, Buffer.byteLength(text, "utf8"));
}
function appendBounded(target, text) {
    target.totalBytes += Buffer.byteLength(text, "utf8");
    const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(target.prefix, "utf8");
    if (remaining > 0)
        target.prefix += utf8Prefix(text, remaining);
}
function boundedText(target) {
    return cappedPrefix(target.prefix, target.totalBytes);
}
function usageTokens(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return;
    const total = value.totalTokens;
    return typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.round(total) : undefined;
}
function nonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function usageFrom(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return;
    const record = value;
    if (![record.input, record.output, record.cacheRead, record.cacheWrite, record.totalTokens].every(nonNegativeNumber))
        return;
    if (!record.cost || typeof record.cost !== "object" || Array.isArray(record.cost))
        return;
    const cost = record.cost;
    if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(nonNegativeNumber))
        return;
    if (record.cacheWrite1h !== undefined && !nonNegativeNumber(record.cacheWrite1h))
        return;
    if (record.reasoning !== undefined && !nonNegativeNumber(record.reasoning))
        return;
    return {
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        ...(record.cacheWrite1h === undefined ? {} : { cacheWrite1h: record.cacheWrite1h }),
        ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
        totalTokens: record.totalTokens,
        cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead,
            cacheWrite: cost.cacheWrite,
            total: cost.total,
        },
    };
}
function sumOptional(left, right) {
    return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}
function addUsage(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    const cacheWrite1h = sumOptional(left.cacheWrite1h, right.cacheWrite1h);
    const reasoning = sumOptional(left.reasoning, right.reasoning);
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
        ...(reasoning === undefined ? {} : { reasoning }),
        totalTokens: left.totalTokens + right.totalTokens,
        cost: {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    };
}
function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor(seconds % 3_600 / 60);
    return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
async function runPi(prepared, input, timeoutPolicy, invocation) {
    if (input.signal?.aborted)
        throw abortError(input.signal);
    return await new Promise((resolve, reject) => {
        const args = [...invocation.args, "--mode", "json", "-p", ...prepared.launch.args, `Task: ${prepared.task}`];
        let child;
        try {
            child = spawn(invocation.command, args, {
                cwd: prepared.cwd,
                env: { ...process.env, ...prepared.launch.env },
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
            });
        }
        catch (cause) {
            reject(new EphemeralSubagentError("spawn", cause instanceof Error ? cause.message : String(cause), cause));
            return;
        }
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let lineParts = [];
        let lineBytes = 0;
        let linePrefix = "";
        let lineEventType;
        let ignoreLine = false;
        let output = "";
        const stderr = { prefix: "", totalBytes: 0 };
        const partial = { prefix: "", totalBytes: 0 };
        let hasPartialText = false;
        let stopReason;
        let errorMessage;
        let spawnError;
        let protocolError;
        let aborted = false;
        const startedAt = Date.now();
        const maxDeadline = startedAt + timeoutPolicy.maxMs;
        let lastEventAt = startedAt;
        let deadline = Math.min(startedAt + timeoutPolicy.idleMs, maxDeadline);
        let timedOutAfterMs;
        let timeoutReason;
        let childExited = false;
        let completedTokens = 0;
        let currentTokens = 0;
        let completedUsage;
        let currentUsage;
        const accumulatedUsage = () => addUsage(completedUsage, currentUsage);
        let deadlineTimer;
        let killTimer;
        let callbackFailure;
        const pendingCallbacks = new Set();
        let signalCallbackFailure;
        const callbackFailed = new Promise((resolve) => { signalCallbackFailure = resolve; });
        const failCallback = (name, cause) => {
            if (callbackFailure)
                return;
            callbackFailure = new EphemeralSubagentError("callback", `Subagent ${name} callback failed.`, cause);
            signalCallbackFailure();
            stop(true);
        };
        const invokeCallback = (name, callback, value) => {
            if (!callback || callbackFailure)
                return;
            let pending;
            try {
                pending = Promise.resolve(callback(value)).then(undefined, (cause) => { failCallback(name, cause); });
            }
            catch (cause) {
                failCallback(name, cause);
                return;
            }
            pendingCallbacks.add(pending);
            void pending.then(() => pendingCallbacks.delete(pending));
        };
        const scheduleDeadline = () => {
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            deadline = Math.min(lastEventAt + timeoutPolicy.idleMs, maxDeadline);
            const scheduledDeadline = deadline;
            deadlineTimer = setTimeout(() => timeout(scheduledDeadline - startedAt, scheduledDeadline === maxDeadline ? "maximum" : "idle"), Math.max(0, scheduledDeadline - Date.now()));
            deadlineTimer.unref();
        };
        const observeEvent = () => {
            if (callbackFailure || aborted || timedOutAfterMs !== undefined || childExited)
                return;
            const now = Date.now();
            if (now >= deadline) {
                timeout(deadline - startedAt, deadline === maxDeadline ? "maximum" : "idle");
                return;
            }
            lastEventAt = now;
            scheduleDeadline();
        };
        const processLine = (line) => {
            if (!line.trim())
                return;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                return;
            }
            if (!event || typeof event !== "object" || Array.isArray(event))
                return;
            const record = event;
            if (typeof record.type !== "string" || !Object.hasOwn(PI_JSON_EVENTS, record.type))
                return;
            observeEvent();
            if (record.type === "message_start") {
                partial.prefix = "";
                partial.totalBytes = 0;
                hasPartialText = false;
                currentUsage = undefined;
                return;
            }
            if (record.type === "message_update") {
                const tokens = usageTokens(record.usage);
                if (tokens !== undefined) {
                    currentTokens = tokens;
                    invokeCallback("onTokens", input.onTokens, completedTokens + currentTokens);
                }
                currentUsage = usageFrom(record.usage) ?? currentUsage;
                const update = record.assistantMessageEvent;
                if (update && typeof update === "object" && !Array.isArray(update)) {
                    const assistantEvent = update;
                    if (assistantEvent.type === "text_start" && hasPartialText)
                        appendBounded(partial, "\n");
                    if (assistantEvent.type === "text_start")
                        hasPartialText = true;
                    if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
                        hasPartialText = true;
                        appendBounded(partial, assistantEvent.delta);
                        output = boundedText(partial);
                        invokeCallback("onUpdate", input.onUpdate, output);
                    }
                }
                return;
            }
            if (record.type !== "message_end")
                return;
            const text = assistantText(record.message);
            if (text !== undefined) {
                output = capEphemeralSubagentOutput(text);
                invokeCallback("onUpdate", input.onUpdate, output);
            }
            if (record.message && typeof record.message === "object" && !Array.isArray(record.message)) {
                const message = record.message;
                if (message.role === "assistant") {
                    const finalUsage = usageFrom(message.usage) ?? currentUsage;
                    completedUsage = addUsage(completedUsage, finalUsage);
                    completedTokens += usageTokens(message.usage) ?? currentTokens;
                    currentTokens = 0;
                    currentUsage = undefined;
                    invokeCallback("onTokens", input.onTokens, completedTokens);
                }
                if (typeof message.stopReason === "string")
                    stopReason = message.stopReason;
                if (typeof message.errorMessage === "string")
                    errorMessage = message.errorMessage;
            }
        };
        async function killTree(force) {
            if (!child.pid)
                return;
            if (process.platform === "win32") {
                await new Promise((done) => {
                    const taskkill = spawn("taskkill", [...(force ? ["/F"] : []), "/T", "/PID", String(child.pid)], {
                        stdio: "ignore",
                        windowsHide: true,
                    });
                    taskkill.once("error", () => done());
                    taskkill.once("close", () => done());
                });
                return;
            }
            try {
                process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
            }
            catch {
                child.kill(force ? "SIGKILL" : "SIGTERM");
            }
        }
        child.stdout.on("data", (data) => {
            if (callbackFailure || protocolError)
                return;
            let offset = 0;
            while (offset < data.length) {
                const newline = data.indexOf("\n", offset);
                const end = newline === -1 ? data.length : newline;
                const part = data.slice(offset, end);
                if (!ignoreLine) {
                    linePrefix += part.slice(0, Math.max(0, 256 - linePrefix.length));
                    const eventType = JSON_EVENT_TYPE.exec(linePrefix)?.[1];
                    if (eventType && !lineEventType)
                        lineEventType = eventType;
                    lineBytes += Buffer.byteLength(part, "utf8");
                    if (lineBytes > MAX_JSON_EVENT_BYTES) {
                        if (lineEventType && !CONSUMED_JSON_EVENTS.has(lineEventType)) {
                            ignoreLine = true;
                            lineParts = [];
                            lineBytes = 0;
                        }
                        else {
                            protocolError = new Error(`Subagent JSON event exceeds ${MAX_JSON_EVENT_BYTES} bytes.`);
                            void killTree(true);
                            return;
                        }
                    }
                    else if (part)
                        lineParts.push(part);
                }
                if (newline === -1)
                    return;
                if (!ignoreLine)
                    processLine(lineParts.join(""));
                if (callbackFailure)
                    return;
                lineParts = [];
                lineBytes = 0;
                linePrefix = "";
                lineEventType = undefined;
                ignoreLine = false;
                offset = newline + 1;
            }
        });
        child.stderr.on("data", (data) => {
            appendBounded(stderr, data);
        });
        child.on("error", (error) => { spawnError = error; });
        function stop(force = false) {
            if (force) {
                void killTree(true);
                return;
            }
            void killTree(false);
            killTimer = setTimeout(() => void killTree(true), Math.min(5_000, Math.max(0, maxDeadline - Date.now())));
            killTimer.unref();
        }
        const abort = () => {
            if (timedOutAfterMs !== undefined || childExited)
                return;
            aborted = true;
            stop();
        };
        function timeout(afterMs, reason) {
            if (timedOutAfterMs !== undefined || childExited)
                return;
            if (reason === "maximum") {
                if (!aborted) {
                    timedOutAfterMs = afterMs;
                    timeoutReason = reason;
                }
                stop(true);
                return;
            }
            if (aborted)
                return;
            timedOutAfterMs = afterMs;
            timeoutReason = reason;
            stop();
        }
        scheduleDeadline();
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted)
            abort();
        // `close` waits for stdio EOF, which descendants can hold after Pi exits.
        // Kill the process group at Pi's exit boundary so `close` can settle.
        child.once("exit", () => {
            childExited = true;
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            input.signal?.removeEventListener("abort", abort);
            void killTree(true);
        });
        child.on("close", async (code) => {
            if (!callbackFailure && !protocolError && lineBytes)
                processLine(lineParts.join(""));
            await killTree(true);
            // A caller callback that never settles must not hold `run()` or its permit
            // past child exit; bound the drain by what remains of the maximum runtime.
            const drainTimer = setTimeout(signalCallbackFailure, Math.min(5_000, Math.max(0, maxDeadline - Date.now())));
            drainTimer.unref();
            await Promise.race([Promise.all(pendingCallbacks), callbackFailed]);
            clearTimeout(drainTimer);
            if (deadlineTimer)
                clearTimeout(deadlineTimer);
            if (killTimer)
                clearTimeout(killTimer);
            input.signal?.removeEventListener("abort", abort);
            if (callbackFailure) {
                reject(new EphemeralSubagentError("callback", callbackFailure.message, callbackFailure.cause, accumulatedUsage()));
            }
            else if (aborted)
                reject(abortError(input.signal, input.signal?.reason, accumulatedUsage()));
            else if (timedOutAfterMs !== undefined) {
                const message = timeoutReason === "maximum"
                    ? `Subagent reached its maximum runtime after ${formatDuration(timedOutAfterMs)}.`
                    : `Subagent timed out after ${formatDuration(timeoutPolicy.idleMs)} without a recognized Pi event.`;
                reject(new EphemeralSubagentError("timeout", message, new Error(message), accumulatedUsage()));
            }
            else if (protocolError) {
                reject(new EphemeralSubagentError("protocol", protocolError.message, protocolError, accumulatedUsage()));
            }
            else if (spawnError) {
                reject(new EphemeralSubagentError("spawn", spawnError.message, spawnError));
            }
            else {
                const exitCode = code ?? 1;
                const outcome = exitCode !== 0 || stopReason === "error" || stopReason === "aborted" ? "failure" : "success";
                resolve({
                    outcome,
                    exitCode,
                    output,
                    stderr: boundedText(stderr),
                    stopReason,
                    errorMessage,
                    usage: addUsage(completedUsage, currentUsage),
                });
            }
        });
    });
}
