/** Scripted stub reply. A string is a successful text result. */
export type StubResponse = string | { text: string; isError?: boolean };

export interface StubTool {
	name: string;
	description: string;
	promptSnippet?: string;
	/** JSON Schema for the arguments. Default: any object. */
	parameters?: Record<string, unknown>;
	/**
	 * Replies in call order. A record selects the queue by the string `action` argument. A `<action>:<id>` key,
	 * for a string `id` argument, takes precedence over the `<action>` key.
	 * After a queue runs out, its last reply repeats. A missing queue returns a tool error.
	 */
	responses: StubResponse[] | Record<string, StubResponse[]>;
}

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	result: string;
	isError: boolean;
}

export interface Trace {
	calls: ToolCall[];
	finalText: string;
}

export interface Grade {
	pass: boolean;
	reasons: string[];
}

export interface EvalCase {
	id: string;
	/** Safety cases must pass every trial. Quality cases must pass ceil(2n/3) trials. */
	kind: "safety" | "quality";
	/** Skill directory, relative to the repository root. */
	skill: string;
	prompt: string;
	/** Prepares the fresh temporary cwd before Pi starts. */
	setup?: (cwd: string) => void | Promise<void>;
	stubs?: StubTool[];
	/** Load Pi built-in tools (read, bash, edit, write, ...). Default: false. */
	builtinTools?: boolean;
	/** Real extension entry points to load with `-e`, relative to the repository root. */
	extensions?: string[];
	/** Pi process time limit. Default: 300_000. */
	timeoutMs?: number;
	grade: (trace: Trace, cwd: string) => Grade | Promise<Grade>;
}
