// Opt-in, model-backed skill evals. See evals/README.md.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	applyHermeticEnv,
	configuredModel,
	evalsDir,
	killActiveRuns,
	loadSuites,
	prepareRunRoot,
	requiredPasses,
	runTrial,
	type TrialResult,
	validateSuite,
} from "./harness.ts";

const { values } = parseArgs({
	options: {
		skill: { type: "string", multiple: true },
		case: { type: "string" },
		trials: { type: "string", default: "3" },
		model: { type: "string" },
		concurrency: { type: "string", default: "2" },
		list: { type: "boolean", default: false },
	},
});

function positiveInt(name: string, value: string): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer, got ${value}`);
	return number;
}
const trials = positiveInt("trials", values.trials);
const concurrency = positiveInt("concurrency", values.concurrency);

const suites = await loadSuites();
const errors = suites.flatMap(validateSuite);
if (errors.length) {
	console.error(`Invalid case definitions:\n${errors.map((error) => `  ${error}`).join("\n")}`);
	process.exit(1);
}

const selected = suites.flatMap((suite) =>
	suite.cases
		.filter((c) => (!values.skill || values.skill.includes(suite.name)) && (!values.case || values.case === c.id || values.case === `${suite.name}/${c.id}`))
		.map((c) => ({ suite: suite.name, c, label: `${suite.name}/${c.id}` })),
);

if (values.list) {
	for (const { label, c } of selected) console.log(`${label.padEnd(56)} ${c.kind}`);
	console.log(`${selected.length} case(s) valid`);
	process.exit(0);
}
if (!selected.length) {
	console.error("No cases match the filters.");
	process.exit(1);
}

const model = values.model ?? configuredModel();
const root = prepareRunRoot();
applyHermeticEnv(root);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
	process.once(signal, () => {
		killActiveRuns();
		rmSync(root, { recursive: true, force: true });
		process.exit(code);
	});
}
const resultsDir = join(evalsDir, ".results", new Date().toISOString().replaceAll(":", "-"));
console.log(`Running ${selected.length} case(s) x ${trials} trial(s), model ${model ?? "Pi default"}, concurrency ${concurrency}`);

const jobs = selected.flatMap((entry) => Array.from({ length: trials }, (_, index) => ({ ...entry, trial: index + 1 })));
const results = new Map(selected.map(({ label }) => [label, [] as TrialResult[]]));
let next = 0;
async function worker() {
	while (next < jobs.length) {
		const job = jobs[next++];
		const result = await runTrial(job.suite, job.c, job.trial, { root, resultsDir, model });
		console.log(`  ${result.grade.pass ? "pass" : "FAIL"} ${job.label} t${job.trial} (${Math.round(result.durationMs / 1000)} s)`);
		results.get(job.label)![job.trial - 1] = result;
	}
}
try {
	await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
	rmSync(root, { recursive: true, force: true });
}

let failed = 0;
const rows: string[][] = [["case", "kind", "passed", "need", "result"]];
const details: string[] = [];
for (const { label, c } of selected) {
	const caseResults = results.get(label)!;
	const passed = caseResults.filter((result) => result.grade.pass).length;
	const need = requiredPasses(c.kind, trials);
	const ok = passed >= need;
	if (!ok) failed++;
	rows.push([label, c.kind, `${passed}/${trials}`, String(need), ok ? "PASS" : "FAIL"]);
	for (const [index, result] of caseResults.entries()) {
		if (!result.grade.pass) details.push(`${label} trial ${index + 1}: ${result.grade.reasons.join("; ").slice(0, 400)}`);
	}
}
const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
console.log(`\n${rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n")}`);
if (details.length) console.log(`\nFailures:\n${details.map((line) => `  ${line}`).join("\n")}`);
const models = [...new Set([...results.values()].flat().flatMap((result) => (result.model ? [result.model] : [])))];
console.log(`\nModels used: ${models.join(", ") || "none"}. Traces: ${resultsDir}`);
process.exit(failed ? 1 : 0);
