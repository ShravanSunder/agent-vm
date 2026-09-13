import { z } from 'zod';

/** Metadata only. Dispatch still verifies the bound bytes and current source lease. */
export const gogFileInputSnapshotSchema = z
	.object({
		leaseId: z.string().min(1).max(256),
		leafGeneration: z.string().min(1).max(256),
		vmId: z.string().min(1).max(256),
		files: z
			.array(
				z
					.object({
						relativePath: z.string().min(1).max(8192),
						byteLength: z
							.number()
							.int()
							.nonnegative()
							.max(16 * 1024 * 1024),
						sha256: z.string().regex(/^[a-f0-9]{64}$/u),
					})
					.strict(),
			)
			.min(1)
			.max(128)
			.readonly(),
	})
	.strict();

export type GogFileInputSnapshot = z.infer<typeof gogFileInputSnapshotSchema>;
