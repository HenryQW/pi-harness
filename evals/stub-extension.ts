// Loaded by Pi children through `-e`. Registers scripted stub tools from the JSON spec at
// PI_EVAL_STUB_SPEC. Stubs only return scripted text: no shell, file, or network access.
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StubResponse, StubTool } from "./types.ts";

export default function (pi: ExtensionAPI) {
	const tools: StubTool[] = JSON.parse(readFileSync(process.env.PI_EVAL_STUB_SPEC!, "utf8"));
	for (const tool of tools) {
		const cursors = new Map<string, number>();
		const next = (key: string, queue: StubResponse[]) => {
			const index = cursors.get(key) ?? 0;
			cursors.set(key, index + 1);
			return queue[Math.min(index, queue.length - 1)];
		};
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			parameters: (tool.parameters ?? { type: "object", additionalProperties: true }) as never,
			async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
				const action = typeof params.action === "string" ? params.action : undefined;
				const byAction = Array.isArray(tool.responses) ? undefined : tool.responses;
				// A `<action>:<id>` queue for a string `id` argument takes precedence over the `<action>` queue.
				const byId = action !== undefined && typeof params.id === "string" ? `${action}:${params.id}` : undefined;
				const selected = byId !== undefined && byAction?.[byId] ? byId : action;
				const queue = byAction ? (selected === undefined ? undefined : byAction[selected]) : (tool.responses as StubResponse[]);
				const key = byAction ? `action:${selected}` : "default";
				const response = queue?.length ? next(key, queue) : { text: `stub ${tool.name}: no scripted response for ${key}`, isError: true };
				const { text: scripted, isError } = typeof response === "string" ? { text: response, isError: false } : response;
				// `{{cwd}}` and `{{<string argument>}}` become JSON-escaped values, so fixtures can echo trial-specific text.
				const text = scripted.replace(/\{\{(\w+)\}\}/g, (token, key: string) => {
					const value = key === "cwd" ? ctx.cwd : params[key];
					return typeof value === "string" ? JSON.stringify(value).slice(1, -1) : token;
				});
				if (isError) throw new Error(text);
				return { content: [{ type: "text", text }], details: {} };
			},
		});
	}
}
