import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_OPTION_LABEL = "Something else.";
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const withRecommended = (label: string): string => `${label.replace(RECOMMENDED_SUFFIX, "")} (Recommended)`;

export interface AskQuestionOption {
	label: string;
	description?: string;
}

export interface AskQuestionRequest {
	question: string;
	options: AskQuestionOption[];
}

export interface AskQuestionResult {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	selectedIndex?: number;
	error?: string;
}

type AskQuestionContext = Pick<ExtensionContext, "mode" | "ui">;

/** Run the validated interactive question flow shared by consumers. */
export async function askQuestion(
	params: AskQuestionRequest,
	ctx: AskQuestionContext,
	signal?: AbortSignal,
): Promise<AskQuestionResult> {
	const question = params.question.trim();
	const suppliedOptions = params.options.map((option) => ({
		label: option.label.trim(),
		...(option.description === undefined ? {} : { description: option.description.trim() }),
	}));
	const options = suppliedOptions.map((option) => option.label);
	if (ctx.mode !== "tui") {
		const error = "UI not available (running in non-interactive mode)";
		return { question, options, answer: null, error };
	}
	let validationError: string | undefined;
	if (!question) validationError = "Question must not be blank";
	else if (suppliedOptions.length < 1 || suppliedOptions.length > 3) validationError = "Provide one to three options";
	else if (suppliedOptions.some((option) => !option.label)) validationError = "Option labels must not be blank";
	else if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) validationError = "Option labels must be unique";
	else if (options.some((option) => option.toLowerCase() === CUSTOM_OPTION_LABEL.toLowerCase())) validationError = `Option label "${CUSTOM_OPTION_LABEL}" is reserved`;
	if (validationError) return { question, options, answer: null, error: validationError };

	const choices = suppliedOptions.map((option, index) => {
		const label = index === 0 ? withRecommended(option.label) : option.label;
		return `${index + 1}. ${label}${option.description ? ` — ${option.description}` : ""}`;
	});
	choices.push(`${choices.length + 1}. ${CUSTOM_OPTION_LABEL}`);

	const selected = await ctx.ui.select(question, choices, { signal });
	const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
	const wasCustom = selectedIndex === suppliedOptions.length;
	const answer = wasCustom
		? (await ctx.ui.input(CUSTOM_OPTION_LABEL, "Type your answer", { signal }))?.trim()
		: suppliedOptions[selectedIndex]?.label;

	if (!answer) return { question, options, answer: null };
	return {
		question,
		options,
		answer,
		wasCustom,
		selectedIndex: wasCustom ? undefined : selectedIndex + 1,
	};
}
