import { spawn } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { markGateHostReady } from "./command.ts";

const [recordPath, launchId, command, ...arguments_] = process.argv.slice(2);
if (!recordPath || !launchId || !command) throw new Error("Required gate host arguments are incomplete");

const control = await markGateHostReady(recordPath, launchId);
while (true) {
	if (await exists(control.cancel)) await cancelLaunch(control.ready, control.cancel);
	if (await exists(control.release)) break;
	await new Promise((resolve) => setTimeout(resolve, 5));
}
await unlink(control.release);
if (await exists(control.cancel)) await cancelLaunch(control.ready, control.cancel);

const child = spawn(command, arguments_, { cwd: process.cwd(), stdio: "inherit" });
child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
child.once("close", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function cancelLaunch(readyPath: string, cancelPath: string): Promise<never> {
	await Promise.all([removeFile(readyPath), removeFile(cancelPath)]);
	throw new Error("Required gate launch was cancelled");
}

async function removeFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}
