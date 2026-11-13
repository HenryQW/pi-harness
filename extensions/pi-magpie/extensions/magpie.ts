import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const instanceId = randomUUID();
export const sessionKey = (session: string) => `${session}-${instanceId}`;

const INTERVAL = 5 * 60_000;
const STALE_AFTER = 10 * 60_000;

type Window = { name: string; remaining?: number; display?: string; text?: boolean; unlimited?: boolean; balance?: number; amount?: number; limit?: number; unit?: string; resetsAt?: string };
type Card = { provider: string; name: string; kind: string; user?: string; alias?: string; from?: string; plan?: string; windows: Window[]; balance?: string; readAt?: string; error?: string };

// External text can contain terminal control characters; errors are never displayed.
function safe(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 120) : fallback;
}

export function parseCards(output: string): Card[] {
	const data: unknown = JSON.parse(output);
	if (!Array.isArray(data)) throw new Error("Invalid quota response");
	return data.map((item): Card => {
		if (!item || typeof item !== "object" || typeof item.provider !== "string" || !item.provider || !Array.isArray(item.windows)) throw new Error("Invalid quota card");
		return {
			provider: safe(item.provider), name: safe(item.name, item.provider), kind: safe(item.kind, "unknown"),
			user: safe(item.user), alias: safe(item.alias), from: safe(item.from), plan: safe(item.plan),
			balance: safe(item.balance), readAt: safe(item.readAt), error: item.error ? "unavailable" : undefined,
			windows: item.windows.map((window: unknown): Window => {
				if (!window || typeof window !== "object" || !("name" in window) || typeof window.name !== "string") throw new Error("Invalid quota window");
				const w = window as Record<string, unknown>;
				return { name: safe(w.name), remaining: typeof w.remaining === "number" && Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100 ? w.remaining : undefined,
					display: safe(w.display), text: w.text === true, unlimited: w.unlimited === true,
					balance: typeof w.balance === "number" && Number.isFinite(w.balance) ? w.balance : undefined,
					amount: typeof w.amount === "number" && Number.isFinite(w.amount) && w.amount >= 0 ? w.amount : undefined,
					limit: typeof w.limit === "number" && Number.isFinite(w.limit) && w.limit >= 0 ? w.limit : undefined, unit: safe(w.unit), resetsAt: safe(w.resetsAt) };
			}),
		};
	});
}

function label(card: Card): string {
	return [card.provider, card.user || card.alias || card.name, card.from && `via ${card.from}`, card.kind, card.plan].filter(Boolean).join(" / ");
}
function stale(card: Card, now: number): boolean {
	const time = Date.parse(card.readAt || "");
	return !Number.isFinite(time) || time > now || now - time >= STALE_AFTER;
}
function extraUsage(card: Card, w: Window): boolean {
	return card.provider === "claude" && w.name === "Usage credits";
}
function windowValue(card: Card, w: Window): string {
	if (extraUsage(card, w)) return w.amount !== undefined && w.limit !== undefined ? `${w.amount} / ${w.limit}${w.unit ? ` ${w.unit}` : ""} used` : "unknown";
	if (w.unlimited) return "unlimited";
	if (w.balance !== undefined) return `${w.balance}${w.unit ? ` ${w.unit}` : ""} balance`;
	if (w.text) return w.display || "unknown";
	return w.remaining === undefined ? "unknown" : `${w.remaining}% remaining`;
}
export function details(cards: Card[], failed: boolean, now = Date.now()): string {
	if (!cards.length) return failed ? "Magpie quota unavailable. Check that Magpie is installed and try /magpie-quota refresh." : "Magpie returned no quota cards.";
	return cards.map((card, index) => {
		const state = [failed || stale(card, now) ? "stale" : "", card.error ? "unavailable" : ""].filter(Boolean).join(", ");
		const windows = card.windows.map((w) => {
			const reset = Date.parse(w.resetsAt || "");
			return `  ${w.name}: ${windowValue(card, w)}${Number.isFinite(reset) && reset <= now ? " (stale)" : ""}${w.resetsAt ? `; resets ${w.resetsAt}` : ""}`;
		});
		if (card.balance) windows.push(`  Balance: ${card.balance}`);
		if (!windows.length) windows.push("  Quota unavailable");
		return `${index + 1}. ${label(card)}${state ? ` (${state})` : ""}\n${windows.join("\n")}\n  Read: ${card.readAt || "unknown"}`;
	}).join("\n\n");
}
type Route = { id: number; asked: string; model: string; served: string; tries: string[]; done: boolean; status: number; account?: string };

