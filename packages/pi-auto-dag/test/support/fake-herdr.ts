import { runCommand, type CommandRunner } from "../../src/command.ts";

export interface FakeHerdrOptions {
	fail_tab_close?: number;
	busy_starts?: number;
	plain_busy_starts?: number;
	fail_agent_prompt?: number;
	crash_after_tab_create?: number;
	crash_after_pane_split?: number;
}

export interface FakeHerdrCall {
	command: string;
	args: string[];
}

export interface FakeHerdr {
	runner: CommandRunner;
	calls: FakeHerdrCall[];
	live: Set<string>;
	agentPanes: Map<string, string>;
	tabs: Map<string, { tab_id: string; label: string; workspace_id: string }>;
	panes: Map<string, { pane_id: string; tab_id: string; label?: string }>;
	count(action: string): number;
}

export function fakeHerdr(input: FakeHerdrOptions = {}): FakeHerdr {
	let tab = 0;
	let pane = 0;
	let remainingCloseFailures = input.fail_tab_close ?? 0;
	let remainingBusyStarts = input.busy_starts ?? 0;
	let remainingPlainBusyStarts = input.plain_busy_starts ?? 0;
	let remainingPromptFailures = input.fail_agent_prompt ?? 0;
	let remainingTabCreateCrashes = input.crash_after_tab_create ?? 0;
	let remainingPaneSplitCrashes = input.crash_after_pane_split ?? 0;
	const live = new Set<string>();
	const agentPanes = new Map<string, string>();
	const tabs = new Map<string, { tab_id: string; label: string; workspace_id: string }>();
	const panes = new Map<string, { pane_id: string; tab_id: string; label?: string }>();
	const calls: FakeHerdrCall[] = [];
	const runner: CommandRunner = async (command, arguments_, options) => {
		const args = [...arguments_];
		calls.push({ command, args });
		if (command !== "herdr") return await runCommand(command, args, options);
		switch (args.slice(0, 2).join(" ")) {
			case "tab create": {
				const tabId = `tab-${++tab}`;
				const paneId = `pane-${++pane}`;
				tabs.set(tabId, { tab_id: tabId, label: args[args.indexOf("--label") + 1], workspace_id: args[args.indexOf("--workspace") + 1] });
				panes.set(paneId, { pane_id: paneId, tab_id: tabId });
				if (remainingTabCreateCrashes-- > 0) return { code: 1, stdout: "", stderr: "simulated create crash" };
				return success({ result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } });
			}
			case "tab list":
				return success({ result: { tabs: [...tabs.values()] } });
			case "tab get": {
				const value = tabs.get(args[2]);
				return value ? success({ result: { tab: value } }) : herdrError("tab_not_found");
			}
			case "pane list":
				return success({ result: { panes: [...panes.values(), { pane_id: "main-pane", workspace_id: "main-workspace" }] } });
			case "pane split": {
				const parent = panes.get(args[args.indexOf("--pane") + 1]);
				if (!parent) return herdrError("pane_not_found");
				const paneId = `pane-${++pane}`;
				panes.set(paneId, { pane_id: paneId, tab_id: parent.tab_id });
				if (remainingPaneSplitCrashes-- > 0) return { code: 1, stdout: "", stderr: "simulated split crash" };
				return success({ result: { pane: { pane_id: paneId } } });
			}
			case "pane rename": {
				const value = panes.get(args[2]);
				if (!value) return herdrError("pane_not_found");
				value.label = args[3];
				return success({ result: {} });
			}
			case "agent start":
				if (remainingBusyStarts-- > 0) return herdrError("agent_pane_busy");
				if (remainingPlainBusyStarts-- > 0) return { code: 1, stdout: "", stderr: "agent_pane_busy" };
				live.add(args[2]);
				agentPanes.set(args[2], args[args.indexOf("--pane") + 1]);
				return success({ result: {} });
			case "agent get": {
				const paneId = live.has(args[2]) ? agentPanes.get(args[2]) : undefined;
				return paneId ? success({ result: { agent: { agent: "pi", pane_id: paneId } } }) : herdrError("agent_not_found");
			}
			case "agent list":
				return success({ result: { agents: [...live].map((agent) => {
					const paneId = agentPanes.get(agent)!;
					const tabId = panes.get(paneId)?.tab_id;
					return { agent: "pi", agent_status: "working", pane_id: paneId, workspace_id: tabId ? tabs.get(tabId)?.workspace_id : undefined };
				}) } });
			case "agent prompt":
				if (remainingPromptFailures-- > 0) return { code: 1, stdout: "", stderr: "simulated prompt crash" };
				return success({ result: {} });
			case "tab close": {
				if (remainingCloseFailures-- > 0) return { code: 1, stdout: "", stderr: "tab busy" };
				if (!tabs.delete(args[2])) return herdrError("tab_not_found");
				for (const [agent, paneId] of agentPanes) if (panes.get(paneId)?.tab_id === args[2]) {
					live.delete(agent);
					agentPanes.delete(agent);
				}
				for (const [paneId, value] of panes) if (value.tab_id === args[2]) panes.delete(paneId);
				return success({ result: {} });
			}
			default:
				return { code: 1, stdout: "", stderr: `Unexpected Herdr command: ${args.join(" ")}` };
		}
	};
	return {
		runner,
		calls,
		live,
		agentPanes,
		tabs,
		panes,
		count(action) { return calls.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === action).length; },
	};
}

function success(value: unknown) {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function herdrError(code: string) {
	return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
}
