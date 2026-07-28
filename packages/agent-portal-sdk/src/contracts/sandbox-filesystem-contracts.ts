import { z } from 'zod';

import {
	BoundedByteCountSchema,
	BoundedOpaqueIdentifierSchema,
	NonnegativeSafeIntegerSchema,
	PositiveSafeIntegerSchema,
	SandboxBinaryChunkSchema,
	SandboxEnvironmentHandleSchema,
	SandboxGuestPathSchema,
	Sha256DigestSchema,
} from './contract-foundations.js';

const SandboxFilesystemPathRequestSchema = z
	.object({
		environment: SandboxEnvironmentHandleSchema,
		path: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsStatRequestSchema = SandboxFilesystemPathRequestSchema;

export const SandboxFilesystemEntrySchema = z
	.object({
		byteLength: NonnegativeSafeIntegerSchema.optional(),
		kind: z.enum(['file', 'directory', 'symlink']),
		path: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsStatResultSchema = z.discriminatedUnion('kind', [
	z.object({ entry: SandboxFilesystemEntrySchema, kind: z.literal('stat') }).strict(),
	z.object({ kind: z.literal('not-found'), path: SandboxGuestPathSchema }).strict(),
]);

export const SandboxFsListRequestSchema = SandboxFilesystemPathRequestSchema.extend({
	cursor: BoundedOpaqueIdentifierSchema.optional(),
	maxDepth: PositiveSafeIntegerSchema.max(32),
	maxEntries: PositiveSafeIntegerSchema.max(1_000),
}).strict();

export const SandboxFsListResultSchema = z
	.object({
		entries: z.array(SandboxFilesystemEntrySchema).max(1_000),
		kind: z.literal('listed'),
		nextCursor: BoundedOpaqueIdentifierSchema.optional(),
	})
	.strict();

export const SandboxFsReadRequestSchema = SandboxFilesystemPathRequestSchema.extend({
	maxBytes: BoundedByteCountSchema,
	offsetBytes: NonnegativeSafeIntegerSchema,
}).strict();

export const SandboxFsReadResultSchema = z
	.object({
		chunk: SandboxBinaryChunkSchema,
		eof: z.boolean(),
		kind: z.literal('read'),
		nextOffsetBytes: NonnegativeSafeIntegerSchema,
		path: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsWriteRequestSchema = SandboxFilesystemPathRequestSchema.extend({
	atomic: z.boolean(),
	content: SandboxBinaryChunkSchema,
	offsetBytes: NonnegativeSafeIntegerSchema.optional(),
}).strict();

export const SandboxFsWriteResultSchema = z
	.object({
		bytesWritten: NonnegativeSafeIntegerSchema,
		contentDigest: Sha256DigestSchema,
		kind: z.literal('written'),
		path: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsMkdirRequestSchema = SandboxFilesystemPathRequestSchema.extend({
	recursive: z.boolean(),
}).strict();

export const SandboxFsMkdirResultSchema = z
	.object({
		created: z.boolean(),
		kind: z.literal('directory-ready'),
		path: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsRenameRequestSchema = z
	.object({
		destinationPath: SandboxGuestPathSchema,
		environment: SandboxEnvironmentHandleSchema,
		replace: z.boolean(),
		sourcePath: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsRenameResultSchema = z
	.object({
		destinationPath: SandboxGuestPathSchema,
		kind: z.literal('renamed'),
		sourcePath: SandboxGuestPathSchema,
	})
	.strict();

export const SandboxFsRemoveRequestSchema = SandboxFilesystemPathRequestSchema.extend({
	recursive: z.boolean(),
}).strict();

export const SandboxFsRemoveResultSchema = z
	.object({ kind: z.literal('removed'), path: SandboxGuestPathSchema, removed: z.boolean() })
	.strict();

export type SandboxFsStatRequest = z.infer<typeof SandboxFsStatRequestSchema>;
export type SandboxFsStatResult = z.infer<typeof SandboxFsStatResultSchema>;
export type SandboxFsListRequest = z.infer<typeof SandboxFsListRequestSchema>;
export type SandboxFsListResult = z.infer<typeof SandboxFsListResultSchema>;
export type SandboxFsReadRequest = z.infer<typeof SandboxFsReadRequestSchema>;
export type SandboxFsReadResult = z.infer<typeof SandboxFsReadResultSchema>;
export type SandboxFsWriteRequest = z.infer<typeof SandboxFsWriteRequestSchema>;
export type SandboxFsWriteResult = z.infer<typeof SandboxFsWriteResultSchema>;
export type SandboxFsMkdirRequest = z.infer<typeof SandboxFsMkdirRequestSchema>;
export type SandboxFsMkdirResult = z.infer<typeof SandboxFsMkdirResultSchema>;
export type SandboxFsRenameRequest = z.infer<typeof SandboxFsRenameRequestSchema>;
export type SandboxFsRenameResult = z.infer<typeof SandboxFsRenameResultSchema>;
export type SandboxFsRemoveRequest = z.infer<typeof SandboxFsRemoveRequestSchema>;
export type SandboxFsRemoveResult = z.infer<typeof SandboxFsRemoveResultSchema>;
