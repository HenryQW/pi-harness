import { join, resolve } from "node:path";

const [rootInput, id] = process.argv.slice(2);
if (!rootInput || !id) throw new Error("Usage: fake-profile-resolver.mjs <root> <profile-id>");
const root = resolve(rootInput);
const coding = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];
const tools = id === "reviewer" ? ["read", "bash", "grep", "find", "ls", "web_search"] : coding;
process.stdout.write(JSON.stringify({
	version: 1,
	id,
	description: `${id} test profile`,
	agent_dir: join(root, "profiles", id),
	skills: [join(root, "profiles", id, ".agents", "skills"), join(root, "shared-skills", ".agents", "skills")],
	tools,
}));
