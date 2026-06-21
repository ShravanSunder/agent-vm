import { z } from 'zod';

export const ArtifactReferenceSchema = z
	.object({
		byteLength: z.number().int().nonnegative().optional(),
		expiresAt: z.string().datetime().optional(),
		id: z.string().min(1),
		mediaType: z.string().optional(),
	})
	.strict();

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
