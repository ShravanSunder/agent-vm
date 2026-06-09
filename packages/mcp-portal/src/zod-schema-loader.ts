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

type JsonStringParseResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false };

const normalizableTypeNames = new Set(['array', 'boolean', 'integer', 'number', 'object']);
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

function isJsonSchemaObject(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && isJsonObject(value);
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

function schemaTypeName(schema: JsonObject): string | undefined {
	const type = schema.type;
	if (typeof type === 'string') {
		return type;
	}
	if (!Array.isArray(type)) {
		return undefined;
	}
	const concreteTypeNames = type.filter(
		(entry): entry is string => typeof entry === 'string' && entry !== 'null',
	);
	if (concreteTypeNames.length !== 1) {
		return undefined;
	}
	const concreteTypeName = concreteTypeNames[0];
	if (concreteTypeName === undefined) {
		return undefined;
	}
	return normalizableTypeNames.has(concreteTypeName) ? concreteTypeName : undefined;
}

function localReferencePath(reference: string): readonly string[] | null {
	if (!reference.startsWith('#/')) {
		return null;
	}
	return reference
		.slice(2)
		.split('/')
		.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function schemaAtPath(rootSchema: JsonObject, path: readonly string[]): JsonObject | null {
	let currentSchema: JsonValue = rootSchema;
	for (const pathPart of path) {
		if (!isJsonObject(currentSchema)) {
			return null;
		}
		const nextSchema: JsonValue | undefined = currentSchema[pathPart];
		if (nextSchema === undefined) {
			return null;
		}
		currentSchema = nextSchema;
	}
	return isJsonObject(currentSchema) ? currentSchema : null;
}

function resolveLocalSchemaReference(
	rootSchema: JsonObject,
	reference: JsonValue | undefined,
): JsonObject | null {
	if (typeof reference !== 'string') {
		return null;
	}
	const path = localReferencePath(reference);
	return path === null ? null : schemaAtPath(rootSchema, path);
}

function allOfSchemas(schema: JsonObject): readonly JsonObject[] {
	const allOf = schema.allOf;
	if (!Array.isArray(allOf)) {
		return [];
	}
	return allOf.filter((entry): entry is JsonObject => isJsonObject(entry));
}

function isObjectLikeSchema(schema: JsonObject, type: string | undefined): boolean {
	return (
		type === 'object' ||
		isJsonSchemaObject(schema.properties) ||
		isJsonSchemaObject(schema.patternProperties) ||
		isJsonSchemaObject(schema.additionalProperties)
	);
}

function isArrayLikeSchema(schema: JsonObject, type: string | undefined): boolean {
	return type === 'array' || Array.isArray(schema.prefixItems) || schema.items !== undefined;
}

function parseJsonString(value: string): JsonStringParseResult {
	try {
		const parsedValue: unknown = JSON.parse(value);
		return { ok: true, value: parsedValue };
	} catch {
		return { ok: false };
	}
}

function parseStringNumber(value: string, props: { readonly integer: boolean }): number | null {
	const trimmedValue = value.trim();
	if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(trimmedValue)) {
		return null;
	}
	const parsedValue = Number(trimmedValue);
	if (!Number.isFinite(parsedValue)) {
		return null;
	}
	if (props.integer && !Number.isInteger(parsedValue)) {
		return null;
	}
	return parsedValue;
}

function parseStringBoolean(value: string): boolean | null {
	const trimmedValue = value.trim();
	if (trimmedValue === 'true') {
		return true;
	}
	if (trimmedValue === 'false') {
		return false;
	}
	return null;
}

function normalizeObjectValueForJsonSchema(
	schema: JsonObject,
	value: Readonly<Record<string, unknown>>,
	rootSchema: JsonObject,
): Record<string, unknown> {
	const normalizedValue: Record<string, unknown> = { ...value };
	const properties = schema.properties;
	if (isJsonSchemaObject(properties)) {
		for (const [propertyName, propertySchema] of Object.entries(properties)) {
			if (propertyName in normalizedValue && isJsonSchemaObject(propertySchema)) {
				normalizedValue[propertyName] = normalizeValueForJsonSchema(
					propertySchema,
					normalizedValue[propertyName],
					rootSchema,
				);
			}
		}
	}

	const patternProperties = schema.patternProperties;
	const matchedPatternProperties = new Set<string>();
	if (isJsonSchemaObject(patternProperties)) {
		for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
			if (!isJsonSchemaObject(patternSchema)) {
				continue;
			}
			let regex: RegExp;
			try {
				regex = new RegExp(pattern, 'u');
			} catch {
				continue;
			}
			for (const propertyName of Object.keys(normalizedValue)) {
				if (regex.test(propertyName)) {
					normalizedValue[propertyName] = normalizeValueForJsonSchema(
						patternSchema,
						normalizedValue[propertyName],
						rootSchema,
					);
					matchedPatternProperties.add(propertyName);
				}
			}
		}
	}

	const additionalProperties = schema.additionalProperties;
	if (isJsonSchemaObject(additionalProperties)) {
		for (const propertyName of Object.keys(normalizedValue)) {
			if (isJsonSchemaObject(properties) && propertyName in properties) {
				continue;
			}
			if (matchedPatternProperties.has(propertyName)) {
				continue;
			}
			normalizedValue[propertyName] = normalizeValueForJsonSchema(
				additionalProperties,
				normalizedValue[propertyName],
				rootSchema,
			);
		}
	}

	return normalizedValue;
}

