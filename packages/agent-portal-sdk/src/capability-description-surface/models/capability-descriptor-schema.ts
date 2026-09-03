import {
	oauthToolAvailabilitySchema,
	oauthToolRequirementSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	CapabilityNameSchema,
	NamespaceNameSchema,
} from '../../contract-primitives/models/capability-reference-schema.js';
import { JsonValueSchema } from '../../contract-primitives/models/json-value-schema.js';

export const JsonSchemaDocumentSchema = z.record(z.string(), JsonValueSchema);

export const ToolSchemaSummarySchema = z
	.object({
		optional: z.array(z.string()),
		propertyCount: z.number().int().nonnegative(),
		required: z.array(z.string()),
		type: z.string().min(1),
	})
	.strict();

export type ToolSchemaSummary = z.infer<typeof ToolSchemaSummarySchema>;

export const ToolSafetySummarySchema = z
	.object({
		destructiveHint: z.boolean().optional(),
		readOnlyHint: z.boolean().optional(),
	})
	.strict();

export type ToolSafetySummary = z.infer<typeof ToolSafetySummarySchema>;

export const ToolSchemaHintSchema = z
	.object({
		message: z.string().max(500),
		next: z.enum(['call_ready', 'describe_before_call']),
	})
	.strict();

export type ToolSchemaHint = z.infer<typeof ToolSchemaHintSchema>;

export const ToolCallDispositionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('without-approval') }).strict(),
	z.object({ kind: z.literal('requires-approval') }).strict(),
	z
		.object({
			describeBeforeCall: z.literal(true),
			kind: z.literal('invocation-dependent'),
		})
		.strict(),
]);

export type ToolCallDisposition = z.infer<typeof ToolCallDispositionSchema>;

export const CapabilityDiscoveryMetadataSchema = z
	.object({
		callDisposition: ToolCallDispositionSchema,
		oauthAvailability: oauthToolAvailabilitySchema.optional(),
		oauthRequirement: oauthToolRequirementSchema.optional(),
	})
	.strict();

export type CapabilityDiscoveryMetadata = z.infer<typeof CapabilityDiscoveryMetadataSchema>;

export const CapabilitySummarySchema = z
	.object({
		callDisposition: ToolCallDispositionSchema.optional(),
		description: z.string().optional(),
		descriptionTruncated: z.boolean().optional(),
		input: ToolSchemaSummarySchema,
		namespace: NamespaceNameSchema,
		output: ToolSchemaSummarySchema.optional(),
		safety: ToolSafetySummarySchema,
		schemaHint: ToolSchemaHintSchema.optional(),
		title: z.string().min(1).optional(),
		name: CapabilityNameSchema,
		oauthAvailability: oauthToolAvailabilitySchema.optional(),
		oauthRequirement: oauthToolRequirementSchema.optional(),
		toolRef: z.string().min(1),
	})
	.strict();

export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;

export const CompactCapabilityDescriptionCodePointLimit = 240;

export function compactCapabilitySummaryDescription(summary: CapabilitySummary): CapabilitySummary {
	if (
		summary.description === undefined ||
		Array.from(summary.description).length <= CompactCapabilityDescriptionCodePointLimit
	) {
		return { ...summary, descriptionTruncated: false };
	}
	const codePoints = Array.from(summary.description);
	return {
		...summary,
		description: `${codePoints.slice(0, CompactCapabilityDescriptionCodePointLimit - 1).join('')}…`,
		descriptionTruncated: true,
	};
}

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

export const CapabilitySearchMatchSchema = CapabilitySummarySchema.extend({
	inputSchema: JsonSchemaDocumentSchema.optional(),
	outputSchema: JsonSchemaDocumentSchema.optional(),
	relationshipHints: z.array(JsonValueSchema).optional(),
	schemaFieldMatches: z.array(JsonValueSchema).optional(),
}).strict();

export type CapabilitySearchMatch = z.infer<typeof CapabilitySearchMatchSchema>;

export const CapabilityDescriptorSchema = z
	.object({
		annotations: JsonSchemaDocumentSchema.default({}),
		callDisposition: ToolCallDispositionSchema.optional(),
		description: z.string().optional(),
		inputSchema: JsonSchemaDocumentSchema.optional(),
		namespace: NamespaceNameSchema,
		outputSchema: JsonSchemaDocumentSchema.optional(),
		related: z.array(JsonValueSchema).default([]),
		schemaHint: ToolSchemaHintSchema.optional(),
		title: z.string().min(1).optional(),
		name: CapabilityNameSchema,
		oauthAvailability: oauthToolAvailabilitySchema.optional(),
		oauthRequirement: oauthToolRequirementSchema.optional(),
		toolRef: z.string().min(1),
		typescriptHelper: z.string().optional(),
		zod: JsonSchemaDocumentSchema.optional(),
	})
	.strict();

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
