import { z } from 'zod';

import { NamespaceNameSchema } from '../contract-primitives/index.js';
import { withPortableSuperRefinement } from '../portable-contracts/portable-refinement-authoring.js';
import {
	BoundedOpaqueIdentifierSchema,
	PositiveSafeIntegerSchema,
} from './contract-foundations.js';

export function compareUnicodeCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const leftCodePoint = leftCodePoints[index] ?? 0;
		const rightCodePoint = rightCodePoints[index] ?? 0;
		if (leftCodePoint !== rightCodePoint) {
			return leftCodePoint - rightCodePoint;
		}
	}
	return leftCodePoints.length - rightCodePoints.length;
}

export const GatewayRuntimeFrameworkKindSchema = z.literal('hermes');
export const GatewayRuntimeManagedPluginClientKindSchema = z.literal('hermes-managed-plugin');
export const GatewayRuntimeFrameworkIdentitySchema = z
	.object({
		kind: z.literal('hermes'),
		profileName: BoundedOpaqueIdentifierSchema,
	})
	.strict()
	.readonly();
export const GatewayRuntimeProjectionCohortDigestSchema = z
	.string()
	.regex(/^projection-cohort:[a-f0-9]{64}$/u);

export const ManagedAgentProjectionSchema = withPortableSuperRefinement({
	refinement: (projection, context) => {
		if (
			new Set(projection.toolPortalNamespaceNames).size !==
			projection.toolPortalNamespaceNames.length
		) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Agent Projection Tool Portal namespace names must be unique.',
				path: ['toolPortalNamespaceNames'],
			});
		}
		const sortedNamespaceNames = [...projection.toolPortalNamespaceNames].toSorted(
			compareUnicodeCodePointStrings,
		);
		if (
			projection.toolPortalNamespaceNames.some(
				(namespaceName, index) => namespaceName !== sortedNamespaceNames[index],
			)
		) {
			context.addIssue({
				code: 'custom',
				message: 'Managed Agent Projection Tool Portal namespace names must be sorted.',
				path: ['toolPortalNamespaceNames'],
			});
		}
	},
	refinementIdentity: 'gateway.managed-agent-projection.namespace-names',
	schema: z
		.object({
			agentId: BoundedOpaqueIdentifierSchema,
			frameworkIdentity: GatewayRuntimeFrameworkIdentitySchema,
			profileAssignmentRevision: BoundedOpaqueIdentifierSchema,
			toolPortalNamespaceNames: z.array(NamespaceNameSchema).readonly(),
			toolPortalProfileId: BoundedOpaqueIdentifierSchema,
		})
		.strict(),
}).readonly();

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
