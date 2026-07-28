import {
	JsonValueSchema,
	PortalErrorSchema,
	SafeDiagnosticSchema,
} from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

export const ControllerExecutionAuthorityBindingSchema = z
	.object({
		fingerprint: z.string().min(1),
		operationId: z.string().min(1),
	})
	.strict();

export const ControllerExecutionNotDispatchedReasonSchema = z.enum([
	'authorization-fingerprint-changed',
	'current-epoch-changed',
	'denied',
	'duplicate-operation',
	'predecessor-owner-unsafe',
	'public-authority-or-policy-override',
	'runner-setup-failed',
	'stale-authority',
]);

export const ControllerExecutionAmbiguousReasonSchema = z.enum([
	'containment-unproven',
	'dispatch-armed',
	'dispatch-state-unknown',
]);

const ControllerExecutionCompletedResultSchema = z
	.object({
		binding: ControllerExecutionAuthorityBindingSchema,
		certainty: z.literal('proven'),
		completion: z.literal('succeeded'),
		diagnostics: z.array(SafeDiagnosticSchema).default([]),
		kind: z.literal('completed'),
		retryClass: z.literal('forbidden'),
		value: JsonValueSchema,
	})
	.strict();

const ControllerExecutionNotDispatchedResultSchema = z
	.object({
		binding: ControllerExecutionAuthorityBindingSchema.optional(),
		certainty: z.literal('proven'),
		diagnostics: z.array(SafeDiagnosticSchema).default([]),
		error: PortalErrorSchema,
		kind: z.literal('not-dispatched'),
		reason: ControllerExecutionNotDispatchedReasonSchema,
		retryClass: z.literal('safe-before-dispatch'),
	})
	.strict();

const ControllerExecutionAmbiguousResultSchema = z
	.object({
		binding: ControllerExecutionAuthorityBindingSchema,
		certainty: z.literal('side-effects-and-termination-unknown'),
		diagnostics: z.array(SafeDiagnosticSchema).default([]),
		error: PortalErrorSchema,
		kind: z.literal('ambiguous'),
		reason: ControllerExecutionAmbiguousReasonSchema,
		retryClass: z.literal('forbidden'),
	})
	.strict();

export const ControllerExecutionResultSchema = z.discriminatedUnion('kind', [
	ControllerExecutionCompletedResultSchema,
	ControllerExecutionNotDispatchedResultSchema,
	ControllerExecutionAmbiguousResultSchema,
]);

export type ControllerExecutionAuthorityBinding = z.infer<
	typeof ControllerExecutionAuthorityBindingSchema
>;
export type ControllerExecutionResult = z.infer<typeof ControllerExecutionResultSchema>;
