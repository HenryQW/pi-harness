import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore, field, parsers, registerConfigReporting } from "@henryqw/pi-config-store";
import { Type } from "typebox";
import { ApprovalDisconnectedError, approvalStatus, forward, isActionName, localApproval, opArgs, parseProbe, prepareSocketDirectory, probeOutput, probeScript, runOp, socketPath } from "../src/bridge.mjs";
import { ApprovalLauncher, createLauncherKey, launcherAddress, launcherKey, launchUser, pairingToken, shellQuote, sshAlias } from "../src/launcher.mjs";

const extensionId = "pi-1password";
const { name, version } = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
const profileId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const sshHost = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const sshUser = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const sshPort = /^(?:ssh:\/\/)(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?([a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:.]+\])(?::([0-9]{1,5}))?$/;
const remoteProbe = `/bin/sh -c '${probeScript.replaceAll("'", "'\\''")}'`;

type Machine = { id: string; label: string; target: string; enabled: boolean };
type ApprovalMachine = Machine & { identity: string };
type Selection = { kind: "local"; executable: string } | { kind: "remote"; machine: ApprovalMachine; socket: string };

async function approvalSocket(targets: Record<string, { socket: string | null }>, id: string) {
	const override = Object.hasOwn(targets, id) ? targets[id].socket : null;
	if (override) return { path: override, managed: false };
	const name = createHash("sha256").update(id).digest().subarray(0, 16).toString("base64url");
	const candidate = join(await realpath(homedir()), ".pi-1password", `${name}.sock`);
	let path: string;
	try {
		path = socketPath(candidate);
	} catch (error) {
		throw new Error(`Set targets.${id}.socket to a short absolute path in a private directory.`, { cause: error });
	}
	if (Object.values(targets).some(({ socket }) => socket === path)) {
		throw new Error("The default approval socket is assigned to another Mac. Use distinct socket paths.");
	}
	return { path, managed: true };
}

function validTarget(target: string) {
	if (target.startsWith("ssh://")) {
		const match = sshPort.exec(target);
		if (!match || (match[2] && !(Number(match[2]) >= 1 && Number(match[2]) <= 65535))) return false;
		return !match[1].startsWith("[") || isIP(match[1].slice(1, -1)) === 6;
	}
	const parts = target.split("@");
	const host = parts.at(-1)!;
	return (parts.length === 1 || (parts.length === 2 && sshUser.test(parts[0]))) &&
		(sshHost.test(host) || isIP(host) === 6);
}

async function listMachines(probe: typeof probeOutput): Promise<Machine[]> {
	const output = await probe("herdr", ["machine", "list", "--json"]);
	if (output === null) throw new Error("Cannot list saved Herdr machines. Check that Herdr is installed and herdr machine list works on the Pi host.");
	let profiles: unknown;
	try {
		profiles = JSON.parse(output);
	} catch {
		throw new Error("Herdr returned an invalid machine list.");
	}
	if (!Array.isArray(profiles)) throw new Error("Herdr returned an invalid machine list.");
	return profiles.map((entry: unknown) => {
		const machine = entry as Partial<Machine> | null;
		if (!machine || typeof machine.id !== "string" || !profileId.test(machine.id) ||
			typeof machine.label !== "string" || !machine.label.trim() || /[\u0000-\u001f\u007f]/u.test(machine.label) ||
			typeof machine.target !== "string" || typeof machine.enabled !== "boolean") {
			throw new Error("Herdr returned an invalid machine profile.");
		}
		return { id: machine.id, label: machine.label, target: machine.target, enabled: machine.enabled };
	});
}

async function eligibleMachines(probe: typeof probeOutput, profiles: Machine[]) {
	const available = await Promise.all(profiles.map(async (machine) => {
		if (!machine.enabled || !validTarget(machine.target)) return null;
		const output = await probe("/usr/bin/ssh", [
			"-nTax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
			"-o", "PermitLocalCommand=no", "-o", "ControlPath=none", "-o", "ForkAfterAuthentication=no",
			"-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=4", "--", machine.target, remoteProbe,
		]);
		const approval = output && parseProbe(output);
		return approval ? { ...machine, identity: approval.identity } : null;
	}));
	return available.filter((machine) => machine !== null);
}

