const C0_C1_CONTROL_RANGES = "\\u0000-\\u001F\\u007F-\\u009F" as const;

export const DISPLAY_TEXT_CONTRACT = {
	controlRanges: C0_C1_CONTROL_RANGES,
	pattern: `^(?![\\s\\S]*[${C0_C1_CONTROL_RANGES}])[\\s\\S]+$`,
} as const;

const DISPLAY_TEXT_CONTROL_PATTERN = new RegExp(`[${DISPLAY_TEXT_CONTRACT.controlRanges}]`, "u");

export function hasDisplayControlCharacters(value: string): boolean {
	return DISPLAY_TEXT_CONTROL_PATTERN.test(value);
}
