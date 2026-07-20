import { z } from 'zod';

import {
	BoundedByteCountSchema,
	BoundedOpaqueIdentifierSchema,
	BoundedOperationMillisecondsSchema,
	NonnegativeSafeIntegerSchema,
	SandboxBinaryChunkSchema,
	SandboxDirectShellStartRequestSchema,
	SandboxProcessHandleSchema,
	SandboxStreamChannelSchema,
	SandboxStreamHandleSchema,
} from './contract-foundations.js';
import {
	SandboxOperationControlResultSchema,
	SandboxOperationIdentitySchema,
	SandboxTerminalOutcomeSchema,
} from './operation-contracts.js';

export const SandboxProcessStartRequestSchema = SandboxDirectShellStartRequestSchema.extend({
	maxRuntimeMs: BoundedOperationMillisecondsSchema,
	retainOutputBytes: BoundedByteCountSchema,
}).strict();

export const SandboxProcessStartResultSchema = z
	.object({
		kind: z.literal('started'),
		operation: SandboxOperationIdentitySchema,
		process: SandboxProcessHandleSchema,
		streams: z.array(SandboxStreamHandleSchema).max(3),
	})
	.strict();

export const SandboxProcessHandleRequestSchema = z
	.object({ process: SandboxProcessHandleSchema })
	.strict();

export const SandboxProcessStatusResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('running'),
			operation: SandboxOperationIdentitySchema,
			process: SandboxProcessHandleSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('terminal'),
			operation: SandboxOperationIdentitySchema,
			outcome: SandboxTerminalOutcomeSchema,
			process: SandboxProcessHandleSchema,
		})
		.strict(),
]);

export const SandboxProcessWaitRequestSchema = SandboxProcessHandleRequestSchema.extend({
	timeoutMs: BoundedOperationMillisecondsSchema,
}).strict();

export const SandboxProcessWaitResultSchema = SandboxProcessStatusResultSchema;

export const SandboxProcessLogsRequestSchema = SandboxProcessHandleRequestSchema.extend({
	channels: z.array(SandboxStreamChannelSchema).min(1).max(4),
	cursor: BoundedOpaqueIdentifierSchema.optional(),
	maxBytes: BoundedByteCountSchema,
}).strict();

export const SandboxProcessLogChunkSchema = z
	.object({
		channel: SandboxStreamChannelSchema,
		chunk: SandboxBinaryChunkSchema,
		sequence: NonnegativeSafeIntegerSchema,
	})
	.strict();

export const SandboxProcessLogsResultSchema = z
	.object({
		chunks: z.array(SandboxProcessLogChunkSchema).max(1_000),
		kind: z.literal('logs'),
		nextCursor: BoundedOpaqueIdentifierSchema.optional(),
		process: SandboxProcessHandleSchema,
		truncated: z.boolean(),
	})
	.strict();

export const SandboxProcessCancelRequestSchema = SandboxProcessHandleRequestSchema;
export const SandboxProcessCancelResultSchema = SandboxOperationControlResultSchema;

export type SandboxProcessStartRequest = z.infer<typeof SandboxProcessStartRequestSchema>;
export type SandboxProcessStartResult = z.infer<typeof SandboxProcessStartResultSchema>;
export type SandboxProcessStatusRequest = z.infer<typeof SandboxProcessHandleRequestSchema>;
export type SandboxProcessStatusResult = z.infer<typeof SandboxProcessStatusResultSchema>;
export type SandboxProcessWaitRequest = z.infer<typeof SandboxProcessWaitRequestSchema>;
export type SandboxProcessWaitResult = z.infer<typeof SandboxProcessWaitResultSchema>;
export type SandboxProcessLogsRequest = z.infer<typeof SandboxProcessLogsRequestSchema>;
export type SandboxProcessLogsResult = z.infer<typeof SandboxProcessLogsResultSchema>;
export type SandboxProcessCancelRequest = z.infer<typeof SandboxProcessCancelRequestSchema>;
export type SandboxProcessCancelResult = z.infer<typeof SandboxProcessCancelResultSchema>;
