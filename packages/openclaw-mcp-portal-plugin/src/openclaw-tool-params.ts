function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObjectString(value: string): Record<string, unknown> | null {
	try {
		const parsedValue: unknown = JSON.parse(value);
		return isObjectRecord(parsedValue) ? parsedValue : null;
	} catch {
		return null;
	}
}

export function normalizeOpenClawToolParams(params: unknown): unknown {
	if (typeof params !== 'string') {
		return params;
	}
	return parseJsonObjectString(params) ?? params;
}

export function normalizeOpenClawToolParamsRecord(params: unknown): Record<string, unknown> | null {
	const normalizedParams = normalizeOpenClawToolParams(params);
	return isObjectRecord(normalizedParams) ? normalizedParams : null;
}
