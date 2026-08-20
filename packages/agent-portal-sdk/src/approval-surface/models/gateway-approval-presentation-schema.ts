import { z } from 'zod';

import { ItemIdSchema } from '../../contract-primitives/models/request-id-schema.js';
import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';

const MAXIMUM_APPROVAL_DISPLAY_DEPTH = 6;
const MAXIMUM_APPROVAL_DISPLAY_ENTRIES = 32;
const MAXIMUM_APPROVAL_DISPLAY_STRING_SCALARS = 256;
const MAXIMUM_APPROVAL_DISPLAY_BYTES = 4_096;
const APPROVAL_REDACTED_VALUE = '[REDACTED]';
const APPROVAL_TRUNCATED_VALUE = '[TRUNCATED]';
const APPROVAL_TRUNCATION_FIELD = '$truncated';

const credentialKeyPattern =
	/(?:token|password|secret|authorization|cookie|api[ _-]?key|private[ _-]?key)/iu;
const credentialValuePattern =
	/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:bearer|basic)\s+\S+|\b(?:api[ _-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*\S+)/iu;

export const GatewayApprovalPresentationRequestSchema = withPortableSuperRefinement({
	refinement: (request, context) => {
		if (
			new TextEncoder().encode(request.display.argumentsPreview).byteLength >
			MAXIMUM_APPROVAL_DISPLAY_BYTES
		) {
			context.addIssue({
				code: 'custom',
				message: 'Approval argument preview exceeds the portable UTF-8 byte bound.',
				path: ['display', 'argumentsPreview'],
			});
		}
	},
	refinementIdentity: 'gateway.approval.arguments-preview.utf8-bytes',
	schema: z
		.object({
			allowedDecisions: z.tuple([z.literal('approve'), z.literal('deny')]),
			challengeId: z.string().uuid(),
			display: z
				.object({
					argumentsPreview: z.string().max(MAXIMUM_APPROVAL_DISPLAY_BYTES),
				})
				.strict(),
			expiresAt: z.string().datetime(),
			itemId: ItemIdSchema,
			name: z.string().min(1).max(256),
			namespace: z.string().min(1).max(256),
		})
		.strict(),
});

export const ApprovalPresentationOutcomeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('approved') }).strict(),
	z.object({ kind: z.literal('denied') }).strict(),
	z
		.object({
			kind: z.literal('cancelled'),
			reason: z.enum(['challenge-expired', 'session-ended', 'user-cancelled']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('unavailable'),
			reason: z.enum(['presenter-missing', 'presentation-failed']),
		})
		.strict(),
]);

export const GatewayApprovalDecisionRequestSchema = z
	.object({
		challengeId: z.string().uuid(),
		decision: z.enum(['approve', 'deny']),
	})
	.strict();

export const GatewayApprovalDecisionResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('recorded'),
			state: z.enum(['approved', 'denied']),
		})
		.strict(),
	z
		.object({
			kind: z.literal('rejected'),
			reason: z.enum([
				'not-found',
				'expired',
				'stale-authority',
				'principal-mismatch',
				'already-decided',
				'presenter-not-authorized',
			]),
		})
		.strict(),
]);

export type GatewayApprovalPresentationRequest = z.infer<
	typeof GatewayApprovalPresentationRequestSchema
>;
export type ApprovalPresentationOutcome = z.infer<typeof ApprovalPresentationOutcomeSchema>;
export type GatewayApprovalDecisionRequest = z.infer<typeof GatewayApprovalDecisionRequestSchema>;
export type GatewayApprovalDecisionResult = z.infer<typeof GatewayApprovalDecisionResultSchema>;

interface ApprovalTruncationMarker {
	readonly omittedCount: number;
	readonly value: typeof APPROVAL_TRUNCATED_VALUE;
}

type SanitizedApprovalValue =
	| ApprovalTruncationMarker
	| boolean
	| null
	| number
	| string
	| readonly SanitizedApprovalValue[]
	| { readonly [key: string]: SanitizedApprovalValue };

function truncateUnicodeScalars(value: string): string | ApprovalTruncationMarker {
	const scalars = Array.from(value);
	if (scalars.length <= MAXIMUM_APPROVAL_DISPLAY_STRING_SCALARS) return value;
	return {
		omittedCount: scalars.length - MAXIMUM_APPROVAL_DISPLAY_STRING_SCALARS,
		value: APPROVAL_TRUNCATED_VALUE,
	};
}

function sanitizeApprovalValue(value: unknown, depth: number): SanitizedApprovalValue {
	if (depth >= MAXIMUM_APPROVAL_DISPLAY_DEPTH) {
		return { omittedCount: 1, value: APPROVAL_TRUNCATED_VALUE };
	}
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
	if (typeof value === 'string') {
		if (credentialValuePattern.test(value)) return APPROVAL_REDACTED_VALUE;
		return truncateUnicodeScalars(value);
	}
	if (Array.isArray(value)) {
		const included = value
			.slice(0, MAXIMUM_APPROVAL_DISPLAY_ENTRIES)
			.map((item) => sanitizeApprovalValue(item, depth + 1));
		if (value.length > MAXIMUM_APPROVAL_DISPLAY_ENTRIES) {
			included[MAXIMUM_APPROVAL_DISPLAY_ENTRIES - 1] = {
				omittedCount: value.length - (MAXIMUM_APPROVAL_DISPLAY_ENTRIES - 1),
				value: APPROVAL_TRUNCATED_VALUE,
			};
		}
		return included;
	}
	if (typeof value !== 'object') return '[UNSUPPORTED]';

	const sortedEntries = Object.entries(value).toSorted(([leftKey], [rightKey]) =>
		leftKey.localeCompare(rightKey),
	);
	const requiresTruncation = sortedEntries.length > MAXIMUM_APPROVAL_DISPLAY_ENTRIES;
	const includedEntryCount = requiresTruncation
		? MAXIMUM_APPROVAL_DISPLAY_ENTRIES - 1
		: MAXIMUM_APPROVAL_DISPLAY_ENTRIES;
	const sanitizedEntries = sortedEntries
		.slice(0, includedEntryCount)
		.map(
			([key, childValue]) =>
				[
					key,
					credentialKeyPattern.test(key)
						? APPROVAL_REDACTED_VALUE
						: sanitizeApprovalValue(childValue, depth + 1),
				] as const,
		);
	if (requiresTruncation) {
		sanitizedEntries.push([
			APPROVAL_TRUNCATION_FIELD,
			{
				omittedCount: sortedEntries.length - includedEntryCount,
				value: APPROVAL_TRUNCATED_VALUE,
			},
		]);
	}
	return Object.fromEntries(sanitizedEntries);
}

export function sanitizeGatewayApprovalArguments(argumentsValue: unknown): string {
	const preview = JSON.stringify(sanitizeApprovalValue(argumentsValue, 0));
	const byteLength = new TextEncoder().encode(preview).byteLength;
	if (byteLength <= MAXIMUM_APPROVAL_DISPLAY_BYTES) return preview;
	return JSON.stringify({
		omittedCount: byteLength - MAXIMUM_APPROVAL_DISPLAY_BYTES,
		value: APPROVAL_TRUNCATED_VALUE,
	});
}
