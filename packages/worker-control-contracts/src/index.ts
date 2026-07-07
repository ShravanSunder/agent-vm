import {
	ControlCorrelationSchema,
	ControlRpcErrorSchema,
	ControlRpcResultBaseSchema,
	ControlSessionStateSchema,
	type ControlSessionControllerToPeerEvents,
	type ControlSessionPeerToControllerEvents,
	KnownControlDomainSchema,
	type ControlDeliveryPolicy,
} from '@agent-vm/control-protocol-contracts';
import { z } from 'zod/v4';

export const WorkerControlDomainSchema = z.literal('worker_control');

export const WorkerControlRpcOperationSchema = z.enum([
	'control_ping',
	'worker_capacity_snapshot',
	'worker_runtime_status',
	'worker_runtime_observation',
	'git_push',
	'git_pull_default',
	'operation_cancel',
	'recovery_command',
]);

export const WorkerControlRpcResultSchema = z.enum([
	...ControlRpcResultBaseSchema.options,
	'accepted',
]);

export const WorkerControlTaskRefSchema = z
	.object({
		taskGeneration: z.string().min(1).optional(),
		taskId: z.string().min(1),
	})
	.strict();

export const WorkerControlCommandRefSchema = z
	.object({
		commandId: z.string().uuid(),
		idempotencyKey: z.string().min(1),
	})
	.strict();

export const WorkerControlGitPushPayloadSchema = z
	.object({
		branchName: z.string().min(1),
		command: WorkerControlCommandRefSchema,
		expectedHead: z.string().min(1).optional(),
		repoUrl: z.string().min(1),
		task: WorkerControlTaskRefSchema,
	})
	.strict();

export const WorkerControlGitPullDefaultPayloadSchema = z
	.object({
		command: WorkerControlCommandRefSchema,
		currentBranch: z.string().min(1).optional(),
		currentHead: z.string().min(1).optional(),
		repoUrl: z.string().min(1),
		task: WorkerControlTaskRefSchema,
		worktreeDirty: z.boolean().optional(),
	})
	.strict();

export const WorkerControlCapacitySnapshotPayloadSchema = z
	.object({
		activeTaskId: z.string().min(1).optional(),
		observedAtMs: z.number().int().positive(),
		state: z.enum(['idle', 'running', 'closing', 'draining']),
	})
	.strict();

export const WorkerControlSessionStateSchema = ControlSessionStateSchema;

export const WorkerControlRuntimeObservationPayloadSchema = z
	.object({
		correlation: ControlCorrelationSchema.optional(),
		observedAtMs: z.number().int().positive(),
		sessionState: WorkerControlSessionStateSchema.optional(),
		state: z.enum(['running', 'closing', 'closed', 'failed']).optional(),
		task: WorkerControlTaskRefSchema,
	})
	.strict();

export const WorkerControlRuntimeStatusPayloadSchema = z
	.object({
		findings: z.array(
			z
				.object({
					id: z.string().min(1),
					ok: z.boolean(),
					safeMessage: z.string().min(1).optional(),
					severity: z.enum(['info', 'warning', 'error']).optional(),
				})
				.strict(),
		),
		observedAtMs: z.number().int().positive(),
		statusKind: z.string().min(1),
	})
	.strict();

export const WorkerControlPingPayloadSchema = z.object({}).strict();

export const WorkerControlActiveOperationIdSchema = z.string().uuid();

export const WorkerInitiatedOperationCancelPayloadSchema = z
	.object({
		activeOperationId: WorkerControlActiveOperationIdSchema,
		initiatedBy: z.literal('worker'),
		reason: z.enum(['caller_cancelled', 'worker_shutdown', 'operation_failed']),
	})
	.strict();

export const ControllerInitiatedWorkerOperationCancelPayloadSchema = z
	.object({
		activeOperationId: WorkerControlActiveOperationIdSchema,
		initiatedBy: z.literal('controller'),
		reason: z.enum(['controller_recovery', 'operator_cancelled', 'timeout']),
	})
	.strict();

export const WorkerControlOperationCancelPayloadSchema = z.discriminatedUnion('initiatedBy', [
	WorkerInitiatedOperationCancelPayloadSchema,
	ControllerInitiatedWorkerOperationCancelPayloadSchema,
]);

export const WorkerControlRecoveryCommandPayloadSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('refresh_runtime_status') }).strict(),
	z.object({ action: z.literal('restart_control_service') }).strict(),
	z
		.object({
			action: z.literal('close_stale_session'),
			targetSessionId: z.string().uuid(),
		})
		.strict(),
]);

