import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	WorkerControlRpcMessageSchema,
	workerControlDeliveryPolicyByOperation,
	type WorkerControlRpcOperation,
} from '@agent-vm/worker-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PullDefaultResult } from '../git-pull-default-operations.js';
import type { PushBranchResult } from '../git-push-operations.js';
import {
	createControlSessionDispatcher,
	type ControlSessionDispatcher,
} from './control-session-dispatcher.js';
import {
	createWorkerControlDomainHandler,
	type WorkerControlRpcOperations,
} from './worker-control-domain-handler.js';

const acceptedSession = {
	bootId: 'worker-boot-a',
	controllerEpoch: 'epoch-a',
	peerId: 'worker-zone-a-task-1',
	zoneId: 'zone-a',
};

const pullDefaultResult = {
	commitsSinceForkPoint: [],
	defaultBranch: 'main',
	divergence: { aheadOfDefault: 0, behindDefault: 0, forkPoint: 'fork-sha' },
	fetchedCommits: [],
	kind: 'advanced',
	localDefaultHead: 'local-main-sha',
	message: 'Default branch refreshed.',
	remoteDefaultHead: 'remote-main-sha',
	repoUrl: 'https://github.com/acme/widgets.git',
	success: true,
} satisfies PullDefaultResult;

const pushResult = {
	branch: 'agent/task-1',
	localHead: 'local-agent-sha',
	repoUrl: 'https://github.com/acme/widgets.git',
	success: true,
} satisfies PushBranchResult;

function createEnvelope(
	operation: WorkerControlRpcOperation,
	overrides: Partial<ControlEnvelope> = {},
): ControlEnvelope {
	return {
		bootId: acceptedSession.bootId,
		commandId: '11111111-1111-4111-8111-111111111111',
		connectionId: '22222222-2222-4222-8222-222222222222',
		controllerEpoch: acceptedSession.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: workerControlDeliveryPolicyByOperation[operation],
		domain: 'worker_control',
		idempotencyKey: `${operation}-idempotency`,
		kind: 'command',
		messageId: '33333333-3333-4333-8333-333333333333',
		operation,
		peerId: acceptedSession.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: '44444444-4444-4444-8444-444444444444',
		zoneId: acceptedSession.zoneId,
		...overrides,
	};
}

function createWorkerRpcOperations(
	overrides: Partial<WorkerControlRpcOperations> = {},
): WorkerControlRpcOperations {
	return {
		pullDefaultForTask: vi.fn(async () => pullDefaultResult),
		pushTaskBranches: vi.fn(async () => ({ results: [pushResult] })),
		...overrides,
	};
}

function createDispatcher(
	operations: WorkerControlRpcOperations,
	options: { readonly taskId?: string } = {},
): ControlSessionDispatcher {
	const dispatcher = createControlSessionDispatcher();
	dispatcher.register(
		'worker_control',
		createWorkerControlDomainHandler({
			authenticatedTask: { taskId: options.taskId ?? 'task-1' },
			operations,
		}),
	);
	return dispatcher;
}

