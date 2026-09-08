import { z } from 'zod';

import { PortalAttachmentSourceSchema } from './portal-attachment-contracts.js';

/** The reference selects the source; no caller may supply its VM, root or owner. */
export const PortalFileRequestSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('attach'),
			source: PortalAttachmentSourceSchema,
			caption: z.string().max(1024).optional(),
		})
		.strict(),
]);
export type PortalFileRequest = z.infer<typeof PortalFileRequestSchema>;

export const PortalFileResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('attached'),
			messageId: z.string().min(1).max(256),
			fileName: z.string().min(1).max(255),
			byteLength: z
				.number()
				.int()
				.nonnegative()
				.max(16 * 1024 * 1024),
			sha256: z.string().regex(/^[a-f0-9]{64}$/u),
			cleanup: z.enum(['complete', 'pending']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('attachment-failed'),
			reason: z.enum(['route-unavailable', 'staging-failed', 'native-send-failed']),
			cleanup: z.enum(['complete', 'pending']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('attachment-unconfirmed'),
			reason: z.enum(['send-timeout', 'send-error']),
			cleanup: z.enum(['complete', 'pending']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('failed'),
			reason: z.enum([
				'unavailable',
				'busy',
				'expired',
				'stale-authority',
				'invalid-path',
				'size-limit',
				'destination-conflict',
				'transfer-failed',
				'cleanup-pending',
			]),
		})
		.strict(),
]);
export type PortalFileResult = z.infer<typeof PortalFileResultSchema>;
