// Copy of the retired session parser. The archive is outside the workspace, so this test cannot import it.
type Json = Record<string, unknown>;

const DIRECT_OUTCOMES = ["succeeded", "failed", "blocked"] as const;

const object = (value: unknown, label: string): Json => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed Herdr ${label}.`);
	return value as Json;
};
const field = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Malformed Herdr ${label}.`);
	return value;
};

function exactFinalTurn(jsonl: string, prompt: string): Json | undefined {
	const lines = jsonl.trimEnd().split("\n");
	let userId: string | undefined;
	let final: Json | undefined;
	let finalId: string | undefined;
	const parents = new Map<string, string>();
	for (const line of lines) {
		const entry = object(JSON.parse(line) as unknown, "session entry");
		if (entry.type === "session") continue;
		const id = field(entry.id, "session entry id");
		if (typeof entry.parentId === "string") parents.set(id, entry.parentId);
		if (entry.type !== "message") continue;
		const message = object(entry.message, "session message");
		if (message.role === "user" && Array.isArray(message.content)
			&& message.content.length === 1 && object(message.content[0], "user content").text === prompt) {
			userId = id;
			final = undefined;
			finalId = undefined;
		} else if (userId && message.role === "user") {
			throw new Error("Pi session contains an unexpected user turn after direct delegation.");
		} else if (userId && message.role === "assistant") {
			final = message;
			finalId = id;
		}
	}
	let ancestor = finalId;
	const seen = new Set<string>();
	while (ancestor && ancestor !== userId && !seen.has(ancestor)) {
		seen.add(ancestor);
		ancestor = parents.get(ancestor);
	}
	return userId && ancestor === userId ? final : undefined;
}

export function exactDirectAnswer(jsonl: string, prompt: string, requireSuccess = false): string {
	const final = exactFinalTurn(jsonl, prompt);
	if (!final || final.stopReason !== "stop" || !Array.isArray(final.content)) {
		throw new Error("Pi did not persist an exact successful final answer for this prompt.");
	}
	const text = final.content.flatMap((part) => {
		const content = object(part, "assistant content");
		return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
	}).join("\n");
	if (!text.trim()) throw new Error("Pi persisted an empty final answer.");
	if (!requireSuccess) return text;
	let completion: Json;
	try { completion = JSON.parse(text) as Json; }
	catch (error) { throw new Error("Pi write-access final answer must be a JSON completion object.", { cause: error }); }
	if (!completion || typeof completion !== "object" || Array.isArray(completion)
		|| !DIRECT_OUTCOMES.some((outcome) => outcome === completion.outcome)
		|| typeof completion.answer !== "string" || !completion.answer.trim()) {
		throw new Error("Pi write-access completion must have a valid outcome and a non-empty answer.");
	}
	if (completion.outcome !== "succeeded") throw new Error(`Direct task reported ${completion.outcome}: ${completion.answer}`);
	return completion.answer;
}
