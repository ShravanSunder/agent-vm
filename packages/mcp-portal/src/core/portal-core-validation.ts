import type { JsonValue } from '../json-schema.js';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPortalCoreJsonValue(
	value: unknown,
	activeObjects = new Set<object>(),
): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value !== 'object') {
		return false;
	}
	if (activeObjects.has(value)) {
		return false;
	}
	activeObjects.add(value);
	const isValid =
		(Array.isArray(value) && value.every((entry) => isPortalCoreJsonValue(entry, activeObjects))) ||
		(isUnknownRecord(value) &&
			Object.values(value).every((entry) => isPortalCoreJsonValue(entry, activeObjects)));
	activeObjects.delete(value);
	return isValid;
}
