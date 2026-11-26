import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("native package filters load the footer, tool rows, and open commands independently", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-footer-resources-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const source = fileURLToPath(new URL("../", import.meta.url));
	for (const selected of [undefined, "open", "footer", "tool-rows"]) {
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({
				packages: [{ source, ...(selected ? { extensions: [`extensions/${selected}.ts`] } : {}) }],
			}),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.deepEqual(extensions.map((extension) => basename(extension.path)).sort(),
			selected ? [`${selected}.ts`] : ["footer.ts", "open.ts", "tool-rows.ts"]);
		assert.deepEqual(extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
			{ footer: [], open: ["open", "set-open-in"], "tool-rows": ["tool-rows"] }[selected ?? ""] ?? ["open", "set-open-in", "tool-rows"]);
	}
});
