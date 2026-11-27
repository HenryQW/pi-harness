import { isIP } from "node:net";
import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore, field, parsers, registerConfigReporting } from "@henryqw/pi-config-store";
import { Type } from "typebox";
import { forward, isActionName, localApproval, opArgs, parseProbe, probeOutput, probeScript, runOp, socketPath } from "../src/bridge.mjs";

const extensionId = "pi-1password";
const profileId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const sshHost = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const sshUser = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const sshPort = /^(?:ssh:\/\/)(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?([a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:.]+\])(?::([0-9]{1,5}))?$/;
const remoteProbe = `/bin/sh -c '${probeScript.replaceAll("'", "'\\''")}'`;

type Machine = { id: string; label: string; target: string; enabled: boolean };
type ApprovalMachine = Machine & { identity: string };
type Selection = { kind: "local"; executable: string } | { kind: "remote"; machine: ApprovalMachine; socket: string };

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
			}), {
				key(value) {
					if (typeof value !== "string" || !profileId.test(value)) throw new Error("Use a Herdr machine profile ID.");
					return value;
				},
			}), {}, { onInvalid: "disable" }),
		},
		check({ targets }) {
			const sockets = Object.values(targets).map(({ socket }) => socket);
			if (sockets.some((socket) => !socket)) throw new Error("Every approval Mac needs a socket path.");
			if (new Set(sockets).size !== sockets.length) throw new Error("Approval Macs need distinct socket paths.");
		},
	});
	const reporter = registerConfigReporting(pi, [store]);
	let selected: Selection | undefined;
	const origin = hostname();

	async function requestRemote(selection: Extract<Selection, { kind: "remote" }>, input: Parameters<typeof forward>[1], signal: AbortSignal | undefined, ctx: ExtensionContext) {
		const loaded = store.loadSync();
		reporter.report(ctx, store, loaded);
		if (loaded.status !== "ok" || loaded.issues.length) throw new Error(`Fix ${store.path} before using 1Password.`);
		const { id, target, identity } = selection.machine;
		const profile = (await listMachines(probe)).find((machine) => machine.id === id && machine.enabled);
		if (profile?.target !== target || loaded.value.targets[id]?.socket !== selection.socket) {
			throw new Error("The selected approval route changed. Select it again with /1password.");
		}
		return forward(selection.socket, input, signal, identity);
	}

	pi.registerCommand("1password", {
		description: "Select an approval Mac with op installed",
		async handler(args, ctx) {
			const requested = args.trim();
			const notify = (message: string) => {
				const status = `Pi host: ${origin}. ${message}`;
				if (ctx.hasUI) ctx.ui.notify(status, "info");
				else process.stderr.write(`${status}\n`);
			};
			const local = !requested || requested === "local" ? await localApproval(probe) : null;
			if (requested === "local") {
				if (!local) throw new Error("Local approval requires macOS and the native op command.");
				selected = { kind: "local", executable: local.executable };
				notify("1Password approval: local.");
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
			const loaded = store.loadSync();
			reporter.report(ctx, store, loaded);
			if (loaded.status !== "ok" || loaded.issues.length) throw new Error(`Fix ${store.path} before selecting an approval Mac.`);
			const { targets } = loaded.value;
			const options = new Map<string, ApprovalMachine | "local">();
			if (local) options.set("local", "local");
			for (const machine of machines) {
				const needsSocket = Object.hasOwn(targets, machine.id) ? "" : " - socket setup required";
				options.set(`${machine.label} (${machine.id})${needsSocket}`, machine);
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
				notify("1Password approval: local.");
				return;
			}
			const socket = Object.hasOwn(targets, choice.id) ? targets[choice.id].socket : null;
			if (!socket) throw new Error(`Configure targets.${choice.id}.socket in ${store.path} and start the approval tunnel on ${choice.label}.`);
			selected = { kind: "remote", machine: choice, socket };
			notify(`1Password approval: ${choice.label}.`);
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
