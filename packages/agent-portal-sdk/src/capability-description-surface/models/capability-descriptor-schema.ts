import { z } from 'zod';

import {
	CapabilityNameSchema,
	NamespaceNameSchema,
} from '../../contract-primitives/models/capability-reference-schema.js';
import { JsonValueSchema } from '../../contract-primitives/models/json-value-schema.js';

export const JsonSchemaDocumentSchema = z.record(z.string(), JsonValueSchema);

export const CapabilitySummarySchema = z
	.object({
		approval: z.enum(['not_required', 'required', 'conditional']),
		description: z.string(),
		name: CapabilityNameSchema,
		namespace: NamespaceNameSchema,
		title: z.string().min(1),
	})
	.strict();

export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;

export const ResultExpectationSchema = z
	.object({
		canReturnArtifacts: z.boolean().default(false),
		canStream: z.boolean().default(false),
		kind: z.enum(['json', 'text', 'binary_artifact', 'mixed']),
		outputJsonSchema: JsonSchemaDocumentSchema.optional(),
		truncation: z.enum(['none', 'possible', 'expected']).default('possible'),
	})
	.strict();

export type ResultExpectation = z.infer<typeof ResultExpectationSchema>;

export const SafeCallingHintSchema = z
	.object({
		code: z.enum([
			'describe_before_call',
			'approval_may_be_required',
			'read_only',
			'write_or_external_effect',
			'large_output_possible',
			'artifact_output_possible',
		]),
		message: z.string().max(500),
	})
	.strict();

export type SafeCallingHint = z.infer<typeof SafeCallingHintSchema>;

export const CapabilityDescriptorSchema = z
	.object({
		approval: z.enum(['not_required', 'required', 'conditional']),
		description: z.string(),
		inputJsonSchema: JsonSchemaDocumentSchema,
		name: CapabilityNameSchema,
		namespace: NamespaceNameSchema,
		outputJsonSchema: JsonSchemaDocumentSchema.optional(),
		result: ResultExpectationSchema,
		safeCallingHints: z.array(SafeCallingHintSchema),
		title: z.string().min(1),
	})
	.strict();

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
