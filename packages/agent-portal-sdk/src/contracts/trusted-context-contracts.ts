import { z } from 'zod';

import { withPortableSuperRefinement } from '../portable-contracts/portable-refinement-authoring.js';
import {
	BoundedOpaqueIdentifierSchema,
	PositiveSafeIntegerSchema,
} from './contract-foundations.js';

export const GatewayRuntimeFrameworkKindSchema = z.enum(['openclaw', 'hermes']);
export const GatewayRuntimeManagedPluginClientKindSchema = z.enum([
	'openclaw-managed-plugin',
	'hermes-managed-plugin',
]);
export const GatewayRuntimeFrameworkIdentitySchema = z
	.discriminatedUnion('kind', [
		z
			.object({
				agentId: BoundedOpaqueIdentifierSchema,
				kind: z.literal('openclaw'),
			})
			.strict(),
		z
			.object({
				kind: z.literal('hermes'),
				profileName: BoundedOpaqueIdentifierSchema,
			})
			.strict(),
	])
	.readonly();
export const GatewayRuntimeProjectionCohortDigestSchema = z
	.string()
	.regex(/^projection-cohort:[a-f0-9]{64}$/u);

export const ManagedAgentProjectionSchema = z
	.object({
		agentId: BoundedOpaqueIdentifierSchema,
		frameworkIdentity: GatewayRuntimeFrameworkIdentitySchema,
		profileAssignmentRevision: BoundedOpaqueIdentifierSchema,
		toolPortalProfileId: BoundedOpaqueIdentifierSchema,
	})
	.strict()
	.readonly();

export const GatewayRuntimeAttachmentMetadataSchema = withPortableSuperRefinement({
	refinement: (metadata, context) => {
		if (new Set(metadata.configuredAgentIds).size !== metadata.configuredAgentIds.length) {
			context.addIssue({
				code: 'custom',
				message: 'Gateway attachment metadata contains a duplicate configured agent id.',
				path: ['configuredAgentIds'],
			});
		}
	},
	refinementIdentity: 'gateway.attachment.unique-agent-ids',
	schema: z
		.object({
			attachmentGeneration: PositiveSafeIntegerSchema,
			clientKind: GatewayRuntimeManagedPluginClientKindSchema,
			configuredAgentIds: z.array(BoundedOpaqueIdentifierSchema).min(1).max(128),
			frameworkEpoch: BoundedOpaqueIdentifierSchema,
			gatewayEpoch: BoundedOpaqueIdentifierSchema,
			protocolVersion: PositiveSafeIntegerSchema,
			projectionCohortDigest: GatewayRuntimeProjectionCohortDigestSchema,
			runtimeEpoch: BoundedOpaqueIdentifierSchema,
			schemaVersion: PositiveSafeIntegerSchema,
		})
		.strict(),
});

export const GatewayStablePrincipalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const GatewayRuntimeTrustedInvocationPrincipalSchema = z
	.object({
		agentId: BoundedOpaqueIdentifierSchema,
		frameworkIdentity: GatewayRuntimeFrameworkIdentitySchema,
		profileAssignmentRevision: BoundedOpaqueIdentifierSchema,
		toolPortalProfileId: BoundedOpaqueIdentifierSchema,
	})
	.strict();

export const GatewayRuntimeTrustedInvocationRequesterSchema = z
	.object({
		authenticatedSubjectId: BoundedOpaqueIdentifierSchema,
	})
	.strict();

export const GatewayRuntimeTrustedInvocationCorrelationSchema = z
	.object({
		runId: BoundedOpaqueIdentifierSchema.optional(),
		sessionId: BoundedOpaqueIdentifierSchema.optional(),
		sessionKey: BoundedOpaqueIdentifierSchema.optional(),
		toolCallId: BoundedOpaqueIdentifierSchema.optional(),
	})
	.strict();

export const GatewayRuntimeTrustedInvocationContextSchema = z
	.object({
		correlation: GatewayRuntimeTrustedInvocationCorrelationSchema.optional(),
		principal: GatewayRuntimeTrustedInvocationPrincipalSchema,
		requester: GatewayRuntimeTrustedInvocationRequesterSchema.optional(),
	})
	.strict();

export type GatewayRuntimeAttachmentMetadata = z.infer<
	typeof GatewayRuntimeAttachmentMetadataSchema
>;
export type GatewayRuntimeFrameworkIdentity = z.infer<typeof GatewayRuntimeFrameworkIdentitySchema>;
export type GatewayRuntimeFrameworkKind = z.infer<typeof GatewayRuntimeFrameworkKindSchema>;
export type GatewayRuntimeManagedPluginClientKind = z.infer<
	typeof GatewayRuntimeManagedPluginClientKindSchema
>;
export type ManagedAgentProjection = z.infer<typeof ManagedAgentProjectionSchema>;
export type GatewayRuntimeTrustedInvocationCorrelation = z.infer<
	typeof GatewayRuntimeTrustedInvocationCorrelationSchema
>;
export type GatewayRuntimeTrustedInvocationContext = z.infer<
	typeof GatewayRuntimeTrustedInvocationContextSchema
>;
export type GatewayStablePrincipalDigest = z.infer<typeof GatewayStablePrincipalDigestSchema>;
export type GatewayRuntimeTrustedInvocationPrincipal = z.infer<
	typeof GatewayRuntimeTrustedInvocationPrincipalSchema
>;
export type GatewayRuntimeTrustedInvocationRequester = z.infer<
	typeof GatewayRuntimeTrustedInvocationRequesterSchema
>;
