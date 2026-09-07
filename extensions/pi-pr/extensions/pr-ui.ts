import { getCapabilities, hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import {
	deriveNextStep,
	derivePullRequestNextStep,
	type DiscoveryIssue,
	type NextStep,
	type PullRequest,
	type PullRequestDiscovery,
	type PullRequestTarget,
} from "./pr-routing.ts";

export type PrDisplayInput = PullRequest & {
	number: number;
	url: string | URL;
	approved: boolean;
	target: PullRequestTarget;
};

export type PrStatusColor = "accent" | "warning" | "success" | "error" | "dim";

export type PrFooter = {
	number?: number;
	url?: string;
	text: string;
	color: PrStatusColor;
};

export type PrDisplay = {
	nextStep: NextStep;
	footer?: PrFooter;
	widget?: string;
};

export type PrTheme = {
	fg(color: PrStatusColor | "text", text: string): string;
};

export function discoveryIssueKey(issue: DiscoveryIssue): string {
	switch (issue.kind) {
		case "candidate-remotes-ambiguous":
			return `${issue.kind}:${[...issue.remotes].sort().join(",")}`;
		case "candidate-prs-ambiguous":
			return `${issue.kind}:${issue.urls.map((url) => url.href).sort().join(",")}`;
		case "candidate-oid-mismatch":
			return `${issue.kind}:${issue.remote}:${issue.urls.map((url) => url.href).sort().join(",")}`;
		case "published-without-pr":
		case "link-configuration":
			return `${issue.kind}:${issue.remote}`;
		case "detached-head":
		case "origin-invalid":
		case "target-invalid":
			return issue.kind;
	}
}

export function discoveryIssueMessage(issue: DiscoveryIssue): string {
	switch (issue.kind) {
		case "detached-head":
			return "PR discovery is blocked because HEAD is detached";
		case "candidate-remotes-ambiguous":
			return `PR target is ambiguous across remotes: ${[...issue.remotes].sort().join(", ")}`;
		case "candidate-prs-ambiguous":
			return `PR target is ambiguous across pull requests: ${issue.urls.map((url) => url.href).sort().join(", ")}`;
		case "candidate-oid-mismatch":
			return `PR discovery is blocked because ${issue.remote} has a different pull request head`;
		case "published-without-pr":
			return `Branch is published on ${issue.remote}; configure it before creating a pull request`;
		case "link-configuration":
			return `PR discovery cannot safely link remote ${issue.remote}; simplify the branch push configuration first`;
		case "origin-invalid":
			return "PR creation is blocked because origin is not one validated GitHub destination";
		case "target-invalid":
			return "PR discovery is blocked by an invalid push target";
	}
}

function footerStatus(input: PrDisplayInput): Pick<PrFooter, "text" | "color"> {
	if (input.lifecycle === "merged") return { text: "merged", color: "success" };
	if (input.lifecycle === "closed") return { text: "closed", color: "dim" };

	const { conditions } = input;
	if (conditions.draft) return { text: "draft", color: "warning" };
	if (conditions.conflict) return { text: "merge conflict", color: "error" };
	if (conditions.baseUpdateRequired) return { text: "base update required", color: "warning" };
	if (conditions.ci === "failure") return { text: "CI failed", color: "error" };
	if (conditions.unresolvedThreads > 0) return { text: `${conditions.unresolvedThreads} unresolved`, color: "warning" };
	if (conditions.changesRequested) return { text: "changes requested", color: "error" };
	if (conditions.ci === "running") return { text: "CI running", color: "warning" };
	if (derivePullRequestNextStep(input) === "merge") return { text: "merge-ready", color: "success" };
	if (input.approved) return { text: "approved", color: "success" };
	return { text: "open", color: "accent" };
}

function widgetText(input: PrDisplayInput, nextStep: NextStep): string | undefined {
	switch (nextStep) {
		case "update-branch":
			return input.conditions.conflict
				? "Run /pr to resolve merge conflict"
				: "Run /pr to update branch";
		case "sweep":
			return "Run /pr to address review feedback";
		case "fix-ci":
			return "Run /pr to fix CI";
		case "merge":
			return "Run /pr to merge pull request";
		case "link-branch":
			return "Run /pr to link pull request branch";
		case "create":
		case "blocked":
		case "none":
			return undefined;
	}
}

export function projectPrDisplay(
	discovery: PullRequestDiscovery<PrDisplayInput>,
	hasLocalCommit = false,
): PrDisplay {
	const nextStep = deriveNextStep(discovery);
	if (discovery.kind === "inactive") return { nextStep };
	if (discovery.kind === "blocked") {
		const ambiguous = discovery.issue.kind === "candidate-remotes-ambiguous" ||
			discovery.issue.kind === "candidate-prs-ambiguous";
		return {
			nextStep,
			footer: {
				text: ambiguous ? "target ambiguous" : "discovery blocked",
				color: "warning",
			},
		};
	}
	if (discovery.kind === "none") {
		return {
			nextStep,
			widget: hasLocalCommit ? "Run /pr to create pull request" : undefined,
		};
	}

	const input = discovery.pullRequest;
	return {
		nextStep,
		footer: {
			number: input.number,
			url: typeof input.url === "string" ? input.url : input.url.href,
			...footerStatus(input),
		},
		widget: widgetText(input, nextStep),
	};
}

export function unavailablePrDisplay(): PrDisplay {
	return {
		nextStep: "none",
		footer: { text: "status unavailable", color: "warning" },
	};
}

export function formatPrFooter(display: PrDisplay, theme: PrTheme): string | undefined {
	if (!display.footer) return undefined;
	const prText = theme.fg("text", display.footer.number === undefined ? "PR" : `PR #${display.footer.number}`);
	const link = display.footer.url && getCapabilities().hyperlinks
		? hyperlink(prText, display.footer.url)
		: prText;
	return `${link} · ${theme.fg(display.footer.color, display.footer.text)}`;
}

export function formatPrWidget(display: PrDisplay, theme?: PrTheme, width?: number): string[] | undefined {
	if (display.widget === undefined) return undefined;
	if (width !== undefined && width <= 0) return [];
	const color = display.footer?.color ?? "accent";
	const icon = color === "error" ? "✗" : color === "warning" ? "!" : color === "success" ? "✓" : "●";
	const line = `${theme ? theme.fg(color, icon) : icon} ${display.widget}`;
	return [width === undefined ? line : truncateToWidth(line, Math.max(1, width))];
}
