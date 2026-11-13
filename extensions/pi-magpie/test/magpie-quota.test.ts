import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { details, footer, parseCards, sessionKey } from "../extensions/magpie.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const payload = [
	{ provider: "codex", name: "Codex", kind: "subscription", user: "one", readAt: "2026-01-01T11:59:00Z", windows: [
		{ name: "5h", remaining: 12, resetsAt: "2026-01-01T13:00:00Z" }, { name: "week", remaining: 42, resetsAt: "2026-01-01T11:00:00Z" },
		{ name: "images", text: true, display: "Unknown" }, { name: "wallet", balance: 5, unit: "USD" },
	] },
	{ provider: "codex", name: "Codex", kind: "subscription", user: "two", readAt: "2026-01-01T11:00:00Z", error: "secret-token", windows: [{ name: "week", remaining: 0 }] },
];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const claude = { provider: "claude", name: "Claude", kind: "subscription", user: "one", readAt: "2026-01-01T11:59:00Z", windows: [
	{ name: "7 days", remaining: 15 }, { name: "Usage credits", used: 100, remaining: 0, amount: 50.05, limit: 50, unit: "SGD" },
] };

function harness(exec?: (...args: any[]) => any) {
	const events = new Map<string, Function>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const statuses: (string | undefined)[] = [], models: (string | undefined)[] = [], notices: string[] = [];
	const ctx = { hasUI: true, model: { provider: "magpie", id: "auto/main", baseUrl: "http://127.0.0.1:3425/v1" }, sessionManager: { getSessionId: () => "pi-session" }, ui: { setStatus: (key: string, value?: string) => { assert.ok(key === "magpie-quota" || key === "magpie-model"); (key === "magpie-quota" ? statuses : models).push(value); }, notify: (value: string) => notices.push(value) } } as unknown as ExtensionContext;
	extension({ on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (_: string, options: { handler: typeof command }) => { command = options.handler; }, exec: exec ?? (async () => ({ code: 0, stdout: JSON.stringify({ running: true, url: "http://127.0.0.1:3425" }) })) } as unknown as ExtensionAPI);
	return { events, command: (args: string) => command(args, ctx), ctx, statuses, models, notices };
}
const route = { id: 123, asked: "auto/main", model: "codex/gpt", served: "gpt-v2", tries: [{ model: "other/model", fail: "secret" }, { model: "codex/gpt" }], done: true, status: 200 };

test("shows each quota window, resets, low and stale accounts without errors", () => {
	const cards = parseCards(JSON.stringify(payload));
	const line = footer(cards, false, now).quota;
	assert.match(line, /#1 5h 12% ~1h/);
	assert.match(line, /#2 week 0% \? stale unavailable/);
	assert.match(details(cards, false, now), /week: 42% remaining \(stale\)/);
	assert.match(details(cards, false, now), /images: Unknown/);
	assert.match(details(cards, false, now), /wallet: 5 USD balance/);
	assert.doesNotMatch(details(cards, false, now), /secret-token/);
	assert.throws(() => parseCards('{"provider":"codex"}'));
});

test("formats reset times in days, hours, and minutes", () => {
	for (const [offset, expected] of [[8487, "~5d 21h 27m"], [7759, "~5d 9h 19m"], [1440, "~1d"], [61, "~1h 1m"], [1 / 60, "~1m"], [0, "?"]] as const) {
		const card = { ...payload[0], windows: [{ name: "week", remaining: 20, resetsAt: new Date(now + offset * 60_000).toISOString() }] };
		assert.ok(footer(parseCards(JSON.stringify([card])), false, now).quota.includes(`week 20% ${expected}`));
	}
});

test("shows Claude extra usage separately from subscription quota", () => {
	const cards = parseCards(JSON.stringify([claude, { ...claude, provider: "other" }]));
	assert.match(details(cards, false, now), /Usage credits: 50\.05 \/ 50 SGD/);
	assert.match(footer(cards, false, now).quota, /#1 7 days 15% \? · #2 Usage credits 0%/);
	const incomplete = parseCards(JSON.stringify([{ ...claude, windows: [{ name: "Usage credits", remaining: 0 }] }]));
	assert.match(details(incomplete, false, now), /Usage credits: unknown/);
	assert.match(footer(incomplete, false, now).quota, /#1 unknown/);
});

test("groups newly low windows per card and tracks recovery separately", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now });
	let first = 15, second = 10;
	const card = () => [{ ...claude, windows: [
		{ name: "7 days", remaining: first }, { name: "5 hours", remaining: second }, claude.windows[1],
	] }];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: card() });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route: null });
		return Response.json({ total: 0, rows: [] });
	});
	const h = harness(async (_: string, args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === "status" ? { running: true, url: "http://127.0.0.1:3425" } : card()) }));
	h.events.get("session_start")!({}, h.ctx); await h.command("");
	const warnings = () => h.notices.filter((notice) => notice.includes("% remaining."));
	assert.deepEqual(warnings(), ["Magpie claude / one / subscription: 7 days has 15% remaining; 5 hours has 10% remaining."]);
	await h.command("refresh"); assert.equal(warnings().length, 1);
	first = 30; await h.command("refresh");
	first = 15; await h.command("refresh");
	assert.equal(warnings().at(-1), "Magpie claude / one / subscription: 7 days has 15% remaining.");
	assert.equal(warnings().length, 2);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("does not associate an ambiguous account with a quota card", () => {
	const cards = parseCards(JSON.stringify([payload[0], { ...payload[0], name: "another" }]));
	const current = { id: 1, asked: "codex/gpt", model: "codex/gpt", served: "", tries: [], done: true, status: 200, account: "one" };
	assert.match(footer(cards, false, now, "codex", current).model, /account\?/);
	assert.deepEqual(footer([], true, now), { quota: "Magpie: quota unavailable", model: "route?" });
	assert.equal(footer([], false, now, "codex", current).model, "magpie/codex/gpt account?");
});

