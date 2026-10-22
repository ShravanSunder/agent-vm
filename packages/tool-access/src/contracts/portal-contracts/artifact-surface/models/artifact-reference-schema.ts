import { z } from 'zod';

export const ArtifactReferenceSchema = z
	.object({
		byteLength: z.number().int().nonnegative(),
		expiresAt: z.string().datetime(),
		fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
		id: z.string().min(1),
		mediaType: z.string().optional(),
	})
	.strict();

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
