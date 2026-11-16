import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCanonicalGitRootResolver } from "../dist/composition.js";
import { CheckedGitRuntime } from "../dist/git-runtime.js";
import { HerdrHostRuntime } from "../dist/herdr-runtime.js";
import { RoleLaunchRuntime } from "../dist/launch-runtime.js";
import { WorkspaceRunner } from "../dist/workspace.js";
import { WorkspaceActionSchema, type WorkspaceRequest, type WorkspaceState } from "../dist/workspace-schema.js";
import type { ExecutionPolicySnapshot } from "../dist/schema.js";
import { workerOutputForMain } from "./result-transport.ts";
import { captureFallbackWarning } from "./task-model-fallback.ts";

/** Workspace requests keep their own versioned set state; scalar requests retain their existing contract. */
export function registerWorkspaceExtension(pi: ExtensionAPI, policy: () => ExecutionPolicySnapshot) {
	let current: ExtensionContext | undefined, epoch = 0;
	const jobs = new Map<AbortController, { session: string; epoch: number; accepted: boolean }>();
	const git = new CheckedGitRuntime();
	const host = (saved: ExecutionPolicySnapshot) => new HerdrHostRuntime({
		inspectInFlightTaskCandidate: git.inspectInFlightTaskCandidate.bind(git),
		executionBudget: () => ({ maxTurns: saved.maxTurns, maxMs: saved.childMaxMs, ...(saved.maxTokens === undefined ? {} : { maxTokens: saved.maxTokens }) }),
	});
	const coordinator = new RoleLaunchRuntime({ pi, context: () => {
		policy();
		if (!current) throw new Error("Workspace Role launch has no current Pi context.");
		return current;
	}, captureFallbackWarning: (signal) => {
		if (!current) throw new Error("Workspace Role launch has no current Pi context.");
		const ctx = current, capturedEpoch = epoch, sessionId = ctx.sessionManager.getSessionId();
		return captureFallbackWarning(pi, ctx, () => epoch === capturedEpoch && current?.sessionManager.getSessionId() === sessionId, signal);
	}, resolveRoot: createCanonicalGitRootResolver(), inspectMainBase: git.inspectMainBase.bind(git) });
	const runner = new WorkspaceRunner({ coordinator, git, policy, host,
		preflightHost: async (root, operation) => await host(policy()).preflightHost({ root, nonGitWorkspace: true }, operation) });
	const stop = () => { epoch++; for (const controller of jobs.keys()) controller.abort(); };
	pi.on("session_start", (_event, ctx) => { stop(); current = ctx; });
	pi.on("session_shutdown", () => { stop(); current = undefined; });
	pi.on("model_select", (event, ctx) => { current = { ...ctx, model: event.model }; });
	const result = (state: WorkspaceState) => {
		// Keep identities complete. Check output stays in the private state, not in a large inline dump.
		const evidence = (value: WorkspaceState["final"]) => value && { ...value, results: value.results.map(({ stdout: _stdout, stderr: _stderr, ...item }) => item) };
		const details = { ...state, preliminary: evidence(state.preliminary), final: evidence(state.final) };
		return { content: [{ type: "text" as const, text: `Workspace ${state.request.id}: ${state.status}. ${state.failure ?? ""}\n${JSON.stringify(details)}` }], details };
	};
	pi.registerTool({ name: "subagent_workspace", label: "Subagent workspace", exposure: "model-only",
		description: "Inspect or act on one explicit multi-repository request. stage takes the complete candidate set as expected; validate and promote take the complete integration tip set. Promotion is serial, not atomic. After any interrupted or partial promotion, reconcile first, then explicitly promote remaining targets. abort retains work; cleanup removes only fully promoted, clean, exactly owned resources. No rollback or automatic replay.",
		parameters: WorkspaceActionSchema,
		async execute(_id, params, signal, _update, ctx) { current = ctx; return result(await runner.action(params, ctx.cwd, signal)); },
	});
	return {
		hasPendingResult: (session: string) => [...jobs].some(([controller, job]) => job.session === session && job.epoch === epoch && job.accepted && !controller.signal.aborted),
		async plan(request: WorkspaceRequest, signal: AbortSignal | undefined, ctx: ExtensionContext) {
			current = ctx;
			const plan = await runner.plan(request, ctx.cwd, signal);
			return { content: [{ type: "text" as const, text: `Workspace dry run passed. No resources created. Not checked: Herdr host, admission, worker, or checks.\n${JSON.stringify(plan)}` }], details: { dryRun: true, ...plan } };
		},
		async execute(request: WorkspaceRequest, signal: AbortSignal | undefined, ctx: ExtensionContext) {
			current = ctx;
			const controller = new AbortController(), job = { session: ctx.sessionManager.getSessionId(), epoch, accepted: false };
			jobs.set(controller, job);
			const abort = () => controller.abort(signal?.reason);
			if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
			let accept!: (state: WorkspaceState) => void, reject!: (error: unknown) => void;
			const accepted = new Promise<WorkspaceState>((resolve, fail) => { accept = resolve; reject = fail; });
			const deliverable = () => epoch === job.epoch && current?.sessionManager.getSessionId() === job.session && ctx.sessionManager.getSessionId() === job.session;
			void runner.execute(request, ctx.cwd, controller.signal, (state) => {
				job.accepted = true; signal?.removeEventListener("abort", abort); accept(state);
			}).then((state) => {
				jobs.delete(controller);
				if (!deliverable()) return;
				try { pi.sendMessage({ customType: "pi-subagent-workspace-result", content: workerOutputForMain(result(state).content[0]!.text), display: true }, { triggerTurn: true, deliverAs: "followUp" }); }
				catch { console.error("Workspace result delivery failed; inspect subagent_workspace status. Saved resources are retained."); }
			}, (error: unknown) => {
				jobs.delete(controller); signal?.removeEventListener("abort", abort);
				if (!job.accepted) { reject(error); return; }
				if (deliverable()) {
					try { pi.sendMessage({ customType: "pi-subagent-workspace-result", content: `Workspace ${request.id} stopped. Inspect subagent_workspace status before recovery.`, display: true }, { triggerTurn: true, deliverAs: "followUp" }); }
					catch { console.error("Workspace failure delivery failed; saved resources are retained."); }
				}
			});
			const state = await accepted;
			if (!deliverable()) throw new Error("Workspace request was saved, but its launching session changed. Inspect subagent_workspace status.");
			return { content: [{ type: "text" as const, text: `Workspace ${state.request.id} saved; one worker will receive the complete selected worktree map. Use subagent_workspace status. No repository is promoted automatically.` }], details: { id: state.request.id, root: state.root } };
		},
	};
}
