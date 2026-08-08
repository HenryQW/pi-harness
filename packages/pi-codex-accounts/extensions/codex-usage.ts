export interface CodexAllowanceWindow {
	remainingPercent: number;
	resetAt: number;
}

export interface CodexUsage {
	allowance: number;
	windows: CodexAllowanceWindow[];
}

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
		? value
		: undefined;
}

function resetAt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value < 10_000_000_000 ? value * 1000 : value;
}

function normalizeWindow(value: unknown, now: number): CodexAllowanceWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = percent(value.used_percent);
	const remainingPercent = percent(value.remaining_percent) ?? (
		usedPercent === undefined ? undefined : 100 - usedPercent
	);
	const expiresAt = resetAt(value.reset_at);
	if (remainingPercent === undefined || expiresAt === undefined || expiresAt <= now) return undefined;
	return { remainingPercent, resetAt: expiresAt };
}

/** The undocumented response has changed shape; only window fields are relied upon. */
export function normalizeCodexUsage(payload: unknown, now = Date.now()): CodexUsage | undefined {
	const windows: CodexAllowanceWindow[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (!isRecord(value)) return;

		const window = normalizeWindow(value, now);
		if (window) windows.push(window);
		for (const entry of Object.values(value)) visit(entry);
	};

	visit(payload);
	if (windows.length === 0) return undefined;
	return { allowance: Math.min(...windows.map((window) => window.remainingPercent)), windows };
}

export async function fetchCodexUsage(
	accessToken: string,
	accountId: string,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<CodexUsage | undefined> {
	const response = await fetcher(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": accountId,
		},
	});
	if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);
	return normalizeCodexUsage(await response.json(), now);
}
