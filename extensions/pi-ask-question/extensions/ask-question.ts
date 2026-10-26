import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askQuestion, askQuestions, type AskQuestionResult } from "@henryqw/pi-ask-question";
import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";

const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option", minLength: 1 }),
	description: Type.Optional(Type.String({ description: "Optional description shown with the label", minLength: 1 })),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
	question: Type.String({ description: "Question to ask user", minLength: 1 }),
	options: Type.Array(QuestionOptionSchema, {
		description: "One to three meaningful options, ordered with recommended option first",
		minItems: 1,
		maxItems: 3,
	}),
}, { additionalProperties: false });
const BatchSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, description: "Questions to ask in order in one tool call" }),
}, { additionalProperties: false });
type QuestionInput = Static<typeof QuestionSchema> | Static<typeof BatchSchema>;

// Providers need a plain object root; execute checks the strict request variant.
const AskQuestionParams = Type.Object({
	question: Type.Optional(QuestionSchema.properties.question),
	options: Type.Optional(QuestionSchema.properties.options),
	questions: Type.Optional(BatchSchema.properties.questions),
}, { additionalProperties: false, description: "Provide either question and options, or questions; never both" });

function answerText(details: AskQuestionResult): string {
	return details.error
		? `Error: ${details.error}`
		: !details.answer
			? "User cancelled question"
			: details.wasCustom
				? `User wrote: ${details.answer}`
				: `User selected: ${details.selectedIndex}. ${details.answer}`;
}

export default function askQuestionExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description: "In interactive TUI (text user interface) sessions, ask one question or a list of questions with one to three options each or a custom answer. The first option is recommended. Lists run in order and stop on cancellation; earlier answers are retained.",
		promptSnippet: "In interactive TUI (text user interface) sessions, ask one question or a list of questions in one tool call",
		promptGuidelines: [
			"In interactive TUI (text user interface) sessions, use ask_question instead of plain assistant text whenever user input is needed to proceed; in non-interactive sessions, ask in plain assistant text.",
			"For ask_question, use {question, options} for one question or {questions: [{question, options}, ...]} to collect several answers in one tool call. Never mix these forms. All questions are validated before the first prompt; cancellation or abort stops the list and retains earlier answers.",
			"Give each ask_question question one to three concise, meaningful options without filler, put the recommended option first, and omit '(Recommended)' from its label.",
			"Give ask_question option descriptions only when they explain meaningful tradeoffs; never repeat option labels.",
		],
		parameters: AskQuestionParams,
		executionMode: "sequential",
		exposure: "model-only",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const issue = Errors(params.questions === undefined ? QuestionSchema : BatchSchema, params)[0];
			if (issue) throw new Error(`Invalid ask_question arguments at ${issue.instancePath || "/"}: ${issue.keyword === "boolean" ? "field is not allowed" : issue.message}. Provide either {question, options} or a nonempty {questions: [{question, options}, ...]}; never both.`);
			const request = params as QuestionInput;
			const interactive = ctx.mode === "tui";
			try {
				if (interactive) pi.events.emit("herdr:blocked", { active: true, label: "Input required" });
				if ("questions" in request) {
					const details = await askQuestions(request.questions, ctx, signal);
					const lines = details.answers.map((answer) => `Question ${answer.questionIndex}: ${answer.question}\n${answerText(answer)}`);
					if (details.error) lines.push(`Error: ${details.error}`);
					else if (details.cancelled) lines.push("Question list cancelled; no further questions were asked.");
					return { content: [{ type: "text" as const, text: lines.join("\n\n") }], details, isError: details.error !== undefined };
				}
				const details = await askQuestion(request, ctx, signal);
				return {
					content: [{ type: "text" as const, text: answerText(details) }],
					details,
				};
			} finally {
				if (interactive) pi.events.emit("herdr:blocked", { active: false });
			}
		},
	});
}
