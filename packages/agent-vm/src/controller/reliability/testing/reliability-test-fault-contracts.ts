import { z } from 'zod';

export const RELIABILITY_FAULT_ACTION_TARGET_KIND = {
	'disable-export-and-saturate-observations': 'gateway',
	'disconnect-control-transport': 'control-session',
	'drop-result-after-side-effect': 'lease-leaf',
	'exit-controller-after-receipt': 'controller',
	'induce-control-sequence-gap': 'control-session',
	'invalidate-ssh-binding': 'lease-leaf',
	'isolate-control-until-gateway-generation-changes': 'gateway',
	'terminate-owned-gateway-runtime': 'gateway',
	'terminate-owned-gateway-service': 'openclaw-process',
} as const;

export type ReliabilityFaultAction = keyof typeof RELIABILITY_FAULT_ACTION_TARGET_KIND;

export const RELIABILITY_FAULT_ACTIONS = [
	'disable-export-and-saturate-observations',
	'disconnect-control-transport',
	'drop-result-after-side-effect',
	'exit-controller-after-receipt',
	'induce-control-sequence-gap',
	'invalidate-ssh-binding',
	'isolate-control-until-gateway-generation-changes',
	'terminate-owned-gateway-runtime',
	'terminate-owned-gateway-service',
] as const satisfies readonly ReliabilityFaultAction[];

export const RELIABILITY_FAULT_MAX_REQUEST_VALIDITY_MS = 30_000;

export const RELIABILITY_FAULT_MAX_RESTORATION_MS = {
	'disable-export-and-saturate-observations': 300_000,
	'disconnect-control-transport': 20_000,
	'drop-result-after-side-effect': 120_000,
	'exit-controller-after-receipt': 600_000,
	'induce-control-sequence-gap': 20_000,
	'invalidate-ssh-binding': 20_000,
	'isolate-control-until-gateway-generation-changes': 900_000,
	'terminate-owned-gateway-runtime': 600_000,
	'terminate-owned-gateway-service': 60_000,
} as const satisfies Readonly<Record<ReliabilityFaultAction, number>>;

const ReliabilityFaultBoundedIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const ReliabilityFaultNonceSchema = z
	.string()
	.min(16)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/u);
const ReliabilityFaultTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ReliabilityFaultGenerationSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);
const ReliabilityFaultGenerationFenceSchema = z
	.object({
		generation: ReliabilityFaultGenerationSchema,
		id: ReliabilityFaultBoundedIdSchema,
	})
	.strict();

export const ReliabilityFaultGenerationFencesSchema = z
	.object({
		controller: ReliabilityFaultGenerationFenceSchema,
		controlSession: ReliabilityFaultGenerationFenceSchema,
		gateway: ReliabilityFaultGenerationFenceSchema,
		leaseLeaf: ReliabilityFaultGenerationFenceSchema,
		openClawProcess: ReliabilityFaultGenerationFenceSchema,
	})
	.strict();

export const ReliabilityFaultTargetKindSchema = z.enum([
	'controller',
	'control-session',
	'gateway',
	'lease-leaf',
	'openclaw-process',
]);

const reliabilityFaultRequestBaseShape = {
	actionId: z.string().uuid(),
	authorityId: z.string().uuid(),
	expiresAtMs: ReliabilityFaultTimestampSchema,
	fences: ReliabilityFaultGenerationFencesSchema,
	issuedAtMs: ReliabilityFaultTimestampSchema,
	nonce: ReliabilityFaultNonceSchema,
	runId: ReliabilityFaultBoundedIdSchema,
	schemaVersion: z.literal(1),
} as const;

function createReliabilityFaultRequestVariant<TAction extends ReliabilityFaultAction>(
	action: TAction,
): z.ZodObject<{
	readonly action: z.ZodLiteral<TAction>;
	readonly actionId: typeof reliabilityFaultRequestBaseShape.actionId;
	readonly authorityId: typeof reliabilityFaultRequestBaseShape.authorityId;
	readonly expiresAtMs: typeof reliabilityFaultRequestBaseShape.expiresAtMs;
	readonly fences: typeof reliabilityFaultRequestBaseShape.fences;
	readonly issuedAtMs: typeof reliabilityFaultRequestBaseShape.issuedAtMs;
	readonly nonce: typeof reliabilityFaultRequestBaseShape.nonce;
	readonly runId: typeof reliabilityFaultRequestBaseShape.runId;
	readonly schemaVersion: typeof reliabilityFaultRequestBaseShape.schemaVersion;
	readonly target: z.ZodObject<{
		readonly generation: typeof ReliabilityFaultGenerationSchema;
		readonly id: typeof ReliabilityFaultBoundedIdSchema;
		readonly kind: z.ZodLiteral<(typeof RELIABILITY_FAULT_ACTION_TARGET_KIND)[TAction]>;
	}>;
}> {
	return z
		.object({
			...reliabilityFaultRequestBaseShape,
			action: z.literal(action),
			target: z
				.object({
					generation: ReliabilityFaultGenerationSchema,
					id: ReliabilityFaultBoundedIdSchema,
					kind: z.literal(RELIABILITY_FAULT_ACTION_TARGET_KIND[action]),
				})
				.strict(),
		})
		.strict();
}

