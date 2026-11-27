import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:https";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import onePassword from "../extensions/1password.ts";
import { loadActions } from "../src/actions.mjs";
import { approvalServer, approvalStatus, forward, metadata, opArgs } from "../src/bridge.mjs";
import { authorizationLine, authorizeLauncher, createLauncherKey, launcherKey, stopWhenIdle } from "../src/launcher.mjs";

const secret = "fixture-api-key";
const reference = "op://vault/item/field";
const identity = "01234567-89ab-cdef-0123-456789abcdef";
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const exec = promisify(execFile);

test("pairing appends one restricted key and preserves an existing SSH configuration", async (t) => {
	const home = await mkdtemp(join(await realpath("/tmp"), "pi-op-authorize-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	});
	const keyPath = await launcherKey(["profile", "identity", "socket", "login"]);
	const [key, repeated] = await Promise.all([createLauncherKey(keyPath), createLauncherKey(keyPath)]);
	assert.equal(repeated, key);
	assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
	const ssh = join(home, ".ssh");
	await mkdir(ssh, { mode: 0o700 });
	const authorized = join(ssh, "authorized_keys");
	const existing = "# existing entry without trailing newline";
	await writeFile(authorized, existing, { mode: 0o600 });
	const argv = ["/bin/echo", "'quoted'", "launch"];
	await assert.rejects(authorizeLauncher(`${key}\nssh-ed25519 more`, argv), /Use the launcher public key/);
	await authorizeLauncher(key, argv);
	await authorizeLauncher(key, argv);
	const expected = authorizationLine(key, argv);
	assert.match(expected, /^restrict,pty,command="exec /);
	assert.equal(await readFile(authorized, "utf8"), `${existing}\n${expected}\n`);
	await assert.rejects(authorizeLauncher(key, ["/bin/false"]), /Remove the old/);
	assert.equal(await readFile(authorized, "utf8"), `${existing}\n${expected}\n`);
});

test("an on-demand companion counts idle time after requests finish", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const server = createHttpServer();
	const active = new EventEmitter();
	let stopped = false;
	const cancel = stopWhenIdle(server, () => { stopped = true; }, 100);
	t.after(cancel);
	t.mock.timers.tick(90);
	server.emit("request", { method: "POST" }, active);
	t.mock.timers.tick(120);
	assert.equal(stopped, false);
	active.emit("close");
	t.mock.timers.tick(80);
	server.emit("request", { method: "GET" }, new EventEmitter());
	t.mock.timers.tick(20);
	assert.equal(stopped, true);
});

test("approval requires an explicit selection and prepares a default socket for an eligible Mac", async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-select-"));
	const configDir = join(dir, "config", "pi-1password");
	const configPath = join(configDir, "config.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.HOME = dir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(dir, { recursive: true, force: true });
	});

	const homeTarget = "ssh://user@personal.example:2222";
	const profiles = [
		{ id: "home", label: "Personal Mac", target: homeTarget, enabled: true },
		{ id: "other", label: "Missing op", target: "other-mac", enabled: true },
		{ id: "disabled", label: "Disabled", target: "disabled-mac", enabled: false },
	];
	const probed: string[] = [];
	const calls: string[] = [];
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	let herdrAvailable = true;
	onePassword({
		on() {},
		registerCommand(name: string, definition: RegisteredCommand) {
			assert.equal(name, "1password");
			command = definition;
		},
		registerTool(definition: Parameters<ExtensionAPI["registerTool"]>[0]) { tools.set(definition.name, definition); },
	} as unknown as ExtensionAPI, async (file, args) => {
		if (file === "herdr") {
			assert.deepEqual(args, ["machine", "list", "--json"]);
			return herdrAvailable ? JSON.stringify(profiles) : null;
		}
		if (file === "/bin/sh") return herdrAvailable ? null : `${identity}\n/usr/bin/true\n2.42.0\n`;
		assert.equal(file, "/usr/bin/ssh");
		if (args[0] === "-G") return "hostname personal.example\nport 2222\n";
		const target = args.at(-2)!;
		probed.push(target);
		return target === homeTarget ? `${identity}\n/opt/homebrew/bin/op\n2.42.0\n` : null;
	});
	let choose: string | undefined;
	let expectedOptions = ["Personal Mac (home)"];
	const ctx = { hasUI: true, ui: {
		notify(message: string) { calls.push(message); },
		async select(_title: string, options: string[]) {
			assert.deepEqual(options, expectedOptions);
			return choose;
		},
	} } as unknown as ExtensionCommandContext & ExtensionToolContext;
	const list = () => tools.get("onepassword_list")!.execute("test", { operation: "vaults" }, undefined, undefined, ctx);
	const actionTool = tools.get("onepassword_action")!;
	assert.ok("type" in actionTool.parameters && actionTool.parameters.type === "object");
	const action = (input: Record<string, unknown> = { action: "verify" }) => actionTool.execute("test", input, undefined, undefined, ctx);
	const discover = (input: Record<string, unknown> = {}) => tools.get("onepassword_actions")!.execute("test", input, undefined, undefined, ctx);

	const complete = command.getArgumentCompletions!;
	assert.deepEqual((await complete("s"))?.map(({ label, value }) => ({ label, value })), [
		{ label: "status", value: "status" },
		{ label: "select", value: "select " },
	]);
	assert.deepEqual((await complete("  st"))?.map(({ value }) => value), ["  status"]);
	assert.deepEqual(await complete("select Personal"), []);
	assert.deepEqual((await complete(""))?.map(({ label }) => label),
		process.platform === "darwin" ? ["status", "select", "pair", "local"] : ["status", "select", "pair"]);
	assert.deepEqual(probed, []);

	await command.handler("status", ctx);
	assert.match(calls.at(-1)!, /No approval Mac selected/);
	await assert.rejects(list, /Select an approval Mac/);
	await assert.rejects(action(), /Select a remote approval Mac/);
	await assert.rejects(discover(), /Select a remote approval Mac/);
	await command.handler("select ", ctx);
	assert.deepEqual(probed, [homeTarget, "other-mac"]);
	await assert.rejects(list, /Select an approval Mac/);
	await assert.rejects(command.handler("auto", ctx), /unavailable/);
	await assert.rejects(command.handler("Missing op", ctx), /unavailable/);
	choose = "Personal Mac (home)";
	await command.handler("", ctx);
	const status = calls.at(-1)!;
	assert.match(status, /^1Password \| Tunnel disconnected\n  Pi host: .+\n  Approval Mac: Personal Mac\n\n/);
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(status.includes(`npx --yes --ignore-scripts @henryqw/pi-1password@${manifest.version}`));
	assert.match(status, /local terminal on Personal Mac/);
	assert.match(status, /run \/1password status/);
	const socket = /^    serve PI_HOST_SSH_ALIAS \\\n    (.+)$/m.exec(status)![1];
	const socketDir = dirname(socket);
	assert.equal(socketDir, join(dir, ".pi-1password"));
	assert.equal((await stat(socketDir)).mode & 0o777, 0o700);
	await assert.rejects(stat(configPath), { code: "ENOENT" });
	await command.handler("home", ctx);
	assert.equal(calls.at(-1), status);
	await chmod(socketDir, 0o1700);
	await assert.rejects(command.handler("home", ctx), /private 0700 directory/);
	assert.equal((await stat(socketDir)).mode & 0o7777, 0o1700);
	await chmod(socketDir, 0o700);
	if (process.platform === "darwin") {
		await exec("/bin/chmod", ["+a", "everyone allow search", socketDir]);
		await assert.rejects(command.handler("home", ctx), /without extra access grants/);
		await exec("/bin/chmod", ["-N", socketDir]);
	}
	await assert.rejects(list, /disconnected/);
	await command.handler("status", ctx);
	assert.match(calls.at(-1)!, /^1Password \| Tunnel disconnected/m);
	await command.handler("pair desktop sf-mbp", ctx);
	assert.match(calls.at(-1)!, /Authorize on the Approval Mac/);
	assert.ok(calls.at(-1)!.includes(`--ignore-scripts @henryqw/pi-1password@${manifest.version}`));
	assert.ok(calls.at(-1)!.includes(`authorize \\\n  sf-mbp ${socket}`));
	assert.match(calls.at(-1)!, /'ssh-ed25519 [A-Za-z0-9+/]{68}'/);
	assert.match(await readFile(`${socket}.pair`, "utf8"), /^[A-Za-z0-9_-]{32}\n$/);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).targets.home, { socket: null, launchUser: "desktop" });
	await command.handler("status", ctx);
	assert.match(calls.at(-1)!, /On-demand tunnel idle/);
	await assert.rejects(discover(), /disconnected/);
	let runs = 0;
	const server = approvalServer({ identity,
		execute: async () => { assert.fail("Status and action discovery must not run op"); },
		actions: new Map([["verify", async () => { runs++; }], ["check-service", async () => { runs++; }]]),
	});
	t.after(() => { server.close(); server.closeAllConnections(); });
	server.listen(socket);
	await once(server, "listening");
	await chmod(socket, 0o600);
	await command.handler("status", ctx);
	assert.deepEqual(calls.at(-1)!.split("\n"), [
		"1Password | Tunnel connected",
		`  Pi host: ${hostname()}`,
		"  Approval Mac: Personal Mac",
		"  Terminal: Idle",
		"  Action grants: 2",
		"  1Password approval: Unknown",
	]);
	await assert.rejects(discover({ reference }), /takes no parameters/);
	assert.deepEqual((await discover()).content, [{ type: "text", text: JSON.stringify({
		approvalMac: "Personal Mac", actions: ["check-service", "verify"],
	}) }]);
	assert.equal(runs, 0);
	await assert.rejects(action({ action: "verify", reference }), /only an approved/);
	assert.deepEqual((await action()).content, [{ type: "text", text: "The approved 1Password action completed." }]);
	profiles[0].label = "status";
	await command.handler("select status", ctx);
	assert.match(calls.at(-1)!, /Approval Mac: status/);
	assert.doesNotMatch(calls.at(-1)!, /npx/);
	await command.handler("status", ctx);
	assert.match(calls.at(-1)!, /^1Password \| Tunnel connected\n  Pi host: .+\n  Approval Mac: status/);
	const override = join(dir, "home.sock");
	await mkdir(configDir, { recursive: true });
	await writeFile(configPath, JSON.stringify({ targets: { home: { socket: override } } }));
	await assert.rejects(action(), /selected approval route changed/);
	await assert.rejects(discover(), /selected approval route changed/);
	await command.handler("status", ctx);
	assert.match(calls.at(-1)!, /selected approval route changed/);
	await command.handler("home", ctx);
	assert.ok(calls.at(-1)?.includes(`serve PI_HOST_SSH_ALIAS \\\n    ${override}\n`));
	await assert.rejects(list, /disconnected/);
	const missingDirectory = join(dir, "missing");
	await writeFile(configPath, JSON.stringify({ targets: { home: { socket: join(missingDirectory, "approval.sock") } } }));
	await command.handler("home", ctx);
	assert.match(calls.at(-1)!, /Create a private 0700 directory for the approval socket/);
	assert.doesNotMatch(calls.at(-1)!, /npx/);
	profiles[0].enabled = false;
	await assert.rejects(list, /selected approval route changed/);
	await assert.rejects(action(), /selected approval route changed/);
	assert.equal(runs, 1);
	if (process.platform === "darwin") {
		herdrAvailable = false;
		choose = "local";
		expectedOptions = ["local"];
		await command.handler("", ctx);
		assert.match(calls.at(-1)!, /Local approval selected/);
		await command.handler("status", ctx);
		assert.match(calls.at(-1)!, /^1Password \| Local approval\n  Pi host: .+\n  Signed op: Available\n  1Password approval: Unknown/);
	}
});

