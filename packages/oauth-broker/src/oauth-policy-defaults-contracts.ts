import {
	googlePolicyDefaultsRevisionSchema,
	googlePolicyDefaultsSnapshotSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

export const oauthPolicyDefaultsActivationInputSchema = z
	.object({
		zoneId: z.string().min(1).max(128),
		defaultsRevision: googlePolicyDefaultsRevisionSchema,
		snapshot: googlePolicyDefaultsSnapshotSchema,
	})
	.strict();
export type OAuthPolicyDefaultsActivationInput = z.infer<
	typeof oauthPolicyDefaultsActivationInputSchema
>;

export const oauthStoredPolicyDefaultsActivationSchema = z
	.object({
		zoneId: z.string().min(1).max(128),
		activeDefaultsDigest: googlePolicyDefaultsRevisionSchema,
		snapshot: googlePolicyDefaultsSnapshotSchema,
		updatedAtMs: z.number().int().nonnegative(),
	})
	.strict();
export type OAuthStoredPolicyDefaultsActivation = z.infer<
	typeof oauthStoredPolicyDefaultsActivationSchema
>;

export const oauthPolicyDefaultsChangeEventSchema = z
	.object({
		kind: z.literal('defaults-activated'),
		actor: z.object({ kind: z.literal('operator-config') }).strict(),
		zoneId: z.string().min(1).max(128),
		eventId: z.uuid(),
		transitionId: z.uuid(),
		timestampMs: z.number().int().nonnegative(),
		oldRevision: googlePolicyDefaultsRevisionSchema.nullable(),
		newRevision: googlePolicyDefaultsRevisionSchema,
		before: googlePolicyDefaultsSnapshotSchema.nullable(),
		after: googlePolicyDefaultsSnapshotSchema,
	})
	.strict();
export type OAuthPolicyDefaultsChangeEvent = z.infer<typeof oauthPolicyDefaultsChangeEventSchema>;
