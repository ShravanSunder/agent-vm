import { z } from 'zod';

import type { JsonObject, JsonValue } from './json-schema.js';

export interface InputValidationIssue {
	readonly code: string;
	readonly message: string;
	readonly path: readonly (number | string)[];
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

function toValidationIssue(issue: z.core.$ZodIssue): InputValidationIssue {
	return {
		code: issue.code,
		message: issue.message,
		path: issue.path.map((pathPart) =>
			typeof pathPart === 'symbol' ? String(pathPart) : pathPart,
		),
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
						issues: parsed.error.issues.map((issue) => toValidationIssue(issue)),
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
