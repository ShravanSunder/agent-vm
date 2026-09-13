import type { GeneratedToolRuntimeDiagnostic } from '@agent-vm/agent-portal-sdk/generated-tools';

import type { JsonObject, JsonValue } from '../json-schema.js';

export interface SafeSchemaProjection {
	readonly diagnostics: readonly GeneratedToolRuntimeDiagnostic[];
	readonly projectedSchema: JsonObject;
}

type ProjectionContext = 'data' | 'schema' | 'schema-array' | 'schema-map';

const sourceBearingExtensionNames = new Set(['tsEnumNames', 'tsType']);
const schemaMapKeywords = new Set([
	'$defs',
	'definitions',
	'dependentSchemas',
	'patternProperties',
	'properties',
]);
const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaKeywords = new Set([
	'additionalItems',
	'additionalProperties',
	'contains',
	'contentSchema',
	'else',
	'if',
	'items',
	'not',
	'propertyNames',
	'then',
	'unevaluatedItems',
	'unevaluatedProperties',
]);

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function childProjectionContext(parentContext: ProjectionContext, key: string): ProjectionContext {
	if (parentContext === 'data') {
		return 'data';
	}
	if (parentContext === 'schema-map') {
		return 'schema';
	}
	if (schemaMapKeywords.has(key)) {
		return 'schema-map';
	}
	if (schemaArrayKeywords.has(key)) {
		return 'schema-array';
	}
	if (schemaKeywords.has(key)) {
		return 'schema';
	}
	return 'data';
}

function projectJsonValue(props: {
	readonly context: ProjectionContext;
	readonly diagnostics: GeneratedToolRuntimeDiagnostic[];
	readonly path: readonly (number | string)[];
	readonly value: JsonValue;
}): JsonValue {
	if (Array.isArray(props.value)) {
		const childContext = props.context === 'schema-array' ? 'schema' : 'data';
		return props.value.map((entry, index) =>
			projectJsonValue({
				context: childContext,
				diagnostics: props.diagnostics,
				path: [...props.path, index],
				value: entry,
			}),
		);
	}
	if (!isJsonObject(props.value)) {
		return props.value;
	}

	const projected: JsonObject = {};
	for (const [key, childValue] of Object.entries(props.value)) {
		const childPath = [...props.path, key];
		if (props.context === 'schema' && sourceBearingExtensionNames.has(key)) {
			props.diagnostics.push({
				kind: 'source-bearing-extension',
				keyword: key === 'tsType' ? 'tsType' : 'tsEnumNames',
				path: childPath,
			});
			continue;
		}
		if (props.context === 'schema' && key === '$ref' && typeof childValue === 'string') {
			const isInDocumentJsonPointer = childValue === '#' || childValue.startsWith('#/');
			if (!isInDocumentJsonPointer) {
				props.diagnostics.push({
					kind: 'external-reference',
					path: childPath,
					reference: childValue,
				});
			}
		}
		setOwnJsonProperty(
			projected,
			key,
			projectJsonValue({
				context: childProjectionContext(props.context, key),
				diagnostics: props.diagnostics,
				path: childPath,
				value: childValue,
			}),
		);
	}
	return projected;
}

export function createSafeSchemaProjection(inputSchema: JsonObject): SafeSchemaProjection {
	const diagnostics: GeneratedToolRuntimeDiagnostic[] = [];
	const projectedSchema = projectJsonValue({
		context: 'schema',
		diagnostics,
		path: [],
		value: inputSchema,
	});
	if (!isJsonObject(projectedSchema)) {
		throw new TypeError('Projected catalog input schema must remain a JSON object.');
	}
	return { diagnostics, projectedSchema };
}
