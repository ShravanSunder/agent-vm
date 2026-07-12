import { randomUUID } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	WorkerControlRpcCommandResultMessageSchema,
	WorkerControlRpcResponsePayloadSchema,
	workerControlDeliveryPolicyByOperation,
	type WorkerControlCapacitySnapshotPayload,
	type WorkerControlPullDefaultResultPayload,
	type WorkerControlGitPushResultPayload,
	type WorkerControlRuntimeObservationPayload,
	type WorkerControlRuntimeStatusPayload,
} from '@agent-vm/worker-control-contracts';

import type { WorkerControlService } from '../../control-session/worker-control-service.js';

export interface WorkerControlGitPushRequest {
	readonly branchName: string;
	readonly expectedHead?: string | undefined;
	readonly repoUrl: string;
	readonly taskId: string;
}

export interface WorkerControlGitPullDefaultRequest {
	readonly currentBranch?: string | null | undefined;
	readonly currentHead?: string | undefined;
	readonly repoUrl: string;
	readonly taskId: string;
	readonly worktreeDirty?: boolean | undefined;
}

export interface WorkerControlControllerToolsClient {
	gitPush(request: WorkerControlGitPushRequest): Promise<WorkerControlGitPushResultPayload>;
	gitPullDefault(
		request: WorkerControlGitPullDefaultRequest,
	): Promise<WorkerControlPullDefaultResultPayload>;
}

export interface WorkerControlRuntimeEventPublisher {
	emitCapacitySnapshot(payload: WorkerControlCapacitySnapshotPayload): Promise<void>;
	emitRuntimeObservation(payload: WorkerControlRuntimeObservationPayload): Promise<void>;
	emitRuntimeStatus(payload: WorkerControlRuntimeStatusPayload): Promise<void>;
}

export class WorkerControlRpcCommandError extends Error {
	public constructor(
		message: string,
		public readonly retryable: boolean | undefined,
	) {
		super(message);
		this.name = 'WorkerControlRpcCommandError';
	}
}

interface PendingWorkerControlCommandIdentity {
	readonly commandId: string;
	readonly messageId: string;
}

function buildIdempotencyKey(parts: readonly (string | null | undefined)[]): string {
	return parts.map((part) => part ?? '<none>').join('\u0000');
}