describe('worker control domain handler', () => {
	it('routes git_push through the controller push authority with expectedHead preserved', async () => {
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pushTaskBranches });
		const dispatcher = createDispatcher(operations);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('git_push'),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'git_push',
				payload: {
					branchName: 'agent/task-1',
					command: {
						commandId: '11111111-1111-4111-8111-111111111111',
						idempotencyKey: 'git_push-idempotency',
					},
					expectedHead: 'local-agent-sha',
					repoUrl: 'https://github.com/acme/widgets.git',
					task: { taskId: 'task-1' },
				},
			}),
		});

		expect(pushTaskBranches).toHaveBeenCalledWith('task-1', {
			branches: [
				{
					branchName: 'agent/task-1',
					expectedHead: 'local-agent-sha',
					repoUrl: 'https://github.com/acme/widgets.git',
				},
			],
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'git_push',
			payload: {
				gitPush: { results: [pushResult] },
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'ok',
			},
		});
	});

	it('routes git_pull_default through the controller pull-default authority', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const operations = createWorkerRpcOperations({ pullDefaultForTask });
		const dispatcher = createDispatcher(operations);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('git_pull_default'),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'git_pull_default',
				payload: {
					command: {
						commandId: '11111111-1111-4111-8111-111111111111',
						idempotencyKey: 'git_pull_default-idempotency',
					},
					currentBranch: 'agent/task-1',
					currentHead: 'local-agent-sha',
					repoUrl: 'https://github.com/acme/widgets.git',
					task: { taskId: 'task-1' },
					worktreeDirty: false,
				},
			}),
		});

		expect(pullDefaultForTask).toHaveBeenCalledWith('task-1', {
			currentBranch: 'agent/task-1',
			currentHead: 'local-agent-sha',
			repoUrl: 'https://github.com/acme/widgets.git',
			worktreeDirty: false,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'git_pull_default',
			payload: {
				gitPullDefault: pullDefaultResult,
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'ok',
			},
		});
	});

	it('rejects git_push when the payload task does not match the authenticated worker session', async () => {
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pushTaskBranches });
		const dispatcher = createDispatcher(operations, { taskId: 'task-a' });

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('git_push'),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'git_push',
				payload: {
					branchName: 'agent/task-b',
					command: {
						commandId: '11111111-1111-4111-8111-111111111111',
						idempotencyKey: 'git_push-idempotency',
					},
					expectedHead: 'local-agent-sha',
					repoUrl: 'https://github.com/acme/widgets.git',
					task: { taskId: 'task-b' },
				},
			}),
		});

		expect(pushTaskBranches).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'git_push',
			payload: {
				error: {
					errorClass: 'worker_control_task_mismatch',
					retryable: false,
					safeMessage: 'worker control command task does not match authenticated session',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
	});

	it('records worker observation events without invoking controller mutations', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pullDefaultForTask, pushTaskBranches });
		const onRuntimeObservation = vi.fn();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'worker_control',
			createWorkerControlDomainHandler({
				authenticatedTask: { taskId: 'task-1' },
				observations: { onRuntimeObservation },
				operations,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('worker_runtime_observation', {
				commandId: undefined,
				deliveryPolicy: 'append_only_observation',
				idempotencyKey: undefined,
				kind: 'event',
			}),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'event',
				operation: 'worker_runtime_observation',
				payload: {
					observedAtMs: 1,
					state: 'running',
					task: { taskId: 'task-1' },
				},
			}),
		});

		expect(response).toBeUndefined();
		expect(onRuntimeObservation).toHaveBeenCalledWith({
			observedAtMs: 1,
			state: 'running',
			task: { taskId: 'task-1' },
		});
		expect(pullDefaultForTask).not.toHaveBeenCalled();
		expect(pushTaskBranches).not.toHaveBeenCalled();
	});

	it('records worker capacity snapshots without invoking controller mutations', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pullDefaultForTask, pushTaskBranches });
		const onCapacitySnapshot = vi.fn();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'worker_control',
			createWorkerControlDomainHandler({
				authenticatedTask: { taskId: 'task-1' },
				observations: { onCapacitySnapshot },
				operations,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('worker_capacity_snapshot', {
				commandId: undefined,
				deliveryPolicy: 'latest_wins',
				idempotencyKey: undefined,
				kind: 'event',
			}),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'event',
				operation: 'worker_capacity_snapshot',
				payload: {
					activeTaskId: 'task-1',
					observedAtMs: 1,
					state: 'running',
				},
			}),
		});

		expect(response).toBeUndefined();
		expect(onCapacitySnapshot).toHaveBeenCalledWith({
			activeTaskId: 'task-1',
			observedAtMs: 1,
			state: 'running',
		});
		expect(pullDefaultForTask).not.toHaveBeenCalled();
		expect(pushTaskBranches).not.toHaveBeenCalled();
	});

	it('records worker runtime status without invoking controller mutations', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pullDefaultForTask, pushTaskBranches });
		const onRuntimeStatus = vi.fn();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'worker_control',
			createWorkerControlDomainHandler({
				authenticatedTask: { taskId: 'task-1' },
				observations: { onRuntimeStatus },
				operations,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('worker_runtime_status', {
				commandId: undefined,
				deliveryPolicy: 'latest_wins',
				idempotencyKey: undefined,
				kind: 'event',
			}),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'event',
				operation: 'worker_runtime_status',
				payload: {
					findings: [
						{
							id: 'task-status:task-1',
							ok: false,
							safeMessage: 'Task task-1 status is failed.',
							severity: 'error',
						},
					],
					observedAtMs: 1,
					statusKind: 'task_status',
				},
			}),
		});

		expect(response).toBeUndefined();
		expect(onRuntimeStatus).toHaveBeenCalledWith({
			findings: [
				{
					id: 'task-status:task-1',
					ok: false,
					safeMessage: 'Task task-1 status is failed.',
					severity: 'error',
				},
			],
			observedAtMs: 1,
			statusKind: 'task_status',
		});
		expect(pullDefaultForTask).not.toHaveBeenCalled();
		expect(pushTaskBranches).not.toHaveBeenCalled();
	});

	it('rejects controller-initiated operation_cancel sent inbound by the worker', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pullDefaultForTask, pushTaskBranches });
		const dispatcher = createDispatcher(operations);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('operation_cancel'),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: '55555555-5555-4555-8555-555555555555',
					initiatedBy: 'controller',
					reason: 'operator_cancelled',
				},
			}),
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				error: {
					errorClass: 'controller_only_operation',
					retryable: false,
					safeMessage: 'controller-initiated operation_cancel is not accepted inbound',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
		expect(pullDefaultForTask).not.toHaveBeenCalled();
		expect(pushTaskBranches).not.toHaveBeenCalled();
	});

	it('rejects recovery_command as controller-initiated only', async () => {
		const pullDefaultForTask = vi.fn(async () => pullDefaultResult);
		const pushTaskBranches = vi.fn(async () => ({ results: [pushResult] }));
		const operations = createWorkerRpcOperations({ pullDefaultForTask, pushTaskBranches });
		const dispatcher = createDispatcher(operations);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('recovery_command'),
			payload: WorkerControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'recovery_command',
				payload: {
					action: 'refresh_runtime_status',
				},
			}),
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'recovery_command',
			payload: {
				error: {
					errorClass: 'controller_only_operation',
					retryable: false,
					safeMessage: 'recovery_command is controller-initiated only',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
		expect(pullDefaultForTask).not.toHaveBeenCalled();
		expect(pushTaskBranches).not.toHaveBeenCalled();
	});
});