test("requests cannot select a command, inject flags, or attach unsupported fields", () => {
	assert.deepEqual(opArgs({ operation: "items", vault: "Work Vault", account: "example.1password.com" }), [
		"item", "list", "--format=json", "--vault=Work Vault", "--account=example.1password.com",
	]);
	assert.deepEqual(opArgs({ operation: "vaults", account: "--help" }), ["vault", "list", "--format=json", "--account=--help"]);
	assert.throws(() => opArgs({ operation: "run", args: ["sh"] }), /supports vault lists/);
	assert.throws(() => opArgs({ operation: "vaults", vault: "Work" }), /Unexpected/);
	assert.throws(() => opArgs({ operation: "read", reference }), /supports vault lists and item lists/);
});

const itemRow = {
	id: "item1", title: "Example", category: "LOGIN", vault: { id: "vault1", name: "Work" },
	urls: [{ href: "https://example.com/token" }], fields: [{ value: "test secret" }],
};
const itemMetadata = { id: "item1", title: "Example", category: "LOGIN", vault: { id: "vault1", name: "Work" } };

test("metadata projection drops fields and URLs before the list reaches Pi", () => {
	assert.deepEqual(metadata("items", [itemRow]), [itemMetadata]);
	assert.deepEqual(metadata("vaults", [{ ...itemRow, name: "Work" }]), [{ id: "item1", name: "Work" }]);
});