export const WorkerControlRpcErrorSchema = ControlRpcErrorSchema;

export const WorkerControlGitResultSchema = z
	.object({
		branch: z.string().min(1).optional(),
		head: z.string().min(1).optional(),
		kind: z.enum(['pushed', 'up_to_date', 'advanced', 'refused_not_fast_forward']),
	})
	.strict();

export const WorkerControlGitPushBranchResultSchema = z
	.object({
		branch: z.string().min(1),
		commitsOnBranch: z
			.array(
				z
					.object({
						author: z.string().min(1).optional(),
						date: z.string().min(1).optional(),
						sha: z.string().min(1),
						subject: z.string().min(1),
					})
					.strict(),
			)
			.optional(),
		defaultBranch: z.string().min(1).optional(),
		divergence: z
			.object({
				aheadOfDefault: z.number().int().nonnegative(),
				behindDefault: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		error: z.string().min(1).optional(),
		localHead: z.string().min(1).optional(),
		pushedInThisCall: z
			.array(
				z
					.object({
						author: z.string().min(1).optional(),
						date: z.string().min(1).optional(),
						sha: z.string().min(1),
						subject: z.string().min(1),
					})
					.strict(),
			)
			.optional(),
		remoteAlreadyHadBranch: z.boolean().optional(),
		remoteBranchHead: z.string().min(1).optional(),
		remoteDefaultHead: z.string().min(1).optional(),
		repoUrl: z.string().min(1),
		success: z.boolean(),
	})
	.strict();

export const WorkerControlGitPushResultPayloadSchema = z
	.object({
		results: z.array(WorkerControlGitPushBranchResultSchema),
	})
	.strict();

export const WorkerControlCommitSummarySchema = z
	.object({
		author: z.string().optional(),
		date: z.string().optional(),
		sha: z.string().min(1),
		subject: z.string(),
	})
	.strict();

export const WorkerControlPullCurrentBranchSyncSchema = z.discriminatedUnion('status', [
	z
		.object({
			branch: z.string().min(1),
			localHead: z.string().min(1),
			reason: z.string().min(1).optional(),
			remoteHead: z.string().min(1),
			status: z.enum(['ahead', 'dirty-worktree', 'diverged']),
			upstreamTrackingRef: z.string().min(1),
		})
		.strict(),
	z
		.object({
			branch: z.string().min(1),
			localHead: z.string().min(1),
			remoteHead: z.string().min(1),
			status: z.enum(['default-branch', 'fast-forwarded', 'up-to-date']),
			upstreamTrackingRef: z.string().min(1),
			reason: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			branch: z.null(),
			localHead: z.string().min(1),
			reason: z.string().min(1),
			status: z.literal('detached'),
			upstreamTrackingRef: z.null(),
		})
		.strict(),
	z
		.object({
			branch: z.string().min(1),
			localHead: z.string().min(1).optional(),
			reason: z.string().min(1),
			status: z.literal('no-upstream'),
			upstreamTrackingRef: z.null(),
		})
		.strict(),
]);

export const WorkerControlPullDefaultResultPayloadSchema = z.discriminatedUnion('kind', [
	z
		.object({
			commitsSinceForkPoint: z.array(WorkerControlCommitSummarySchema),
			currentBranch: z.string().min(1).nullable().optional(),
			currentBranchSync: WorkerControlPullCurrentBranchSyncSchema.optional(),
			defaultBranch: z.string().min(1),
			divergence: z
				.object({
					aheadOfDefault: z.number().int().nonnegative(),
					behindDefault: z.number().int().nonnegative(),
					forkPoint: z.string().min(1),
				})
				.strict(),
			fetchedCommits: z.array(WorkerControlCommitSummarySchema),
			kind: z.literal('advanced'),
			localDefaultHead: z.string().min(1),
			message: z.string().min(1),
			remoteDefaultHead: z.string().min(1),
			repoUrl: z.string().min(1),
			success: z.literal(true),
		})
		.strict(),
	z
		.object({
			defaultBranch: z.string().min(1),
			error: z.string().min(1),
			kind: z.literal('refused-not-fast-forward'),
			message: z.string().min(1),
			remoteDefaultHead: z.string().min(1),
			repoUrl: z.string().min(1),
			success: z.literal(false),
		})
		.strict(),
	z
		.object({
			error: z.string().min(1),
			kind: z.literal('failed'),
			message: z.string().min(1),
			repoUrl: z.string().min(1),
			success: z.literal(false),
		})
		.strict(),
]);

export const WorkerControlRpcDomainCorrelationSchema = ControlCorrelationSchema;

const WorkerControlRpcForbiddenResponseFieldsSchema = {
	activeOperationId: z.never().optional(),
	error: z.never().optional(),
	git: z.never().optional(),
	gitPullDefault: z.never().optional(),
	gitPush: z.never().optional(),
} as const;

export const WorkerControlRpcResponseBasePayloadSchema = z.object({
	...WorkerControlRpcForbiddenResponseFieldsSchema,
	responseToMessageId: z.string().uuid(),
	result: WorkerControlRpcResultSchema,
});

const WorkerControlRpcErrorResponseResultSchema = z.enum([
	'accepted',
	'failed',
	'timeout',
	'rejected',
	'cancelled',
	'stale_generation',
]);

const WorkerControlRpcResponseCorrelationSchema = z
	.object({
		responseToMessageId: z.string().uuid(),
	})
	.strict();

export const WorkerControlRpcBareResponsePayloadSchema = z.discriminatedUnion('result', [
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		result: z.literal('ok'),
	}).strict(),
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		error: WorkerControlRpcErrorSchema,
		result: WorkerControlRpcErrorResponseResultSchema,
	}).strict(),
]);

