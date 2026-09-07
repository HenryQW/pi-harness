import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerModelTask } from "@henryqw/pi-task-models";
import {
	createEphemeralSubagentExecutor,
	loadRoles,
	resolveRoleLaunch,
} from "@henryqw/pi-subagent";
import {
	AutoDagRunner,
	PrelaunchFailure,
	assertCleanGitWorkspace,
	identifyGitWorkspace,
	resolveGitRoot,
	type ChildRunInput,
	type ExecCommand,
} from "../src/runner.ts";
import {
	ExecuteRequestSchema,
	IdOnlySchema,
	ResumeRequestSchema,
	parseExecuteRequest,
	parseId,
	parseResumeRequest,
} from "../src/schema.ts";

const AUTO_DAG_TASK = {
	id: "pi-auto-dag/task",
	label: "Auto DAG task",
	purpose: "Run one serial durable task in a shared Git workspace.",
	defaultProfile: "fast",
} as const;

const CHILD_TIMEOUT = { idleMs: 10 * 60_000, maxMs: 30 * 60_000 };

function toolResult(response: Awaited<ReturnType<AutoDagRunner["execute"]>>) {
	return {
		content: [{ type: "text" as const, text: response.text }],
		details: { state: response.state, ...(response.drift === undefined ? {} : { drift: response.drift }) },
		...(response.usage === undefined ? {} : { usage: response.usage }),
	};
}

export default function autoDagExtension(pi: ExtensionAPI): void {
	registerModelTask(pi, AUTO_DAG_TASK);
	const executor = createEphemeralSubagentExecutor({
		maxConcurrency: 1,
		maxTurns: 50,
		timeout: CHILD_TIMEOUT,
	});
	let latestCtx: ExtensionContext | undefined;
	const exec: ExecCommand = (command, args, options) => pi.exec(command, args, options);

	const runner = new AutoDagRunner({
		now: () => Date.now(),
		resolveRoot: (cwd, signal) => resolveGitRoot(exec, cwd, signal),
		assertClean: (root, signal) => assertCleanGitWorkspace(exec, root, signal),
		identifyWorkspace: (root, signal) => identifyGitWorkspace(exec, root, signal),
		exec: (command, args, options) => pi.exec(command, args, options),
		async runChild(input: ChildRunInput) {
			input.signal.throwIfAborted();
			const ctx = latestCtx;
			if (!ctx) throw new PrelaunchFailure("Pi session context is unavailable.");
			let roles;
			try {
				roles = loadRoles();
			} catch (error) {
				throw new PrelaunchFailure(`Role configuration failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			const role = roles.find(({ name }) => name === input.role);
			if (!role) {
				throw new PrelaunchFailure(
					`Unknown Subagent Role ${JSON.stringify(input.role)}. Available Roles: ${roles.map(({ name }) => name).join(", ") || "none"}.`,
				);
			}
			let launch;
			try {
				launch = resolveRoleLaunch(pi, ctx, { role, task: AUTO_DAG_TASK, modelClass: input.modelClass });
			} catch (error) {
				throw new PrelaunchFailure(
					`Role or task-model route failed for ${JSON.stringify(input.role)}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			if (launch.missingSkills.length) {
				ctx.ui.notify(`Subagent Role ${input.role} skipped unavailable Skills: ${launch.missingSkills.join(", ")}.`, "warning");
			}
			return await executor.run({
				signal: input.signal,
				prepare: async () => {
					await input.onLaunch?.();
					return { launch, task: input.task, cwd: input.cwd };
				},
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		void runner.recover(ctx.cwd).catch((error) => {
			ctx.ui.notify(`Auto DAG recovery failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	});
	pi.on("model_select", (event, ctx) => {
		latestCtx = { ...ctx, model: event.model };
	});
	pi.on("agent_settled", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.registerTool({
		name: "auto_dag_execute",
		label: "Auto DAG execute",
		description: "Start one validated durable request and run its dependent tasks serially in the current clean Git workspace.",
		promptSnippet: "Run durable dependent tasks serially in one shared Git workspace",
		promptGuidelines: [
			"Use Auto DAG for non-trivial dependent work. Execute trivial requests directly in Main.",
			"Supply exact Role names, fast or balanced model classes, direct command/args checks, and an explicit total elapsed budget.",
			"Add judgment only for a criterion that direct checks cannot establish. Reviewers are never implicit.",
		],
		parameters: ExecuteRequestSchema,
		prepareArguments: parseExecuteRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			return toolResult(await runner.execute(params, ctx.cwd, signal));
		},
	});

	pi.registerTool({
		name: "auto_dag_status",
		label: "Auto DAG status",
		description: "Read one durable Auto DAG request and report workspace drift without changing it.",
		parameters: IdOnlySchema,
		prepareArguments(value) {
			return { id: parseId(value) };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			return toolResult(await runner.status(params, ctx.cwd));
		},
	});

	pi.registerTool({
		name: "auto_dag_resume",
		label: "Auto DAG resume",
		description: "Deliberately retry, replace, or verify unfinished work, rerun final verification, or approve an unchanged checked final judgment.",
		parameters: ResumeRequestSchema,
		prepareArguments: parseResumeRequest,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			latestCtx = ctx;
			return toolResult(await runner.resume(params, ctx.cwd, signal));
		},
	});

	pi.registerTool({
		name: "auto_dag_abort",
		label: "Auto DAG abort",
		description: "Stop this process's active Auto DAG request or mark an inactive unfinished request for attention.",
		parameters: IdOnlySchema,
		prepareArguments(value) {
			return { id: parseId(value) };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			return toolResult(await runner.abort(params, ctx.cwd));
		},
	});
}
