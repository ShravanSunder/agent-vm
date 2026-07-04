import type {
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import {
	WorkerControlRpcMessageSchema,
	type WorkerControlRpcMessage,
} from '@agent-vm/worker-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
	WorkerControlAcceptedSession,
	WorkerControlService,
} from '../../control-session/worker-control-service.js';
import {
	createWorkerControlControllerToolsClient,
	createWorkerControlRuntimeEventPublisher,
} from './worker-control-rpc-client.js';

const acceptedSession = {
	bootId: 'worker-boot-a',
	connectionId: '55555555-5555-4555-8555-555555555555',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'worker-generation-a',
	peerId: 'worker-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
} satisfies WorkerControlAcceptedSession;

describe('createWorkerControlControllerToolsClient', () => {
	it('reuses worker git command identity after an ack-before-result transport flap', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const emittedMessages: WorkerControlRpcMessage[] = [];
		let nextSequence = 1;
		let sendCount = 0;
		const service = {
			emitApplicationMessage: vi.fn(
				async (
					envelope: ControlEnvelope,
					domainMessage: DomainControlMessageIdentity,
					payload: unknown,
				) => {
					expect(domainMessage).toEqual({ kind: 'command', operation: 'git_push' });
					emittedEnvelopes.push(envelope);
					emittedMessages.push(WorkerControlRpcMessageSchema.parse(payload));
					sendCount += 1;
					if (sendCount === 1) {
						throw new Error('transport lost command_result after accepted ack');
					}
					return {
						kind: 'command_result',
						operation: 'git_push',
						payload: {
							gitPush: { results: [] },
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					};
				},
			),
			getAcceptedSession: vi.fn(async () => acceptedSession),
			nextPeerSequence: vi.fn(() => {
				const sequence = nextSequence;
				nextSequence += 1;
				return sequence;
			}),
		} satisfies Pick<
			WorkerControlService,
			'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
		>;
		const client = createWorkerControlControllerToolsClient(service);
		const request = {
			branchName: 'agent/task-1',
			expectedHead: 'abc123',
			repoUrl: 'https://github.com/acme/widgets.git',
			taskId: 'task-1',
		};

		await expect(client.gitPush(request)).rejects.toThrow(
			'transport lost command_result after accepted ack',
		);
		await expect(client.gitPush(request)).resolves.toEqual({ results: [] });

		expect(emittedEnvelopes).toHaveLength(2);
		expect(emittedMessages).toHaveLength(2);
		expect(emittedEnvelopes[1]?.commandId).toBe(emittedEnvelopes[0]?.commandId);
		expect(emittedEnvelopes[1]?.idempotencyKey).toBe(emittedEnvelopes[0]?.idempotencyKey);
		expect(emittedEnvelopes[1]?.messageId).toBe(emittedEnvelopes[0]?.messageId);
		const firstMessage = emittedMessages[0];
		const secondMessage = emittedMessages[1];
		if (
			firstMessage?.kind !== 'command' ||
			firstMessage.operation !== 'git_push' ||
			secondMessage?.kind !== 'command' ||
			secondMessage.operation !== 'git_push'
		) {
			throw new Error('Expected git_push command messages.');
		}
		expect(secondMessage.payload.command).toEqual(firstMessage.payload.command);
	});

	it('reuses pull-default message identity after an ack-before-result transport flap', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const emittedMessages: WorkerControlRpcMessage[] = [];
		let nextSequence = 1;
		let sendCount = 0;
		const service = {
			emitApplicationMessage: vi.fn(
				async (
					envelope: ControlEnvelope,
					domainMessage: DomainControlMessageIdentity,
					payload: unknown,
				) => {
					expect(domainMessage).toEqual({
						kind: 'command',
						operation: 'git_pull_default',
					});
					emittedEnvelopes.push(envelope);
					emittedMessages.push(WorkerControlRpcMessageSchema.parse(payload));
					sendCount += 1;
					if (sendCount === 1) {
						throw new Error('transport lost pull-default command_result after accepted ack');
					}
					return {
						kind: 'command_result',
						operation: 'git_pull_default',
						payload: {
							gitPullDefault: {
								error: 'pull-default failed in fixture',
								kind: 'failed',
								message: 'pull-default failed in fixture',
								repoUrl: 'https://github.com/acme/widgets.git',
								success: false,
							},
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					};
				},
			),
			getAcceptedSession: vi.fn(async () => acceptedSession),
			nextPeerSequence: vi.fn(() => {
				const sequence = nextSequence;
				nextSequence += 1;
				return sequence;
			}),
		} satisfies Pick<
			WorkerControlService,
			'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
		>;
		const client = createWorkerControlControllerToolsClient(service);
		const request = {
			currentBranch: 'agent/task-1',
			currentHead: 'abc123',
			repoUrl: 'https://github.com/acme/widgets.git',
			taskId: 'task-1',
			worktreeDirty: false,
		};

		await expect(client.gitPullDefault(request)).rejects.toThrow(
			'transport lost pull-default command_result after accepted ack',
		);
		await expect(client.gitPullDefault(request)).resolves.toEqual({
			error: 'pull-default failed in fixture',
			kind: 'failed',
			message: 'pull-default failed in fixture',
			repoUrl: 'https://github.com/acme/widgets.git',
			success: false,
		});

		expect(emittedEnvelopes).toHaveLength(2);
		expect(emittedMessages).toHaveLength(2);
		expect(emittedEnvelopes[1]?.commandId).toBe(emittedEnvelopes[0]?.commandId);
		expect(emittedEnvelopes[1]?.idempotencyKey).toBe(emittedEnvelopes[0]?.idempotencyKey);
		expect(emittedEnvelopes[1]?.messageId).toBe(emittedEnvelopes[0]?.messageId);
		const firstMessage = emittedMessages[0];
		const secondMessage = emittedMessages[1];
		if (
			firstMessage?.kind !== 'command' ||
			firstMessage.operation !== 'git_pull_default' ||
			secondMessage?.kind !== 'command' ||
			secondMessage.operation !== 'git_pull_default'
		) {
			throw new Error('Expected git_pull_default command messages.');
		}
		expect(secondMessage.payload.command).toEqual(firstMessage.payload.command);
	});
});

