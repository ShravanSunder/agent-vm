import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { workerControlDeliveryPolicyByOperation } from '@agent-vm/worker-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerControlApplicationMessageHandler } from './worker-control-application-handler.js';

function createEnvelope(
	operation:
		| 'control_ping'
		| 'git_pull_default'
		| 'git_push'
		| 'operation_cancel'
		| 'recovery_command',
): ControlEnvelope {
	return {
		bootId: 'worker-boot-a',
		commandId: '11111111-1111-4111-8111-111111111111',
		connectionId: '22222222-2222-4222-8222-222222222222',
		controllerEpoch: 'controller-epoch-a',
		createdAtMs: 1,
		deliveryPolicy: workerControlDeliveryPolicyByOperation[operation],
		domain: 'worker_control',
		idempotencyKey: `${operation}-key`,
		kind: 'command',
		messageId: '33333333-3333-4333-8333-333333333333',
		operation,
		peerId: 'worker-zone-a-task-1',
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: '44444444-4444-4444-8444-444444444444',
		zoneId: 'zone-a',
	};
}

describe('worker control application message handler', () => {
	it('rejects controller-initiated operation_cancel because task close stays on ingress HTTP', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('operation_cancel'),
			payload: {
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '55555555-5555-4555-8555-555555555555',
					initiatedBy: 'controller',
					reason: 'operator_cancelled',
				},
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: '55555555-5555-4555-8555-555555555555',
				error: {
					errorClass: 'worker_control_cancel_not_supported',
					retryable: false,
					safeMessage: 'worker task cancellation remains on the ingress HTTP task close route',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});

	it('rejects controller-initiated operation_cancel even when no task is active', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('operation_cancel'),
			payload: {
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '55555555-5555-4555-8555-555555555555',
					initiatedBy: 'controller',
					reason: 'operator_cancelled',
				},
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: '55555555-5555-4555-8555-555555555555',
				error: {
					errorClass: 'worker_control_cancel_not_supported',
					retryable: false,
					safeMessage: 'worker task cancellation remains on the ingress HTTP task close route',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});

	it('rejects worker-initiated operation_cancel sent as a controller command', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('operation_cancel'),
			payload: {
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '55555555-5555-4555-8555-555555555555',
					initiatedBy: 'worker',
					reason: 'caller_cancelled',
				},
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				error: {
					errorClass: 'worker_initiated_cancel_not_accepted_from_controller',
					retryable: false,
					safeMessage: 'worker-initiated operation_cancel is not accepted as a controller command',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});

	it('answers refresh_runtime_status recovery commands without mutating tasks', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('recovery_command'),
			payload: {
				kind: 'command',
				operation: 'recovery_command',
				payload: { action: 'refresh_runtime_status' },
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'recovery_command',
			payload: {
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'ok',
			},
		});
	});

	it('rejects unsupported recovery commands', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('recovery_command'),
			payload: {
				kind: 'command',
				operation: 'recovery_command',
				payload: { action: 'restart_control_service' },
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'recovery_command',
			payload: {
				error: {
					errorClass: 'worker_recovery_action_not_supported',
					retryable: false,
					safeMessage:
						"worker recovery action 'restart_control_service' is not supported by this runtime",
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});

	it('rejects controller-originated worker git commands', async () => {
		const closeActiveTask = vi.fn(async () => true);
		const handler = createWorkerControlApplicationMessageHandler();

		const response = await handler.handle({
			envelope: createEnvelope('git_push'),
			payload: {
				kind: 'command',
				operation: 'git_push',
				payload: {
					branchName: 'agent/task-1',
					command: {
						commandId: '11111111-1111-4111-8111-111111111111',
						idempotencyKey: 'git_push:task-1',
					},
					repoUrl: 'https://github.com/acme/widgets.git',
					task: { taskId: 'task-1' },
				},
			},
		});

		expect(closeActiveTask).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'git_push',
			payload: {
				error: {
					errorClass: 'worker_originated_operation',
					retryable: false,
					safeMessage: 'git_push is worker-originated and is not accepted as a controller command',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});
});