export const WorkerControlRpcGitPushResponsePayloadSchema = z.discriminatedUnion('result', [
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		gitPush: WorkerControlGitPushResultPayloadSchema,
		result: z.literal('ok'),
	}).strict(),
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		error: WorkerControlRpcErrorSchema,
		result: WorkerControlRpcErrorResponseResultSchema,
	}).strict(),
]);

export const WorkerControlRpcGitPullDefaultResponsePayloadSchema = z.discriminatedUnion('result', [
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		gitPullDefault: WorkerControlPullDefaultResultPayloadSchema,
		result: z.literal('ok'),
	}).strict(),
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		error: WorkerControlRpcErrorSchema,
		result: WorkerControlRpcErrorResponseResultSchema,
	}).strict(),
]);

export const WorkerControlRpcOperationCancelResponsePayloadSchema = z.discriminatedUnion('result', [
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		activeOperationId: WorkerControlActiveOperationIdSchema,
		result: z.literal('ok'),
	}).strict(),
	WorkerControlRpcResponseCorrelationSchema.extend({
		...WorkerControlRpcForbiddenResponseFieldsSchema,
		activeOperationId: WorkerControlActiveOperationIdSchema.optional(),
		error: WorkerControlRpcErrorSchema,
		result: WorkerControlRpcErrorResponseResultSchema,
	}).strict(),
]);

export const WorkerControlRpcResponsePayloadSchema = z.union([
	WorkerControlRpcBareResponsePayloadSchema,
	WorkerControlRpcGitPushResponsePayloadSchema,
	WorkerControlRpcGitPullDefaultResponsePayloadSchema,
	WorkerControlRpcOperationCancelResponsePayloadSchema,
]);

const WorkerControlRpcControlPingCommandResultMessageSchema =
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('control_ping'),
		payload: WorkerControlRpcBareResponsePayloadSchema,
	}).strict();

const WorkerControlRpcGitPushCommandResultMessageSchema =
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('git_push'),
		payload: WorkerControlRpcGitPushResponsePayloadSchema,
	}).strict();

const WorkerControlRpcGitPullDefaultCommandResultMessageSchema =
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('git_pull_default'),
		payload: WorkerControlRpcGitPullDefaultResponsePayloadSchema,
	}).strict();

const WorkerControlRpcOperationCancelCommandResultMessageSchema =
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('operation_cancel'),
		payload: WorkerControlRpcOperationCancelResponsePayloadSchema,
	}).strict();

const WorkerControlRpcRecoveryCommandResultMessageSchema =
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command_result'),
		operation: z.literal('recovery_command'),
		payload: WorkerControlRpcBareResponsePayloadSchema,
	}).strict();

export const WorkerControlRpcCommandResultMessageSchema = z.discriminatedUnion('operation', [
	WorkerControlRpcControlPingCommandResultMessageSchema,
	WorkerControlRpcGitPushCommandResultMessageSchema,
	WorkerControlRpcGitPullDefaultCommandResultMessageSchema,
	WorkerControlRpcOperationCancelCommandResultMessageSchema,
	WorkerControlRpcRecoveryCommandResultMessageSchema,
]);

