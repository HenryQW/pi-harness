import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConfigLoad, type ConfigReporter, createConfigStore, field, parsers, registerConfigReporting } from "@henryqw/pi-config-store";

const DEFAULT_COMMAND = "code";

export function createOpenInConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-open-in",
		agentDir,
		fields: { command: field(parsers.string({ trim: true }), DEFAULT_COMMAND) },
	});
}

type OpenInConfigStore = ReturnType<typeof createOpenInConfigStore>;

const SESSION_REPORTER = Symbol.for("@henryqw/pi-footer/open-in-reporter");

/**
 * Report open-in config issues at each session start; the returned function reports a lazy read.
 * `footer.ts` and `open.ts` load as separate module instances, so process state lets the first handler
 * of a `session_start` event own the reporter that both use. Each issue then shows one time.
 */
export function registerOpenInConfigReporting(
	pi: Pick<ExtensionAPI, "on">,
	store: OpenInConfigStore,
): (ctx: Pick<ExtensionContext, "hasUI" | "ui">, loaded: ConfigLoad<unknown>) => void {
	const own = registerConfigReporting(pi, []);
	let reporter = own;
	pi.on("session_start", (event, ctx) => {
		const state = globalThis as { [SESSION_REPORTER]?: { event: unknown; reporter: ConfigReporter } };
		if (state[SESSION_REPORTER]?.event !== event) state[SESSION_REPORTER] = { event, reporter: own };
		reporter = state[SESSION_REPORTER].reporter;
		reporter.report(ctx, store, store.loadSync());
	});
	return (ctx, loaded) => reporter.report(ctx, store, loaded);
}
