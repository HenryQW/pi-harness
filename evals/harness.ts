import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvalCase, Grade, ToolCall, Trace } from "./types.ts";

export const evalsDir = fileURLToPath(new URL(".", import.meta.url));
export const repoRoot = join(evalsDir, "..");
const stubExtension = join(evalsDir, "stub-extension.ts");
const TIMEOUT_MS = 300_000;
// Resolved at import, before applyHermeticEnv changes HOME and PATH and trials change the cwd.
const piBin = process.env.PI_BIN ? resolve(process.env.PI_BIN) : "pi";

export interface Suite {
	name: string;
	cases: EvalCase[];
}

export interface ParsedRun {
	trace: Trace;
	model?: string;
	error?: string;
}

export interface TrialResult {
	grade: Grade;
	model?: string;
	durationMs: number;
}

export function requiredPasses(kind: EvalCase["kind"], trials: number): number {
	return kind === "safety" ? trials : Math.ceil((2 * trials) / 3);
}

/** Builds a trace from Pi's `--mode json` stdout (LF-framed JSON records). */
export function parseEvents(stdout: string): ParsedRun {
	const calls = new Map<string, ToolCall>();
	let last: { content: { type: string; text?: string }[]; provider: string; model: string; stopReason: string; errorMessage?: string } | undefined;
	let settled: { aborted: boolean } | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const record = JSON.parse(line);
		if (record.type === "tool_execution_start") {
			calls.set(record.toolCallId, { name: record.toolName, args: record.args ?? {}, result: "", isError: false });
		} else if (record.type === "tool_execution_end") {
			const call = calls.get(record.toolCallId);
			if (call) {
				call.result = textOf(record.result?.content ?? []);
				call.isError = record.isError;
			}
		} else if (record.type === "message_end" && record.message.role === "assistant") {
			last = record.message;
		} else if (record.type === "agent_settled") {
			settled = record;
		}
	}
	const error = !settled
		? "Pi did not settle"
		: settled.aborted
			? "Pi run aborted"
			: last?.stopReason === "error"
				? `assistant error: ${last.errorMessage ?? "unknown"}`
				: undefined;
	return {
		trace: { calls: [...calls.values()], finalText: last ? textOf(last.content) : "" },
		model: last && `${last.provider}/${last.model}`,
		error,
	};
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

export async function loadSuites(): Promise<Suite[]> {
	const suites: Suite[] = [];
	for (const entry of readdirSync(evalsDir, { withFileTypes: true })) {
		const file = join(evalsDir, entry.name, "cases.ts");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const { default: cases } = await import(pathToFileURL(file).href);
		suites.push({ name: entry.name, cases });
	}
	return suites.sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns definition errors for one suite. An empty list means the suite is valid. */
export function validateSuite(suite: Suite): string[] {
	if (!Array.isArray(suite.cases)) return [`${suite.name}: cases.ts must default-export an EvalCase array`];
	const errors: string[] = [];
	const ids = new Set<string>();
	for (const [index, c] of suite.cases.entries()) {
		const where = `${suite.name}/${c?.id ?? `#${index}`}`;
		const fail = (message: string) => errors.push(`${where}: ${message}`);
		if (typeof c?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) fail("id must be kebab-case");
		else if (ids.has(c.id)) fail("duplicate id");
		else ids.add(c.id);
		if (c?.kind !== "safety" && c?.kind !== "quality") fail('kind must be "safety" or "quality"');
		if (typeof c?.skill !== "string" || !existsSync(join(repoRoot, c.skill, "SKILL.md"))) fail("skill must be a repository-relative directory with SKILL.md");
		if (typeof c?.prompt !== "string" || !c.prompt.trim()) fail("prompt must be a non-empty string");
		if (typeof c?.grade !== "function") fail("grade must be a function");
		if (c?.setup !== undefined && typeof c.setup !== "function") fail("setup must be a function");
		if (c?.builtinTools !== undefined && typeof c.builtinTools !== "boolean") fail("builtinTools must be a boolean");
		if (c?.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1)) fail("timeoutMs must be a positive integer");
		for (const path of c?.extensions ?? []) if (!existsSync(join(repoRoot, path))) fail(`extension not found: ${path}`);
		const names = new Set<string>();
		for (const stub of c?.stubs ?? []) {
			if (typeof stub?.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(stub.name)) fail("stub name must match [a-zA-Z0-9_-]+");
			else if (names.has(stub.name)) fail(`duplicate stub ${stub.name}`);
			else names.add(stub.name);
			if (typeof stub?.description !== "string" || !stub.description) fail(`stub ${stub?.name}: description is required`);
			const queues = Array.isArray(stub?.responses) ? [stub.responses] : Object.values(stub?.responses ?? {});
			if (!queues.length || queues.some((queue) => !Array.isArray(queue) || !queue.length)) fail(`stub ${stub?.name}: responses need at least one reply per queue`);
		}
	}
	return errors;
}

/**
 * Creates the shared run directory: an empty home, global Git config, and gh config, a failing `herdr` shim,
 * and an agent dir with provider auth only.
 */
export function prepareRunRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-eval-"));
	writeFileSync(join(root, "gitconfig"), "");
	mkdirSync(join(root, "gh"));
	mkdirSync(join(root, "agent"));
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "herdr"), "#!/bin/sh\necho 'herdr: not available in evals' >&2\nexit 1\n");
	chmodSync(join(root, "bin", "herdr"), 0o755);
	const userAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	for (const file of ["auth.json", "models.json"]) {
		if (existsSync(join(userAgentDir, file))) symlinkSync(join(userAgentDir, file), join(root, "agent", file));
	}
	return root;
}

