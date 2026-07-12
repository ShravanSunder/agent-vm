import {
	WorkerControlRpcCommandResultMessageSchema,
	WorkerControlRpcMessageSchema,
	workerControlDeliveryPolicyByOperation,
	type WorkerControlCapacitySnapshotPayload,
	type WorkerControlRpcOperation,
	type WorkerControlRuntimeObservationPayload,
	type WorkerControlRuntimeStatusPayload,
} from '@agent-vm/worker-control-contracts';

import type { PullDefaultRequest, PullDefaultResult } from '../git-pull-default-operations.js';
import type { PushBranchRequest, PushBranchResult } from '../git-push-operations.js';
import type { ControlSessionDomainHandler } from './control-session-dispatcher.js';

export interface WorkerControlRpcOperations {
	pullDefaultForTask(taskId: string, input: PullDefaultRequest): Promise<PullDefaultResult>;
	pushTaskBranches(
		taskId: string,
		input: { readonly branches: readonly PushBranchRequest[] },
	): Promise<{ readonly results: readonly PushBranchResult[] }>;
}

export interface WorkerControlObservationHandlers {
	readonly onCapacitySnapshot?: (
		payload: WorkerControlCapacitySnapshotPayload,
	) => Promise<void> | void;
	readonly onRuntimeObservation?: (
		payload: WorkerControlRuntimeObservationPayload,
	) => Promise<void> | void;
	readonly onRuntimeStatus?: (payload: WorkerControlRuntimeStatusPayload) => Promise<void> | void;
}

export interface WorkerControlDomainHandlerOptions {
	readonly authenticatedTask: {
		readonly taskGeneration?: string;
		readonly taskId: string;
	};
	readonly observations?: WorkerControlObservationHandlers;
	readonly operations: WorkerControlRpcOperations;
}

function commandResultPayload(options: {
	readonly error?: {
		readonly errorClass: string;
		readonly retryable?: boolean;
		readonly safeMessage?: string;
	};
	readonly gitPullDefault?: PullDefaultResult;
	readonly gitPush?: { readonly results: readonly PushBranchResult[] };
	readonly operation: WorkerControlRpcOperation;
	readonly responseToMessageId: string;
	readonly result: 'ok' | 'rejected' | 'failed';
}): unknown {
	return WorkerControlRpcMessageSchema.parse({
		kind: 'command_result',
		operation: options.operation,
		payload: {
			...(options.error === undefined ? {} : { error: options.error }),
			...(options.gitPullDefault === undefined ? {} : { gitPullDefault: options.gitPullDefault }),
			...(options.gitPush === undefined ? {} : { gitPush: options.gitPush }),
			responseToMessageId: options.responseToMessageId,
			result: options.result,
		},
	});
}

function rejectTaskMismatchPayload(
	operation: WorkerControlRpcOperation,
	responseToMessageId: string,
): unknown {
	return commandResultPayload({
		error: {
			errorClass: 'worker_control_task_mismatch',
			retryable: false,
			safeMessage: 'worker control command task does not match authenticated session',
		},
		operation,
		responseToMessageId,
		result: 'rejected',
	});
}

function taskMatchesAuthenticatedSession(options: {
	readonly authenticatedTask: WorkerControlDomainHandlerOptions['authenticatedTask'];
	readonly payloadTask: {
		readonly taskGeneration?: string | undefined;
		readonly taskId: string;
	};
}): boolean {
	if (options.payloadTask.taskId !== options.authenticatedTask.taskId) {
		return false;
	}
	if (
		options.authenticatedTask.taskGeneration !== undefined &&
		options.payloadTask.taskGeneration !== options.authenticatedTask.taskGeneration
	) {
		return false;
	}
	return true;
}

