import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_OPTION_LABEL = "Something else.";
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

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

export interface AskQuestionsResult {
	answers: Array<AskQuestionResult & { questionIndex: number }>;
	cancelled: boolean;
	error?: string;
}

type AskQuestionContext = Pick<ExtensionContext, "mode" | "ui">;

function prepareQuestion(params: AskQuestionRequest, ctx: AskQuestionContext) {
	const question = params.question.trim();
	const suppliedOptions = params.options.map((option) => ({
		label: option.label.trim(),
		description: option.description?.trim(),
	}));
	const options = suppliedOptions.map((option) => option.label);
	let error: string | undefined;
	if (ctx.mode !== "tui") error = "UI not available (running in non-interactive mode)";
	else if (!question) error = "Question must not be blank";
	else if (suppliedOptions.length < 1 || suppliedOptions.length > 3) error = "Provide one to three options";
	else if (suppliedOptions.some((option) => !option.label)) error = "Option labels must not be blank";
	else if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) error = "Option labels must be unique";
	else if (options.some((option) => option.toLowerCase() === CUSTOM_OPTION_LABEL.toLowerCase())) error = `Option label "${CUSTOM_OPTION_LABEL}" is reserved`;
	return { question, suppliedOptions, options, error };
}

/** Run the validated interactive question flow shared by consumers. */
export async function askQuestion(
	params: AskQuestionRequest,
	ctx: AskQuestionContext,
	signal?: AbortSignal,
): Promise<AskQuestionResult> {
	const { question, suppliedOptions, options, error } = prepareQuestion(params, ctx);
	if (error) return { question, options, answer: null, error };
	if (signal?.aborted) return { question, options, answer: null };

	const choices = suppliedOptions.map((option, index) => {
		const label = index === 0 ? `${option.label.replace(RECOMMENDED_SUFFIX, "")} (Recommended)` : option.label;
		return `${index + 1}. ${label}${option.description ? ` — ${option.description}` : ""}`;
	});
	choices.push(`${choices.length + 1}. ${CUSTOM_OPTION_LABEL}`);

	const selected = await ctx.ui.select(question, choices, { signal });
	if (signal?.aborted) return { question, options, answer: null };
	const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
	const wasCustom = selectedIndex === suppliedOptions.length;
	const answer = wasCustom
		? (await ctx.ui.input(CUSTOM_OPTION_LABEL, "Type your answer", { signal }))?.trim()
		: suppliedOptions[selectedIndex]?.label;

	if (!answer || signal?.aborted) return { question, options, answer: null };
	return {
		question,
		options,
		answer,
		wasCustom,
		selectedIndex: wasCustom ? undefined : selectedIndex + 1,
	};
}

/** Validate all questions before the first dialog, then ask in order. */
export async function askQuestions(
	questions: AskQuestionRequest[],
	ctx: AskQuestionContext,
	signal?: AbortSignal,
): Promise<AskQuestionsResult> {
	const result: AskQuestionsResult = { answers: [], cancelled: false };
	if (!questions.length) return { ...result, error: "Provide at least one question" };
	for (const [index, question] of questions.entries()) {
		const { error } = prepareQuestion(question, ctx);
		if (error) return { ...result, error: `Question ${index + 1}: ${error}` };
	}
	for (const [index, question] of questions.entries()) {
		if (signal?.aborted) return { ...result, cancelled: true };
		let answer: AskQuestionResult;
		try {
			answer = await askQuestion(question, ctx, signal);
		} catch (error) {
			return { ...result, error: `Question ${index + 1}: ${error instanceof Error ? error.message : String(error)}` };
		}
		result.answers.push({ questionIndex: index + 1, ...answer });
		if (answer.error) return { ...result, error: `Question ${index + 1}: ${answer.error}` };
		if (answer.answer === null) return { ...result, cancelled: true };
	}
	return result;
}