function routeDetails(route?: Route): string {
	return route
		? `${route.asked || "unknown"} → ${route.model || "unknown"}${!route.done ? " (trying)" : route.status >= 400 ? " (failed)" : ""}${route.served && route.served !== route.model ? ` (served ${route.served})` : ""}${route.tries.length > 1 ? ` · tried ${route.tries.join(" → ")}` : ""} · account ${route.account || "unknown"}`
		: "route unknown · account unknown";
}

function resetTime(reset: number, now: number): string {
	if (!Number.isFinite(reset) || reset <= now) return "?";
	const minutes = Math.ceil((reset - now) / 60_000);
	const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), remainder = minutes % 60;
	return `~${[days && `${days}d`, hours && `${hours}h`, remainder && `${remainder}m`].filter(Boolean).join(" ")}`;
}

export function footer(cards: Card[], failed: boolean, now = Date.now(), provider?: string, route?: Route): { quota: string; model: string } {
	const indexed = cards.map((card, index) => ({ card, index }));
	const routedProvider = route?.model.split("/")[0] || provider;
	const matches = route?.account ? indexed.filter(({ card }) => card.user === route.account && !card.from && card.kind === "subscription" && card.provider === routedProvider) : [];
	const matched = matches.length === 1 ? matches[0] : undefined;
	const ordered = [...indexed].sort((a, b) => {
		const rank = (entry: typeof a) => entry === matched ? 0 : entry.card.provider === routedProvider ? 1 : 2;
		return rank(a) - rank(b);
	});
	const parts = ordered.slice(0, 2).map(({ card, index }) => {
		const windows = card.windows.filter((w) => !extraUsage(card, w) && !w.text && !w.unlimited && w.balance === undefined && w.remaining !== undefined);
		const w = windows.reduce<Window | undefined>((lowest, value) => !lowest || value.remaining! < lowest.remaining! ? value : lowest, undefined);
		const reset = Date.parse(w?.resetsAt || "");
		const time = resetTime(reset, now);
		const old = failed || stale(card, now) || (Number.isFinite(reset) && reset <= now);
		return `#${index + 1} ${w ? `${w.name} ${w.remaining}% ${time}` : "unknown"}${old ? " stale" : ""}${card.error ? " unavailable" : ""}`;
	});
	const model = route?.served ? (route.served.startsWith(`${routedProvider}/`) ? route.served : `${routedProvider}/${route.served}`) : route?.model;
	const routed = route ? `${model || "unknown"}${route.tries.length > 1 ? ` fallback(${route.tries.length - 1})` : ""}${route.done && route.status >= 400 ? " failed" : ""} ${matched ? `#${matched.index + 1}` : "account?"}` : "route?";
	return { quota: cards.length ? `Magpie ${parts.join(" · ")}` : `Magpie: ${failed ? "quota unavailable" : "no quota"}`, model: route ? `magpie/${routed}` : "route?" };
}

async function readRoute(url: string, session: string, signal: AbortSignal): Promise<Route | undefined> {
	const target = new URL("/v1/magpie/route", url);
	target.searchParams.set("session", session);
	const response = await fetch(target, { signal });
	if (!response.ok) throw new Error("Route unavailable");
	const data = await response.json() as { session?: unknown; route?: any };
	const r = data.route;
	if (data.session !== session || !r || !Number.isSafeInteger(r.id) || r.id <= 0 || !Array.isArray(r.tries)) return undefined;
	const route: Route = { id: r.id, asked: safe(r.asked), model: safe(r.model), served: safe(r.served), tries: r.tries.map((t: any) => safe(t?.model)).filter(Boolean), done: r.done === true, status: typeof r.status === "number" ? r.status : 0 };
	if (!route.done || route.status < 200 || route.status >= 300) return route;
	const usage = new URL("/v1/magpie/usage/requests", url);
	usage.searchParams.set("period", "all");
	usage.searchParams.set("route", String(route.id));
	usage.searchParams.set("limit", "100");
	try {
		for (let offset = 0; offset < 1000; offset += 100) {
			usage.searchParams.set("offset", String(offset));
			const page = await fetch(usage, { signal });
			if (!page.ok) break;
			const body = await page.json() as { rows?: any; total?: unknown };
			if (!Array.isArray(body.rows) || typeof body.total !== "number") break;
			const row = body.rows.find((row: any) => row.route_id === route.id && row.session === session && row.provider === route.model.split("/")[0] && (row.model === route.model || row.model === route.model.slice(route.model.indexOf("/") + 1)) && !row.source && row.status >= 200 && row.status < 300);
			if (row) { route.account = safe(row.providerAccount) || undefined; break; }
			if (offset + body.rows.length >= body.total || !body.rows.length) break;
		}
	} catch { /* Route remains useful when usage is unavailable. */ }
	return route;
}

