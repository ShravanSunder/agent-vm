import type { JsonObject } from '@agent-collaboration/tool-access/contracts';

import type { PortalToolRecord } from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import { buildZodValidatorFromJsonSchema } from '#mcp-gateway/portal-tools/json-schema-validators';
import type { InputValidationIssue } from '#mcp-gateway/portal-tools/models/input-validation-results';

export function validatePortalToolArguments(
	tool: PortalToolRecord,
	argumentsValue: JsonObject,
):
	| { readonly ok: true; readonly value: unknown }
	| {
			readonly error:
				| {
						readonly issues: readonly InputValidationIssue[];
						readonly kind: 'input_validation';
						readonly namespace: string;
						readonly toolName: string;
				  }
				| {
						readonly feature: string;
						readonly kind: 'schema_validation_unavailable';
						readonly message: string;
						readonly namespace: string;
						readonly path: readonly (number | string)[];
						readonly toolName: string;
				  };
			readonly ok: false;
	  } {
	const validator = buildZodValidatorFromJsonSchema(tool.inputSchema);
	if (!validator.ok) {
		return {
			error: { ...validator.error, namespace: tool.namespace, toolName: tool.toolName },
			ok: false,
		};
	}

	const result = validator.validate(argumentsValue);
	if (!result.ok) {
		return {
			error: { ...result.error, namespace: tool.namespace, toolName: tool.toolName },
			ok: false,
		};
	}

	return result;
}