export default function onePassword(pi: ExtensionAPI, probe = probeOutput) {
	const store = createConfigStore({
		extensionId,
		fields: {
			targets: field(parsers.record(parsers.object({
				socket: field(parsers.nullable(socketPath), null, { onInvalid: "disable" }),
				launchUser: field(parsers.nullable(launchUser), null, { onInvalid: "disable" }),
			}), {
				key(value) {
					if (typeof value !== "string" || !profileId.test(value)) throw new Error("Use a Herdr machine profile ID.");
					return value;
				},
			}), {}, { onInvalid: "disable" }),
		},
		check({ targets }) {
			const routes = Object.values(targets);
			if (routes.some((route) => !route.socket && !route.launchUser)) throw new Error("An approval target needs a socket override or launcher login.");
			const sockets = routes.flatMap(({ socket }) => socket ? [socket] : []);
			if (new Set(sockets).size !== sockets.length) throw new Error("Approval Macs need distinct socket paths.");
		},
	});
	const reporter = registerConfigReporting(pi, [store]);
	let selected: Selection | undefined;
	const origin = hostname();
	const launcher = new ApprovalLauncher();
	pi.on("session_shutdown", () => launcher.close());

	async function launchRoute(selection: Extract<Selection, { kind: "remote" }>, user: string) {
		const { machine, socket } = selection;
		const address = await launcherAddress(machine.target, probe);
		const key = await launcherKey([machine.id, machine.identity, machine.target, address.host, address.port, socket, user]);
		return { socket, identity: machine.identity, ...address, user, key };
	}

	async function verifyRemote(selection: Extract<Selection, { kind: "remote" }>, ctx: ExtensionContext) {
		const loaded = store.loadSync();
		reporter.report(ctx, store, loaded);
		if (loaded.status !== "ok" || loaded.issues.length) throw new Error(`Fix ${store.path} before using 1Password.`);
		const { id, target } = selection.machine;
		const profile = (await listMachines(probe)).find((machine) => machine.id === id && machine.enabled);
		if (profile?.target !== target || (await approvalSocket(loaded.value.targets, id)).path !== selection.socket) {
			throw new Error("The selected approval route changed. Select it again with /1password.");
		}
		return Object.hasOwn(loaded.value.targets, id) ? loaded.value.targets[id].launchUser : null;
	}

	async function requestRemote(selection: Extract<Selection, { kind: "remote" }>, input: Parameters<typeof forward>[1], signal: AbortSignal | undefined, ctx: ExtensionContext) {
		const user = await verifyRemote(selection, ctx);
		const request = () => forward(selection.socket, input, signal, selection.machine.identity);
		try {
			return await request();
		} catch (error) {
			if (!(error instanceof ApprovalDisconnectedError) || !user) throw error;
			signal?.throwIfAborted();
			await launcher.start(await launchRoute(selection, user));
			signal?.throwIfAborted();
			if (await verifyRemote(selection, ctx) !== user) throw new Error("The paired launcher changed. Request approval again.");
			return request();
		}
	}

	async function remoteStatus(selection: Extract<Selection, { kind: "remote" }>, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		await verifyRemote(selection, ctx);
		return approvalStatus(selection.socket, signal, selection.machine.identity);
	}

	pi.registerCommand("1password", {
		description: "Select, pair, or check a 1Password approval Mac",
		getArgumentCompletions(prefix) {
			const typed = prefix.trimStart();
			const indent = prefix.slice(0, prefix.length - typed.length);
			const options = [
				{ label: "status", value: "status", description: "Check the current approval route" },
				{ label: "select", value: "select ", description: "Open the picker or enter a Herdr machine label" },
				{ label: "pair", value: "pair ", description: "Set up on-demand approval for the selected Mac" },
			];
			if (process.platform === "darwin") {
				options.push({ label: "local", value: "local", description: "Use this Mac for vault and item lists" });
			}
			return options.filter(({ label }) => label.startsWith(typed))
				.map((option) => ({ ...option, value: indent + option.value }));
		},
		async handler(args, ctx) {
			const command = args.trim();
			const explicit = /^select\s+(.+)$/.exec(command);
			const requested = command === "select" ? "" : explicit?.[1] ?? command;
			const notify = (heading: string, lines: string[] = [], level: "info" | "error" = "info") => {
				const status = [`1Password | ${heading}`, `  Pi host: ${origin}`, ...lines].join("\n");
				if (ctx.hasUI) ctx.ui.notify(status, level);
				else process.stderr.write(`${status}\n`);
			};
			const showRemoteStatus = async (selection: Extract<Selection, { kind: "remote" }>) => {
				const { machine, socket } = selection;
				const approvalMac = `  Approval Mac: ${machine.label}`;
				let user: string | null = null;
				try {
					user = await verifyRemote(selection, ctx);
					const { busy, actions } = await approvalStatus(socket, undefined, machine.identity);
					notify("Tunnel connected", [
						approvalMac,
						`  Terminal: ${busy ? "Busy" : "Idle"}`,
						`  Action grants: ${actions.length}`,
						"  1Password approval: Unknown",
					]);
				} catch (error) {
					if (error instanceof ApprovalDisconnectedError) {
						if (user) {
							notify("On-demand tunnel idle", [approvalMac, "", "A vault list, item list, or named action starts the terminal."]);
							return;
						}
						notify("Tunnel disconnected", [
							approvalMac,
							"",
							"For on-demand approval, run /1password pair <mac-login> <pi-host-alias>.",
							"For a manual tunnel, use the command below.",
							"",
							`Run this in a local terminal on ${machine.label}:`,
							`  npx --yes --ignore-scripts ${name}@${version} \\`,
							"    serve PI_HOST_SSH_ALIAS \\",
							`    ${socket}`,
							"",
							"Replace PI_HOST_SSH_ALIAS with the SSH address or alias for the Pi host.",
							"Keep that terminal open. In Pi, run /1password status to check the connection.",
						]);
					} else {
						notify("Status check failed", [approvalMac, "", error instanceof Error ? error.message : "Cannot check the approval terminal."], "error");
					}
				}
			};
			if (command === "pair" || /^pair\s/u.test(command)) {
				const [user, host, extra] = command.split(/\s+/).slice(1);
				if (!user || !host || extra || !sshAlias.test(host)) {
					throw new Error("Use /1password pair <mac-login> <pi-host-alias>. Use the Approval Mac login and its SSH alias for this Pi host.");
				}
				if (selected?.kind !== "remote") throw new Error("Select a remote approval Mac with /1password.");
				const selection = selected;
				await verifyRemote(selection, ctx);
				const route = await launchRoute(selection, launchUser(user));
				const publicKey = await createLauncherKey(route.key);
				const proof = createHash("sha256").update(await pairingToken(selection.socket)).digest("hex");
				const id = selection.machine.id;
				await store.update((config) => ({ targets: { ...config.targets, [id]: {
					socket: Object.hasOwn(config.targets, id) ? config.targets[id].socket : null,
					launchUser: user,
				} } }));
				const companion = '"$HOME/.pi-1password-companion"';
				notify("Authorize on the Approval Mac", [
					`  Approval Mac: ${selection.machine.label}`,
					"",
					"Paste this block into a local terminal on that Mac:",
					...[
						`npm install --prefix ${companion} --ignore-scripts ${name}@${version} &&`,
						`  ${companion}/node_modules/.bin/pi-1password authorize`,
						`  ${host} ${selection.socket}`,
						`  ${proof}`,
						`  ${user} ${selection.machine.identity}`,
					].map((line) => `${line} \\`),
					`  ${shellQuote(publicKey)}`,
					"",
					"Then ask Pi for a vault list to test the connection.",
				]);
				return;
			}
			if (command === "status") {
				const selection = selected;
				if (!selection) {
					notify("No approval Mac selected", ["", "Select one with /1password."]);
				} else if (selection.kind === "local") {
					const local = await localApproval(probe);
					if (local?.executable === selection.executable) {
						notify("Local approval", ["  Signed op: Available", "  1Password approval: Unknown"]);
					} else {
						notify("Local approval check failed", ["", "Run /1password local again to verify the signed op command."], "error");
					}
				} else {
					await showRemoteStatus(selection);
				}
				return;
			}
			const selectLocal = command === "local";
			const local = !requested || selectLocal ? await localApproval(probe) : null;
			if (selectLocal) {
				if (!local) throw new Error("Local approval requires macOS and the native op command.");
				selected = { kind: "local", executable: local.executable };
				notify("Local approval selected");
				return;
			}
			let profiles: Machine[];
			try {
				profiles = await listMachines(probe);
			} catch (error) {
				if (requested || !local) throw error;
				profiles = [];
				notify(error instanceof Error ? error.message : "Herdr machine discovery failed.");
			}
			const exact = profiles.find(({ id }) => id === requested);
			const matches = exact ? [exact] : requested ? profiles.filter(({ label }) => label === requested) : profiles;
			if (requested && matches.length > 1) throw new Error("Several Herdr machines use this label. Select the profile ID from /1password.");
			const machines = await eligibleMachines(probe, matches);
			const options = new Map<string, ApprovalMachine | "local">();
			if (local) options.set("local", "local");
			for (const machine of machines) {
				options.set(`${machine.label} (${machine.id})`, machine);
			}
			let choice: ApprovalMachine | "local" | undefined;
			if (requested) {
				if (!machines.length) throw new Error("This Herdr machine is unavailable for approval. Use /1password to see eligible Macs.");
				choice = machines[0];
			} else if (!options.size || !ctx.hasUI) {
				notify(options.size ? `Approval choices: ${Array.from(options.keys()).join(", ")}.` : "No eligible Macs with op found.");
				return;
			} else {
				const current = selected?.kind === "local" ? "local" : selected?.machine.label ?? "none";
				const answer = await ctx.ui.select(`1Password approval Mac (current: ${current})`, Array.from(options.keys()));
				if (answer === undefined) return;
				choice = options.get(answer);
			}
			if (!choice) return;
			if (choice === "local") {
				if (!local) throw new Error("Local approval requires macOS and the native op command.");
				selected = { kind: "local", executable: local.executable };
				notify("Local approval selected");
				return;
			}
			const loaded = store.loadSync();
			reporter.report(ctx, store, loaded);
			if (loaded.status !== "ok" || loaded.issues.length) throw new Error(`Fix ${store.path} before selecting an approval Mac.`);
			const { path: socket, managed } = await approvalSocket(loaded.value.targets, choice.id);
			if (managed) await prepareSocketDirectory(socket);
			selected = { kind: "remote", machine: choice, socket };
			await showRemoteStatus(selected);
		},
	});

	pi.registerTool({
		name: "onepassword_list",
		label: "1Password list",
		description: "List 1Password vault or item metadata through the user's selected approval Mac. Use the op skill for account selection and secret handling.",
		parameters: Type.Object({
			operation: Type.Union([Type.Literal("vaults"), Type.Literal("items")]),
			account: Type.Optional(Type.String()),
			vault: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		async execute(_id, input, signal, _update, ctx) {
			if (input?.operation !== "items" && input?.operation !== "vaults") throw new Error("Select vaults or items.");
			opArgs(input);
			const selection = selected;
			if (!selection) throw new Error("Select an approval Mac with /1password.");
			const rows = selection.kind === "local"
				? await runOp(selection.executable, input, signal)
				: await requestRemote(selection, input, signal, ctx);
			const name = selection.kind === "local" ? "local" : selection.machine.label;
			return { content: [{ type: "text", text: JSON.stringify({ piHost: origin, approvalMac: name, rows }) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "onepassword_actions",
		label: "1Password action names",
		description: "List configured action names on the selected remote approval Mac. Use when the user wants to see available actions. This does not request 1Password approval or run an action.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, input, signal, _update, ctx) {
			if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
				throw new Error("Action discovery takes no parameters.");
			}
			const selection = selected;
			if (selection?.kind !== "remote") throw new Error("Select a remote approval Mac with /1password.");
			const { actions } = await remoteStatus(selection, signal, ctx);
			return { content: [{ type: "text", text: JSON.stringify({ approvalMac: selection.machine.label, actions }) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "onepassword_action",
		label: "1Password action",
		description: "Run a user-requested named action on the selected remote approval Mac. The Mac sets the credential and HTTPS destination. Returns completion status only.",
		parameters: Type.Object({ action: Type.String() }, { additionalProperties: false }),
		async execute(_id, input, signal, _update, ctx) {
			if (!input || Object.keys(input).length !== 1 || !isActionName(input.action)) {
				throw new Error("Send only an approved 1Password action name.");
			}
			const selection = selected;
			if (selection?.kind !== "remote") throw new Error("Select a remote approval Mac with /1password.");
			await requestRemote(selection, { operation: "action", action: input.action }, signal, ctx);
			return { content: [{ type: "text", text: "The approved 1Password action completed." }], details: undefined };
		},
	});
}
