import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askQuestion } from "@henryqw/pi-ask-question";
import { Type } from "typebox";

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
			const details = await askQuestion(params, ctx, signal);
			return {
				content: [{
					type: "text" as const,
					text: details.error
						? `Error: ${details.error}`
						: !details.answer
							? "User cancelled question"
							: details.wasCustom
								? `User wrote: ${details.answer}`
								: `User selected: ${details.selectedIndex}. ${details.answer}`,
				}],
				details,
			};
		},
	});
}
