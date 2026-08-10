import { spawn } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { markGateHostReady } from "./command.ts";

const [recordPath, launchId, command, ...arguments_] = process.argv.slice(2);
if (!recordPath || !launchId || !command) throw new Error("Required gate host arguments are incomplete");

const releasePath = await markGateHostReady(recordPath, launchId);
while (true) {
	try {
		await access(releasePath);
		break;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
await unlink(releasePath);

const child = spawn(command, arguments_, { cwd: process.cwd(), stdio: "inherit" });
child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
child.once("close", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
