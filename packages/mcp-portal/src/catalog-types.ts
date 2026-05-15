import { z } from 'zod';

import { jsonObjectSchema, type JsonObject, type JsonValue } from './json-schema.js';

const forbiddenMetadataKeys = new Set([
	'agentid',
	'authprofile',
	'bindingid',
	'runid',
	'sessionid',
]);

function findForbiddenMetadataKey(value: JsonObject): string | null {
	const stack: JsonValue[] = [value];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		if (Array.isArray(current)) {
			stack.push(...current);
			continue;
		}

		if (typeof current !== 'object' || current === null) {
			continue;
		}

		for (const [key, childValue] of Object.entries(current)) {
			if (forbiddenMetadataKeys.has(key.toLowerCase())) {
				return key;
			}
			if (typeof childValue === 'object' && childValue !== null) {
				stack.push(childValue);
			}
		}
	}

	return null;
}

export const portalToolAnnotationsSchema = z
	.object({
		destructiveHint: z.boolean().optional(),
		idempotentHint: z.boolean().optional(),
		openWorldHint: z.boolean().optional(),
		readOnlyHint: z.boolean().optional(),
		title: z.string().optional(),
	})
	.catchall(jsonObjectSchema.or(z.string()).or(z.number()).or(z.boolean()).or(z.null()))
	.optional();

export const safeToolMetadataSchema = jsonObjectSchema
	.optional()
	.superRefine((metadata, context) => {
		if (!metadata) {
			return;
		}

		const forbiddenKey = findForbiddenMetadataKey(metadata);
		if (forbiddenKey) {
			context.addIssue({
				code: 'custom',
				message: `metadata contains forbidden key "${forbiddenKey}"`,
			});
		}
	});

export const portalToolRecordSchema = z
	.object({
		annotations: portalToolAnnotationsSchema,
		description: z.string().optional(),
		inputSchema: jsonObjectSchema,
		metadata: safeToolMetadataSchema,
		namespace: z.string().min(1),
		outputSchema: jsonObjectSchema.optional(),
		title: z.string().optional(),
		toolName: z.string().min(1),
	})
	.strict();

export type PortalToolRecord = z.infer<typeof portalToolRecordSchema>;
export type PortalToolAnnotations = z.infer<typeof portalToolAnnotationsSchema>;
