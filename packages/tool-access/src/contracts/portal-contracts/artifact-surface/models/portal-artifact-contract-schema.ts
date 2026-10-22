import { z } from 'zod';

import { JsonValueSchema } from '../../contract-primitives/models/json-value-schema.js';
import { ArtifactReferenceSchema } from './artifact-reference-schema.js';

export const PortalArtifactRecordSchema = z
	.object({
		metadata: z.record(z.string(), JsonValueSchema).optional(),
		reference: ArtifactReferenceSchema,
		redactionProfile: z.string().min(1),
	})
	.strict();

export type PortalArtifactRecord = z.infer<typeof PortalArtifactRecordSchema>;

export const PortalArtifactReadRequestSchema = z
	.object({
		maxBytes: z
			.number()
			.int()
			.positive()
			.max(16 * 1024 * 1024),
		offsetBytes: z.number().int().nonnegative().default(0),
		reference: ArtifactReferenceSchema,
	})
	.strict();

export type PortalArtifactReadRequest = z.infer<typeof PortalArtifactReadRequestSchema>;

export const PortalArtifactReadResultSchema = z
	.object({
		contentBase64: z.string(),
		mediaType: z.string().optional(),
		offsetBytes: z.number().int().nonnegative(),
		reference: ArtifactReferenceSchema,
		truncated: z.boolean().default(false),
	})
	.strict();

export type PortalArtifactReadResult = z.infer<typeof PortalArtifactReadResultSchema>;

export const PortalArtifactRedactorSchema = z
	.object({
		maxModelVisibleBytes: z.number().int().nonnegative(),
		profile: z.string().min(1),
	})
	.strict();

export type PortalArtifactRedactor = z.infer<typeof PortalArtifactRedactorSchema>;
