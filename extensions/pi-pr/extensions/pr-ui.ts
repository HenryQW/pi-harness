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

	switch (nextStep) {
		case "update-branch":
			return input.conditions.conflict
				? { text: "merge conflict", color: "error" }
				: { text: "base update required", color: "warning" };
		case "sweep":
			return input.conditions.unresolvedThreads > 0
				? { text: `${input.conditions.unresolvedThreads} unresolved`, color: "warning" }
				: { text: "changes requested", color: "error" };
		case "fix-ci":
			return { text: "CI failed", color: "error" };
		case "merge":
			return { text: "merge-ready", color: "success" };
		case "none":
			if (input.conditions.ci === "running") return { text: "CI running", color: "warning" };
			if (input.conditions.draft) return { text: "draft", color: "warning" };
			if (input.approved) return { text: "approved", color: "success" };
			return { text: "open", color: "accent" };
		case "create":
			throw new Error("create is only valid without a pull request");
	}
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

export function projectPrDisplay(input: PrDisplayInput | null): PrDisplay {
	const nextStep = deriveNextStep(input);
	if (input === null) return { nextStep, widget: "Run /pr to create pull request" };

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
