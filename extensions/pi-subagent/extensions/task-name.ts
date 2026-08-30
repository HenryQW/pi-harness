import { Type, type Static } from "typebox";

const TASK_NAME_MAX_LENGTH = 29 as const;
const TASK_NAME_CONTROL_RANGES = "\\u0000-\\u001F\\u007F-\\u009F" as const;
const TASK_NAME_LIMIT_WORDING = `about five words and fewer than ${TASK_NAME_MAX_LENGTH + 1} characters`;
const TASK_NAME_WORDING = `short descriptive name of ${TASK_NAME_LIMIT_WORDING}`;

export const TASK_NAME_CONTRACT = {
	minLength: 1,
	maxLength: TASK_NAME_MAX_LENGTH,
	description: `Short descriptive task name, ${TASK_NAME_LIMIT_WORDING}; C0/C1 control characters are rejected.`,
	promptGuidance: `Use a ${TASK_NAME_WORDING} without C0/C1 control characters.`,
	controlRanges: TASK_NAME_CONTROL_RANGES,
	pattern: `^(?![\\s\\S]*[${TASK_NAME_CONTROL_RANGES}])[\\s\\S]+$`,
} as const;

export const TaskNameSchema = Type.String({
	minLength: TASK_NAME_CONTRACT.minLength,
	maxLength: TASK_NAME_CONTRACT.maxLength,
	description: TASK_NAME_CONTRACT.description,
	pattern: TASK_NAME_CONTRACT.pattern,
});

export type TaskName = Static<typeof TaskNameSchema>;

const TASK_NAME_CONTROL_PATTERN = new RegExp(`[${TASK_NAME_CONTRACT.controlRanges}]`, "u");

export function normalizeTaskName(value: TaskName, path: string): TaskName {
	if (TASK_NAME_CONTROL_PATTERN.test(value)) throw new Error(`${path} must not contain C0/C1 control characters.`);
	const normalized = value.trim();
	if (!normalized) throw new Error(`${path} must be non-empty text.`);
	return normalized;
}
