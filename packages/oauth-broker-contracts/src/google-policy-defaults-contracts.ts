import { z } from 'zod';

import { googleServicePolicyDefaultsSchema } from './google-account-policy-contracts.js';
import { oauthApplicationIdSchema } from './oauth-identifiers.js';

export const googlePolicyDefaultsSourceSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('collection'),
			collectionId: z.string().min(1).max(128),
			version: z.string().min(1).max(128),
		})
		.strict(),
	z.object({ kind: z.literal('explicit') }).strict(),
	z.object({ kind: z.literal('missing') }).strict(),
]);
export type GooglePolicyDefaultsSource = z.infer<typeof googlePolicyDefaultsSourceSchema>;

export const googlePolicyDefaultsSnapshotSchema = z
	.object({
		defaultsByAgentApplication: z.record(
			z.string().min(1).max(128),
			z.record(oauthApplicationIdSchema, googleServicePolicyDefaultsSchema),
		),
		sourcesByAgent: z.record(z.string().min(1).max(128), googlePolicyDefaultsSourceSchema),
	})
	.strict()
	.refine(
		(snapshot) => {
			const agents = Object.keys(snapshot.defaultsByAgentApplication);
			return (
				agents.length === Object.keys(snapshot.sourcesByAgent).length &&
				agents.every((agentId) => Object.hasOwn(snapshot.sourcesByAgent, agentId))
			);
		},
		{ message: 'Default snapshots must identify the source for exactly their configured agents.' },
	);
export type GooglePolicyDefaultsSnapshot = z.infer<typeof googlePolicyDefaultsSnapshotSchema>;

export const googlePolicyDefaultsRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