test("approval sockets require a matching Mac and private permissions", async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-test-"));
	const socket = join(dir, "op.sock");
	const list = (mac = identity) => forward(socket, { operation: "items" }, undefined, mac);
	const server = approvalServer({ identity, execute: async () => [itemRow] });
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	await assert.rejects(list(), /disconnected/);
	server.listen(socket);
	await once(server, "listening");
	await chmod(socket, 0o600);
	await assert.rejects(list("different-mac"), /does not match/);
	await assert.rejects(approvalStatus(socket, undefined, "different-mac"), /does not match/);
	assert.deepEqual(await approvalStatus(socket, undefined, identity), { busy: false, actions: [] });
	await assert.rejects(forward(socket, { operation: "action", action: "verify" }, undefined, identity), /no grant/);
	assert.deepEqual(await list(), [itemMetadata]);
	await chmod(socket, 0o666);
	await assert.rejects(list(), /0600 approval socket/);
	await assert.rejects(approvalStatus(socket, undefined, identity), /0600 approval socket/);
	await chmod(socket, 0o600);
	await chmod(dir, 0o755);
	await assert.rejects(list(), /private 0700 directory/);
});

test("status works while the terminal handles another request", { timeout: 10_000 }, async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-status-"));
	const socket = join(dir, "op.sock");
	const events = new EventEmitter();
	const started = once(events, "started");
	const server = approvalServer({ identity, async execute() {
		const release = once(events, "release");
		events.emit("started");
		await release;
		return [itemRow];
	} });
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	server.listen(socket);
	await once(server, "listening");
	await chmod(socket, 0o600);
	const list = forward(socket, { operation: "items" }, undefined, identity);
	try {
		await Promise.race([started, list]);
		assert.deepEqual(await approvalStatus(socket, undefined, identity), { busy: true, actions: [] });
	} finally {
		events.emit("release");
		assert.deepEqual(await list, [itemMetadata]);
	}
	assert.deepEqual(await approvalStatus(socket, undefined, identity), { busy: false, actions: [] });
});

