import { EffectiveNamespaceDiscoverySchema } from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

import { StandaloneToolPortalAuthenticatedEnvelopeSchema } from './standalone-entrypoint/standalone-tool-portal-bearer-credentials.js';
import { ToolPortalAbortSignalSchema } from './tool-portal-abort-signal-schema.js';

export const ToolPortalStandaloneServiceInvocationOptionsSchema = z
	.object({
		approvalToken: z.string().min(1).optional(),
		correlation: z.object({ sessionId: z.string().min(1) }).strict(),
		origin: z
			.object({
				authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelopeSchema,
				kind: z.literal('standalone'),
			})
			.strict(),
		signal: ToolPortalAbortSignalSchema.optional(),
		surfaceClass: z.enum(['http', 'mcp']),
	})
	.strict();

export type ToolPortalStandaloneServiceInvocationOptions = z.infer<
	typeof ToolPortalStandaloneServiceInvocationOptionsSchema
>;

const ToolPortalStandaloneAgentProjectionSchema = z
	.object({
		agentId: z.string().min(1),
		credentialVersion: z.number().int().positive(),
		profileAssignmentRevision: z.string().min(1),
		toolPortalProfileId: z.string().min(1),
	})
	.strict();

export const ToolPortalStandaloneSemanticSnapshotSchema = z
	.object({
		activeRevision: z.string().min(1),
		agentProjections: z.record(z.string().min(1), ToolPortalStandaloneAgentProjectionSchema),
		bindingRevision: z.string().min(1),
		catalogRevision: z.string().min(1),
		desiredRevision: z.string().min(1),
		profilePolicyRevision: z.string().min(1),
		providerRevision: z.string().min(1),
		namespaceDiscoveryByProfile: z.record(
			z.string().min(1),
			z.array(EffectiveNamespaceDiscoverySchema),
		),
		schemaRevision: z.string().min(1),
		schemaVersion: z.literal(1),
		surfaceEligibilityByProfile: z.record(
			z.string().min(1),
			z.record(z.string().min(1), z.array(z.enum(['http', 'mcp'])).min(1)),
		),
	})
	.strict();

export type ToolPortalStandaloneSemanticSnapshot = z.infer<
	typeof ToolPortalStandaloneSemanticSnapshotSchema
>;
