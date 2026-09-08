import { z } from 'zod';

import { oauthAccountIdSchema } from './google-account-policy-contracts.js';
import { oauthAccountActivityAvailabilitySchema } from './oauth-authorization-action-contracts.js';
import { oauthApplicationIdSchema } from './oauth-identifiers.js';

export const oauthOperationToolRequirementSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		operationId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthOperationToolRequirement = z.infer<typeof oauthOperationToolRequirementSchema>;
export const oauthToolAvailabilityBatchMaximumRequirements = 256;
export function oauthOperationRequirementIdentity(
	requirement: OAuthOperationToolRequirement,
): string {
	return JSON.stringify([requirement.applicationId, requirement.operationId]);
}
const requirementsSchema = z
	.array(oauthOperationToolRequirementSchema)
	.min(1)
	.max(oauthToolAvailabilityBatchMaximumRequirements)
	.readonly()
	.refine(
		(requirements) =>
			new Set(requirements.map(oauthOperationRequirementIdentity)).size === requirements.length,
		'Google operation requirements must be unique.',
	);

export const oauthToolRequirementSchema = z
	.object({
		kind: z.literal('google-account'),
		accountArgument: z.literal('accountId'),
		describeBeforeCall: z.literal(true),
		operations: requirementsSchema,
	})
	.strict();
export type OAuthToolRequirement = z.infer<typeof oauthToolRequirementSchema>;

export const oauthAccountToolOptionSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		metadata: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('verified'), accountAlias: z.string().min(1).max(320) }).strict(),
			z.object({ kind: z.literal('unavailable') }).strict(),
		]),
		availability: oauthAccountActivityAvailabilitySchema,
	})
	.strict()
	.refine(
		(option) => option.availability.kind !== 'ready' || option.metadata.kind === 'verified',
		'Usable account activity requires authenticated account metadata.',
	);
export type OAuthAccountToolOption = z.infer<typeof oauthAccountToolOptionSchema>;

export const oauthOperationAvailabilitySchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('accounts'),
			accounts: z.array(oauthAccountToolOptionSchema).max(256).readonly(),
		})
		.strict(),
	z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type OAuthOperationAvailability = z.infer<typeof oauthOperationAvailabilitySchema>;
export const oauthToolAvailabilityBatchRequestSchema = z
	.object({ requirements: requirementsSchema })
	.strict();
export type OAuthToolAvailabilityBatchRequest = z.infer<
	typeof oauthToolAvailabilityBatchRequestSchema
>;

export const oauthToolAvailabilityBatchItemSchema = z
	.object({
		requirement: oauthOperationToolRequirementSchema,
		availability: oauthOperationAvailabilitySchema,
	})
	.strict();
export const oauthToolAvailabilityBatchResultSchema = z
	.object({
		items: z
			.array(oauthToolAvailabilityBatchItemSchema)
			.max(oauthToolAvailabilityBatchMaximumRequirements)
			.readonly(),
	})
	.strict()
	.refine(
		(result) =>
			new Set(result.items.map((item) => oauthOperationRequirementIdentity(item.requirement)))
				.size === result.items.length,
		'Google operation availability results must be unique.',
	);
export type OAuthToolAvailabilityBatchResult = z.infer<
	typeof oauthToolAvailabilityBatchResultSchema
>;
export const oauthToolAvailabilitySchema = z
	.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('operation-options'),
				items: oauthToolAvailabilityBatchResultSchema.shape.items,
			})
			.strict(),
		z.object({ kind: z.literal('unavailable') }).strict(),
	])
	.refine(
		(availability) =>
			availability.kind !== 'operation-options' ||
			new Set(availability.items.map((item) => oauthOperationRequirementIdentity(item.requirement)))
				.size === availability.items.length,
		'Google operation availability results must be unique.',
	);
export type OAuthToolAvailability = z.infer<typeof oauthToolAvailabilitySchema>;