const ReliabilityFaultApplyRequestVariantSchema = z.discriminatedUnion('action', [
	createReliabilityFaultRequestVariant('disconnect-control-transport'),
	createReliabilityFaultRequestVariant('induce-control-sequence-gap'),
	createReliabilityFaultRequestVariant('terminate-owned-gateway-service'),
	createReliabilityFaultRequestVariant('terminate-owned-gateway-runtime'),
	createReliabilityFaultRequestVariant('invalidate-ssh-binding'),
	createReliabilityFaultRequestVariant('drop-result-after-side-effect'),
	createReliabilityFaultRequestVariant('disable-export-and-saturate-observations'),
	createReliabilityFaultRequestVariant('isolate-control-until-gateway-generation-changes'),
	createReliabilityFaultRequestVariant('exit-controller-after-receipt'),
]);

function expectedTargetFence(request: {
	readonly fences: z.infer<typeof ReliabilityFaultGenerationFencesSchema>;
	readonly target: { readonly kind: z.infer<typeof ReliabilityFaultTargetKindSchema> };
}): z.infer<typeof ReliabilityFaultGenerationFenceSchema> {
	switch (request.target.kind) {
		case 'controller':
			return request.fences.controller;
		case 'control-session':
			return request.fences.controlSession;
		case 'gateway':
			return request.fences.gateway;
		case 'lease-leaf':
			return request.fences.leaseLeaf;
		case 'openclaw-process':
			return request.fences.openClawProcess;
		default: {
			const unreachableTargetKind: never = request.target.kind;
			throw new Error(`Unsupported reliability target kind: ${String(unreachableTargetKind)}`);
		}
	}
}

function addTargetFenceIssue(
	value: {
		readonly fences: z.infer<typeof ReliabilityFaultGenerationFencesSchema>;
		readonly target: z.infer<typeof ReliabilityFaultGenerationFenceSchema> & {
			readonly kind: z.infer<typeof ReliabilityFaultTargetKindSchema>;
		};
	},
	context: z.core.$RefinementCtx,
): void {
	const expectedFence = expectedTargetFence(value);
	if (
		value.target.id !== expectedFence.id ||
		value.target.generation !== expectedFence.generation
	) {
		context.addIssue({
			code: 'custom',
			message: 'Fault target identity must equal its corresponding generation fence.',
			path: ['target'],
		});
	}
}

export const reliabilityFaultApplyRequestSchema =
	ReliabilityFaultApplyRequestVariantSchema.superRefine((request, context) => {
		const validityMs = request.expiresAtMs - request.issuedAtMs;
		if (validityMs <= 0 || validityMs > RELIABILITY_FAULT_MAX_REQUEST_VALIDITY_MS) {
			context.addIssue({
				code: 'custom',
				message: `Fault request validity must be between 1 and ${RELIABILITY_FAULT_MAX_REQUEST_VALIDITY_MS} ms.`,
				path: ['expiresAtMs'],
			});
		}
		addTargetFenceIssue(request, context);
	});

const ReliabilityFaultActionSchema = z.enum(RELIABILITY_FAULT_ACTIONS);
const ReliabilityFaultTargetSchema = z
	.object({
		generation: ReliabilityFaultGenerationSchema,
		id: ReliabilityFaultBoundedIdSchema,
		kind: ReliabilityFaultTargetKindSchema,
	})
	.strict();
const reliabilityFaultReceiptBaseShape = {
	action: ReliabilityFaultActionSchema,
	actionId: z.string().uuid(),
	authorityId: z.string().uuid(),
	fences: ReliabilityFaultGenerationFencesSchema,
	receiptId: z.string().uuid(),
	recordedAtMs: ReliabilityFaultTimestampSchema,
	runId: ReliabilityFaultBoundedIdSchema,
	schemaVersion: z.literal(1),
	target: ReliabilityFaultTargetSchema,
} as const;