test("correlates fallback and served account across usage pages", async (t) => {
	const urls: URL[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input)); urls.push(url);
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route });
		if (url.searchParams.get("offset") === "0") return Response.json({ total: 101, rows: Array.from({ length: 100 }, () => ({ route_id: 123, session: "other", provider: "codex", model: "gpt", status: 200, providerAccount: "wrong" })) });
		return Response.json({ total: 101, rows: [{ route_id: 123, session: sessionKey("pi-session"), provider: "codex", model: "gpt", status: 200, providerAccount: "two" }] });
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx);
	await h.command(""); await tick(); await tick();
	const text = h.statuses.at(-1)!;
	assert.equal(h.models.at(-1), "magpie/codex/gpt-v2 fallback(1) #2");
	assert.ok(text.indexOf("#2") < text.indexOf("#1"));
	await h.command("");
	assert.match(h.notices.at(-1)!, /auto\/main → codex\/gpt \(served gpt-v2\).*tried other\/model → codex\/gpt.*account two/);
	assert.doesNotMatch(text, /secret|wrong/);
	assert.equal(urls.filter((url) => url.pathname.endsWith("requests")).length, 2);
	assert.equal(urls.find((url) => url.pathname.endsWith("requests"))?.searchParams.get("route"), "123");
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("does not attribute unrelated, unavailable, or failed usage to a session", async (t) => {
	let usage: object | Response = { total: 2, rows: [
		{ route_id: 123, session: "another", provider: "codex", model: "gpt", status: 200, providerAccount: "wrong" },
		{ route_id: 123, session: sessionKey("pi-session"), provider: "other", model: "gpt", status: 200, providerAccount: "wrong" },
	] };
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route });
		return usage instanceof Response ? usage : Response.json(usage);
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx);
	await h.command(""); await tick(); await tick();
	assert.match(h.models.at(-1)!, /gpt-v2.*account\?/);
	usage = new Response("denied", { status: 403 });
	h.events.get("turn_end")!({}, h.ctx); await tick(); await tick();
	assert.match(h.models.at(-1)!, /gpt-v2.*account\?/);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("scopes headers and clears old routes on model switch and shutdown", async (t) => {
	let resolveRoute!: (response: Response) => void;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return new Promise<Response>((resolve) => { resolveRoute = resolve; });
		return Response.json({ total: 0, rows: [] });
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx); await h.command(""); await tick();
	const headers: Record<string, string> = { existing: "keep", "x-magpie-session": "old" };
	h.events.get("before_provider_headers")!({ headers }, h.ctx);
	assert.deepEqual(headers, { existing: "keep", "X-Magpie-Session": sessionKey("pi-session") });
	(h.ctx as any).model = { provider: "other", id: "example" };
	h.events.get("model_select")!({ model: h.ctx.model }, h.ctx);
	const otherHeaders = { existing: "keep" };
	h.events.get("before_provider_headers")!({ headers: otherHeaders }, h.ctx);
	assert.deepEqual(otherHeaders, { existing: "keep" });
	resolveRoute(Response.json({ session: sessionKey("pi-session"), route })); await tick();
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.models.at(-1), undefined);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("ignores routes from another selected model and aborts manual refresh", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route: { ...route, asked: "auto/old" } });
		return Response.json({ total: 0, rows: [] });
	});
	let finish!: (value: object) => void;
	let signal!: AbortSignal;
	const h = harness(async (_: string, args: string[], opts: { signal: AbortSignal }) => {
		if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ running: true, url: "http://127.0.0.1:3425" }) };
		signal = opts.signal; return new Promise((resolve) => { finish = resolve; });
	});
	h.events.get("session_start")!({}, h.ctx); await h.command(""); await tick(); await tick();
	assert.match(h.models.at(-1)!, /route\?/);
	const pending = h.command("refresh");
	h.events.get("session_shutdown")!({}, h.ctx); assert.equal(signal.aborted, true);
	finish({ code: 0, stdout: JSON.stringify(payload) }); await pending;
	assert.equal(h.statuses.at(-1), undefined);
});