export function createWorkerControlDomainHandler(
	options: WorkerControlDomainHandlerOptions,
): ControlSessionDomainHandler {
	return {
		policyByOperation: workerControlDeliveryPolicyByOperation,
		messageIdentity: ({ payload }) => {
			const message = WorkerControlRpcMessageSchema.parse(payload);
			return {
				kind: message.kind,
				operation: message.operation,
			};
		},
		buildHandlerFailureResult: ({ envelope, payload }) => {
			const message = WorkerControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') {
				return undefined;
			}
			return WorkerControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: {
					error: {
						errorClass: 'worker_control_handler_failed',
						retryable: true,
						safeMessage: `Worker control command '${message.operation}' failed after acceptance.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				},
			});
		},
		handle: async ({ envelope, payload }) => {
			const message = WorkerControlRpcMessageSchema.parse(payload);
			if (message.kind === 'event') {
				switch (message.operation) {
					case 'worker_capacity_snapshot':
						await options.observations?.onCapacitySnapshot?.(message.payload);
						break;
					case 'worker_runtime_status':
						await options.observations?.onRuntimeStatus?.(message.payload);
						break;
					case 'worker_runtime_observation':
						if (
							taskMatchesAuthenticatedSession({
								authenticatedTask: options.authenticatedTask,
								payloadTask: message.payload.task,
							})
						) {
							await options.observations?.onRuntimeObservation?.(message.payload);
						}
						break;
				}
				return undefined;
			}
			if (message.kind !== 'command') {
				return undefined;
			}
			switch (message.operation) {
				case 'control_ping':
					return commandResultPayload({
						operation: 'control_ping',
						responseToMessageId: envelope.messageId,
						result: 'ok',
					});
				case 'git_push': {
					if (
						!taskMatchesAuthenticatedSession({
							authenticatedTask: options.authenticatedTask,
							payloadTask: message.payload.task,
						})
					) {
						return rejectTaskMismatchPayload('git_push', envelope.messageId);
					}
					const result = await options.operations.pushTaskBranches(
						options.authenticatedTask.taskId,
						{
							branches: [
								{
									branchName: message.payload.branchName,
									...(message.payload.expectedHead === undefined
										? {}
										: { expectedHead: message.payload.expectedHead }),
									repoUrl: message.payload.repoUrl,
								},
							],
						},
					);
					return commandResultPayload({
						gitPush: result,
						operation: 'git_push',
						responseToMessageId: envelope.messageId,
						result: 'ok',
					});
				}
				case 'git_pull_default': {
					if (
						!taskMatchesAuthenticatedSession({
							authenticatedTask: options.authenticatedTask,
							payloadTask: message.payload.task,
						})
					) {
						return rejectTaskMismatchPayload('git_pull_default', envelope.messageId);
					}
					const result = await options.operations.pullDefaultForTask(
						options.authenticatedTask.taskId,
						{
							...(message.payload.currentBranch === undefined
								? {}
								: { currentBranch: message.payload.currentBranch }),
							...(message.payload.currentHead === undefined
								? {}
								: { currentHead: message.payload.currentHead }),
							repoUrl: message.payload.repoUrl,
							...(message.payload.worktreeDirty === undefined
								? {}
								: { worktreeDirty: message.payload.worktreeDirty }),
						},
					);
					return commandResultPayload({
						gitPullDefault: result,
						operation: 'git_pull_default',
						responseToMessageId: envelope.messageId,
						result: 'ok',
					});
				}
				case 'operation_cancel':
					if (message.payload.initiatedBy === 'controller') {
						return commandResultPayload({
							error: {
								errorClass: 'controller_only_operation',
								retryable: false,
								safeMessage: 'controller-initiated operation_cancel is not accepted inbound',
							},
							operation: 'operation_cancel',
							responseToMessageId: envelope.messageId,
							result: 'rejected',
						});
					}
					return commandResultPayload({
						error: {
							errorClass: 'worker_operation_cancel_unimplemented',
							retryable: false,
							safeMessage: 'worker operation cancellation is not configured',
						},
						operation: 'operation_cancel',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					});
				case 'recovery_command':
					return commandResultPayload({
						error: {
							errorClass: 'controller_only_operation',
							retryable: false,
							safeMessage: 'recovery_command is controller-initiated only',
						},
						operation: 'recovery_command',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					});
			}
			return undefined;
		},
	};
}
