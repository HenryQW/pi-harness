import assert from "node:assert/strict";
import test from "node:test";
import { DISPLAY_TEXT_CONTRACT, hasDisplayControlCharacters } from "../src/display-text.ts";

test("display-text pattern contains no regex lookaround", () => {
	// GitHub Copilot rejects lookaround in tool JSON-schema patterns (400 "regex lookaround is not supported").
	assert.doesNotMatch(DISPLAY_TEXT_CONTRACT.pattern, /\(\?[=!<]/);
});

test("display-text pattern accepts plain text and rejects empty, newline, and control characters", () => {
	const re = new RegExp(DISPLAY_TEXT_CONTRACT.pattern, "u");
	assert.ok(re.test("code-reviewer"));
	assert.ok(re.test("provider/model-id"));
	assert.ok(re.test("Unicode ✓ ok"));
	assert.ok(!re.test(""));
	assert.ok(!re.test("line1\nline2"));
	assert.ok(!re.test("tab\there"));
	assert.ok(!re.test("bell\u0007"));
	assert.ok(!re.test("del\u007F"));
	assert.ok(!re.test("c1\u0085"));
});

test("display-text pattern agrees with the runtime control-character check", () => {
	const re = new RegExp(DISPLAY_TEXT_CONTRACT.pattern, "u");
	for (const sample of ["plain", "a\nb", "a\u0001b", "x\u009Fy", "ok"]) {
		assert.equal(re.test(sample), !hasDisplayControlCharacters(sample), JSON.stringify(sample));
	}
});
