import { z } from 'zod';

// Copied per-call upstream limit. Aggregate output bounds belong to S3c.
export const maximumNodeHostResultBytes = 4 * 1024 * 1024;
// Three 1024-character key strings and one state reference/reason, each at
// worst six JSON bytes per character, need 24 KiB. Fixed version, digest,
// generated UUID, ISO timestamps and JSON punctuation fit within the extra 8 KiB.
export const maximumOperationRecordEnvelopeBytes = 32 * 1024;
export const minimumNodeOperationRecordBytes =
	maximumNodeHostResultBytes + maximumOperationRecordEnvelopeBytes;

export const nodeOperationStoreBoundsSchema = z.strictObject({
	maximumOperations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	maximumRecordBytes: z
		.number()
		.int()
		.min(minimumNodeOperationRecordBytes)
		.max(Number.MAX_SAFE_INTEGER),
});
export type NodeOperationStoreBounds = z.infer<typeof nodeOperationStoreBoundsSchema>;
