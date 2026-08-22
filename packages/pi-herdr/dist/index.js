import { lock } from "proper-lockfile";
export function createHerdrClient(execute) {
    const exec = async (args, options) => {
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
            throw new TypeError("Herdr command arguments must be an array of strings");
        }
        return await execute("herdr", args, options);
    };
    const run = async (args, options) => {
        const result = await exec(args, options);
        if (result.code !== 0 || result.killed)
            throw new Error(herdrCommandFailure(args, result));
        return result.stdout;
    };
    return {
        exec,
        run,
        async json(args, options) {
            const stdout = await run(args, options);
            try {
                const value = JSON.parse(stdout);
                if (!value || typeof value !== "object" || Array.isArray(value))
                    throw new Error();
                return value;
            }
            catch {
                throw new Error(`${herdrCommandName(args)} returned invalid JSON`);
            }
        },
    };
}
export function herdrCommandFailure(args, result) {
    const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "killed" : `exit ${result.code}`);
    return `${herdrCommandName(args)} failed: ${detail}`;
}
export function hasHerdrErrorCode(result, expected) {
    return [result.stdout, result.stderr].some((text) => {
        try {
            return containsErrorCode(JSON.parse(text), expected);
        }
        catch {
            return false;
        }
    });
}
/** Lock a Herdr worktree checkout path while mutating it via the Herdr CLI. */
export async function withWorktreeLock(checkout, operation) {
    const release = await lock(checkout);
    try {
        return await operation();
    }
    finally {
        await release();
    }
}
function herdrCommandName(args) {
    return ["herdr", ...args.slice(0, 2)].join(" ");
}
function containsErrorCode(value, expected) {
    if (!value || typeof value !== "object")
        return false;
    if (Array.isArray(value))
        return value.some((entry) => containsErrorCode(entry, expected));
    const record = value;
    const error = record.error;
    return Boolean(error && typeof error === "object" && !Array.isArray(error) && error.code === expected)
        || Object.values(record).some((entry) => containsErrorCode(entry, expected));
}