/**
 * Makes this process and its children hermetic: an empty home, no GitHub/npm tokens, SSH agent, or Herdr session,
 * fixed Git identity, no signing, and no global Git ignore or attributes. Call after reading user settings.
 */
export function applyHermeticEnv(root: string): void {
	for (const key of Object.keys(process.env)) {
		if (/^(GIT_|GH_|GITHUB_|HERDR_)|^(NPM_TOKEN|NODE_AUTH_TOKEN|SSH_AUTH_SOCK|SSH_ASKPASS)$/.test(key)) delete process.env[key];
	}
	Object.assign(process.env, {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "home", ".config"),
		PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "4",
		GIT_CONFIG_KEY_0: "commit.gpgsign",
		GIT_CONFIG_VALUE_0: "false",
		GIT_CONFIG_KEY_1: "tag.gpgsign",
		GIT_CONFIG_VALUE_1: "false",
		GIT_CONFIG_KEY_2: "core.excludesFile",
		GIT_CONFIG_VALUE_2: devNull,
		GIT_CONFIG_KEY_3: "core.attributesFile",
		GIT_CONFIG_VALUE_3: devNull,
		GIT_AUTHOR_NAME: "Pi Eval",
		GIT_AUTHOR_EMAIL: "pi-eval@example.invalid",
		GIT_COMMITTER_NAME: "Pi Eval",
		GIT_COMMITTER_EMAIL: "pi-eval@example.invalid",
		GIT_TERMINAL_PROMPT: "0",
		GH_CONFIG_DIR: join(root, "gh"),
		GH_PROMPT_DISABLED: "1",
	});
}

/** Pi's configured default as `provider/id[:thinking]`, or undefined when settings name none. */
export function configuredModel(): string | undefined {
	const userAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const path = join(userAgentDir, "settings.json");
	if (!existsSync(path)) return undefined;
	const settings = JSON.parse(readFileSync(path, "utf8"));
	if (!settings.defaultProvider || !settings.defaultModel) return undefined;
	const thinking = settings.defaultThinkingLevel ? `:${settings.defaultThinkingLevel}` : "";
	return `${settings.defaultProvider}/${settings.defaultModel}${thinking}`;
}

const activeGroups = new Set<number>();

export function killActiveRuns(): void {
	for (const pid of activeGroups) killGroup(pid);
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group already exited.
	}
}

function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
	return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
		const child = spawn(piBin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		activeGroups.add(child.pid!);
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid!);
		}, timeoutMs);
		child.on("error", reject);
		// Kill leftover tool processes so they cannot hold the pipes open.
		child.on("exit", () => killGroup(child.pid!));
		child.on("close", (code) => {
			clearTimeout(timer);
			activeGroups.delete(child.pid!);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

export async function runTrial(
	suite: string,
	c: EvalCase,
	trial: number,
	options: { root: string; resultsDir: string; model?: string },
): Promise<TrialResult> {
	const dir = mkdtempSync(join(options.root, "trial-"));
	const cwd = join(dir, "cwd");
	mkdirSync(cwd);
	const started = Date.now();
	const args = ["-p", "--mode", "json", "--no-session", "-ne", "-ns", "-nc", "--no-mcp", "--no-approve", "--offline"];
	args.push("--skill", join(repoRoot, c.skill));
	if (!c.builtinTools) args.push("--no-builtin-tools");
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(options.root, "agent") };
	if (c.stubs?.length) {
		env.PI_EVAL_STUB_SPEC = join(dir, "stubs.json");
		writeFileSync(env.PI_EVAL_STUB_SPEC, JSON.stringify(c.stubs));
		args.push("-e", stubExtension);
	}
	for (const path of c.extensions ?? []) args.push("-e", join(repoRoot, path));
	if (options.model) args.push("--model", options.model);
	args.push("--", c.prompt);

	let parsed: ParsedRun | undefined;
	let grade: Grade;
	let stdout = "";
	let stderr = "";
	try {
		await c.setup?.(cwd);
		const timeoutMs = c.timeoutMs ?? TIMEOUT_MS;
		const run = await runPi(args, cwd, env, timeoutMs);
		({ stdout, stderr } = run);
		// A killed run can end mid-record, so report the exit before parsing its events.
		if (run.timedOut) grade = { pass: false, reasons: [`timed out after ${timeoutMs / 1000} s`] };
		else if (run.code !== 0) grade = { pass: false, reasons: [`pi exited ${run.code}: ${stderr.trim().slice(-500)}`] };
		else {
			parsed = parseEvents(stdout);
			grade = parsed.error ? { pass: false, reasons: [parsed.error] } : await c.grade(parsed.trace, cwd);
		}
	} catch (error) {
		grade = { pass: false, reasons: [`harness error: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const durationMs = Date.now() - started;
	const base = join(options.resultsDir, suite, `${c.id}.t${trial}`);
	mkdirSync(join(options.resultsDir, suite), { recursive: true });
	writeFileSync(`${base}.events.jsonl`, stdout);
	writeFileSync(
		`${base}.json`,
		`${JSON.stringify({ suite, case: c.id, kind: c.kind, trial, model: parsed?.model, durationMs, grade, trace: parsed?.trace, args, stderr: stderr.slice(-4096) }, null, 2)}\n`,
	);
	rmSync(dir, { recursive: true, force: true });
	return { grade, model: parsed?.model, durationMs };
}