test("status handles old companions and rejects responses with grant details", async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-compat-"));
	const socket = join(dir, "op.sock");
	let supportsStatus = false;
	const server = createHttpServer((req, res) => {
		if (req.method === "POST" && req.url === "/op") {
			res.end(JSON.stringify({ result: [itemMetadata] }));
		} else if (supportsStatus) {
			res.end(JSON.stringify({ busy: false, actions: ["verify"], reference }));
		} else {
			res.writeHead(404).end();
		}
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	server.listen(socket);
	await once(server, "listening");
	await chmod(socket, 0o600);
	await assert.rejects(approvalStatus(socket, undefined, identity), /Status is unavailable.*Check the selected socket route.*update pi-1password/);
	assert.deepEqual(await forward(socket, { operation: "items" }, undefined, identity), [itemMetadata]);
	supportsStatus = true;
	await assert.rejects(approvalStatus(socket, undefined, identity), /invalid status/);
});

function send(socket: string, payload: object, mac = identity) {
	return new Promise<string>((resolve, reject) => {
		const body = JSON.stringify(payload);
		const req = request({ socketPath: socket, method: "POST", path: "/op", agent: false,
			headers: { "content-length": Buffer.byteLength(body), "x-pi-approval-mac": mac },
		}, (res) => {
			let reply = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { reply += chunk; });
			res.on("end", () => resolve(reply));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end(body);
	});
}

test("an action sends its pinned credential only to its HTTPS destination", async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-action-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const socket = join(dir, "op.sock");
	const policy = join(dir, "actions.json");
	const op = join(dir, "op");
	await writeFile(op, `#!/bin/sh
[ "$#" = 4 ] && [ "$1" = read ] && [ "$2" = --no-newline ] &&
[ "$3" = '${reference}' ] && [ "$4" = '--account=fixture.1password.com' ] &&
printf '%s' '${secret}'
`, { mode: 0o700 });
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert]);
	const certificate = await readFile(cert, "utf8");
	const received: Array<{ path: string | undefined; method: string | undefined; credential: string | string[] | undefined }> = [];
	const service = createServer({ key: await readFile(key), cert: certificate }, (req, res) => {
		received.push({ path: req.url, method: req.method, credential: req.headers.authorization ?? req.headers["x-api-key"] });
		if (req.url === "/redirect") res.writeHead(302, { location: "/other" });
		res.end(secret);
	});
	t.after(() => { service.close(); service.closeAllConnections(); });
	service.listen(0, "127.0.0.1");
	await once(service, "listening");
	const address = service.address();
	assert.ok(address && typeof address === "object");
	const url = `https://127.0.0.1:${address.port}`;
	const grant = { account: "fixture.1password.com", reference, url: `${url}/fixed`, header: "bearer" };
	await writeFile(policy, JSON.stringify({ verify: { ...grant, url: url.replace("https", "http") } }), { mode: 0o600 });
	await assert.rejects(loadActions(policy, op), /Fix the action file/);
	await writeFile(policy, JSON.stringify({ verify: { ...grant, consumer: "/bin/sh" } }));
	await assert.rejects(loadActions(policy, op), /Fix the action file/);
	await writeFile(policy, JSON.stringify({ verify: grant, "verify-key": { ...grant, header: "x-api-key" }, redirect: { ...grant, url: `${url}/redirect` } }));
	await chmod(policy, 0o644);
	await assert.rejects(loadActions(policy, op), /private 0600 action file/);
	await chmod(policy, 0o600);
	if (process.platform === "darwin") {
		await exec("/bin/chmod", ["+a", "everyone allow write", policy]);
		await assert.rejects(loadActions(policy, op), /without extra access grants/);
		await exec("/bin/chmod", ["-a#", "0", policy]);
	}
	const actions = await loadActions(policy, op);
	await assert.rejects(actions.get("verify")!(AbortSignal.abort()), { name: "AbortError" });
	const server = approvalServer({ identity, actions, execute: async () => [] });
	t.after(() => { server.close(); server.closeAllConnections(); });
	server.listen(socket);
	await once(server, "listening");
	await chmod(socket, 0o600);

	const action = { operation: "action", action: "verify" };
	assert.equal(await send(socket, action, "wrong-mac"), '{"actionError":"mismatch"}');
	assert.equal(await send(socket, { ...action, action: "missing" }), '{"actionError":"unavailable"}');
	assert.match(await send(socket, { ...action, reference, account: "other", url: `${url}/other`, args: ["/bin/sh"] }), /only an approved/);
	assert.match(await send(socket, { operation: "read", reference }), /supports vault lists and item lists/);
	assert.equal(await send(socket, action), '{"actionError":"failed"}');
	assert.deepEqual(received, []);

	const priorCertificates = getCACertificates("default");
	setDefaultCACertificates([...priorCertificates, certificate]);
	t.after(() => setDefaultCACertificates(priorCertificates));
	assert.equal(await send(socket, action), '{"completed":true}');
	assert.equal(await forward(socket, { ...action, action: "verify-key" }, undefined, identity), true);
	assert.equal(await send(socket, { ...action, action: "redirect" }), '{"actionError":"failed"}');
	assert.deepEqual(received, [
		{ path: "/fixed", method: "GET", credential: `Bearer ${secret}` },
		{ path: "/fixed", method: "GET", credential: secret },
		{ path: "/redirect", method: "GET", credential: `Bearer ${secret}` },
	]);
});

