import { z } from 'zod';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthServiceIdSchema,
} from './oauth-identifiers.js';
import { oauthMinimumPermissionSchema } from './oauth-permission-contracts.js';

export const oauthAccountProfileToolRequirementSchema = z
	.object({
		applicationId: oauthApplicationIdSchema,
		kind: z.literal('oauth-account-profile'),
		minimumPermission: oauthMinimumPermissionSchema,
		serviceId: oauthServiceIdSchema,
	})
	.strict();
export type OAuthAccountProfileToolRequirement = z.infer<
	typeof oauthAccountProfileToolRequirementSchema
>;

export const oauthInvocationDependentToolRequirementSchema = z
	.object({
		accountProfileArgument: z.literal('accountProfile'),
		describeBeforeCall: z.literal(true),
		kind: z.literal('invocation-dependent-oauth-account-profile'),
	})
	.strict();

export const oauthToolRequirementSchema = z.discriminatedUnion('kind', [
	oauthAccountProfileToolRequirementSchema,
	oauthInvocationDependentToolRequirementSchema,
]);
export type OAuthToolRequirement = z.infer<typeof oauthToolRequirementSchema>;

export const oauthEligibleAccountProfileSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
	})
	.strict();
export type OAuthEligibleAccountProfile = z.infer<typeof oauthEligibleAccountProfileSchema>;

export const oauthToolAvailabilitySchema = z.discriminatedUnion('kind', [
	z
		.object({
			accountProfiles: z.array(oauthEligibleAccountProfileSchema).min(1).readonly(),
			kind: z.literal('ready'),
		})
		.strict(),
	z.object({ kind: z.literal('authorization-required') }).strict(),
	z.object({ kind: z.literal('reauthorization-required') }).strict(),
	z.object({ kind: z.literal('scope-insufficient') }).strict(),
	z.object({ kind: z.literal('authorization-status-unavailable') }).strict(),
]);
export type OAuthToolAvailability = z.infer<typeof oauthToolAvailabilitySchema>;

export const oauthToolAvailabilityBatchMaximumRequirements = 256;

function oauthToolRequirementIdentity(requirement: OAuthAccountProfileToolRequirement): string {
	return [requirement.applicationId, requirement.serviceId, requirement.minimumPermission].join(
		'\u0000',
	);
}

export const oauthToolAvailabilityBatchRequestSchema = z
	.object({
		requirements: z
			.array(oauthAccountProfileToolRequirementSchema)
			.min(1)
			.max(oauthToolAvailabilityBatchMaximumRequirements)
			.readonly(),
	})
	.strict()
	.refine(
		(request) =>
			new Set(request.requirements.map(oauthToolRequirementIdentity)).size ===
			request.requirements.length,
		{ message: 'OAuth availability batch requirements must be unique.' },
	);
export type OAuthToolAvailabilityBatchRequest = z.infer<
	typeof oauthToolAvailabilityBatchRequestSchema
>;

export const oauthToolAvailabilityBatchItemSchema = z
	.object({
		availability: oauthToolAvailabilitySchema,
		requirement: oauthAccountProfileToolRequirementSchema,
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
			new Set(result.items.map((item) => oauthToolRequirementIdentity(item.requirement))).size ===
			result.items.length,
		{ message: 'OAuth availability batch result requirements must be unique.' },
	);
export type OAuthToolAvailabilityBatchResult = z.infer<
	typeof oauthToolAvailabilityBatchResultSchema
>;
