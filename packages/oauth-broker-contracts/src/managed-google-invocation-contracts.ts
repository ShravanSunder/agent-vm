import { z } from 'zod';

import { gogFileInputSnapshotSchema } from './gog-file-input-contracts.js';
import {
	oauthAccountIdSchema,
	oauthAuthorizationIdSchema,
} from './google-account-policy-contracts.js';
import { googlePolicyDefaultsRevisionSchema } from './google-policy-defaults-contracts.js';
import { oauthApplicationIdSchema } from './oauth-identifiers.js';

export const managedGoogleInvocationBindingSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		applicationId: oauthApplicationIdSchema,
		authorizationId: oauthAuthorizationIdSchema,
		generation: z.number().int().positive(),
		authorizationMetadataRevision: z.number().int().positive(),
		overrideRevision: z.number().int().positive(),
		defaultsRevision: googlePolicyDefaultsRevisionSchema,
		configRevision: z.string().min(1).max(256),
		clientBindingRevision: z.string().min(1).max(256),
		catalogVersion: z.string().min(1).max(256),
		commandTableRevision: z.string().regex(/^[a-f0-9]{64}$/u),
		operationId: z.string().min(1).max(128),
		gmailWriteAllowed: z.boolean(),
	})
	.strict();
export type ManagedGoogleInvocationBinding = z.infer<typeof managedGoogleInvocationBindingSchema>;

export const managedGoogleDisplaySchema = z
	.object({
		accountId: oauthAccountIdSchema,
		authorizationId: oauthAuthorizationIdSchema,
		accountAlias: z.string().min(1).max(320),
		applicationLabel: z.string().min(1).max(160),
		authorizationMetadataRevision: z.number().int().positive(),
	})
	.strict();
export type ManagedGoogleDisplay = z.infer<typeof managedGoogleDisplaySchema>;

export const managedGoogleReadyPreflightSchema = z
	.object({
		kind: z.literal('ready'),
		disposition: z.enum(['ask', 'allow']),
		binding: managedGoogleInvocationBindingSchema,
		display: managedGoogleDisplaySchema,
		fileInputs: gogFileInputSnapshotSchema.optional(),
	})
	.strict();
export type ManagedGoogleReadyPreflight = z.infer<typeof managedGoogleReadyPreflightSchema>;
export const managedGooglePreflightResultSchema = z.discriminatedUnion('kind', [
	managedGoogleReadyPreflightSchema,
	z
		.object({
			kind: z.literal('no-oauth'),
			commandTableRevision: z.string().regex(/^[a-f0-9]{64}$/u),
		})
		.strict(),
	z.object({ kind: z.literal('denied') }).strict(),
	z.object({ kind: z.literal('consent-required') }).strict(),
	z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type ManagedGooglePreflightResult = z.infer<typeof managedGooglePreflightResultSchema>;
