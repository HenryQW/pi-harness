import { DEFAULT_CONFIG } from "../internal/config.ts";
import { createPayload, type BtwPayload, type CreatePayloadOptions } from "../internal/core.ts";

export function fixturePayloadOptions(
	overrides: Partial<CreatePayloadOptions> = {},
): CreatePayloadOptions {
	return {
		createdAt: "2026-07-15T00:00:00.000Z",
		parentSessionId: "12345678-1234-1234-1234-123456789abc",
		parentPaneId: "w1:p1",
		metadata: {
			generatedAt: "2026-07-15T00:00:00.000Z",
			cwd: "/tmp/project",
			session: "/tmp/session.jsonl",
			model: "test-provider/test-model",
		},
		parentSystemPrompt: "parent system prompt",
		parentActiveTools: ["read", "bash"],
		parentThinkingLevel: "high",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "parent question" }],
				timestamp: 1,
			},
		],
		draftQuestion: "question",
		config: { ...DEFAULT_CONFIG },
		...overrides,
	};
}

export function fixturePayload(overrides: Partial<CreatePayloadOptions> = {}): BtwPayload {
	return createPayload(fixturePayloadOptions(overrides));
}
