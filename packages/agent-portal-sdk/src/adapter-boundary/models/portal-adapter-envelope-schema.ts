import { z } from 'zod';

export const TrustedAgentScopeSchema = z
	.object({
		agentId: z.string().min(1),
		profileId: z.string().min(1),
		source: z.enum(['mcp-portal', 'tool-portal', 'controller']),
		userId: z.string().min(1).optional(),
	})
	.strict();

export type TrustedAgentScope = z.infer<typeof TrustedAgentScopeSchema>;

export const PortalAdapterEnvelopeSchema = z
	.object({
		adapter: z.enum(['mcp-provider', 'tool-portal', 'cli', 'sdk', 'http-api']),
		auditCorrelationId: z.string().min(1).optional(),
		trustedScope: TrustedAgentScopeSchema,
	})
	.strict();

export type PortalAdapterEnvelope = z.infer<typeof PortalAdapterEnvelopeSchema>;