export const ReliabilityFaultRefusalReasonSchema = z.enum([
	'ambiguous-target',
	'expired-request',
	'invalid-authority',
	'replayed-request',
	'stale-controller-generation',
	'stale-control-session-generation',
	'stale-gateway-generation',
	'stale-lease-leaf-generation',
	'stale-openclaw-process-generation',
	'stale-target-generation',
	'target-unavailable',
	'unsupported-action',
	'wrong-run',
]);
export type ReliabilityFaultRefusalReason = z.infer<typeof ReliabilityFaultRefusalReasonSchema>;

export const ReliabilityFaultFailureReasonSchema = z.enum([
	'action-failed',
	'restoration-deadline-exceeded',
	'restoration-failed',
	'target-disappeared',
]);

const ReliabilityFaultAppliedReceiptSchema = z
	.object({
		...reliabilityFaultReceiptBaseShape,
		restorationDeadlineMs: ReliabilityFaultTimestampSchema,
		state: z.literal('applied'),
	})
	.strict();
const ReliabilityFaultRefusedReceiptSchema = z
	.object({
		...reliabilityFaultReceiptBaseShape,
		reason: ReliabilityFaultRefusalReasonSchema,
		state: z.literal('refused'),
	})
	.strict();
const ReliabilityFaultRestoredReceiptSchema = z
	.object({
		...reliabilityFaultReceiptBaseShape,
		appliedReceiptId: z.string().uuid(),
		state: z.literal('restored'),
	})
	.strict();
const ReliabilityFaultFailedReceiptSchema = z
	.object({
		...reliabilityFaultReceiptBaseShape,
		appliedReceiptId: z.string().uuid().optional(),
		failurePhase: z.enum(['apply', 'restore']),
		reason: ReliabilityFaultFailureReasonSchema,
		state: z.literal('failed'),
	})
	.strict();
const ReliabilityFaultExitArmedReceiptSchema = z
	.object({
		...reliabilityFaultReceiptBaseShape,
		action: z.literal('exit-controller-after-receipt'),
		launcherProofDeadlineMs: ReliabilityFaultTimestampSchema,
		launcherTerminalProofRequired: z.literal(true),
		state: z.literal('exit-armed'),
		target: ReliabilityFaultTargetSchema.extend({ kind: z.literal('controller') }).strict(),
	})
	.strict();

export const reliabilityFaultReceiptSchema = z
	.discriminatedUnion('state', [
		ReliabilityFaultAppliedReceiptSchema,
		ReliabilityFaultRefusedReceiptSchema,
		ReliabilityFaultRestoredReceiptSchema,
		ReliabilityFaultFailedReceiptSchema,
		ReliabilityFaultExitArmedReceiptSchema,
	])
	.superRefine((receipt, context) => {
		if (RELIABILITY_FAULT_ACTION_TARGET_KIND[receipt.action] !== receipt.target.kind) {
			context.addIssue({
				code: 'custom',
				message: 'Fault receipt action does not match target kind.',
				path: ['target', 'kind'],
			});
		}
		addTargetFenceIssue(receipt, context);
		if (receipt.action === 'exit-controller-after-receipt' && receipt.state !== 'exit-armed') {
			context.addIssue({
				code: 'custom',
				message: 'Controller exit must return an exit-armed receipt.',
				path: ['state'],
			});
		}
		const deadlineMs =
			receipt.state === 'applied'
				? receipt.restorationDeadlineMs
				: receipt.state === 'exit-armed'
					? receipt.launcherProofDeadlineMs
					: undefined;
		if (deadlineMs !== undefined) {
			const restorationMs = deadlineMs - receipt.recordedAtMs;
			if (
				restorationMs <= 0 ||
				restorationMs > RELIABILITY_FAULT_MAX_RESTORATION_MS[receipt.action]
			) {
				context.addIssue({
					code: 'custom',
					message: 'Fault receipt deadline exceeds the action restoration bound.',
					path: [receipt.state === 'applied' ? 'restorationDeadlineMs' : 'launcherProofDeadlineMs'],
				});
			}
		}
	});

export type ReliabilityFaultApplyRequest = z.infer<typeof reliabilityFaultApplyRequestSchema>;
export type ReliabilityFaultReceipt = z.infer<typeof reliabilityFaultReceiptSchema>;
