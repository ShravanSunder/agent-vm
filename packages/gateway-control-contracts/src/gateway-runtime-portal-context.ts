import { ManagedAgentProjectionSchema } from '@agent-vm/agent-portal-sdk/contracts';
import { z } from 'zod/v4';

export {
	GatewayRuntimeFrameworkKindSchema,
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationCorrelationSchema,
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	GatewayRuntimeTrustedInvocationRequesterSchema,
	ManagedAgentProjectionSchema,
} from '@agent-vm/agent-portal-sdk/contracts';
export type {
	GatewayRuntimeFrameworkKind,
	GatewayRuntimeFrameworkIdentity,
	GatewayRuntimeTrustedInvocationCorrelation,
	GatewayRuntimeTrustedInvocationContext,
	GatewayRuntimeTrustedInvocationPrincipal,
	GatewayRuntimeTrustedInvocationRequester,
	ManagedAgentProjection,
} from '@agent-vm/agent-portal-sdk/contracts';

export const GatewayRuntimePortalSurfaceClassSchema = z.enum(['mcp', 'protected_uds']);

export const GatewayRuntimePortalSemanticSnapshotSchema = z
	.object({
		activeRevision: z.string().min(1),
		agentProjections: z.record(z.string().min(1), ManagedAgentProjectionSchema),
		bindingRevision: z.string().min(1),
		catalogRevision: z.string().min(1),
		desiredRevision: z.string().min(1),
		profilePolicyRevision: z.string().min(1),
		projectionCohortDigest: z.string().regex(/^projection-cohort:[a-f0-9]{64}$/u),
		providerRevision: z.string().min(1),
		schemaRevision: z.string().min(1),
		schemaVersion: z.literal(1),
		surfaceEligibilityByProfile: z.record(
			z.string().min(1),
			z.record(z.string().min(1), z.array(GatewayRuntimePortalSurfaceClassSchema).min(1)),
		),
	})
	.strict();

export type GatewayRuntimePortalSurfaceClass = z.infer<
	typeof GatewayRuntimePortalSurfaceClassSchema
>;
export type GatewayRuntimePortalSemanticSnapshot = z.infer<
	typeof GatewayRuntimePortalSemanticSnapshotSchema
>;
