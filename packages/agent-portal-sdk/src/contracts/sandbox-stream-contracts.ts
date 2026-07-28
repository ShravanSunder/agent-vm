import { z } from 'zod';

import {
	BoundedByteCountSchema,
	BoundedOpaqueIdentifierSchema,
	NonnegativeSafeIntegerSchema,
	SandboxBinaryChunkSchema,
	SandboxStreamHandleSchema,
	Sha256DigestSchema,
} from './contract-foundations.js';

export const SandboxStreamReadRequestSchema = z
	.object({
		cursor: BoundedOpaqueIdentifierSchema.optional(),
		maxBytes: BoundedByteCountSchema,
		stream: SandboxStreamHandleSchema,
	})
	.strict();

export const SandboxStreamReadResultSchema = z
	.object({
		chunk: SandboxBinaryChunkSchema,
		eof: z.boolean(),
		kind: z.literal('read'),
		nextCursor: BoundedOpaqueIdentifierSchema.optional(),
		sequence: NonnegativeSafeIntegerSchema,
		stream: SandboxStreamHandleSchema,
	})
	.strict();

export const SandboxStreamWriteRequestSchema = z
	.object({
		content: SandboxBinaryChunkSchema,
		contentDigest: Sha256DigestSchema,
		sequence: NonnegativeSafeIntegerSchema,
		stream: SandboxStreamHandleSchema,
	})
	.strict();

export const SandboxStreamWriteResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			bytesWritten: NonnegativeSafeIntegerSchema,
			kind: z.literal('written'),
			sequence: NonnegativeSafeIntegerSchema,
			stream: SandboxStreamHandleSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('already-written'),
			sequence: NonnegativeSafeIntegerSchema,
			stream: SandboxStreamHandleSchema,
		})
		.strict(),
]);

export const SandboxStreamCloseRequestSchema = z
	.object({ stream: SandboxStreamHandleSchema })
	.strict();

export const SandboxStreamCloseResultSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('closed'), stream: SandboxStreamHandleSchema }).strict(),
	z.object({ kind: z.literal('already-closed'), stream: SandboxStreamHandleSchema }).strict(),
]);

export type SandboxStreamReadRequest = z.infer<typeof SandboxStreamReadRequestSchema>;
export type SandboxStreamReadResult = z.infer<typeof SandboxStreamReadResultSchema>;
export type SandboxStreamWriteRequest = z.infer<typeof SandboxStreamWriteRequestSchema>;
export type SandboxStreamWriteResult = z.infer<typeof SandboxStreamWriteResultSchema>;
export type SandboxStreamCloseRequest = z.infer<typeof SandboxStreamCloseRequestSchema>;
export type SandboxStreamCloseResult = z.infer<typeof SandboxStreamCloseResultSchema>;
