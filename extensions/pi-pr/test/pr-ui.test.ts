import assert from "node:assert/strict";
import test from "node:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import {
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay,
	type PrDisplayInput,
	type PrStatusColor,
	type PrTheme,
} from "../extensions/pr-ui.ts";
import type {
	LocalMergeSafety,
	PullRequestConditions,
	PullRequestLifecycle,
} from "../extensions/pr-routing.ts";

const conditions: PullRequestConditions = {
	draft: false,
	baseUpdateRequired: false,
	conflict: false,
	changesRequested: false,
	unresolvedThreads: 0,
	ci: "none",
	review: "ready",
	policy: "ready",
};
const local: LocalMergeSafety = { worktree: "clean", head: "equal" };
const theme: PrTheme = {
	fg(color: PrStatusColor, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

function pullRequest(overrides: {
	lifecycle?: PullRequestLifecycle;
	conditions?: Partial<PullRequestConditions>;
	local?: Partial<LocalMergeSafety>;
	approved?: boolean;
} = {}): PrDisplayInput {
	return {
		number: 42,
		url: "https://github.com/acme/project/pull/42",
		approved: overrides.approved ?? false,
		lifecycle: overrides.lifecycle ?? "open",
		conditions: { ...conditions, ...overrides.conditions },
		local: { ...local, ...overrides.local },
	};
}

const plain = (text: string) => text
	.replace(/\x1b\]8;;.*?\x1b\\/g, "")
	.replace(/<\/?[^>]+>/g, "");

function withCapabilities(hyperlinks: boolean, fn: () => void): void {
	const previous = getCapabilities();
	try {
		setCapabilities({ ...previous, hyperlinks });
		fn();
	} finally {
		setCapabilities(previous);
	}
}

test("projects normal runnable, merge, and no-action states", () => {
	const cases: Array<{
		name: string;
		input: PrDisplayInput | null;
		localCommit?: boolean;
		nextStep: string;
		footer?: string;
		color?: PrStatusColor;
		widget?: string;
	}> = [
		{
			name: "no pull request after local commit",
			input: null,
			localCommit: true,
			nextStep: "create",
			widget: "Run /pr to create pull request",
		},
		{
			name: "required base update",
			input: pullRequest({ conditions: { baseUpdateRequired: true } }),
			nextStep: "update-branch",
			footer: "base update required",
			color: "warning",
			widget: "Run /pr to update branch",
		},
		{
			name: "merge conflict",
			input: pullRequest({ conditions: { conflict: true } }),
			nextStep: "update-branch",
			footer: "merge conflict",
			color: "error",
			widget: "Run /pr to resolve merge conflict",
		},
		{
			name: "changes requested",
			input: pullRequest({ conditions: { changesRequested: true } }),
			nextStep: "sweep",
			footer: "changes requested",
			color: "error",
			widget: "Run /pr to address review feedback",
		},
		{
			name: "CI failure",
			input: pullRequest({ conditions: { ci: "failure" } }),
			nextStep: "fix-ci",
			footer: "CI failed",
			color: "error",
			widget: "Run /pr to fix CI",
		},
		{
			name: "waiting for CI",
			input: pullRequest({ conditions: { ci: "running" } }),
			nextStep: "none",
			footer: "CI running",
			color: "warning",
		},
		{
			name: "draft before running CI",
			input: pullRequest({ conditions: { draft: true, ci: "running" } }),
			nextStep: "none",
			footer: "draft",
			color: "warning",
		},
		{
			name: "merge-ready",
			input: pullRequest({ conditions: { ci: "success" } }),
			nextStep: "merge",
			footer: "merge-ready",
			color: "success",
			widget: "Run /pr to merge pull request",
		},
		{
			name: "approved but waiting",
			input: pullRequest({ approved: true, conditions: { policy: "pending" } }),
			nextStep: "none",
			footer: "approved",
			color: "success",
		},
		{
			name: "open and waiting",
			input: pullRequest({ conditions: { review: "pending" } }),
			nextStep: "none",
			footer: "open",
			color: "accent",
		},
		{
			name: "merged",
			input: pullRequest({ lifecycle: "merged", conditions: { conflict: true, ci: "failure" } }),
			nextStep: "none",
			footer: "merged",
			color: "success",
		},
		{
			name: "closed",
			input: pullRequest({ lifecycle: "closed", conditions: { changesRequested: true, ci: "failure" } }),
			nextStep: "none",
			footer: "closed",
			color: "dim",
		},
	];

	for (const { name, input, localCommit, nextStep, footer, color, widget } of cases) {
		const display = projectPrDisplay(input, localCommit);
		assert.equal(display.nextStep, nextStep, name);
		assert.equal(display.footer?.text, footer, `${name} footer`);
		assert.equal(display.footer?.color, color, `${name} color`);
		assert.equal(formatPrWidget(display), widget, `${name} widget`);
	}
});

test("uses visible-condition priority for combined states", () => {
	const cases: Array<{
		name: string;
		input: PrDisplayInput;
		nextStep: string;
		footer: string;
		color: PrStatusColor;
		widget?: string;
	}> = [
		{
			name: "draft before every open condition",
			input: pullRequest({ conditions: {
				draft: true,
				conflict: true,
				changesRequested: true,
				unresolvedThreads: 3,
				ci: "failure",
			} }),
			nextStep: "none",
			footer: "draft",
			color: "warning",
		},
		{
			name: "conflict before base update, feedback, and CI",
			input: pullRequest({ conditions: {
				baseUpdateRequired: true,
				conflict: true,
				changesRequested: true,
				unresolvedThreads: 3,
				ci: "failure",
			} }),
			nextStep: "update-branch",
			footer: "merge conflict",
			color: "error",
			widget: "Run /pr to resolve merge conflict",
		},
		{
			name: "base update before feedback and CI",
			input: pullRequest({ conditions: {
				baseUpdateRequired: true,
				changesRequested: true,
				unresolvedThreads: 3,
				ci: "failure",
			} }),
			nextStep: "update-branch",
			footer: "base update required",
			color: "warning",
			widget: "Run /pr to update branch",
		},
		{
			name: "unresolved feedback before changes requested and CI",
			input: pullRequest({ conditions: {
				changesRequested: true,
				unresolvedThreads: 3,
				ci: "failure",
			} }),
			nextStep: "sweep",
			footer: "3 unresolved",
			color: "warning",
			widget: "Run /pr to address review feedback",
		},
		{
			name: "changes requested before CI",
			input: pullRequest({ conditions: { changesRequested: true, ci: "failure" } }),
			nextStep: "sweep",
			footer: "changes requested",
			color: "error",
			widget: "Run /pr to address review feedback",
		},
		{
			name: "CI failure before waiting",
			input: pullRequest({ conditions: { ci: "failure", review: "pending", policy: "pending" } }),
			nextStep: "fix-ci",
			footer: "CI failed",
			color: "error",
			widget: "Run /pr to fix CI",
		},
		{
			name: "running CI before approved fallback",
			input: pullRequest({ approved: true, conditions: { ci: "running" } }),
			nextStep: "none",
			footer: "CI running",
			color: "warning",
		},
	];

	for (const { name, input, nextStep, footer, color, widget } of cases) {
		const display = projectPrDisplay(input);
		assert.equal(display.nextStep, nextStep, name);
		assert.equal(display.footer?.text, footer, `${name} footer`);
		assert.equal(display.footer?.color, color, `${name} color`);
		assert.equal(formatPrWidget(display), widget, `${name} widget`);
	}
});

test("formats themed footer text with OSC-8 only when supported", () => {
	const display = projectPrDisplay(pullRequest({ conditions: { review: "pending" } }));

	withCapabilities(true, () => {
		const footer = formatPrFooter(display, theme);
		if (footer === undefined) throw new Error("expected footer");
		assert.match(footer, /\x1b\]8;;https:\/\/github\.com\/acme\/project\/pull\/42\x1b\\/);
		assert.match(footer, /<text>PR #42<\/text>/);
		assert.equal(plain(footer), "PR #42 · open");
	});

	withCapabilities(false, () => {
		const footer = formatPrFooter(display, theme);
		if (footer === undefined) throw new Error("expected footer");
		assert.equal(footer, "<text>PR #42</text> · <accent>open</accent>");
		assert.doesNotMatch(footer, /\x1b\]8;;/);
		assert.equal(plain(footer), "PR #42 · open");
	});
});

