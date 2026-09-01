import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import {
	deriveNextStep,
	type NextStep,
	type PullRequest,
} from "./pr-routing.ts";

export type PrDisplayInput = PullRequest & {
	number: number;
	url: string | URL;
	approved: boolean;
};

export type PrStatusColor = "accent" | "warning" | "success" | "error" | "dim";

export type PrFooter = {
	number: number;
	url: string;
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

function footerStatus(input: PrDisplayInput, nextStep: NextStep): Pick<PrFooter, "text" | "color"> {
	if (input.lifecycle === "merged") return { text: "merged", color: "success" };
	if (input.lifecycle === "closed") return { text: "closed", color: "dim" };

	const { conditions } = input;
	if (conditions.draft) return { text: "draft", color: "warning" };
	if (conditions.conflict) return { text: "merge conflict", color: "error" };
	if (conditions.baseUpdateRequired) return { text: "base update required", color: "warning" };
	if (conditions.unresolvedThreads > 0) return { text: `${conditions.unresolvedThreads} unresolved`, color: "warning" };
	if (conditions.changesRequested) return { text: "changes requested", color: "error" };
	if (conditions.ci === "failure") return { text: "CI failed", color: "error" };
	if (conditions.ci === "running") return { text: "CI running", color: "warning" };
	if (nextStep === "merge") return { text: "merge-ready", color: "success" };
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
		case "create":
		case "none":
			return undefined;
	}
}

export function projectPrDisplay(input: PrDisplayInput | null, hasLocalCommit = false): PrDisplay {
	const nextStep = deriveNextStep(input);
	if (input === null) {
		return {
			nextStep,
			widget: hasLocalCommit ? "Run /pr to create pull request" : undefined,
		};
	}

	const status = footerStatus(input, nextStep);
	return {
		nextStep,
		footer: {
			number: input.number,
			url: typeof input.url === "string" ? input.url : input.url.href,
			...status,
		},
		widget: widgetText(input, nextStep),
	};
}

export function formatPrFooter(display: PrDisplay, theme: PrTheme): string | undefined {
	if (!display.footer) return undefined;
	const prText = theme.fg("text", `PR #${display.footer.number}`);
	const link = getCapabilities().hyperlinks ? hyperlink(prText, display.footer.url) : prText;
	return `${link} · ${theme.fg(display.footer.color, display.footer.text)}`;
}

export function formatPrWidget(display: PrDisplay): string | undefined {
	return display.widget;
}
