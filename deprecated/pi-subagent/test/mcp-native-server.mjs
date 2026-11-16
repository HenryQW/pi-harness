import { createInterface } from "node:readline";

const tools = ["permitted", "private", "scripted", "delayed", "fallback"].map((name) => ({
	name, description: `Local ${name} tool`, inputSchema: { type: "object", properties: {} },
}));
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-test", version: "1.0.0" } };
			break;
		case "tools/list": result = { tools }; break;
		case "tools/call": result = { content: [{ type: "text", text: request.params.name }] }; break;
		default:
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
			continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
