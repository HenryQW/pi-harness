import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigStore, parsers, registerConfigReporting } from "@henryqw/pi-config-store";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

type Role = "bouncer" | "bartender" | "other";
type Decision = { action: "allow" | "confirm" } | { action: "block"; reason: string };

// shortcut: Scan direct commands and substitutions. Use a full parser if aliases, scripts, or eval must be inspected.
function* shellCommands(source: string, cursor = { index: 0 }, end?: string): Generator<string[]> {
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote = "";
	const finishWord = () => {
		if (inWord) words.push(word);
		inWord = false;
		word = "";
	};
	while (cursor.index < source.length) {
		const char = source[cursor.index++]!;
		if (quote === "'") {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === "\\" && cursor.index < source.length) {
			const escaped = source[cursor.index++]!;
			if (escaped === "\n") continue;
			if (quote && !'"`$\\'.includes(escaped)) word += "\\";
			word += escaped;
			inWord = true;
		} else if (!quote && char === end) {
			break;
		} else if (char === "`" || (char === "$" && source[cursor.index] === "(")) {
			if (char === "$") cursor.index++;
			yield* shellCommands(source, cursor, char === "$" ? ")" : "`");
			word += "$";
			inWord = true;
		} else if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "#" && !inWord) {
			const newline = source.indexOf("\n", cursor.index);
			cursor.index = newline < 0 ? source.length : newline;
		} else if (char === "(") {
			finishWord();
			if (words.length) yield words;
			words = [];
			yield* shellCommands(source, cursor, ")");
		} else if (";&|\n)".includes(char)) {
			finishWord();
			if (words.length) yield words;
			words = [];
		} else if (/\s/.test(char)) {
			finishWord();
		} else {
			word += char;
			inWord = true;
		}
	}
	finishWord();
	if (words.length) yield words;
}

const wrapperOptions = new Map<string, readonly string[]>([
	["env", ["-u", "--unset", "-C", "--chdir"]],
	["command", []],
	["exec", ["-a"]],
	["sudo", ["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot", "--command-timeout", "--user"]],
]);
const gitOptions = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"];
const ghOptions = ["-R", "--repo"];

function skipOptions(words: string[], index: number, withValue: readonly string[]): number {
	while (words[index]?.startsWith("-")) {
		const option = words[index++]!;
		if (option === "--") break;
		if (withValue.includes(option)) index++;
	}
	return index;
}

export function gateDecision(role: Role, toolName: string, input: Record<string, unknown>): Decision {
	if (role === "bartender" && toolName === "herdr_handoff") {
		return { action: "block", reason: "Bartenders cannot use herdr_handoff." };
	}
	if (role === "other" || toolName !== "bash" || typeof input.command !== "string") return { action: "allow" };

	commands: for (const words of shellCommands(input.command)) {
		let index = 0;
		let command = "";
		while (index < words.length) {
			const word = words[index++]!;
			if (/^[A-Za-z_]\w*=/.test(word)) continue;
			command = basename(word);
			const options = wrapperOptions.get(command);
			if (!options) break;
			const next = skipOptions(words, index, options);
			if (command === "command" && words.slice(index, next).some((word) => /^-[p]*[vV]/.test(word))) continue commands;
			index = next;
		}
		if (command === "git" && words[skipOptions(words, index, gitOptions)] === "push") {
			return role === "bouncer" ? { action: "confirm" } : { action: "block", reason: "Bartenders cannot run git push." };
		}
		if (command === "gh") {
			if (role === "bartender") return { action: "block", reason: "Bartenders cannot run gh." };
			const group = skipOptions(words, index, ghOptions);
			const action = words[skipOptions(words, group + 1, ghOptions)];
			if (words[group] === "pr" && (action === "create" || action === "merge")) return { action: "confirm" };
		}
	}
	return { action: "allow" };
}

const line = Type.String({ pattern: "^[^\\r\\n]*$" });
const tickResult = Type.Object({
	digest: Type.String(),
	items: Type.Array(Type.Object({ kind: line, repo: line, number: Type.Integer(), text: line, turn: Type.Optional(line) })),
	failures: Type.Array(Type.Object({ step: line, repo: line, number: Type.Integer(), message: line })),
});

function parseTickResult(stdout: string): Static<typeof tickResult> {
	const result: unknown = JSON.parse(stdout);
	if (!Check(tickResult, result)) throw new Error("Tick output must match the Bouncer result format.");
	return result;
}