function normalizeArrayValueForJsonSchema(
	schema: JsonObject,
	value: readonly unknown[],
	rootSchema: JsonObject,
): readonly unknown[] {
	const items = schema.items;
	const prefixItems = schema.prefixItems;
	if (Array.isArray(prefixItems)) {
		return value.map((entry, index) => {
			const itemSchema = prefixItems[index];
			if (isJsonSchemaObject(itemSchema)) {
				return normalizeValueForJsonSchema(itemSchema, entry, rootSchema);
			}
			if (isJsonSchemaObject(items)) {
				return normalizeValueForJsonSchema(items, entry, rootSchema);
			}
			return entry;
		});
	}

	if (Array.isArray(items)) {
		return value.map((entry, index) => {
			const itemSchema = items[index];
			return isJsonSchemaObject(itemSchema)
				? normalizeValueForJsonSchema(itemSchema, entry, rootSchema)
				: entry;
		});
	}
	if (isJsonSchemaObject(items)) {
		return value.map((entry) => normalizeValueForJsonSchema(items, entry, rootSchema));
	}
	return value;
}

function normalizeValueForJsonSchema(
	schema: JsonObject,
	value: unknown,
	rootSchema: JsonObject = schema,
): unknown {
	const referencedSchema = resolveLocalSchemaReference(rootSchema, schema.$ref);
	if (referencedSchema !== null) {
		return normalizeValueForJsonSchema(referencedSchema, value, rootSchema);
	}

	let normalizedValue = value;
	for (const allOfSchema of allOfSchemas(schema)) {
		normalizedValue = normalizeValueForJsonSchema(allOfSchema, normalizedValue, rootSchema);
	}

	const type = schemaTypeName(schema);
	const isObjectLike = isObjectLikeSchema(schema, type);
	const isArrayLike = isArrayLikeSchema(schema, type);
	if ((type === 'number' || type === 'integer') && typeof normalizedValue === 'string') {
		return parseStringNumber(normalizedValue, { integer: type === 'integer' }) ?? normalizedValue;
	}
	if (type === 'boolean' && typeof normalizedValue === 'string') {
		return parseStringBoolean(normalizedValue) ?? normalizedValue;
	}

	if ((isObjectLike || isArrayLike) && typeof normalizedValue === 'string') {
		const parsedValue = parseJsonString(normalizedValue);
		if (
			parsedValue.ok &&
			((isObjectLike && isJsonObjectValue(parsedValue.value)) ||
				(isArrayLike && Array.isArray(parsedValue.value)))
		) {
			normalizedValue = parsedValue.value;
		}
	}

	if (isObjectLike && isJsonObjectValue(normalizedValue)) {
		return normalizeObjectValueForJsonSchema(schema, normalizedValue, rootSchema);
	}
	if (isArrayLike && Array.isArray(normalizedValue)) {
		return normalizeArrayValueForJsonSchema(schema, normalizedValue, rootSchema);
	}
	return normalizedValue;
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
				const normalizedValue = normalizeValueForJsonSchema(jsonSchema, value);
				const parsed = zodSchema.safeParse(normalizedValue);
				if (parsed.success) {
					return { ok: true, value: parsed.data };
				}

				return {
					error: {
						kind: 'input_validation',
						issues: parsed.error.issues.map((issue) => toValidationIssue(issue, normalizedValue)),
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