export default function (pi: ExtensionAPI) {
	let cards: Card[] = [], failed = false, controller: AbortController | undefined;
	let running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
	let active = false, staleTimer: ReturnType<typeof setTimeout> | undefined;
	let provider: string | undefined, gateway: string | undefined, route: Route | undefined;
	let routeVersion = 0, routeController: AbortController | undefined, routeTimer: ReturnType<typeof setTimeout> | undefined;
	let requestPending = false;
	const lowWindows = new Set<string>();
	function alertLow(ctx: ExtensionContext, next: Card[]) {
		const now = Date.now();
		for (const card of next) {
			if (card.error || stale(card, now)) continue;
			const warnings: string[] = [];
			for (const w of card.windows) {
				const reset = Date.parse(w.resetsAt || "");
				if (extraUsage(card, w) || w.text || w.unlimited || w.balance !== undefined || w.remaining === undefined || (Number.isFinite(reset) && reset <= now)) continue;
				const key = JSON.stringify([card.provider, card.user, card.alias, card.from, card.name, w.name]);
				if (w.remaining < 25) {
					if (!lowWindows.has(key)) warnings.push(`${w.name} has ${w.remaining}% remaining`);
					lowWindows.add(key);
				} else lowWindows.delete(key);
			}
			if (warnings.length) ctx.ui.notify(`Magpie ${label(card)}: ${warnings.join("; ")}.`, "warning");
		}
	}
	function paint(ctx: ExtensionContext) {
		if (staleTimer) clearTimeout(staleTimer);
		if (!active || !ctx.hasUI) return;
		const now = Date.now();
		if (ctx.model?.provider !== "magpie") return;
		const status = footer(cards, failed, now, provider, route);
		ctx.ui.setStatus("magpie-quota", status.quota);
		ctx.ui.setStatus("magpie-model", status.model);
		const nextStale = cards.flatMap((card) => [Date.parse(card.readAt || "") + STALE_AFTER, ...card.windows.map((window) => Date.parse(window.resetsAt || ""))]).filter((time) => time > now && time <= now + STALE_AFTER);
		if (nextStale.length) { staleTimer = setTimeout(() => paint(ctx), Math.min(...nextStale) - now); staleTimer.unref(); }
	}
	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		while (running) {
			await running;
			if (!force || !active) return;
		}
		const current = new AbortController();
		controller = current;
		running = (async () => {
			try {
				let output: string;
				if (force || !gateway) {
					const result = await pi.exec("magpie", force ? ["quota", "--json"] : ["status", "--json"], { signal: current.signal, timeout: 20_000, maxBuffer: 1_048_576 });
					if (result.code !== 0 || result.killed || result.truncated) throw new Error("Magpie command failed");
					output = result.stdout;
					if (!force) {
						const status = JSON.parse(output);
						if (!status.running || typeof status.url !== "string") throw new Error("Magpie gateway unavailable");
						const address = new URL(status.url);
						if (!/^https?:$/.test(address.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) throw new Error("Gateway is not local");
						gateway = address.origin;
					}
				} else output = "";
				if (!force) {
					const response = await fetch(new URL("/v1/magpie/quotas?kept=1", gateway), { signal: AbortSignal.any([current.signal, AbortSignal.timeout(5_000)]) });
					if (!response.ok) throw new Error("Cached quota unavailable");
					output = JSON.stringify((await response.json()).data);
				}
				const next = parseCards(output);
				if (!current.signal.aborted && active) { cards = next; failed = false; alertLow(ctx, next); if (!force) void updateRoute(ctx); }
			} catch {
				if (!current.signal.aborted && active) { failed = true; if (!force) { gateway = undefined; route = undefined; ++routeVersion; } }
			} finally {
				if (controller === current) { controller = undefined; running = undefined; paint(ctx); }
			}
		})();
		return running;
	}
	async function updateRoute(ctx: ExtensionContext, attempt = 0) {
		if (routeTimer) clearTimeout(routeTimer);
		const version = ++routeVersion;
		routeController?.abort();
		const current = new AbortController();
		routeController = current;
		const model = ctx.model;
		if (!active || requestPending || model?.provider !== "magpie" || !gateway) return;
		try {
			if (model.baseUrl && new URL(model.baseUrl).origin !== gateway) throw new Error("Different gateway");
			const found = await readRoute(gateway, sessionKey(ctx.sessionManager.getSessionId()), AbortSignal.any([current.signal, AbortSignal.timeout(5_000)]));
			if (active && version === routeVersion) route = found?.asked === model.id ? found : undefined;
		} catch {
			if (active && version === routeVersion) route = undefined;
		}
		if (active && version === routeVersion) {
			paint(ctx);
			if ((!route && attempt < 5) || (route && (!route.done || (route.status >= 200 && route.status < 300 && !route.account && attempt < 5)))) {
				routeTimer = setTimeout(() => { void updateRoute(ctx, route && !route.done ? 0 : attempt + 1); }, 2_000);
				routeTimer.unref();
			}
		}
	}
	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider !== "magpie") return;
		for (const key of Object.keys(event.headers)) if (key.toLowerCase() === "x-magpie-session") delete event.headers[key];
		event.headers["X-Magpie-Session"] = sessionKey(ctx.sessionManager.getSessionId());
		requestPending = true;
		route = undefined;
		if (routeTimer) clearTimeout(routeTimer);
		routeController?.abort();
		++routeVersion;
		paint(ctx);
	});
	pi.on("after_provider_response", (_event, ctx) => { requestPending = false; void updateRoute(ctx); });
	pi.on("turn_end", (_event, ctx) => { requestPending = false; void updateRoute(ctx); });

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		active = true;
		provider = ctx.model?.provider === "magpie" ? ctx.model.id.split("/")[0] : undefined;
		if (ctx.model?.provider === "magpie") ctx.ui.setStatus("magpie-quota", "Magpie: loading");
		void refresh(ctx);
		timer = setInterval(() => { void refresh(ctx); }, INTERVAL);
		timer.unref();
	});
	pi.on("model_select", (event, ctx) => {
		provider = event.model.provider === "magpie" ? event.model.id.split("/")[0] : undefined;
		requestPending = false;
		route = undefined;
		if (routeTimer) clearTimeout(routeTimer);
		routeController?.abort();
		++routeVersion;
		if (event.model.provider !== "magpie") {
			ctx.ui.setStatus("magpie-quota", undefined);
			ctx.ui.setStatus("magpie-model", undefined);
		}
		else { paint(ctx); void updateRoute(ctx); }
	});
	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		if (routeTimer) clearTimeout(routeTimer);
		routeController?.abort();
		++routeVersion;
		if (timer) clearInterval(timer);
		if (staleTimer) clearTimeout(staleTimer);
		staleTimer = undefined;
		timer = undefined;
		controller?.abort();
		controller = undefined;
		running = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("magpie-quota", undefined);
			ctx.ui.setStatus("magpie-model", undefined);
		}
	});
	pi.registerCommand("magpie-quota", {
		description: "Show Magpie quota details or refresh them",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim() && args.trim() !== "refresh") { ctx.ui.notify("Usage: /magpie-quota [refresh]", "error"); return; }
			if (running) await running;
			if (!active) return;
			if (args.trim() === "refresh") await refresh(ctx, true);
			if (active) ctx.ui.notify(`Magpie: ${routeDetails(route)}\n\n${details(cards, failed)}`, failed ? "warning" : "info");
		},
	});
}
