import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskModelsExtension } from "@henryqw/pi-task-models";

export function registerTaskModelsExtension(pi: ExtensionAPI, options?: { agentDir?: string }): void {
	createTaskModelsExtension(pi, options);
}

export default function taskModelsExtension(pi: ExtensionAPI): void {
	registerTaskModelsExtension(pi);
}