test("the companion rejects the old raw read and broad grant commands", async () => {
	await assert.rejects(exec(process.execPath, [cli, "read", "/tmp/op.sock", reference, "--", "/bin/cat"]), /Usage/);
	await assert.rejects(exec(process.execPath, [cli, "serve", "host", "/tmp/op.sock", "--allow-read"]), /Usage/);
});

test("the companion refuses actions under diagnostics or additional certificate trust", async (t) => {
	const dir = await mkdtemp(join(await realpath("/tmp"), "pi-op-runtime-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const script = join(dir, "probe.mjs");
	const actionsUrl = new URL("../src/actions.mjs", import.meta.url).href;
	await writeFile(script, `import { checkActionRuntime } from ${JSON.stringify(actionsUrl)};
checkActionRuntime();\n`);
	const protectedScript = join(dir, "protected.mjs");
	await writeFile(protectedScript, `import assert from 'node:assert/strict';
import { url } from 'node:inspector';
import { checkActionRuntime } from ${JSON.stringify(actionsUrl)};
assert.equal(checkActionRuntime(), true);
process.kill(process.pid, 'SIGUSR1');
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(url(), undefined);\n`);
	await exec(process.execPath, ["--disable-sigusr1", protectedScript]);
	for (const category of ["http", "https", "stream"]) {
		await assert.rejects(exec(process.execPath, [script], { env: { ...process.env, NODE_DEBUG: category } }),
			/Disable Node\.js .*debug logging/, category);
	}
	for (const option of ["--inspect=127.0.0.1:0", `--tls-keylog=${join(dir, "keys")}`, "--heapsnapshot-signal=SIGUSR2", "--use-system-ca"]) {
		await assert.rejects(exec(process.execPath, [option, script]), /without Node\.js runtime options/, option);
	}
	await assert.rejects(exec(process.execPath, [script], { env: { ...process.env, NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2" } }),
		/without Node\.js runtime options/);
	for (const setting of [{ NODE_EXTRA_CA_CERTS: join(dir, "extra.pem") }, { NODE_USE_SYSTEM_CA: "1" }]) {
		await assert.rejects(exec(process.execPath, [script], { env: { ...process.env, ...setting } }),
			/Unset NODE_EXTRA_CA_CERTS and NODE_USE_SYSTEM_CA/);
	}
});
