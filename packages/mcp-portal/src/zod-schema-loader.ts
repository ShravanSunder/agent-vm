import { z } from 'zod';

import type { JsonObject, JsonValue } from './json-schema.js';

export interface InputValidationIssue {
	readonly code: string;
	readonly expected?: string;
	readonly keys?: readonly string[];
	readonly message: string;
	readonly path: readonly (number | string)[];
	readonly received?: {
		readonly preview?: string;
		readonly type: string;
	};
	readonly values?: readonly JsonValue[];
}

export interface InputValidationError {
	readonly kind: 'input_validation';
	readonly issues: readonly InputValidationIssue[];
}

export interface SchemaValidationUnavailableError {
	readonly feature: string;
	readonly kind: 'schema_validation_unavailable';
	readonly message: string;
	readonly path: readonly (number | string)[];
}

export type PortalValidationResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly error: InputValidationError; readonly ok: false };

export type BuiltZodValidator =
	| {
			readonly ok: true;
			readonly validate: (value: unknown) => PortalValidationResult;
	  }
	| {
			readonly error: SchemaValidationUnavailableError;
			readonly ok: false;
	  };

interface UnsupportedFeature {
	readonly feature: string;
	readonly path: readonly (number | string)[];
}

const unsupportedFeatures = new Set([
	'contains',
	'dependentSchemas',
	'else',
	'if',
	'not',
	'then',
	'unevaluatedProperties',
	'uniqueItems',
]);

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findUnsupportedFeature(
	value: JsonValue,
	path: readonly (number | string)[] = [],
): UnsupportedFeature | null {
	if (Array.isArray(value)) {
		for (const [index, childValue] of value.entries()) {
			const childUnsupported = findUnsupportedFeature(childValue, [...path, index]);
			if (childUnsupported) {
				return childUnsupported;
			}
		}
		return null;
	}

	if (!isJsonObject(value)) {
		return null;
	}

	for (const [key, childValue] of Object.entries(value)) {
		if (unsupportedFeatures.has(key)) {
			return { feature: key, path: [...path, key] };
		}
		const childUnsupported = findUnsupportedFeature(childValue, [...path, key]);
		if (childUnsupported) {
			return childUnsupported;
		}
	}

	return null;
}

function unavailableError(
	feature: string,
	path: readonly (number | string)[],
): SchemaValidationUnavailableError {
	return {
		feature,
		kind: 'schema_validation_unavailable',
		message: `JSON Schema feature "${feature}" is not supported by the portal validator.`,
		path,
	};
}

function valueAtPath(value: unknown, path: readonly (number | string)[]): unknown {
	let currentValue = value;
	for (const pathPart of path) {
		if (typeof pathPart === 'number') {
			if (!Array.isArray(currentValue)) {
				return undefined;
			}
			currentValue = currentValue[pathPart];
			continue;
		}
		if (!isJsonObjectValue(currentValue)) {
			return undefined;
		}
		currentValue = currentValue[pathPart];
	}
	return currentValue;
}

function isJsonObjectValue(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTypeName(value: unknown): string {
	if (value === undefined) {
		return 'undefined';
	}
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value;
}

function jsonValuePreview(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value.length > 80 ? `${value.slice(0, 77)}...` : value;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return String(value);
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		return undefined;
	}
	return serialized.length > 80 ? `${serialized.slice(0, 77)}...` : serialized;
}

function keysFromIssue(issue: z.core.$ZodIssue): readonly string[] | undefined {
	if (!('keys' in issue)) {
		return undefined;
	}
	const value = issue.keys;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		return undefined;
	}
	return value;
}

function valuesFromIssue(issue: z.core.$ZodIssue): readonly JsonValue[] | undefined {
	if (!('values' in issue)) {
		return undefined;
	}
	const value: unknown = issue.values;
	if (!Array.isArray(value)) {
		return undefined;
	}
	const values: JsonValue[] = [];
	for (const entry of value) {
		if (!isJsonValue(entry)) {
			return undefined;
		}
		values.push(entry);
	}
	return values;
}

function isJsonValue(value: unknown): value is JsonValue {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		(Array.isArray(value) && value.every((entry) => isJsonValue(entry))) ||
		(isJsonObjectValue(value) && Object.values(value).every((entry) => isJsonValue(entry)))
	);
}

function expectedFromIssue(issue: z.core.$ZodIssue): string | undefined {
	if (!('expected' in issue)) {
		return undefined;
	}
	const expected = issue.expected;
	return typeof expected === 'string' ? expected : undefined;
}

function toValidationIssue(issue: z.core.$ZodIssue, inputValue: unknown): InputValidationIssue {
	const path = issue.path.map((pathPart) =>
		typeof pathPart === 'symbol' ? String(pathPart) : pathPart,
	);
	const receivedValue = valueAtPath(inputValue, path);
	const preview = jsonValuePreview(receivedValue);
	const result: InputValidationIssue = {
		code: issue.code,
		message: issue.message,
		path,
		received: {
			type: jsonTypeName(receivedValue),
			...(preview === undefined ? {} : { preview }),
		},
	};
	const expected = expectedFromIssue(issue);
	const keys = keysFromIssue(issue);
	const values = valuesFromIssue(issue);
	return {
		...result,
		...(expected === undefined ? {} : { expected }),
		...(keys === undefined ? {} : { keys }),
		...(values === undefined ? {} : { values }),
	};
}

export function buildZodValidatorFromJsonSchema(jsonSchema: JsonObject): BuiltZodValidator {
	const unsupported = findUnsupportedFeature(jsonSchema);
	if (unsupported) {
		return {
			error: unavailableError(unsupported.feature, unsupported.path),
			ok: false,
		};
	}

	try {
		const zodSchema = z.fromJSONSchema(jsonSchema);

		return {
			ok: true,
			validate(value: unknown): PortalValidationResult {
				const parsed = zodSchema.safeParse(value);
				if (parsed.success) {
					return { ok: true, value: parsed.data };
				}

				return {
					error: {
						kind: 'input_validation',
						issues: parsed.error.issues.map((issue) => toValidationIssue(issue, value)),
					},
					ok: false,
				};
			},
		};
	} catch (error) {
		return {
			error: {
				feature: 'conversion_failed',
				kind: 'schema_validation_unavailable',
				message: error instanceof Error ? error.message : String(error),
				path: [],
			},
			ok: false,
		};
	}
}