export function registerBouncer(pi: ExtensionAPI): void {
	const configReporter = registerConfigReporting(pi, []);
	type Session = { role: Role; timer?: NodeJS.Timeout };
	let session: Session | undefined;
	let inFlight: Promise<void> | undefined;

	const stop = () => {
		if (session?.timer) clearInterval(session.timer);
		session = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		const current: Session = { role: "other" };
		session = current;
		if (process.env.PI_BOUNCER !== "1") {
			const branch = await pi.exec("git", ["-C", ctx.cwd, "symbolic-ref", "--short", "-q", "HEAD"]).catch(() => undefined);
			if (branch?.code === 0 && !branch.killed && /^bouncer\/\d+(-|$)/.test(branch.stdout.trim())) current.role = "bartender";
			return;
		}
		current.role = "bouncer";
		const store = createConfigStore({
			extensionId: "pi-herdr-tools",
			fileName: "bouncer.json",
			entries(raw, report) {
				const config = raw as Record<string, unknown>;
				if (config.tick === undefined) throw new Error("tick is required");
				const tick = parsers.absolutePath()(config.tick, report);
				try {
					if (!statSync(tick).isFile()) throw new Error("not a file");
					accessSync(tick, constants.X_OK);
				} catch {
					throw new Error("tick must point to an executable file");
				}
				const intervalMs = config.intervalMs === undefined ? 60_000 : parsers.integer({ min: 5_000 })(config.intervalMs, report);
				return { tick, intervalMs };
			},
		});
		const config = store.loadSync();
		if (config.status === "disabled" || config.issues.length) {
			if (ctx.hasUI) configReporter.report(ctx, store, { status: "disabled", source: config.source, issues: config.issues });
			return;
		}
		const { tick, intervalMs } = config.value;
		let lastDigest: string | undefined;
		// The keys of the last accepted result. A wake sends only the lines that are not in it.
		let seen = new Set<string>();
		const reported = new Set<string>();
		const notify = (message: string, detail: string) => {
			if (session !== current || !ctx.hasUI || reported.has(detail)) return;
			reported.add(detail);
			ctx.ui.notify(message, "error");
		};
		const runTick = async () => {
			try {
				const result = await pi.exec(tick, ["--json"], { timeout: 120_000 });
				if (session !== current) return;
				if (result.killed || result.code !== 0) {
					const message = result.killed ? "Bouncer tick was killed." : `Bouncer tick exited with code ${result.code}.`;
					notify(message, `${message}\n${result.stderr.trim()}`);
					return;
				}
				let details: Static<typeof tickResult>;
				try {
					details = parseTickResult(result.stdout);
				} catch (error) {
					notify("Bouncer tick returned invalid output. Check the result format.", String(error));
					return;
				}
				if (details.digest === lastDigest) return;
				const lines = new Map([
					...details.items.map(({ kind, repo, number, text, turn }) =>
						[JSON.stringify([kind, repo, number, text, turn ?? null]), `${kind} ${repo}#${number}: ${text}`] as const),
					...details.failures.map(({ step, repo, number, message }) =>
						[JSON.stringify(["failure", step, repo, number, message]), `${step} failed for ${repo}#${number}: ${message}`] as const),
				]);
				const fresh = [...lines].filter(([key]) => !seen.has(key)).map(([, text]) => text);
				if (fresh.length > 0) {
					if (!ctx.isIdle()) return;
					pi.sendMessage({ customType: "bouncer", content: fresh.join("\n"), display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
				}
				lastDigest = details.digest;
				seen = new Set(lines.keys());
			} catch (error) {
				notify("Could not run the Bouncer tick.", String(error));
			}
		};
		const startTick = () => {
			if (inFlight || session !== current) return;
			inFlight = runTick().finally(() => { inFlight = undefined; });
		};
		startTick();
		// Node turns delays above its timer limit into a one-millisecond interval.
		const steps = Math.ceil(intervalMs / 2_147_483_647);
		let elapsed = 0;
		current.timer = setInterval(() => {
			if (++elapsed < steps) return;
			elapsed = 0;
			startTick();
		}, Math.ceil(intervalMs / steps));
		current.timer.unref();
	});

	pi.on("session_shutdown", async () => {
		stop();
		await inFlight;
	});
	pi.on("tool_call", async (event, ctx) => {
		const decision = gateDecision(session?.role ?? "other", event.toolName, event.input);
		if (decision.action === "block") return { block: true, reason: decision.reason };
		if (decision.action === "confirm" && isToolCallEventType("bash", event)) {
			const { command } = event.input;
			if (!ctx.hasUI || !(await ctx.ui.confirm("Bouncer gate", command))) {
				return { block: true, reason: `The owner did not confirm: ${command}` };
			}
		}
	});
}
