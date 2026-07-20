import { z } from 'zod';

import { BoundedOpaqueIdentifierSchema } from './contract-foundations.js';

export const SandboxOperationIdentitySchema = z
	.object({
		operationId: BoundedOpaqueIdentifierSchema,
		owningGeneration: BoundedOpaqueIdentifierSchema,
	})
	.strict();

const SandboxCompletedSucceededOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		completion: z.literal('succeeded'),
		kind: z.literal('completed'),
		retryClass: z.literal('forbidden'),
	})
	.strict();

const SandboxCompletedFailedOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		completion: z.literal('failed'),
		kind: z.literal('completed'),
		retryClass: z.enum(['forbidden', 'policy-gated']),
	})
	.strict();

const SandboxNotDispatchedOutcomeSchema = z
	.object({
		certainty: z.literal('proven'),
		kind: z.literal('not-dispatched'),
		retryClass: z.literal('safe-before-dispatch'),
	})
	.strict();

export const SandboxProvenTerminationOutcomeSchema = z.discriminatedUnion('kind', [
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('cancelled-proven'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('timed-out-proven'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
	z
		.object({
			certainty: z.literal('proven-terminated'),
			kind: z.literal('replaced-proven'),
			priorSideEffects: z.literal('possible'),
			retryClass: z.literal('manual-only'),
		})
		.strict(),
]);

export const SandboxAmbiguousOutcomeSchema = z
	.object({
		certainty: z.literal('side-effects-and-termination-unknown'),
		kind: z.literal('ambiguous'),
		retryClass: z.literal('forbidden'),
	})
	.strict();

export const SandboxTerminalOutcomeSchema = z.union([
	SandboxNotDispatchedOutcomeSchema,
	SandboxCompletedSucceededOutcomeSchema,
	SandboxCompletedFailedOutcomeSchema,
	SandboxProvenTerminationOutcomeSchema,
	SandboxAmbiguousOutcomeSchema,
]);

export const SandboxOperationControlResultSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('running'), operation: SandboxOperationIdentitySchema }).strict(),
	z
		.object({
			kind: z.literal('cancel-request-accepted'),
			operation: SandboxOperationIdentitySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('cancellation-pending'),
			operation: SandboxOperationIdentitySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('termination-proven'),
			operation: SandboxOperationIdentitySchema,
			outcome: SandboxProvenTerminationOutcomeSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('already-terminal'),
			operation: SandboxOperationIdentitySchema,
			outcome: SandboxTerminalOutcomeSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('ambiguous'),
			operation: SandboxOperationIdentitySchema,
			outcome: SandboxAmbiguousOutcomeSchema,
		})
		.strict(),
]);

export const SandboxRetainedResultLookupRequestSchema = z
	.object({ operation: SandboxOperationIdentitySchema })
	.strict();

export const SandboxRetainedResultLookupResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('retained'),
			operation: SandboxOperationIdentitySchema,
			outcome: SandboxTerminalOutcomeSchema,
		})
		.strict(),
	z.object({ kind: z.literal('pending'), operation: SandboxOperationIdentitySchema }).strict(),
	z
		.object({
			kind: z.literal('unavailable'),
			reason: z.literal('not-retained-or-not-authorized'),
		})
		.strict(),
]);

export type SandboxOperationIdentity = z.infer<typeof SandboxOperationIdentitySchema>;
export type SandboxOperationControlResult = z.infer<typeof SandboxOperationControlResultSchema>;
export type SandboxRetainedResultLookupRequest = z.infer<
	typeof SandboxRetainedResultLookupRequestSchema
>;
export type SandboxRetainedResultLookupResult = z.infer<
	typeof SandboxRetainedResultLookupResultSchema
>;
export type SandboxTerminalOutcome = z.infer<typeof SandboxTerminalOutcomeSchema>;
