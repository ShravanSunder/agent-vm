import { z } from 'zod';

import {
	BoundedOperationMillisecondsSchema,
	NonnegativeSafeIntegerSchema,
	PositiveSafeIntegerSchema,
	SandboxDirectShellStartRequestSchema,
	SandboxStreamHandleSchema,
	SandboxTerminalHandleSchema,
} from './contract-foundations.js';
import {
	SandboxOperationControlResultSchema,
	SandboxOperationIdentitySchema,
	SandboxTerminalOutcomeSchema,
} from './operation-contracts.js';

export const SandboxExecStartModeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('direct') }).strict(),
	z
		.object({
			attachTimeoutMs: BoundedOperationMillisecondsSchema,
			kind: z.literal('attachment-reserved'),
			terminal: z.boolean(),
		})
		.strict(),
]);

export const SandboxExecStartRequestSchema = SandboxDirectShellStartRequestSchema.extend({
	mode: SandboxExecStartModeSchema,
	timeoutMs: BoundedOperationMillisecondsSchema,
}).strict();

const SandboxExecDirectStartedResultSchema = z
	.object({
		kind: z.literal('started'),
		mode: z.literal('direct'),
		operation: SandboxOperationIdentitySchema,
		streams: z.array(SandboxStreamHandleSchema).max(3),
	})
	.strict();

const SandboxExecAttachmentReservedResultSchema = z
	.object({
		kind: z.literal('started'),
		mode: z.literal('attachment-reserved'),
		operation: SandboxOperationIdentitySchema,
		terminal: SandboxTerminalHandleSchema,
	})
	.strict();

export const SandboxExecStartResultSchema = z.union([
	SandboxExecDirectStartedResultSchema,
	SandboxExecAttachmentReservedResultSchema,
]);

export const SandboxExecWaitRequestSchema = z
	.object({
		operation: SandboxOperationIdentitySchema,
		timeoutMs: BoundedOperationMillisecondsSchema,
	})
	.strict();

export const SandboxExecWaitResultSchema = z
	.object({
		exitCode: NonnegativeSafeIntegerSchema.max(255).optional(),
		operation: SandboxOperationIdentitySchema,
		outcome: SandboxTerminalOutcomeSchema,
	})
	.strict();

export const SandboxExecCancelRequestSchema = z
	.object({ operation: SandboxOperationIdentitySchema })
	.strict();

export const SandboxExecCancelResultSchema = SandboxOperationControlResultSchema;

export const SandboxTerminalSizeSchema = z
	.object({
		columns: PositiveSafeIntegerSchema.max(1_000),
		rows: PositiveSafeIntegerSchema.max(1_000),
	})
	.strict();

export type SandboxExecStartRequest = z.infer<typeof SandboxExecStartRequestSchema>;
export type SandboxExecStartResult = z.infer<typeof SandboxExecStartResultSchema>;
export type SandboxExecWaitRequest = z.infer<typeof SandboxExecWaitRequestSchema>;
export type SandboxExecWaitResult = z.infer<typeof SandboxExecWaitResultSchema>;
export type SandboxExecCancelRequest = z.infer<typeof SandboxExecCancelRequestSchema>;
export type SandboxExecCancelResult = z.infer<typeof SandboxExecCancelResultSchema>;
