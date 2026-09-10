import {
	googleAccountPolicySnapshotSchema,
	googlePolicyDefaultsRevisionSchema,
	oauthBrowserOwnerIdentitySchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { encryptedOAuthEnvelopeSchema } from './envelope-codec.js';

const policyMutationShape = {
	before: googleAccountPolicySnapshotSchema,
	after: googleAccountPolicySnapshotSchema,
	envelope: encryptedOAuthEnvelopeSchema,
};
export const oauthAccountPolicySaveInputSchema = z
	.object({
		...policyMutationShape,
		expectedDefaultsRevision: googlePolicyDefaultsRevisionSchema,
	})
	.strict();
export type OAuthAccountPolicySaveInput = z.infer<typeof oauthAccountPolicySaveInputSchema>;

export const oauthAccountPolicyActivationInputSchema = z
	.object({
		...policyMutationShape,
		expectedTransitionId: z.uuid(),
	})
	.strict();
export type OAuthAccountPolicyActivationInput = z.infer<
	typeof oauthAccountPolicyActivationInputSchema
>;

export const oauthAccountPolicyContainmentInputSchema = z
	.object({
		snapshot: googleAccountPolicySnapshotSchema,
		expectedTransitionId: z.uuid(),
		result: z.enum(['pending', 'failed']),
	})
	.strict();
export type OAuthAccountPolicyContainmentInput = z.infer<
	typeof oauthAccountPolicyContainmentInputSchema
>;

export const oauthAccountPolicyChangeEventSchema = z
	.object({
		kind: z.enum([
			'policy-saved',
			'policy-activated',
			'policy-containment-pending',
			'policy-containment-failed',
		]),
		actor: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('owner'), identity: oauthBrowserOwnerIdentitySchema }).strict(),
			z.object({ kind: z.literal('system-recovery') }).strict(),
		]),
		eventId: z.uuid(),
		transitionId: z.uuid(),
		timestampMs: z.number().int().nonnegative(),
		zoneId: z.string().min(1).max(128),
		agentId: z.string().min(1).max(128),
		accountId: googleAccountPolicySnapshotSchema.shape.accountId,
		applicationId: googleAccountPolicySnapshotSchema.shape.applicationId,
		authorizationId: googleAccountPolicySnapshotSchema.shape.authorizationId,
		oldRevision: z.number().int().positive(),
		newRevision: z.number().int().positive(),
		before: googleAccountPolicySnapshotSchema.shape.services,
		after: googleAccountPolicySnapshotSchema.shape.services,
		state: z.enum(['applying', 'active']),
	})
	.strict();
export type OAuthAccountPolicyChangeEvent = z.infer<typeof oauthAccountPolicyChangeEventSchema>;