describe('createWorkerControlRuntimeEventPublisher', () => {
	it('emits capacity snapshots as latest-wins worker_control event messages', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const emittedMessages: WorkerControlRpcMessage[] = [];
		const service = {
			emitApplicationMessage: vi.fn(
				async (
					envelope: ControlEnvelope,
					domainMessage: DomainControlMessageIdentity,
					payload: unknown,
				) => {
					expect(domainMessage).toEqual({
						kind: 'event',
						operation: 'worker_capacity_snapshot',
					});
					emittedEnvelopes.push(envelope);
					emittedMessages.push(WorkerControlRpcMessageSchema.parse(payload));
					return { received: true };
				},
			),
			getAcceptedSession: vi.fn(async () => acceptedSession),
			nextPeerSequence: vi.fn(() => 5),
		} satisfies Pick<
			WorkerControlService,
			'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
		>;
		const publisher = createWorkerControlRuntimeEventPublisher(service);

		await publisher.emitCapacitySnapshot({
			activeTaskId: 'task-1',
			observedAtMs: 123,
			state: 'running',
		});

		expect(emittedEnvelopes).toEqual([
			expect.objectContaining({
				deliveryPolicy: 'latest_wins',
				domain: 'worker_control',
				kind: 'event',
				operation: 'worker_capacity_snapshot',
				sequence: 5,
			}),
		]);
		expect(emittedEnvelopes[0]?.commandId).toBeUndefined();
		expect(emittedEnvelopes[0]?.idempotencyKey).toBeUndefined();
		expect(service.nextPeerSequence).toHaveBeenCalledWith({
			deliveryPolicy: 'latest_wins',
		});
		expect(emittedMessages).toEqual([
			{
				kind: 'event',
				operation: 'worker_capacity_snapshot',
				payload: {
					activeTaskId: 'task-1',
					observedAtMs: 123,
					state: 'running',
				},
			},
		]);
	});

	it('emits runtime observations as worker_control event messages', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const emittedMessages: WorkerControlRpcMessage[] = [];
		const service = {
			emitApplicationMessage: vi.fn(
				async (
					envelope: ControlEnvelope,
					domainMessage: DomainControlMessageIdentity,
					payload: unknown,
				) => {
					expect(domainMessage).toEqual({
						kind: 'event',
						operation: 'worker_runtime_observation',
					});
					emittedEnvelopes.push(envelope);
					emittedMessages.push(WorkerControlRpcMessageSchema.parse(payload));
					return { received: true };
				},
			),
			getAcceptedSession: vi.fn(async () => acceptedSession),
			nextPeerSequence: vi.fn(() => 7),
		} satisfies Pick<
			WorkerControlService,
			'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
		>;
		const publisher = createWorkerControlRuntimeEventPublisher(service);

		await publisher.emitRuntimeObservation({
			observedAtMs: 123,
			state: 'running',
			task: { taskId: 'task-1' },
		});

		expect(emittedEnvelopes).toEqual([
			expect.objectContaining({
				deliveryPolicy: 'append_only_observation',
				domain: 'worker_control',
				kind: 'event',
				operation: 'worker_runtime_observation',
				sequence: 7,
			}),
		]);
		expect(emittedEnvelopes[0]?.commandId).toBeUndefined();
		expect(emittedEnvelopes[0]?.idempotencyKey).toBeUndefined();
		expect(emittedMessages).toEqual([
			{
				kind: 'event',
				operation: 'worker_runtime_observation',
				payload: {
					observedAtMs: 123,
					state: 'running',
					task: { taskId: 'task-1' },
				},
			},
		]);
	});

	it('emits runtime status as latest-wins worker_control event messages', async () => {
		const emittedEnvelopes: ControlEnvelope[] = [];
		const emittedMessages: WorkerControlRpcMessage[] = [];
		const service = {
			emitApplicationMessage: vi.fn(
				async (
					envelope: ControlEnvelope,
					domainMessage: DomainControlMessageIdentity,
					payload: unknown,
				) => {
					expect(domainMessage).toEqual({
						kind: 'event',
						operation: 'worker_runtime_status',
					});
					emittedEnvelopes.push(envelope);
					emittedMessages.push(WorkerControlRpcMessageSchema.parse(payload));
					return { received: true };
				},
			),
			getAcceptedSession: vi.fn(async () => acceptedSession),
			nextPeerSequence: vi.fn(() => 9),
		} satisfies Pick<
			WorkerControlService,
			'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
		>;
		const publisher = createWorkerControlRuntimeEventPublisher(service);

		await publisher.emitRuntimeStatus({
			findings: [
				{
					id: 'task-status:task-1',
					ok: false,
					safeMessage: 'Task task-1 status is failed.',
					severity: 'error',
				},
			],
			observedAtMs: 123,
			statusKind: 'task_status',
		});

		expect(emittedEnvelopes).toEqual([
			expect.objectContaining({
				deliveryPolicy: 'latest_wins',
				domain: 'worker_control',
				kind: 'event',
				operation: 'worker_runtime_status',
				sequence: 9,
			}),
		]);
		expect(emittedEnvelopes[0]?.commandId).toBeUndefined();
		expect(emittedEnvelopes[0]?.idempotencyKey).toBeUndefined();
		expect(emittedMessages).toEqual([
			{
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
					observedAtMs: 123,
					statusKind: 'task_status',
				},
			},
		]);
	});
});
