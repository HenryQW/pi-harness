import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

// These packages have consumers outside the declared dependency graph:
// pi-pr/test/pr-native.test.ts and pi-herdr-tools/test/loading.test.ts.
const crossPackageTestSources = new Set(["@henryqw/pi-subagent", "@henryqw/pi-ask-question"]);

/** Return selected workspace names, or null when all workspace tests are required. */
export function affectedWorkspaces(base, packageManagerExecPath) {
	const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const baseCommit = git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`).trim();
	const mergeBases = git("merge-base", "--all", baseCommit, "HEAD").trim().split("\n");
	if (mergeBases.length !== 1 || !mergeBases[0]) throw new Error(`A unique merge base is required for ${base}.`);
	const [mergeBase] = mergeBases;
	console.log(`Affected workspace tests: base ${base}, merge base ${mergeBase}`);

	// Read untracked paths first so staging between queries cannot omit a new file.
	const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").slice(0, -1);
	const changes = git("diff", "--no-renames", "--name-status", "-z", mergeBase, "--").split("\0").slice(0, -1);
	for (const file of untracked) {
		changes.push("A", file);
	}
	if (!changes.length) return [];
	const fullSuite = (reason) => {
		console.log(`Run all workspace tests: ${reason}`);
		return null;
	};
	// A changed graph can omit old consumers. Renames appear as deletion and addition.
	const versionChanged = new Set();
	for (let index = 0; index < changes.length; index += 2) {
		const file = changes[index + 1];
		if (!["A", "M"].includes(changes[index])) return fullSuite(`file change requires all tests (${changes[index]}): ${file}`);
		if (file !== "package.json" && !file.endsWith("/package.json")) continue;
		if (changes[index] !== "M" || !/^(extensions|packages)\/[^/]+\/package\.json$/.test(file)) {
			return fullSuite(`package manifest changed: ${file}`);
		}
		let previous, current;
		try {
			previous = JSON.parse(git("show", `${mergeBase}:${file}`));
			current = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return fullSuite(`cannot compare package manifest: ${file}`);
		}
		if (typeof previous?.version !== "string" || typeof current?.version !== "string" || typeof current.name !== "string") {
			return fullSuite(`invalid package manifest: ${file}`);
		}
		delete previous.version;
		delete current.version;
		if (!isDeepStrictEqual(previous, current)) return fullSuite(`package manifest changed beyond version: ${file}`);
		versionChanged.add(current.name);
	}

	const list = (args) => {
		const projects = JSON.parse(execFileSync(packageManagerExecPath, [...args, "list", "--depth", "-1", "--json"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		}));
		if (!Array.isArray(projects) || projects.some((project) => !project || typeof project.name !== "string" || typeof project.path !== "string")) {
			throw new Error("pnpm returned an invalid workspace list.");
		}
		return projects;
	};
	const projects = list(["--recursive"])
		.map((project) => ({ ...project, directory: relative(process.cwd(), project.path).replaceAll("\\", "/") }));
	const packages = projects.filter(({ directory }) => /^(extensions|packages)\/[^/]+$/.test(directory));
	const requiredPackages = new Set();
	for (let index = 1; index < changes.length; index += 2) {
		const file = changes[index];
		const owner = packages.find(({ directory }) => file.startsWith(`${directory}/`));
		if (!owner) return fullSuite(`change outside a current package: ${file}`);
		requiredPackages.add(owner.name);
	}

	if (versionChanged.size) {
		for (const project of projects) {
			let manifest;
			try {
				manifest = JSON.parse(readFileSync(`${project.path}/package.json`, "utf8"));
			} catch {
				return fullSuite(`cannot read consumer manifest: ${project.name}`);
			}
			if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return fullSuite(`invalid consumer manifest: ${project.name}`);
			for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
				const dependencies = manifest[field];
				if (dependencies === undefined) continue;
				if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return fullSuite(`invalid ${field}: ${project.name}`);
				for (const [name, spec] of Object.entries(dependencies)) {
					// Name-based ranges are safe; aliases, paths, and other protocols can hide consumers.
					const range = typeof spec === "string" ? spec.replace(/^workspace:/, "") : null;
					if (range === null || /[/:@\\#]/.test(range) || range === "." || range === ".." || /\.(tgz|tar(?:\.gz)?)$/.test(range)) {
						return fullSuite(`unsupported dependency reference: ${project.name} ${field}.${name}`);
					}
					if (versionChanged.has(name)) requiredPackages.add(project.name);
				}
			}
		}
	}

	const filters = [...requiredPackages].flatMap((name) => ["--filter", `...${name}`]);
	const selected = new Set(list(filters).map(({ name }) => name));
	if ([...requiredPackages].some((name) => !selected.has(name))) {
		throw new Error("pnpm affected selection omitted a required package. Run pnpm test and check the selector.");
	}
	if ([...crossPackageTestSources].some((name) => selected.has(name))) {
		return fullSuite("affected cross-package tests have no declared dependency edge");
	}
	return [...selected];
}