test("keeps blocked mutating conditions in the footer without a widget", () => {
	const actions: Array<{
		name: string;
		conditions: Partial<PullRequestConditions>;
		footer: string;
		color: PrStatusColor;
	}> = [
		{ name: "base update", conditions: { baseUpdateRequired: true }, footer: "base update required", color: "warning" },
		{ name: "conflict", conditions: { conflict: true }, footer: "merge conflict", color: "error" },
		{ name: "changes requested", conditions: { changesRequested: true }, footer: "changes requested", color: "error" },
		{ name: "unresolved feedback", conditions: { unresolvedThreads: 2 }, footer: "2 unresolved", color: "warning" },
		{ name: "failed CI", conditions: { ci: "failure" }, footer: "CI failed", color: "error" },
	];
	const blocked: Array<{ name: string; local: LocalMergeSafety }> = [
		{ name: "dirty", local: { worktree: "dirty", head: "equal" } },
		{ name: "behind", local: { worktree: "clean", head: "behind" } },
		{ name: "ahead", local: { worktree: "clean", head: "ahead" } },
		{ name: "diverged", local: { worktree: "clean", head: "diverged" } },
	];

	for (const action of actions) {
		for (const local of blocked) {
			const display = projectPrDisplay(pullRequest({
				conditions: action.conditions,
				local: local.local,
			}));
			const name = `${action.name} ${local.name}`;
			assert.equal(display.nextStep, "none", `${name} route`);
			assert.equal(display.footer?.text, action.footer, `${name} footer`);
			assert.equal(display.footer?.color, action.color, `${name} color`);
			assert.equal(formatPrWidget(display), undefined, `${name} widget`);
		}
	}
});

test("clears widget for non-actionable projections", () => {
	const actionable = projectPrDisplay(pullRequest({ conditions: { ci: "failure" } }));
	assert.equal(formatPrWidget(actionable), "Run /pr to fix CI");

	const cleared = [
		projectPrDisplay(pullRequest({ conditions: { ci: "running" } })),
		projectPrDisplay(pullRequest({ conditions: { review: "pending" } })),
		projectPrDisplay(pullRequest({ conditions: { draft: true } })),
		projectPrDisplay(pullRequest({ lifecycle: "merged" })),
		projectPrDisplay(pullRequest({ lifecycle: "closed" })),
	];
	for (const display of cleared) assert.equal(formatPrWidget(display), undefined);
});
