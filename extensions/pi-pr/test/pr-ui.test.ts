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

test("projects every next step into one footer status and optional widget", () => {
	const cases: Array<{
		name: string;
		input: PrDisplayInput | null;
		nextStep: string;
		footer?: string;
		widget?: string;
	}> = [
		{
			name: "no pull request",
			input: null,
			nextStep: "create",
			widget: "Run /pr to create pull request",
		},
		{
			name: "required base update",
			input: pullRequest({ conditions: { baseUpdateRequired: true } }),
			nextStep: "update-branch",
			footer: "base update required",
			widget: "Run /pr to update branch",
		},
		{
			name: "merge conflict",
			input: pullRequest({ conditions: { conflict: true } }),
			nextStep: "update-branch",
			footer: "merge conflict",
			widget: "Run /pr to resolve merge conflict",
		},
		{
			name: "changes requested",
			input: pullRequest({ conditions: { changesRequested: true } }),
			nextStep: "sweep",
			footer: "changes requested",
			widget: "Run /pr to address review feedback",
		},
		{
			name: "CI failure",
			input: pullRequest({ conditions: { ci: "failure" } }),
			nextStep: "fix-ci",
			footer: "CI failed",
			widget: "Run /pr to fix CI",
		},
		{
			name: "waiting for CI",
			input: pullRequest({ conditions: { ci: "running" } }),
			nextStep: "none",
			footer: "CI running",
		},
		{
			name: "draft",
			input: pullRequest({ conditions: { draft: true } }),
			nextStep: "none",
			footer: "draft",
		},
		{
			name: "merge-ready",
			input: pullRequest({ conditions: { ci: "success" } }),
			nextStep: "merge",
			footer: "merge-ready",
			widget: "Run /pr to merge pull request",
		},
		{
			name: "approved but waiting",
			input: pullRequest({ approved: true, conditions: { policy: "pending" } }),
			nextStep: "none",
			footer: "approved",
		},
		{
			name: "open and waiting",
			input: pullRequest({ conditions: { review: "pending" } }),
			nextStep: "none",
			footer: "open",
		},
		{
			name: "merged",
			input: pullRequest({ lifecycle: "merged", conditions: { conflict: true, ci: "failure" } }),
			nextStep: "none",
			footer: "merged",
		},
		{
			name: "closed",
			input: pullRequest({ lifecycle: "closed", conditions: { changesRequested: true, ci: "failure" } }),
			nextStep: "none",
			footer: "closed",
		},
	];

	for (const { name, input, nextStep, footer, widget } of cases) {
		const display = projectPrDisplay(input);
		assert.equal(display.nextStep, nextStep, name);
		assert.equal(display.footer?.text, footer, `${name} footer`);
		assert.equal(formatPrWidget(display), widget, `${name} widget`);
	}
});

test("uses conflict and unresolved count before lower-priority conditions", () => {
	const conflict = projectPrDisplay(pullRequest({
		conditions: {
			baseUpdateRequired: true,
			conflict: true,
			changesRequested: true,
			unresolvedThreads: 3,
			ci: "failure",
		},
	}));
	assert.equal(conflict.nextStep, "update-branch");
	assert.equal(conflict.footer?.text, "merge conflict");
	assert.equal(formatPrWidget(conflict), "Run /pr to resolve merge conflict");

	const feedback = projectPrDisplay(pullRequest({
		conditions: {
			changesRequested: true,
			unresolvedThreads: 3,
			ci: "failure",
		},
	}));
	assert.equal(feedback.nextStep, "sweep");
	assert.equal(feedback.footer?.text, "3 unresolved");
	assert.equal(formatPrWidget(feedback), "Run /pr to address review feedback");
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
