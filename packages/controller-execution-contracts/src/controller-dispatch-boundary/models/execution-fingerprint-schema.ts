import { CapabilityReferenceSchema } from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

export const ExecutionFingerprintSchema = z
	.object({
		agentId: z.string().min(1),
		artifactIntentHash: z.string().min(1),
		backendBindingRevision: z.string().min(1),
		canonicalArgumentHash: z.string().min(1),
		capability: CapabilityReferenceSchema,
		catalogRevision: z.string().min(1),
		custodyMode: z.enum(['ephemeral_material', 'controller_durable_state']),
		egressPolicyHash: z.string().min(1),
		executableTemplateRevision: z.string().min(1),
		operatorUserId: z.string().min(1).optional(),
		outputPolicyHash: z.string().min(1),
		policyRevision: z.string().min(1),
	})
	.strict();

export type ExecutionFingerprint = z.infer<typeof ExecutionFingerprintSchema>;
