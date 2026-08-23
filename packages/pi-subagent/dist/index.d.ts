import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type HerdrExecutor } from "@henryqw/pi-herdr";
import { type AvailableModel, type ProfileName, type ResolvedTaskRoute, type ThinkingLevel } from "@henryqw/pi-task-models";
export interface Role {
    name: string;
    description: string;
    tools?: string[];
    extensions: string[];
    skills: string[];
    systemPrompt: string;
}
export interface PiLaunch {
    env: Record<string, string>;
    args: string[];
}
export interface ResolvedRoleLaunch extends PiLaunch {
    model: AvailableModel;
    thinkingLevel: ThinkingLevel;
    missingSkills: string[];
}
export interface CreateRoleLaunchInput {
    role: Role;
    route: ResolvedTaskRoute;
    extensions?: readonly string[];
    tools?: readonly string[];
    env?: Readonly<Record<string, string>>;
}
export interface ResolveRoleLaunchInput extends Omit<CreateRoleLaunchInput, "route"> {
    taskId: string;
    agentDir?: string;
}
export interface ResolvedRoleSkills {
    paths: string[];
    missing: string[];
}
export declare const isProfileName: (value: unknown) => value is ProfileName;
export declare function loadRoles(agentDir?: string): Role[];
export declare function resolveTaskRoute(ctx: ExtensionContext, profileName: ProfileName, agentDir?: string, thinking?: ThinkingLevel): ResolvedTaskRoute;
export declare function resolveRoleSkills(pi: Pick<ExtensionAPI, "getCommands">, role: Role): ResolvedRoleSkills;
export declare function createRoleLaunch(pi: Pick<ExtensionAPI, "getCommands">, ctx: Pick<ExtensionContext, "isProjectTrusted">, input: CreateRoleLaunchInput): ResolvedRoleLaunch;
export declare function resolveRoleLaunch(pi: Pick<ExtensionAPI, "getCommands">, ctx: ExtensionContext, input: ResolveRoleLaunchInput): ResolvedRoleLaunch;
export interface ManagedSubagentHost {
    cwd: string;
    workspaceId: string;
}
export interface ManagedSubagentCommandOptions {
    cwd: string;
}
export type ManagedSubagentExecutor = HerdrExecutor<ManagedSubagentCommandOptions>;
export interface ManagedSubagentHostOptions {
    execute: ManagedSubagentExecutor;
    delay?: (milliseconds: number) => Promise<void>;
}
export interface ManagedSubagentTab {
    tabId: string;
    paneId: string;
}
export declare function launchEnvironmentArgs(launch: PiLaunch): string[];
export declare function managedSubagentName(workspaceId: string, ...identity: string[]): string;
export declare function managedSubagentWorkspaceId(cwd: string, mainPane: string, options: ManagedSubagentHostOptions): Promise<string>;
/** Returns pane ID to Herdr status for agents owned by this workspace. */
export declare function listManagedSubagents(host: ManagedSubagentHost, options: ManagedSubagentHostOptions): Promise<Map<string, string>>;
export declare function createManagedSubagentTab(host: ManagedSubagentHost, cwd: string, launch: PiLaunch, label: string, options: ManagedSubagentHostOptions): Promise<ManagedSubagentTab>;
export declare function reconcileManagedSubagentTab(host: ManagedSubagentHost, input: {
    tabId?: string;
    paneId?: string;
    cwd: string;
    launch: PiLaunch;
    label: string;
}, options: ManagedSubagentHostOptions): Promise<ManagedSubagentTab>;
export declare function findManagedSubagentTab(host: ManagedSubagentHost, label: string, options: ManagedSubagentHostOptions): Promise<ManagedSubagentTab | undefined>;
export declare function managedSubagentTabExists(host: ManagedSubagentHost, tabId: string, options: ManagedSubagentHostOptions): Promise<boolean>;
export declare function reconcileManagedSubagentPane(host: ManagedSubagentHost, tabId: string, rootPaneId: string, cwd: string, launch: PiLaunch, label: string, options: ManagedSubagentHostOptions): Promise<string>;
export declare function startManagedSubagent(host: ManagedSubagentHost, agent: string, pane: string, launch: PiLaunch, options: ManagedSubagentHostOptions, hooks?: {
    beforeStart?: () => Promise<void>;
    onStarted?: () => Promise<void>;
}): Promise<"existing" | "started">;
export declare function promptManagedSubagent(host: ManagedSubagentHost, agent: string, prompt: string | Record<string, unknown>, options: ManagedSubagentHostOptions): Promise<void>;
export declare function retireManagedSubagentTab(host: ManagedSubagentHost, tabId: string, options: ManagedSubagentHostOptions): Promise<void>;
