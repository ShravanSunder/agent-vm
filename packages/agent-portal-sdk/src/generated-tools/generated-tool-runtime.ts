import { z } from 'zod';

import {
	JsonObjectSchema,
	type JsonObject,
} from '../contract-primitives/models/json-value-schema.js';
import type { PortalCallResult } from '../portal-call-surface/models/portal-call-result-schema.js';
import type {
	ToolPortalClientRequestOptions,
	ToolPortalMcpClient,
} from '../tool-portal-mcp-client/index.js';

export type GeneratedToolTyping = 'structurally-derived' | 'widened';
export type GeneratedToolRuntimeValidation = 'local-zod' | 'portal-only';

export type GeneratedToolRuntimeDiagnostic =
	| {
			readonly kind: 'source-bearing-extension';
			readonly keyword: 'tsEnumNames' | 'tsType';
			readonly path: readonly (number | string)[];
	  }
	| {
			readonly kind: 'external-reference';
			readonly path: readonly (number | string)[];
			readonly reference: string;
	  }
	| {
			readonly kind: 'static-conversion-failed' | 'declaration-safety-failed';
			readonly message: string;
			readonly path: readonly (number | string)[];
	  }
	| {
			readonly feature: string;
			readonly kind: 'runtime-validation-unsupported';
			readonly path: readonly (number | string)[];
	  };

export interface GeneratedToolDefinition {
	readonly diagnostics: readonly GeneratedToolRuntimeDiagnostic[];
	readonly inputSchema: JsonObject;
	readonly name: string;
	readonly namespace: string;
	readonly runtimeValidation: GeneratedToolRuntimeValidation;
	readonly typing: GeneratedToolTyping;
}

export type GeneratedToolCallOptions = ToolPortalClientRequestOptions;

export type GeneratedToolFunction<TInput extends object> = (
	input: TInput,
	options?: GeneratedToolCallOptions,
) => Promise<PortalCallResult>;

export class GeneratedToolSchemaValidationUnavailableError extends Error {
	readonly code = 'schema_validation_unavailable';
	readonly toolName: string;
	readonly toolNamespace: string;

	constructor(props: {
		readonly cause: unknown;
		readonly toolName: string;
		readonly toolNamespace: string;
	}) {
		super(
			`Local schema validation is unavailable for generated tool ${JSON.stringify(
				`${props.toolNamespace}/${props.toolName}`,
			)}. Portal did not receive the call.`,
			{ cause: props.cause },
		);
		this.name = 'GeneratedToolSchemaValidationUnavailableError';
		this.toolName = props.toolName;
		this.toolNamespace = props.toolNamespace;
	}
}

type GeneratedToolPortalClient = Pick<ToolPortalMcpClient, 'call'>;

let generatedCallSequence = 0;

function createGeneratedCallId(): string {
	generatedCallSequence += 1;
	return `generated-${crypto.randomUUID()}-${String(generatedCallSequence)}`;
}

function createLazyInputValidator(
	definition: GeneratedToolDefinition,
): ((input: unknown) => void) | undefined {
	if (definition.runtimeValidation === 'portal-only') {
		return undefined;
	}

	let validator: z.ZodType | undefined;
	return (input: unknown): void => {
		if (validator === undefined) {
			try {
				validator = z.fromJSONSchema(definition.inputSchema);
			} catch (error) {
				throw new GeneratedToolSchemaValidationUnavailableError({
					cause: error,
					toolName: definition.name,
					toolNamespace: definition.namespace,
				});
			}
		}
		validator.parse(input);
	};
}

/**
 * Binds one generated tool definition to the caller-supplied Portal client.
 * The returned function never owns client connection or lifecycle.
 */
export function createGeneratedToolFunction<TInput extends object>(
	client: GeneratedToolPortalClient,
	definition: GeneratedToolDefinition,
): GeneratedToolFunction<TInput> {
	const validateInput = createLazyInputValidator(definition);
	return async (
		input: TInput,
		options: GeneratedToolCallOptions = {},
	): Promise<PortalCallResult> => {
		const canonicalArguments = JsonObjectSchema.parse(input);
		validateInput?.(canonicalArguments);
		return await client.call(
			{
				calls: [
					{
						arguments: canonicalArguments,
						id: createGeneratedCallId(),
						name: definition.name,
						namespace: definition.namespace,
					},
				],
			},
			options,
		);
	};
}

export type { JsonObject } from '../contract-primitives/models/json-value-schema.js';
export type { PortalCallResult } from '../portal-call-surface/models/portal-call-result-schema.js';
export type {
	ToolPortalClientRequestOptions,
	ToolPortalMcpClient,
} from '../tool-portal-mcp-client/index.js';
