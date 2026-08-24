import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
	label: string;
	description?: string;
}

type DisplayOption = QuestionOption & { isOther?: boolean };

const CUSTOM_OPTION_LABEL = "Something else.";
// Models are told to omit "(Recommended)" from labels but don't always comply; normalize instead of duplicating.
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
const withRecommended = (label: string): string => `${label.replace(RECOMMENDED_SUFFIX, "")} (Recommended)`;
const NUMBER_KEYS = ["1", "2", "3", "4"] as const;

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
			if (suppliedOptions.length < 1 || suppliedOptions.length > 3) validationError = "1 to 3 options required";
			else if (!question) validationError = "Question must not be blank";
			else if (suppliedOptions.some((option) => !option.label)) validationError = "Option labels must not be blank";
			else if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) validationError = "Option labels must be unique";
			else if (options.some((option) => option.toLowerCase() === CUSTOM_OPTION_LABEL.toLowerCase())) validationError = `Option label "${CUSTOM_OPTION_LABEL}" is reserved`;
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Error: ${validationError}` }],
					details: { question, options, answer: null, error: validationError } satisfies QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [...suppliedOptions, { label: CUSTOM_OPTION_LABEL, isOther: true }];
			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;
					const editorTheme: EditorTheme = {
						borderColor: (text) => theme.fg("accent", text),
						selectList: {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function refresh(): void {
						cachedLines = undefined;
						tui.requestRender();
					}

					editor.onSubmit = (value) => {
						const answer = value.trim();
						if (answer) done({ answer, wasCustom: true });
						else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function selectOption(): void {
						const selected = allOptions[optionIndex]!;
						if (selected.isOther) editMode = true;
						else done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
					}

					function handleInput(data: string): void {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						const numberIndex = NUMBER_KEYS.findIndex((key, index) => index < allOptions.length && matchesKey(data, key));
						if (numberIndex >= 0) {
							optionIndex = numberIndex;
							selectOption();
						} else if (matchesKey(data, Key.up)) optionIndex = Math.max(0, optionIndex - 1);
						else if (matchesKey(data, Key.down)) optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						else if (matchesKey(data, Key.enter)) selectOption();
						else if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						} else return;
						refresh();
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const addWrapped = (text: string): void => { lines.push(...wrapTextWithAnsi(text, renderWidth)); };
						const addWrappedWithPrefix = (prefix: string, text: string): void => {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let index = 0; index < wrapped.length; index++) {
								lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
							}
						};

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						addWrappedWithPrefix(" ", theme.fg("text", question));
						lines.push("");
						for (let index = 0; index < allOptions.length; index++) {
							const option = allOptions[index]!;
							const selected = index === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${index + 1}. ${index === 0 ? withRecommended(option.label) : option.label}${option.isOther && editMode ? " ✎" : ""}`;
							addWrappedWithPrefix(prefix, theme.fg(selected || (option.isOther && editMode) ? "accent" : "text", label));
							if (option.description) addWrappedWithPrefix("     ", theme.fg("muted", option.description));
						}
						if (editMode) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", editMode ? "Enter to submit • Esc to go back" : `↑↓ navigate • 1–${allOptions.length} or Enter to select • Esc to cancel`));
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						cachedLines = lines;
						return lines;
					}

					const abort = (): void => done(null);
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });

					return {
						render,
						invalidate: () => { cachedLines = undefined; },
						handleInput,
						dispose: () => signal?.removeEventListener("abort", abort),
					};
				},
			);

			if (!result) {
				return {
					content: [{ type: "text" as const, text: "User cancelled question" }],
					details: { question, options, answer: null } satisfies QuestionDetails,
				};
			}
			return {
				content: [{
					type: "text" as const,
					text: result.wasCustom ? `User wrote: ${result.answer}` : `User selected: ${result.index}. ${result.answer}`,
				}],
				details: {
					question,
					options,
					answer: result.answer,
					wasCustom: result.wasCustom,
					selectedIndex: result.index,
				} satisfies QuestionDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ask_question ")) + theme.fg("muted", args.question);
			const options = Array.isArray(args.options) ? args.options : [];
			if (options.length) {
				const labels = options.map((option: QuestionOption) => option.label);
				const numbered = [...labels, CUSTOM_OPTION_LABEL].map((option, index) => `${index + 1}. ${index === 0 ? withRecommended(option) : option}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (details.wasCustom) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer), 0, 0);
			}
			const display = details.selectedIndex ? `${details.selectedIndex}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
