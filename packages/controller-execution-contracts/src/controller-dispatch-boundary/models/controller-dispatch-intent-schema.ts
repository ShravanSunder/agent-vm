import { CapabilityReferenceSchema, JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

export const ControllerTrustedScopeSchema = z
	.object({
		agentId: z.string().min(1),
		profileId: z.string().min(1),
		userId: z.string().min(1).optional(),
	})
	.strict();

export const ControllerDispatchIntentSchema = z
	.object({
		auditCorrelationId: z.string().min(1),
		canonicalArguments: JsonObjectSchema,
		capability: CapabilityReferenceSchema,
		trustedScope: ControllerTrustedScopeSchema,
	})
	.strict();

export type ControllerDispatchIntent = z.infer<typeof ControllerDispatchIntentSchema>;
