export function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`Unknown ${label} setting: ${key}`);
	}
	for (const key of keys) {
		if (!(key in value)) throw new Error(`Missing ${label} setting: ${key}`);
	}
}

export function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const result = value;
	if (!result.trim()) throw new Error(`${label} must not be empty`);
	return result;
}

export function positiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value as number;
}

export function optionalPositiveInteger(value: unknown, fallback: number, label: string): number {
	return value === undefined ? fallback : positiveInteger(value, label);
}

export function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

export function stringArray(value: unknown, label: string): string[] {
	return array(value, label).map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}