export const WorkerControlRpcCommandMessageSchema = z.discriminatedUnion('operation', [
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('control_ping'),
		payload: WorkerControlPingPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('git_push'),
		payload: WorkerControlGitPushPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('git_pull_default'),
		payload: WorkerControlGitPullDefaultPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('operation_cancel'),
		payload: WorkerControlOperationCancelPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('command'),
		operation: z.literal('recovery_command'),
		payload: WorkerControlRecoveryCommandPayloadSchema,
	}).strict(),
]);

export const WorkerControlRpcEventMessageSchema = z.discriminatedUnion('operation', [
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('event'),
		operation: z.literal('worker_capacity_snapshot'),
		payload: WorkerControlCapacitySnapshotPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('event'),
		operation: z.literal('worker_runtime_status'),
		payload: WorkerControlRuntimeStatusPayloadSchema,
	}).strict(),
	WorkerControlRpcDomainCorrelationSchema.extend({
		kind: z.literal('event'),
		operation: z.literal('worker_runtime_observation'),
		payload: WorkerControlRuntimeObservationPayloadSchema,
	}).strict(),
]);

export const WorkerControlEventOnlyOperationSchema = z.enum([
	'worker_capacity_snapshot',
	'worker_runtime_status',
	'worker_runtime_observation',
]);

export const WorkerControlRpcCommandResultOperationSchema = WorkerControlRpcOperationSchema.exclude(
	WorkerControlEventOnlyOperationSchema.options,
);

export const WorkerControlRpcMessageSchema = z.union([
	WorkerControlRpcCommandMessageSchema,
	WorkerControlRpcEventMessageSchema,
	WorkerControlRpcCommandResultMessageSchema,
]);

export const workerControlDeliveryPolicyByOperation = {
	control_ping: 'acked_idempotent',
	git_pull_default: 'single_use_critical',
	git_push: 'single_use_critical',
	operation_cancel: 'acked_idempotent',
	recovery_command: 'critical_idempotent',
	worker_capacity_snapshot: 'latest_wins',
	worker_runtime_observation: 'append_only_observation',
	worker_runtime_status: 'latest_wins',
} as const satisfies Record<WorkerControlRpcOperation, ControlDeliveryPolicy>;

export const workerControlCommandExecutionTimeoutMsByOperation = {
	control_ping: 5_000,
	git_pull_default: 120_000,
	git_push: 120_000,
	operation_cancel: 5_000,
	recovery_command: 10_000,
	worker_capacity_snapshot: 5_000,
	worker_runtime_observation: 5_000,
	worker_runtime_status: 5_000,
} as const satisfies Record<WorkerControlRpcOperation, number>;

export type WorkerControlRpcOperation = z.infer<typeof WorkerControlRpcOperationSchema>;
export type WorkerControlRpcMessage = z.infer<typeof WorkerControlRpcMessageSchema>;
export type WorkerControlCapacitySnapshotPayload = z.infer<
	typeof WorkerControlCapacitySnapshotPayloadSchema
>;
export type WorkerControlRuntimeObservationPayload = z.infer<
	typeof WorkerControlRuntimeObservationPayloadSchema
>;
export type WorkerControlRuntimeStatusPayload = z.infer<
	typeof WorkerControlRuntimeStatusPayloadSchema
>;
export type WorkerControlControllerToWorkerEvents =
	ControlSessionControllerToPeerEvents<WorkerControlRpcMessage>;
export type WorkerControlWorkerToControllerEvents =
	ControlSessionPeerToControllerEvents<WorkerControlRpcMessage>;
export type WorkerControlGitPushResultPayload = z.infer<
	typeof WorkerControlGitPushResultPayloadSchema
>;
export type WorkerControlPullDefaultResultPayload = z.infer<
	typeof WorkerControlPullDefaultResultPayloadSchema
>;

export function buildWorkerControlJsonSchemas(): Readonly<Record<string, unknown>> {
	return {
		domain: z.toJSONSchema(WorkerControlDomainSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
		message: z.toJSONSchema(WorkerControlRpcMessageSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
		operation: z.toJSONSchema(WorkerControlRpcOperationSchema, {
			io: 'input',
			unrepresentable: 'any',
		}),
	};
}

export function assertWorkerControlDomainRegistered(): 'worker_control' {
	return KnownControlDomainSchema.extract(['worker_control']).parse('worker_control');
}