test("does not substitute an older account when the latest matching record has none", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route });
		return Response.json({ total: 2, rows: [
			{ route_id: 123, session: sessionKey("pi-session"), provider: "codex", model: "gpt", status: 200 },
			{ route_id: 123, session: sessionKey("pi-session"), provider: "codex", model: "gpt", status: 200, providerAccount: "old" },
		] });
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx); await h.command(""); await tick(); await tick();
	assert.match(h.models.at(-1)!, /account\?/);
	assert.doesNotMatch(h.models.at(-1)!, /account old/);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("serializes manual refreshes and marks readings stale on time", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: [{ ...payload[0], windows: [payload[0].windows[0]], readAt: new Date(now).toISOString() }] });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route: null });
		return Response.json({ total: 0, rows: [] });
	});
	const complete: ((value: object) => void)[] = [];
	const h = harness(async (_: string, args: string[]) => args[0] === "status"
		? { code: 0, stdout: JSON.stringify({ running: true, url: "http://127.0.0.1:3425" }) }
		: new Promise((resolve) => { complete.push(resolve); }));
	h.events.get("session_start")!({}, h.ctx); await h.command("");
	assert.doesNotMatch(h.statuses.at(-1)!, /#1.* stale/);
	t.mock.timers.tick(600_000);
	assert.match(h.statuses.at(-1)!, /#1.* stale/);
	const pending = [h.command("refresh"), h.command("refresh")];
	assert.equal(complete.length, 1);
	complete[0]({ code: 0, stdout: JSON.stringify(payload) }); await tick();
	assert.equal(complete.length, 2);
	complete[1]({ code: 0, stdout: JSON.stringify(payload) }); await Promise.all(pending);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("warns once for each fresh low window and warns again after recovery", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now });
	let reading = 50, readAt = now;
	const card = () => [{ ...payload[0], readAt: new Date(readAt).toISOString(), windows: [{ name: "5h", remaining: reading, resetsAt: "2026-01-01T13:00:00Z" }] }];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: card() });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route: null });
		return Response.json({ total: 0, rows: [] });
	});
	const h = harness(async (_: string, args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === "status" ? { running: true, url: "http://127.0.0.1:3425" } : card()) }));
	h.events.get("session_start")!({}, h.ctx); await h.command("");
	reading = 20; readAt = now - 11 * 60_000; await h.command("refresh");
	assert.equal(h.notices.filter((notice) => notice.includes("has 20% remaining")).length, 0);
	readAt = now; await h.command("refresh"); await h.command("refresh");
	assert.equal(h.notices.filter((notice) => notice.includes("has 20% remaining")).length, 1);
	reading = 30; await h.command("refresh"); reading = 20; await h.command("refresh");
	assert.equal(h.notices.filter((notice) => notice.includes("has 20% remaining")).length, 2);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("retries the account lookup after the route completes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let rows: object[] = [], visible = false;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) return Response.json({ session: sessionKey("pi-session"), route: visible ? route : null });
		return Response.json({ total: rows.length, rows });
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx); await h.command(""); await tick(); await tick();
	assert.match(h.models.at(-1)!, /route\?/);
	visible = true; t.mock.timers.tick(2_000); await tick(); await tick();
	assert.match(h.models.at(-1)!, /account\?/);
	rows = [{ route_id: 123, session: sessionKey("pi-session"), provider: "codex", model: "gpt", status: 200, providerAccount: "two" }];
	t.mock.timers.tick(2_000); await tick(); await tick();
	assert.match(h.models.at(-1)!, /fallback\(1\) #2/);
	h.events.get("session_shutdown")!({}, h.ctx);
});

test("does not restore a previous route during a new request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let routeReads = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("quotas")) return Response.json({ data: payload });
		if (url.pathname.endsWith("route")) { routeReads++; return Response.json({ session: sessionKey("pi-session"), route }); }
		return Response.json({ total: 0, rows: [] });
	});
	const h = harness(); h.events.get("session_start")!({}, h.ctx); await h.command(""); await tick(); await tick();
	h.events.get("before_provider_headers")!({ headers: {} }, h.ctx);
	const before = routeReads;
	t.mock.timers.tick(5 * 60_000); await tick(); await tick();
	assert.equal(routeReads, before);
	assert.match(h.models.at(-1)!, /route\?/);
	h.events.get("session_shutdown")!({}, h.ctx);
});
