import type { JsonValue } from './json-schema.js';

const credentialPatterns = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bBasic\s+[A-Za-z0-9._~+/=-]+/gi,
	/\b(api[_-]?key|token|password|secret)=([^&\s]+)/gi,
];

export interface RedactionOptions {
	readonly exactValues?: readonly string[];
}

export function isCredentialConfigKey(key: string): boolean {
	const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
	return (
		normalizedKey === 'auth' ||
		normalizedKey === 'authorization' ||
		normalizedKey === 'apikey' ||
		normalizedKey.endsWith('apikey') ||
		normalizedKey.endsWith('token') ||
		normalizedKey.endsWith('password') ||
		normalizedKey.endsWith('secret')
	);
}

function redactExactValues(text: string, exactValues: readonly string[]): string {
	return exactValues
		.filter((value) => value.length > 0)
		.reduce((currentText, value) => currentText.split(value).join('[REDACTED]'), text);
}

export function redactCredentialText(text: string, options: RedactionOptions = {}): string {
	const patternRedactedText = credentialPatterns.reduce(
		(current, pattern) => current.replace(pattern, '[REDACTED]'),
		text,
	);
	return redactExactValues(patternRedactedText, options.exactValues ?? []);
}

function redactJsonValue(value: unknown, options: RedactionOptions, keyHint?: string): unknown {
	if (typeof value === 'string') {
		return keyHint && isCredentialConfigKey(keyHint)
			? '[REDACTED]'
			: redactCredentialText(value, options);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => redactJsonValue(entry, options));
	}

	if (typeof value !== 'object' || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [
			key,
			redactJsonValue(childValue, options, key),
		]),
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}

	if (typeof value !== 'object') {
		return false;
	}

	return Object.values(value).every(isJsonValue);
}

export function redactUpstreamResponse(response: unknown, options: RedactionOptions = {}): unknown {
	return redactJsonValue(response, options);
}

export function redactThrownError(error: unknown, options: RedactionOptions = {}): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(redactCredentialText(message, options));
}

export function toRedactedJsonValue(value: unknown, options: RedactionOptions = {}): JsonValue {
	const redacted = redactJsonValue(value, options);
	if (isJsonValue(redacted)) {
		return redacted;
	}

	return null;
}
