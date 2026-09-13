import { z } from 'zod';

export const PortalAttachmentSourceSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('operation-file'),
			referenceId: z.string().uuid(),
			path: z.string().min(1).max(8192),
		})
		.strict(),
	z.object({ kind: z.literal('tool-vm-file'), path: z.string().min(1).max(8192) }).strict(),
]);

/** Private plugin orchestration. Recipient/profile/session come from the trusted invocation. */
export const PortalAttachmentRequestSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('stage'), source: PortalAttachmentSourceSchema }).strict(),
	z
		.object({
			action: z.literal('settle'),
			stagingId: z.string().uuid(),
			outcome: z.enum(['sent', 'failed', 'unconfirmed', 'sender-pending']),
		})
		.strict(),
]);
export type PortalAttachmentRequest = z.infer<typeof PortalAttachmentRequestSchema>;

export const PortalAttachmentResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('staged'),
			stagingId: z.string().uuid(),
			path: z.string().regex(
				// oxlint-disable-next-line no-control-regex -- reject control bytes in this shared TS/Python filesystem-path contract.
				/^\/home\/hermes\/\.cache\/agent-vm-native\/[a-f0-9]{64}\/[a-f0-9]{64}\/portal-native-[a-z0-9][a-z0-9_-]{0,63}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,255}$/u,
			),
			byteLength: z
				.number()
				.int()
				.nonnegative()
				.max(16 * 1024 * 1024),
			sha256: z.string().regex(/^[a-f0-9]{64}$/u),
		})
		.strict(),
	z
		.object({
			kind: z.literal('failed'),
			reason: z.enum(['unavailable', 'capacity', 'transfer-failed', 'cleanup-pending']),
		})
		.strict(),
	z.object({ kind: z.literal('cleaned') }).strict(),
	z.object({ kind: z.literal('retained') }).strict(),
	z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type PortalAttachmentResult = z.infer<typeof PortalAttachmentResultSchema>;
