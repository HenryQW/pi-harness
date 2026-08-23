import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const PROFILE_NAMES: readonly ["fast", "balanced", "frontier", "fav"];
export type ProfileName = (typeof PROFILE_NAMES)[number];
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export declare const DEFAULT_TASK_ASSIGNMENTS: {
    readonly "pi-herdr-btw/btw": "fast";
    readonly "pi-herdr-rename/rename": "fast";
    readonly "pi-auto-compact/autoCompact": "fast";
    readonly "pi-subagent/delegateTask": "balanced";
    readonly "pi-auto-dag/implement": "balanced";
    readonly "pi-auto-dag/review": "frontier";
};
export type TaskModelRoute = {
    model: string;
    thinkingLevel: ThinkingLevel;
};
export type TaskModelProfile = {
    primary: TaskModelRoute;
    fallback?: TaskModelRoute;
};
export type TaskModelsConfig = {
    profiles: Partial<Record<ProfileName, TaskModelProfile>>;
    tasks: Record<string, ProfileName>;
};
export type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];
export type ResolvedTaskRoute = {
    model: AvailableModel;
    thinkingLevel: ThinkingLevel;
};
export type ActiveTaskPackage = {
    packageName: string;
    task: string;
};
export declare const configPath: (agentDir?: string) => string;
export declare function readTaskModelsConfig(agentDir?: string): TaskModelsConfig;
export declare function writeTaskModelsConfig(config: TaskModelsConfig, agentDir?: string): void;
export declare function canonicalModelReference(model: {
    provider: string;
    id: string;
} | string): string;
export declare function modelReference(model: {
    provider: string;
    id: string;
}): string;
export declare function dedupeAvailableModels(models: readonly AvailableModel[], preferredProvider?: string): AvailableModel[];
export declare function resolveAvailableModel(models: readonly AvailableModel[], reference: string, preferredProvider?: string): AvailableModel | undefined;
export declare function supportedThinkingLevels(model: AvailableModel): ThinkingLevel[];
export declare function availableTaskModels(ctx: ExtensionContext): AvailableModel[];
export declare function taskThinkingLevels(ctx: ExtensionContext, model: AvailableModel): ThinkingLevel[];
export declare function rememberedThinkingLevel(model: {
    provider: string;
    id: string;
} | string, agentDir?: string): ThinkingLevel | undefined;
export declare function resolveTaskModelRoute(ctx: ExtensionContext, route: TaskModelRoute, agentDir?: string, thinking?: ThinkingLevel): ResolvedTaskRoute | undefined;
export declare function resolveConfiguredTaskRoutes(ctx: ExtensionContext, task: string, agentDir?: string, thinking?: ThinkingLevel): ResolvedTaskRoute[];
export type TaskRouteErrorCode = "config-read" | "task-unassigned" | "profile-missing" | "no-route";
export type TaskRouteError = Error & {
    taskRouteCode: TaskRouteErrorCode;
    profileName?: ProfileName;
};
export declare function resolveConfiguredTaskRoute(ctx: ExtensionContext, task: string, agentDir?: string, thinking?: ThinkingLevel): ResolvedTaskRoute;
export declare function orderedProfileRoutes(profile: TaskModelProfile): TaskModelRoute[];
export declare function activeTaskPackages(pi: Pick<ExtensionAPI, "getCommands" | "getAllTools">, tasks?: Readonly<Record<string, ProfileName>>): ActiveTaskPackage[];
export declare function createTaskModelsExtension(pi: ExtensionAPI, options?: {
    agentDir?: string;
}): void;
export default function taskModelsExtension(pi: ExtensionAPI): void;
