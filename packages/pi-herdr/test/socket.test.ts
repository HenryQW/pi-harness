import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HerdrRequestError, requestHerdr } from "../src/socket.ts";

async function server(t: TestContext, respond: (request: any) => string | undefined) {
	const root = await mkdtemp(join(tmpdir(), "herdr-socket-"));
	const path = join(root, "api.sock");
	let calls = 0;
	const socket = createServer((client) => {
		let buffer = "";
		client.on("error", () => {});
		client.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.endsWith("\n")) return;
			calls++;
			const response = respond(JSON.parse(buffer));
			if (response !== undefined) client.end(response);
		});
	});
	await new Promise<void>((resolve) => socket.listen(path, resolve));
	t.after(async () => { await new Promise<void>((resolve) => socket.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
	return { path, calls: () => calls };
}

test("socket request preserves argument arrays and accepts only its response identity", async (t) => {
	const command = ["node", "/tmp/a b", "quotes '\"\n雪"];
	const endpoint = await server(t, (request) => {
		assert.equal(request.method, "layout.apply");
		assert.deepEqual(request.params.root.command, command);
		return JSON.stringify({ id: request.id, result: { type: "layout_apply" } }) + "\n";
	});
	assert.deepEqual(await requestHerdr("layout.apply", { root: { command } }, { socketPath: endpoint.path }), { type: "layout_apply" });
	assert.equal(endpoint.calls(), 1);
	const foreign = await server(t, () => '{"id":"foreign","result":{}}\n');
	await assert.rejects(requestHerdr("ping", {}, { socketPath: foreign.path }), (error: HerdrRequestError) => error.code === "identity" && error.dispatched);
});

test("uncertain mutation times out once, and structured failures retain their code", async (t) => {
	const endpoint = await server(t, () => undefined);
	await assert.rejects(requestHerdr("layout.apply", {}, { socketPath: endpoint.path, timeoutMs: 30 }), (error: HerdrRequestError) => error.code === "timeout" && error.dispatched);
	assert.equal(endpoint.calls(), 1);
	const failed = await server(t, (request) => JSON.stringify({ id: request.id, error: { code: "invalid_params", message: "Invalid layout" } }) + "\n");
	await assert.rejects(requestHerdr("layout.apply", {}, { socketPath: failed.path }), (error: HerdrRequestError) => error.code === "invalid_params" && error.message === "Invalid layout");
});

test("abort before dispatch sends nothing; oversized and malformed responses fail closed", async (t) => {
	const endpoint = await server(t, () => "invalid\n");
	await assert.rejects(requestHerdr("ping", {}, { socketPath: endpoint.path, signal: AbortSignal.abort() }), (error: HerdrRequestError) => error.code === "aborted" && !error.dispatched);
	assert.equal(endpoint.calls(), 0);
	await assert.rejects(requestHerdr("ping", {}, { socketPath: endpoint.path }), (error: HerdrRequestError) => error.code === "response_invalid");
	const large = await server(t, () => "x".repeat(1024 * 1024 + 1));
	await assert.rejects(requestHerdr("ping", {}, { socketPath: large.path }), (error: HerdrRequestError) => error.code === "response_limit");
});
