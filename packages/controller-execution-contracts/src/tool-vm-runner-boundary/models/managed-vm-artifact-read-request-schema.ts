import { z } from 'zod';

export const ManagedVmArtifactReadMaxBytes = 16 * 1024 * 1024;

export const ManagedVmArtifactReadRequestSchema = z
	.object({
		artifactId: z.string().min(1),
		maxBytes: z.number().int().positive().max(ManagedVmArtifactReadMaxBytes),
		noFollow: z.literal(true),
	})
	.strict();

export type ManagedVmArtifactReadRequest = z.infer<typeof ManagedVmArtifactReadRequestSchema>;
