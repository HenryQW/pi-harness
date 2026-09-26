import assert from "node:assert/strict";
import test from "node:test";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import {
	discoveryIssueDetails,
	formatPrFooter,
	formatPrWidget,
	projectPrDisplay as projectDiscoveryDisplay,
	type PrDisplayInput,
	type PrStatusColor,
	type PrTheme,
} from "../extensions/pr-ui.ts";
import type {
	DiscoveryIssue,
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
const target = {
	provenance: "configured" as const,
	branch: "feature/pr",
	remote: "origin",
	ref: "feature/pr",
	repository: "acme/project",
	host: "github.com",
	fetchSource: "git@github.com:acme/project.git",
	remoteOid: "b".repeat(40),
};

function projectPrDisplay(
	input: PrDisplayInput | null,
	ahead = 0,
	worktree: "clean" | "dirty" | "operation" = "clean",
	relation: "same-ref" | "distinct-ref" = "distinct-ref",
) {
	return input
		? projectDiscoveryDisplay({ kind: "current", pullRequest: input })
		: projectDiscoveryDisplay({
			kind: "none",
			creationTarget: target,
			branch: { ahead, worktree, relation },
		});
}
const theme: PrTheme = {
	fg(color: PrStatusColor | "text", text: string) {
		return `<${color}>${text}</${color}>`;
	},
};
const ansiTheme: PrTheme = {
	fg(_color, text) {
		return `\x1b[36m${text}\x1b[0m`;
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
		url: new URL("https://github.com/acme/project/pull/42"),
		approved: overrides.approved ?? false,
		lifecycle: overrides.lifecycle ?? "open",
		conditions: { ...conditions, ...overrides.conditions },
		local: { ...local, ...overrides.local },
		target,
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

test("blocker details preserve sorted identity and exact notification text", () => {
	const urls = [new URL("https://github.com/acme/project/pull/43"), new URL("https://github.com/acme/project/pull/42")];
	const cases: Array<[DiscoveryIssue, string, string]> = [
		[{ kind: "detached-head" }, "detached-head", "PR discovery is blocked because HEAD is detached"],
		[{ kind: "candidate-remotes-ambiguous", remotes: ["origin", "fork"] }, "candidate-remotes-ambiguous:fork,origin", "PR target is ambiguous across remotes: fork, origin"],
		[{ kind: "candidate-prs-ambiguous", urls }, "candidate-prs-ambiguous:https://github.com/acme/project/pull/42,https://github.com/acme/project/pull/43", "PR target is ambiguous across pull requests: https://github.com/acme/project/pull/42, https://github.com/acme/project/pull/43"],
		[{ kind: "candidate-oid-mismatch", remote: "fork", urls }, "candidate-oid-mismatch:fork:https://github.com/acme/project/pull/42,https://github.com/acme/project/pull/43", "PR discovery is blocked because fork has a different pull request head"],
		[{ kind: "published-without-pr", remote: "fork" }, "published-without-pr:fork", "Branch is published on fork; configure it before creating a pull request"],
		[{ kind: "link-configuration", remote: "fork" }, "link-configuration:fork", "PR discovery cannot safely link remote fork; simplify the branch push configuration first"],
		[{ kind: "origin-invalid" }, "origin-invalid", "PR creation is blocked because origin is not one validated GitHub destination"],
		[{ kind: "target-invalid" }, "target-invalid", "PR discovery is blocked by an invalid push target"],
	];
	for (const [issue, key, message] of cases) assert.deepEqual(discoveryIssueDetails(issue), { key, message });
});

test("projects normal runnable, merge, and no-action states", () => {
	const cases: Array<{
		name: string;
		input: PrDisplayInput | null;
		ahead?: number;
		nextStep: string;
		footer?: string;
		color?: PrStatusColor;
		widget?: string;
	}> = [
		{
			name: "no pull request with zero ahead commits",
			input: null,
			nextStep: "none",
		},
		{
			name: "no pull request with positive ahead commits",
			input: null,
			ahead: 1,
			nextStep: "create",
			widget: "Run /pr to create pull request",
		},
		{
			name: "required base update",
			input: pullRequest({ conditions: { baseUpdateRequired: true, policy: "pending" } }),
			nextStep: "none",
			footer: "base update required",
			color: "warning",
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
			name: "unsupported CI failure",
			input: pullRequest({ conditions: { ci: "failure-blocked" } }),
			nextStep: "none",
			footer: "CI failed",
			color: "error",
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

	for (const { name, input, ahead, nextStep, footer, color, widget } of cases) {
		const display = projectPrDisplay(input, ahead);
		assert.equal(display.nextStep, nextStep, name);
		assert.equal(display.footer?.text, footer, `${name} footer`);
		assert.equal(display.footer?.color, color, `${name} color`);
		assert.equal(display.widget, widget, `${name} widget`);
	}
});

test("shows creation only for actionable pending branch state", () => {
	assert.deepEqual(projectPrDisplay(null, 0, "dirty", "distinct-ref"), {
		nextStep: "create",
		widget: "Run /pr to create pull request",
	});
	assert.deepEqual(projectPrDisplay(null, 0, "operation", "distinct-ref"), {
		nextStep: "none",
		widget: undefined,
	});
	assert.deepEqual(projectPrDisplay(null, 0, "dirty", "same-ref"), {
		nextStep: "none",
		widget: undefined,
	});
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
			name: "behind base does not suppress CI",
			input: pullRequest({ conditions: {
				baseUpdateRequired: true,
				changesRequested: true,
				unresolvedThreads: 3,
				ci: "failure",
			} }),
			nextStep: "fix-ci",
			footer: "base update required",
			color: "warning",
			widget: "Run /pr to fix CI",
		},
		{
			name: "unresolved feedback before changes requested",
			input: pullRequest({ conditions: {
				changesRequested: true,
				unresolvedThreads: 3,
			} }),
			nextStep: "sweep",
			footer: "3 unresolved",
			color: "warning",
			widget: "Run /pr to address review feedback",
		},
		{
			name: "CI failure before feedback",
			input: pullRequest({ conditions: { changesRequested: true, unresolvedThreads: 3, ci: "failure" } }),
			nextStep: "fix-ci",
			footer: "CI failed",
			color: "error",
			widget: "Run /pr to fix CI",
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
		assert.equal(display.widget, widget, `${name} widget`);
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

test("prefixes plain actions with themed semantic icons", () => {
	const cases = [
		{
			name: "error",
			display: projectPrDisplay(pullRequest({ conditions: { conflict: true } })),
			color: "error",
			icon: "✗",
			text: "Run /pr to resolve merge conflict",
		},
		{
			name: "warning",
			display: projectPrDisplay(pullRequest({ conditions: { conflict: true, baseUpdateRequired: true } })),
			color: "error",
			icon: "✗",
			text: "Run /pr to resolve merge conflict",
		},
		{
			name: "success",
			display: projectPrDisplay(pullRequest({ conditions: { ci: "success" } })),
			color: "success",
			icon: "✓",
			text: "Run /pr to merge pull request",
		},
		{
			name: "accent",
			display: projectPrDisplay(null, 1),
			color: "accent",
			icon: "●",
			text: "Run /pr to create pull request",
		},
	];

	for (const { name, display, color, icon, text } of cases) {
		const plainWidget = formatPrWidget(display);
		assert.deepEqual(plainWidget, [`${icon} ${text}`], `${name} plain`);
		assert.doesNotMatch(plainWidget?.[0] ?? "", /\x1b/, `${name} plain ANSI`);
		assert.deepEqual(formatPrWidget(display, theme), [`<${color}>${icon}</${color}> ${text}`], name);
	}
	assert.equal(formatPrWidget({ nextStep: "none" }, undefined, 0), undefined);
});

test("truncates the themed action line to narrow TUI widths", () => {
	const display = projectPrDisplay(pullRequest({ conditions: { unresolvedThreads: 123_456_789 } }));
	assert.equal(display.footer?.text, "123456789 unresolved");
	assert.equal(display.widget, "Run /pr to address review feedback");

	for (const width of [-1, 0]) assert.deepEqual(formatPrWidget(display, ansiTheme, width), []);
	const widget = formatPrWidget(display, ansiTheme, 8);
	assert.equal(widget?.length, 1);
	assert.ok(widget?.every((line) => visibleWidth(line) <= 8));
});

test("routes dirty work before a merge conflict", () => {
	const display = projectPrDisplay(pullRequest({
		conditions: { conflict: true },
		local: { worktree: "dirty", head: "equal" },
	}));
	assert.equal(display.nextStep, "publish-work");
	assert.equal(display.footer?.text, "merge conflict");
	assert.equal(display.footer?.color, "error");
	assert.equal(display.widget, "Run /pr to publish local work");
});
