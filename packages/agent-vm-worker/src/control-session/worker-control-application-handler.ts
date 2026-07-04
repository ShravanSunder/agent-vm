import {
	WorkerControlRpcCommandResultMessageSchema,
	WorkerControlRpcMessageSchema,
	type WorkerControlRpcOperation,
} from '@agent-vm/worker-control-contracts';

import type {
	WorkerControlApplicationMessageHandler,
	WorkerControlApplicationMessageContext,
} from './worker-control-service.js';

function commandResultPayload(options: {
	readonly activeOperationId?: string | undefined;
	readonly error?: {
		readonly errorClass: string;
		readonly retryable?: boolean;
		readonly safeMessage?: string;
	};
	readonly operation: WorkerControlRpcOperation;
	readonly responseToMessageId: string;
	readonly result: 'ok' | 'accepted' | 'cancelled' | 'failed' | 'rejected';
}): unknown {
	return WorkerControlRpcCommandResultMessageSchema.parse({
		kind: 'command_result',
		operation: options.operation,
		payload: {
			...(options.activeOperationId === undefined
				? {}
				: { activeOperationId: options.activeOperationId }),
			...(options.error === undefined ? {} : { error: options.error }),
			responseToMessageId: options.responseToMessageId,
			result: options.result,
		},
	});
}

function commandFailurePayload(
	context: WorkerControlApplicationMessageContext,
	error: unknown,
): unknown {
	const message = WorkerControlRpcMessageSchema.parse(context.payload);
	if (message.kind !== 'command') {
		return undefined;
	}
	return commandResultPayload({
		error: {
			errorClass: 'worker_control_application_handler_failed',
			retryable: true,
			safeMessage:
				error instanceof Error ? error.message : 'Worker control command failed after acceptance.',
		},
		operation: message.operation,
		responseToMessageId: context.envelope.messageId,
		result: 'failed',
	});
}

export function createWorkerControlApplicationMessageHandler(): WorkerControlApplicationMessageHandler {
	return {
		messageIdentity: ({ payload }) => {
			const message = WorkerControlRpcMessageSchema.parse(payload);
			return {
				kind: message.kind,
				operation: message.operation,
			};
		},
		buildHandlerFailureResult: commandFailurePayload,
		handle: async ({ envelope, payload }) => {
			const message = WorkerControlRpcMessageSchema.parse(payload);
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
				case 'operation_cancel': {
					if (message.payload.initiatedBy !== 'controller') {
						return commandResultPayload({
							error: {
								errorClass: 'worker_initiated_cancel_not_accepted_from_controller',
								retryable: false,
								safeMessage:
									'worker-initiated operation_cancel is not accepted as a controller command',
							},
							operation: 'operation_cancel',
							responseToMessageId: envelope.messageId,
							result: 'rejected',
						});
					}
					return commandResultPayload({
						activeOperationId: message.payload.activeOperationId,
						error: {
							errorClass: 'worker_control_cancel_not_supported',
							retryable: false,
							safeMessage: 'worker task cancellation remains on the ingress HTTP task close route',
						},
						operation: 'operation_cancel',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					});
				}
				case 'recovery_command': {
					if (message.payload.action === 'refresh_runtime_status') {
						return commandResultPayload({
							operation: 'recovery_command',
							responseToMessageId: envelope.messageId,
							result: 'ok',
						});
					}
					return commandResultPayload({
						error: {
							errorClass: 'worker_recovery_action_not_supported',
							retryable: false,
							safeMessage: `worker recovery action '${message.payload.action}' is not supported by this runtime`,
						},
						operation: 'recovery_command',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					});
				}
				case 'git_push':
				case 'git_pull_default':
					return commandResultPayload({
						error: {
							errorClass: 'worker_originated_operation',
							retryable: false,
							safeMessage: `${message.operation} is worker-originated and is not accepted as a controller command`,
						},
						operation: message.operation,
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					});
			}
			return undefined;
		},
	};
}