export function createWorkerControlControllerToolsClient(
	service: Pick<
		WorkerControlService,
		'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
	>,
): WorkerControlControllerToolsClient {
	const pendingCommandIdentityByIdempotencyKey = new Map<
		string,
		PendingWorkerControlCommandIdentity
	>();

	function pendingCommandIdentityFor(idempotencyKey: string): PendingWorkerControlCommandIdentity {
		const existingIdentity = pendingCommandIdentityByIdempotencyKey.get(idempotencyKey);
		if (existingIdentity !== undefined) {
			return existingIdentity;
		}
		const identity = {
			commandId: randomUUID(),
			messageId: randomUUID(),
		} satisfies PendingWorkerControlCommandIdentity;
		pendingCommandIdentityByIdempotencyKey.set(idempotencyKey, identity);
		return identity;
	}

	function forgetPendingCommandIdentity(idempotencyKey: string): void {
		pendingCommandIdentityByIdempotencyKey.delete(idempotencyKey);
	}

	async function emitWorkerControlCommand(options: {
		readonly commandId: string;
		readonly idempotencyKey: string;
		readonly messageId: string;
		readonly operation: 'git_push' | 'git_pull_default';
		readonly payload: unknown;
	}): Promise<ReturnType<typeof WorkerControlRpcResponsePayloadSchema.parse>> {
		const session = await service.getAcceptedSession();
		const envelope = {
			bootId: session.bootId,
			commandId: options.commandId,
			connectionId: session.connectionId,
			controllerEpoch: session.controllerEpoch,
			createdAtMs: Date.now(),
			deliveryPolicy: workerControlDeliveryPolicyByOperation[options.operation],
			domain: 'worker_control',
			idempotencyKey: options.idempotencyKey,
			kind: 'command',
			messageId: options.messageId,
			operation: options.operation,
			peerId: session.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: service.nextPeerSequence(),
			sessionId: session.sessionId,
			zoneId: session.zoneId,
		} satisfies ControlEnvelope;
		const responseMessagePayload = await service.emitApplicationMessage(
			envelope,
			{ kind: 'command', operation: options.operation },
			{
				kind: 'command',
				operation: options.operation,
				payload: options.payload,
			},
		);
		const responseMessage =
			WorkerControlRpcCommandResultMessageSchema.parse(responseMessagePayload);
		if (responseMessage.operation !== options.operation) {
			throw new WorkerControlRpcCommandError(
				'Controller response operation did not match the Worker control command.',
				false,
			);
		}
		const response = WorkerControlRpcResponsePayloadSchema.parse(responseMessage.payload);
		if (response.responseToMessageId !== options.messageId) {
			throw new WorkerControlRpcCommandError(
				'Controller response did not match the Worker control command.',
				false,
			);
		}
		if (response.result !== 'ok' && response.result !== 'accepted') {
			throw new WorkerControlRpcCommandError(
				response.error?.safeMessage ?? `Worker control command ${options.operation} failed.`,
				response.error?.retryable,
			);
		}
		return response;
	}

	return {
		gitPush: async (request) => {
			const idempotencyKey = buildIdempotencyKey([
				'git_push',
				request.taskId,
				request.repoUrl,
				request.branchName,
				request.expectedHead,
			]);
			const commandIdentity = pendingCommandIdentityFor(idempotencyKey);
			try {
				const response = await emitWorkerControlCommand({
					commandId: commandIdentity.commandId,
					idempotencyKey,
					messageId: commandIdentity.messageId,
					operation: 'git_push',
					payload: {
						branchName: request.branchName,
						command: {
							commandId: commandIdentity.commandId,
							idempotencyKey,
						},
						...(request.expectedHead === undefined ? {} : { expectedHead: request.expectedHead }),
						repoUrl: request.repoUrl,
						task: { taskId: request.taskId },
					},
				});
				if (response.gitPush === undefined) {
					throw new WorkerControlRpcCommandError(
						'Controller response did not include git push result.',
						false,
					);
				}
				forgetPendingCommandIdentity(idempotencyKey);
				return response.gitPush;
			} catch (error) {
				if (error instanceof WorkerControlRpcCommandError) {
					forgetPendingCommandIdentity(idempotencyKey);
				}
				throw error;
			}
		},
		gitPullDefault: async (request) => {
			const idempotencyKey = buildIdempotencyKey([
				'git_pull_default',
				request.taskId,
				request.repoUrl,
				request.currentBranch,
				request.currentHead,
				String(request.worktreeDirty ?? false),
			]);
			const commandIdentity = pendingCommandIdentityFor(idempotencyKey);
			try {
				const response = await emitWorkerControlCommand({
					commandId: commandIdentity.commandId,
					idempotencyKey,
					messageId: commandIdentity.messageId,
					operation: 'git_pull_default',
					payload: {
						command: {
							commandId: commandIdentity.commandId,
							idempotencyKey,
						},
						...(request.currentBranch === undefined || request.currentBranch === null
							? {}
							: { currentBranch: request.currentBranch }),
						...(request.currentHead === undefined ? {} : { currentHead: request.currentHead }),
						repoUrl: request.repoUrl,
						task: { taskId: request.taskId },
						...(request.worktreeDirty === undefined
							? {}
							: { worktreeDirty: request.worktreeDirty }),
					},
				});
				if (response.gitPullDefault === undefined) {
					throw new WorkerControlRpcCommandError(
						'Controller response did not include pull-default result.',
						false,
					);
				}
				forgetPendingCommandIdentity(idempotencyKey);
				return response.gitPullDefault;
			} catch (error) {
				if (error instanceof WorkerControlRpcCommandError) {
					forgetPendingCommandIdentity(idempotencyKey);
				}
				throw error;
			}
		},
	};
}

export function createWorkerControlRuntimeEventPublisher(
	service: Pick<
		WorkerControlService,
		'emitApplicationMessage' | 'getAcceptedSession' | 'nextPeerSequence'
	>,
): WorkerControlRuntimeEventPublisher {
	async function emitWorkerControlEvent(options: {
		readonly operation:
			| 'worker_capacity_snapshot'
			| 'worker_runtime_observation'
			| 'worker_runtime_status';
		readonly payload: unknown;
	}): Promise<void> {
		const session = await service.getAcceptedSession();
		const deliveryPolicy = workerControlDeliveryPolicyByOperation[options.operation];
		const envelope = {
			bootId: session.bootId,
			connectionId: session.connectionId,
			controllerEpoch: session.controllerEpoch,
			createdAtMs: Date.now(),
			deliveryPolicy,
			domain: 'worker_control',
			kind: 'event',
			messageId: randomUUID(),
			operation: options.operation,
			peerId: session.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: service.nextPeerSequence({ deliveryPolicy }),
			sessionId: session.sessionId,
			zoneId: session.zoneId,
		} satisfies ControlEnvelope;
		await service.emitApplicationMessage(
			envelope,
			{ kind: 'event', operation: options.operation },
			{
				kind: 'event',
				operation: options.operation,
				payload: options.payload,
			},
		);
	}

	return {
		emitCapacitySnapshot: async (payload) => {
			await emitWorkerControlEvent({
				operation: 'worker_capacity_snapshot',
				payload,
			});
		},
		emitRuntimeObservation: async (payload) => {
			await emitWorkerControlEvent({
				operation: 'worker_runtime_observation',
				payload,
			});
		},
		emitRuntimeStatus: async (payload) => {
			await emitWorkerControlEvent({
				operation: 'worker_runtime_status',
				payload,
			});
		},
	};
}

export function createUnavailableWorkerControlControllerToolsClient(): WorkerControlControllerToolsClient {
	const unavailable = async (): Promise<never> => {
		throw new WorkerControlRpcCommandError('Worker control session is not configured.', false);
	};
	return {
		gitPullDefault: unavailable,
		gitPush: unavailable,
	};
}
