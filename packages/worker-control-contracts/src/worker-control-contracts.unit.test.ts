import { readFile } from 'node:fs/promises';

import {
	ControlCloseSchema,
	ControlEnvelopeSchema,
	assertDerivedControlDeliveryPolicy,
	type ControlMessageReceipt,
} from '@agent-vm/control-protocol-contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	WorkerControlDomainSchema,
	WorkerControlPullDefaultResultPayloadSchema,
	WorkerControlGitPushPayloadSchema,
	buildWorkerControlJsonSchemas,
	WorkerControlRpcCommandResultMessageSchema,
	WorkerControlRpcMessageSchema,
	WorkerControlRpcOperationSchema,
	assertWorkerControlDomainRegistered,
	workerControlCommandExecutionTimeoutMsByOperation,
	workerControlDeliveryPolicyByOperation,
	type WorkerControlControllerToWorkerEvents,
	type WorkerControlRpcMessage,
	type WorkerControlWorkerToControllerEvents,
} from './index.js';

async function readJsonSchemaArtifact(relativePath: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as unknown;
}

const workerCommandEnvelope = ControlEnvelopeSchema.parse({
	bootId: 'worker-boot-a',
	commandId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	createdAtMs: 1,
	deliveryPolicy: 'single_use_critical',
	domain: 'worker_control',
	idempotencyKey: 'worker-command-key',
	kind: 'command',
	messageId: '22222222-2222-4222-8222-222222222222',
	operation: 'git_push',
	peerId: 'worker-zone-a',
	protocolVersion: 1,
	sequence: 1,
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
});

