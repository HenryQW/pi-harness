import { execFileSync } from "node:child_process";
import {
	constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync,
	renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const original = 'modelText=isSelected?theme.fg("accent",item.id):item.id,name=getDistinctModelName({id:item.id,name:item.model.name}),nameText=name?theme.fg("muted",` (${name})`):"",providerBadge=theme.fg("muted",`[${item.provider}]`),line=`${cursor}${currentMarker}${modelText}${nameText} ${providerBadge}${defaultBadge}`';
const replacement = [
	"",
	"/* shortcut: Keep this local relay label rule until Pi supports display aliases. */",
	'isMagpieRelay = item.provider === "magpie" && item.id.startsWith("vps/"),',
	'label = isMagpieRelay ? item.id.slice("vps/".length) : item.id,',
	'modelText = isSelected ? theme.fg("accent", label) : label,',
	'name = isMagpieRelay ? undefined : getDistinctModelName({id:item.id,name:item.model.name}),',
	'nameText = name ? theme.fg("muted", ` (${name})`) : "",',
	'providerBadge = isMagpieRelay ? "" : ` ${theme.fg("muted", `[${item.provider}]`)}`,',
	'line = `${cursor}${currentMarker}${modelText}${nameText}${providerBadge}${defaultBadge}`',
].join("\n");

function patchPicker(install) {
	install = realpathSync(install);
	const pin = join(install, "current-version");
	const version = readFileSync(pin, "utf8").trim();
	if (!/^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) throw new Error(`Invalid Pi version in ${pin}`);
	const modules = join(install, "releases", version, "node_modules");
	const bundle = join(modules, "@earendil-works", "pi-coding-agent", "dist", "bundle");
	const cli = join(bundle, "cli.js");
	if (realpathSync(join(modules, ".bin", "pi")) !== cli
		|| !readFileSync(cli, "utf8").includes('createRequire(import.meta.url)("./cli-runtime.js");')) {
		throw new Error(`Pi ${version} does not launch the expected bundle`);
	}
	const runtime = join(bundle, "cli-runtime.js");
	if (realpathSync(runtime) !== runtime) throw new Error(`Pi runtime is outside its expected path: ${runtime}`);
	const imports = [...readFileSync(runtime, "utf8").matchAll(/import\{configureHttpDispatcher,main\}from"\.\/chunks\/(chunk-[A-Z0-9]+\.js)";/g)];
	if (imports.length !== 1) throw new Error(`Expected one main bundle import for Pi ${version}`);
	const chunks = join(bundle, "chunks");
	const path = join(chunks, imports[0][1]);
	if (realpathSync(path) !== path) throw new Error(`Pi main bundle is outside its expected path: ${path}`);
	const info = lstatSync(path);
	if (!info.isFile()) throw new Error(`Pi main bundle is not a regular file: ${path}`);
	const source = readFileSync(path, "utf8");
	const backup = `${path}.picker-labels-original`;
	const backupError = `Missing or invalid Pi picker backup: ${backup}`;
	if (!source.includes('Model Name: ${selected.model.name}')) {
		throw new Error(`Picker rendering changed in Pi ${version}: ${path}`);
	}
	if (source.split(replacement).length === 2 && !source.includes(original)) {
		if (!lstatSync(backup, { throwIfNoEntry: false })?.isFile()) throw new Error(backupError);
		const saved = readFileSync(backup, "utf8");
		if (saved.split(original).length !== 2 || saved.replace(original, () => replacement) !== source) {
			throw new Error(backupError);
		}
		console.log(`Pi ${version} picker labels already patched: ${path}`);
		console.log(`Original bundle: ${backup}`);
		return;
	}
	if (source.split(original).length !== 2 || source.includes(replacement)) {
		throw new Error(`Picker rendering changed in Pi ${version}: ${path}`);
	}

	const temporary = mkdtempSync(join(chunks, ".picker-labels-"));
	try {
		const edited = join(temporary, "picker.js");
		writeFileSync(edited, source.replace(original, () => replacement), { mode: info.mode & 0o777 });
		execFileSync(process.execPath, ["--check", edited], { stdio: "inherit" });
		try {
			copyFileSync(path, backup, constants.COPYFILE_EXCL);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		if (!lstatSync(backup).isFile() || readFileSync(backup, "utf8") !== source) throw new Error(backupError);
		if (readFileSync(path, "utf8") !== source || readFileSync(pin, "utf8").trim() !== version) {
			throw new Error(`Pi changed while preparing the patch: ${path}`);
		}
		renameSync(edited, path);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	console.log(`Patched Pi ${version} picker labels: ${path}`);
	console.log(`Original bundle: ${backup}`);
}

try {
	patchPicker(process.argv[2] ?? join(homedir(), ".pi", "agent", "install"));
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
