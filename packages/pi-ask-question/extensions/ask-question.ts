import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CUSTOM_OPTION_LABEL = "Something else.";
// Models are told to omit "(Recommended)" from labels but don't always comply; normalize instead of duplicating.
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const withRecommended = (label: string): string => `${label.replace(RECOMMENDED_SUFFIX, "")} (Recommended)`;

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	selectedIndex?: number;
	error?: string;
}

const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option", minLength: 1 }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label", minLength: 1 })),
});

const AskQuestionParams = Type.Object({
	question: Type.String({ description: "Question to ask user", minLength: 1 }),
	options: Type.Array(QuestionOptionSchema, {
		description: "One to three meaningful options, ordered with recommended option first",
		minItems: 1,
		maxItems: 3,
	}),
});

export default function askQuestionExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: "In interactive TUI sessions, ask user one question with up to three options or a custom answer. First option is shown as recommended.",
		promptSnippet: "In interactive TUI sessions, ask user one question with up to three options or a custom answer",
		promptGuidelines: [
			"In interactive TUI sessions, use ask_question instead of plain assistant text whenever user input is needed to proceed; in non-interactive sessions, ask in plain assistant text.",
			"Give ask_question one to three concise, meaningful options without inventing filler, put recommended option first, and omit '(Recommended)' from its label.",
			"Give ask_question option descriptions only when they explain meaningful tradeoffs; never repeat option labels.",
		],
		parameters: AskQuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const question = params.question.trim();
			const suppliedOptions = params.options.map((option) => ({
				label: option.label.trim(),
				...(option.description === undefined ? {} : { description: option.description.trim() }),
			}));
			const options = suppliedOptions.map((option) => option.label);
			if (ctx.mode !== "tui") {
				const error = "UI not available (running in non-interactive mode)";
				return {
					content: [{ type: "text" as const, text: `Error: ${error}` }],
					details: { question, options, answer: null, error } satisfies QuestionDetails,
				};
			}
			let validationError: string | undefined;
			if (!question) validationError = "Question must not be blank";
			else if (suppliedOptions.some((option) => !option.label)) validationError = "Option labels must not be blank";
			else if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) validationError = "Option labels must be unique";
			else if (options.some((option) => option.toLowerCase() === CUSTOM_OPTION_LABEL.toLowerCase())) validationError = `Option label "${CUSTOM_OPTION_LABEL}" is reserved`;
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Error: ${validationError}` }],
					details: { question, options, answer: null, error: validationError } satisfies QuestionDetails,
				};
			}

			const choices = suppliedOptions.map((option, index) => {
				const label = index === 0 ? withRecommended(option.label) : option.label;
				return `${label}${option.description ? ` — ${option.description}` : ""}`;
			});
			choices.push(CUSTOM_OPTION_LABEL);

			const selected = await ctx.ui.select(question, choices, { signal });
			const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
			const wasCustom = selectedIndex === suppliedOptions.length;
			const answer = wasCustom
				? (await ctx.ui.input(CUSTOM_OPTION_LABEL, "Type your answer", { signal }))?.trim()
				: suppliedOptions[selectedIndex]?.label;

			if (!answer) {
				return {
					content: [{ type: "text" as const, text: "User cancelled question" }],
					details: { question, options, answer: null } satisfies QuestionDetails,
				};
			}
			return {
				content: [{
					type: "text" as const,
					text: wasCustom ? `User wrote: ${answer}` : `User selected: ${selectedIndex + 1}. ${answer}`,
				}],
				details: {
					question,
					options,
					answer,
					wasCustom,
					selectedIndex: wasCustom ? undefined : selectedIndex + 1,
				} satisfies QuestionDetails,
			};
		},
	});
}