describe('worker control contract shell', () => {
	it('reserves the worker_control domain', () => {
		expect(WorkerControlDomainSchema.parse('worker_control')).toBe('worker_control');
		expect(assertWorkerControlDomainRegistered()).toBe('worker_control');
		expect(WorkerControlDomainSchema.safeParse('gateway_control').success).toBe(false);
	});

	it('keeps the worker operation union exact and separated from gateway lease ops', () => {
		expect([...WorkerControlRpcOperationSchema.options].toSorted()).toEqual([
			'control_ping',
			'git_pull_default',
			'git_push',
			'operation_cancel',
			'recovery_command',
			'worker_capacity_snapshot',
			'worker_runtime_observation',
			'worker_runtime_status',
		]);

		expect(WorkerControlRpcOperationSchema.safeParse('lease_create').success).toBe(false);
		expect(WorkerControlRpcOperationSchema.safeParse('task_submit').success).toBe(false);
		expect(WorkerControlRpcOperationSchema.safeParse('task_close').success).toBe(false);
	});

	it('keeps worker git command budgets separate from transport ack timing', () => {
		expect(workerControlCommandExecutionTimeoutMsByOperation.git_push).toBeGreaterThan(2_000);
		expect(workerControlCommandExecutionTimeoutMsByOperation.git_pull_default).toBeGreaterThan(
			2_000,
		);
		expect(Object.keys(workerControlCommandExecutionTimeoutMsByOperation).toSorted()).toEqual(
			[...WorkerControlRpcOperationSchema.options].toSorted(),
		);
	});

	it('exports domain JSON schemas matching the reviewed static artifact', async () => {
		await expect(
			readJsonSchemaArtifact('./worker-control-json-schema.snapshot.json'),
		).resolves.toEqual(buildWorkerControlJsonSchemas());
	});

	it('exports Socket.IO event maps with receipt-only message acknowledgements', () => {
		type WorkerControlMessageReceipt = Parameters<
			Parameters<WorkerControlControllerToWorkerEvents['control:message']>[2]
		>[0];
		expectTypeOf<WorkerControlMessageReceipt>().toEqualTypeOf<ControlMessageReceipt>();
		const workerPayload = WorkerControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'git_push',
			payload: {
				branchName: 'agent/task-1',
				command: {
					commandId: '44444444-4444-4444-8444-444444444444',
					idempotencyKey: 'git-push-task-1',
				},
				repoUrl: 'https://github.com/acme/widgets.git',
				task: {
					taskId: 'task-1',
				},
			},
		});
		const closePayload = ControlCloseSchema.parse({
			reason: 'normal_shutdown',
			sessionId: workerCommandEnvelope.sessionId,
		});
		const controllerToWorkerEvents = {
			'control:close': (payload, acknowledge) => {
				expect(payload).toEqual(closePayload);
				acknowledge({ received: true });
			},
			'control:hello': (payload, acknowledge) => {
				expect(payload.domain).toBe('worker_control');
				acknowledge({
					connectionId: workerCommandEnvelope.connectionId,
					controllerEpoch: workerCommandEnvelope.controllerEpoch,
					outcome: 'accepted',
					sessionId: workerCommandEnvelope.sessionId,
				});
			},
			'control:message': (envelope, payload, acknowledge) => {
				const typedPayload: WorkerControlRpcMessage = payload;
				expect(envelope.domain).toBe('worker_control');
				expect(typedPayload).toEqual(workerPayload);
				acknowledge({ received: true });
			},
		} satisfies WorkerControlControllerToWorkerEvents;
		const workerToControllerEvents = {
			'control:close': controllerToWorkerEvents['control:close'],
			'control:message': controllerToWorkerEvents['control:message'],
		} satisfies WorkerControlWorkerToControllerEvents;

		controllerToWorkerEvents['control:hello'](
			{
				bootId: workerCommandEnvelope.bootId,
				controllerEpoch: workerCommandEnvelope.controllerEpoch,
				domain: 'worker_control',
				peerId: workerCommandEnvelope.peerId,
				protocolVersion: 1,
			},
			(response) => {
				expect(response.outcome).toBe('accepted');
			},
		);
		workerToControllerEvents['control:message'](workerCommandEnvelope, workerPayload, (receipt) => {
			expect(receipt.received).toBe(true);
		});
	});

	it('accepts git push intent fields and rejects controller authority fields', () => {
		const validPayload = {
			branchName: 'agent/task-1',
			command: {
				commandId: '44444444-4444-4444-8444-444444444444',
				idempotencyKey: 'git-push-task-1',
			},
			expectedHead: 'abc123',
			repoUrl: 'https://github.com/acme/widgets.git',
			task: {
				taskGeneration: 'generation-a',
				taskId: 'task-1',
			},
		};

		expect(WorkerControlGitPushPayloadSchema.parse(validPayload)).toEqual(validPayload);

		for (const invalidPayload of [
			{ ...validPayload, branchName: '' },
			{ ...validPayload, protectedBranches: ['main'] },
			{ ...validPayload, defaultBranch: 'main' },
			{ ...validPayload, hostPath: '/Users/example/repo' },
			{ ...validPayload, credentialRef: 'op://vault/item/credential' },
			{ ...validPayload, force: true },
		]) {
			expect(WorkerControlGitPushPayloadSchema.safeParse(invalidPayload).success).toBe(false);
		}
	});

	it('allows worker commands and events but forbids event-only operations as command results', () => {
		expect(
			WorkerControlRpcMessageSchema.safeParse({
				kind: 'command',
				operation: 'git_push',
				payload: {
					branchName: 'agent/task-1',
					command: {
						commandId: '44444444-4444-4444-8444-444444444444',
						idempotencyKey: 'git-push-task-1',
					},
					expectedHead: 'abc123',
					repoUrl: 'https://github.com/acme/widgets.git',
					task: {
						taskId: 'task-1',
					},
				},
			}).success,
		).toBe(true);

		expect(
			WorkerControlRpcMessageSchema.safeParse({
				kind: 'event',
				operation: 'worker_runtime_observation',
				payload: {
					observedAtMs: 1,
					sessionState: 'ready',
					state: 'running',
					task: {
						taskId: 'task-1',
					},
				},
			}).success,
		).toBe(true);

		expect(
			WorkerControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'worker_runtime_observation',
				payload: {
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);
	});

	it('binds command_result payload fields to the worker operation', () => {
		const gitPushResult = {
			results: [
				{
					branch: 'agent/task-1',
					repoUrl: 'https://github.com/acme/widgets.git',
					success: true,
				},
			],
		};

		const gitPullDefaultResult = {
			commitsSinceForkPoint: [
				{
					author: 'Ada Example',
					date: '2026-07-03T17:31:00.000Z',
					sha: 'abc123',
					subject: 'Implement the thing',
				},
			],
			defaultBranch: 'main',
			divergence: {
				aheadOfDefault: 0,
				behindDefault: 1,
				forkPoint: 'abc123',
			},
			fetchedCommits: [
				{
					sha: 'def456',
					subject: 'Update default branch',
				},
			],
			kind: 'advanced',
			localDefaultHead: 'def456',
			message: 'advanced default branch',
			remoteDefaultHead: 'def456',
			repoUrl: 'https://github.com/acme/widgets.git',
			success: true,
		};

		expect(
			WorkerControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'git_push',
				payload: {
					gitPush: gitPushResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(true);

		expect(
			WorkerControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'control_ping',
				payload: {
					gitPush: gitPushResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);

		expect(
			WorkerControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'git_push',
				payload: {
					gitPullDefault: gitPullDefaultResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(false);

		expect(
			WorkerControlRpcCommandResultMessageSchema.safeParse({
				kind: 'command_result',
				operation: 'git_pull_default',
				payload: {
					gitPullDefault: gitPullDefaultResult,
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok',
				},
			}).success,
		).toBe(true);

		for (const malformedGitPullDefaultResult of [
			{
				...gitPullDefaultResult,
				commitsSinceForkPoint: [{ subject: 'missing sha' }],
			},
			{
				...gitPullDefaultResult,
				fetchedCommits: [{ sha: 'abc123' }],
			},
			{
				...gitPullDefaultResult,
				fetchedCommits: [{ extra: true, sha: 'abc123', subject: 'extra field' }],
			},
		]) {
			expect(
				WorkerControlPullDefaultResultPayloadSchema.safeParse(malformedGitPullDefaultResult)
					.success,
			).toBe(false);
		}
	});

	it('covers every worker operation with a derived delivery policy', () => {
		expect(Object.keys(workerControlDeliveryPolicyByOperation).toSorted()).toEqual(
			[...WorkerControlRpcOperationSchema.options].toSorted(),
		);

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: workerCommandEnvelope,
				policyByOperation: workerControlDeliveryPolicyByOperation,
			}),
		).not.toThrow();

		expect(() =>
			assertDerivedControlDeliveryPolicy({
				envelope: {
					...workerCommandEnvelope,
					deliveryPolicy: 'latest_wins',
				},
				policyByOperation: workerControlDeliveryPolicyByOperation,
			}),
		).toThrow(/delivery policy mismatch/u);
	});
});
