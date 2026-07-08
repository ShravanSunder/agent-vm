import type {
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import type {
	GatewayControlLeaseSnapshot,
	GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayControlLeaseClient,
	type GatewayControlLeaseClientOptions,
} from './gateway-control-lease-client.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

type GatewayControlCommandMessage = Extract<GatewayControlRpcMessage, { readonly kind: 'command' }>;
type LeaseReacquireCommandMessage = Extract<
	GatewayControlCommandMessage,
	{ readonly operation: 'lease_reacquire' }
>;

const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {
		main: 'test-main-agent-authority-key-with-enough-length',
	},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	zoneId: 'zone-a',
} satisfies GatewayControlIdentity;

const leaseRequest = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	profileId: 'standard',
	sessionKey: 'agent:main:test-session',
	workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
	zoneId: 'zone-a',
} as const;

function createIdSequence(ids: readonly string[]): () => string {
	let index = 0;
	return () => {
		const id = ids[index];
		if (id === undefined) {
			throw new Error('test id exhausted');
		}
		index += 1;
		return id;
	};
}

function createDefaultIds(): readonly string[] {
	return [
		'11111111-1111-4111-8111-111111111111',
		'22222222-2222-4222-8222-222222222222',
		'33333333-3333-4333-8333-333333333333',
		'44444444-4444-4444-8444-444444444444',
		'55555555-5555-4555-8555-555555555555',
		'66666666-6666-4666-8666-666666666666',
		'77777777-7777-4777-8777-777777777777',
		'88888888-8888-4888-8888-888888888888',
		'99999999-9999-4999-8999-999999999999',
		'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
		'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
		'ffffffff-ffff-4fff-8fff-ffffffffffff',
	];
}

function createLeaseSnapshot(leaseId: string): GatewayControlLeaseSnapshot {
	return {
		agentId: 'main',
		expiresAtMs: 120_000,
		idleTtlMs: 120_000,
		leaseId,
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'pem',
			knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
			port: 22,
			user: 'sandbox',
		},
		state: 'idle',
		tcpSlot: 0,
		transport: 'ssh-sandbox',
		workdir: '/workspace',
		zoneId: 'zone-a',
	};
}

function createFakeGatewayControlService(
	handleMessage: (params: {
		readonly envelope: ControlEnvelope;
		readonly domainMessage: DomainControlMessageIdentity;
		readonly payload: GatewayControlRpcMessage;
	}) => GatewayControlRpcMessage,
): GatewayControlService {
	let sequence = 0;
	return {
		close: vi.fn(async () => {}),
		emitApplicationMessage: vi.fn(async (envelope, domainMessage, payload) =>
			handleMessage({
				envelope,
				domainMessage,
				payload: payload as GatewayControlRpcMessage,
			}),
		),
		getAcceptedSession: vi.fn(async () => ({
			...identity,
			connectionId: '55555555-5555-4555-8555-555555555555',
			sessionId: '33333333-3333-4333-8333-333333333333',
		})),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => false),
		handleUpgrade: vi.fn(() => false),
		nextPeerSequence: vi.fn(() => {
			sequence += 1;
			return sequence;
		}),
	};
}

function createLeaseClient(
	controlService: GatewayControlService,
	options: Partial<GatewayControlLeaseClientOptions> = {},
): ReturnType<typeof createGatewayControlLeaseClient> {
	return createGatewayControlLeaseClient({
		controlService,
		createId: createIdSequence(createDefaultIds()),
		identity,
		now: () => 1,
		...options,
	});
}

function isLeaseReacquireCommand(
	message: GatewayControlRpcMessage,
): message is LeaseReacquireCommandMessage {
	return message.kind === 'command' && message.operation === 'lease_reacquire';
}

describe('gateway control lease client recovery behavior', () => {
	it('treats cleanup release and active-use end for forgotten leases as idempotent', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const controlService = createFakeGatewayControlService(({ payload }) => {
			observedMessages.push(payload);
			throw new Error(`unexpected gateway-control command ${payload.operation}`);
		});
		const leaseClient = createLeaseClient(controlService);

		await expect(
			leaseClient.releaseLease('01890f00-0000-7000-8000-000000000001'),
		).resolves.toBeUndefined();
		await expect(
			leaseClient.endActiveUse('01890f00-0000-7000-8000-000000000001', 'use-a', {
				outcome: 'failed',
			}),
		).resolves.toBeUndefined();

		expect(observedMessages).toEqual([]);
	});

	it.each([
		{ reason: 'lease_authority_absent', status: 404 },
		{ reason: 'ownership_denied', status: 400 },
	] as const)(
		'does not refresh caller context or trust plugin fields after $reason reacquire rejection',
		async ({ reason, status }) => {
			const observedMessages: GatewayControlRpcMessage[] = [];
			const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
			const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
				observedMessages.push(payload);
				if (payload.operation === 'caller_context_register') {
					return {
						kind: 'command_result',
						operation: 'caller_context_register',
						payload: {
							callerContext: {
								callerContextId: '44444444-4444-4444-8444-444444444444',
							},
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					};
				}
				if (payload.operation === 'lease_create') {
					return {
						kind: 'command_result',
						operation: 'lease_create',
						payload: {
							lease: createLeaseSnapshot(oldLeaseId),
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					};
				}
				expect(payload.operation).toBe('lease_reacquire');
				return {
					kind: 'command_result',
					operation: 'lease_reacquire',
					payload: {
						leaseRejectionReason: reason,
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			});
			const leaseClient = createLeaseClient(controlService);

			await leaseClient.requestLease(leaseRequest);
			await expect(
				leaseClient.reacquireLease(oldLeaseId, {
					observedAtMs: 42,
					staleEvidence: {
						kind: 'caller-context',
						reason: reason === 'lease_authority_absent' ? 'lease_authority_absent' : 'stale',
					},
				}),
			).rejects.toMatchObject({
				leaseRejectionReason: reason,
				responseBody: expect.objectContaining({ leaseRejectionReason: reason }),
				status,
			});

			expect(observedMessages.map((message) => message.operation)).toEqual([
				'caller_context_register',
				'lease_create',
				'lease_reacquire',
			]);
			const reacquireMessage = observedMessages.find(isLeaseReacquireCommand);
			if (reacquireMessage === undefined) {
				throw new Error('expected lease_reacquire command');
			}
			expect(reacquireMessage.payload).toEqual({
				callerContext: {
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				oldLeaseId,
				staleEvidence: {
					kind: 'caller-context',
					observedAtMs: 42,
					reason: reason === 'lease_authority_absent' ? 'lease_authority_absent' : 'stale',
				},
			});
			expect(reacquireMessage.payload).not.toHaveProperty('agentId');
			expect(reacquireMessage.payload).not.toHaveProperty('profileId');
			expect(reacquireMessage.payload).not.toHaveProperty('sessionKey');
			expect(reacquireMessage.payload).not.toHaveProperty('workMountDir');
		},
	);

	it('refreshes caller context after session-mismatch reacquire rejection', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const newLeaseId = '01890f00-0000-7000-8000-000000000002';
		let registeredContextIndex = 0;
		let reacquireAttempts = 0;
		const contextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
		] as const;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				const callerContextId = contextIds[registeredContextIndex];
				if (callerContextId === undefined) {
					throw new Error('caller context id exhausted');
				}
				registeredContextIndex += 1;
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: { callerContextId },
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_reacquire');
			reacquireAttempts += 1;
			if (reacquireAttempts === 1) {
				return {
					kind: 'command_result',
					operation: 'lease_reacquire',
					payload: {
						leaseRejectionReason: 'caller_context_session_mismatch',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			}
			return {
				kind: 'command_result',
				operation: 'lease_reacquire',
				payload: {
					lease: createLeaseSnapshot(newLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'caller-context', reason: 'session_mismatch' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_reacquire',
			'caller_context_register',
			'lease_reacquire',
		]);
		expect(
			observedMessages.filter(isLeaseReacquireCommand).map((message) => message.payload),
		).toEqual([
			expect.objectContaining({
				callerContext: { callerContextId: '44444444-4444-4444-8444-444444444444' },
				oldLeaseId,
			}),
			expect.objectContaining({
				callerContext: { callerContextId: '99999999-9999-4999-8999-999999999999' },
				oldLeaseId,
			}),
		]);
	});

	it('remembers replacement lease caller context after successful reacquire', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const newLeaseId = '01890f00-0000-7000-8000-000000000002';
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_reacquire') {
				return {
					kind: 'command_result',
					operation: 'lease_reacquire',
					payload: {
						lease: createLeaseSnapshot(newLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_renew');
			return {
				kind: 'command_result',
				operation: 'lease_renew',
				payload: {
					lease: createLeaseSnapshot(newLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'file-bridge' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));
		await expect(leaseClient.renewLease(newLeaseId)).resolves.toEqual(
			expect.objectContaining({ leaseId: newLeaseId }),
		);

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_reacquire',
			'lease_renew',
		]);
		expect(observedMessages[3]?.payload).toEqual({
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			leaseId: newLeaseId,
		});
	});

	it('re-registers caller context for stale reacquire after force release tombstones the old lease map', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const newLeaseId = '01890f00-0000-7000-8000-000000000002';
		let registeredContextIndex = 0;
		const contextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
		] as const;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				const callerContextId = contextIds[registeredContextIndex];
				if (callerContextId === undefined) {
					throw new Error('caller context id exhausted');
				}
				registeredContextIndex += 1;
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: { callerContextId },
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_release') {
				return {
					kind: 'command_result',
					operation: 'lease_release',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_reacquire');
			return {
				kind: 'command_result',
				operation: 'lease_reacquire',
				payload: {
					lease: createLeaseSnapshot(newLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await leaseClient.releaseLease(oldLeaseId, {
			force: true,
			observedAtMs: 42,
			staleEvidence: { kind: 'tool-vm-ssh', operation: 'finalize' },
		});
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'finalize' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_release',
			'caller_context_register',
			'lease_reacquire',
		]);
		const reacquireMessage = observedMessages.find(isLeaseReacquireCommand);
		if (reacquireMessage === undefined) {
			throw new Error('expected lease_reacquire command');
		}
		expect(reacquireMessage.payload).toEqual({
			callerContext: {
				callerContextId: '99999999-9999-4999-8999-999999999999',
			},
			oldLeaseId,
			staleEvidence: {
				kind: 'tool-vm-ssh',
				observedAtMs: 42,
				operation: 'finalize',
			},
		});
	});

	it('does not retain a stale-reacquire hint for explicit force release without stale evidence', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_release');
			return {
				kind: 'command_result',
				operation: 'lease_release',
				payload: {
					lease: createLeaseSnapshot(oldLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await leaseClient.releaseLease(oldLeaseId, { force: true });

		expect(leaseClient.getRetiredLeaseReacquireRequest?.(oldLeaseId)).toBeUndefined();
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'finalize' },
			}),
		).rejects.toMatchObject({ status: 409 });
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_release',
		]);
	});

	it('retains the reacquire hint when force-release cleanup is rejected as caller-context absent', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const newLeaseId = '01890f00-0000-7000-8000-000000000002';
		let registeredContextIndex = 0;
		const contextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		] as const;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				const callerContextId = contextIds[registeredContextIndex];
				if (callerContextId === undefined) {
					throw new Error('caller context id exhausted');
				}
				registeredContextIndex += 1;
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: { callerContextId },
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_release') {
				return {
					kind: 'command_result',
					operation: 'lease_release',
					payload: {
						leaseRejectionReason: 'caller_context_absent',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			}
			expect(payload.operation).toBe('lease_reacquire');
			return {
				kind: 'command_result',
				operation: 'lease_reacquire',
				payload: {
					lease: createLeaseSnapshot(newLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await expect(
			leaseClient.releaseLease(oldLeaseId, {
				force: true,
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'file-bridge' },
			}),
		).resolves.toBeUndefined();
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'file-bridge' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));

		expect(observedMessages.map((message) => message.operation)).toContain('lease_reacquire');
		expect(
			observedMessages.some(
				(message) =>
					isLeaseReacquireCommand(message) &&
					message.payload.oldLeaseId === oldLeaseId &&
					message.payload.callerContext.callerContextId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			),
		).toBe(true);
	});

	it('keeps old-lease reacquire tombstones after the first successful replacement for sibling handles', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		const newLeaseId = '01890f00-0000-7000-8000-000000000002';
		let registeredContextIndex = 0;
		const contextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		] as const;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				const callerContextId = contextIds[registeredContextIndex];
				if (callerContextId === undefined) {
					throw new Error('caller context id exhausted');
				}
				registeredContextIndex += 1;
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: { callerContextId },
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_release') {
				return {
					kind: 'command_result',
					operation: 'lease_release',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_reacquire');
			return {
				kind: 'command_result',
				operation: 'lease_reacquire',
				payload: {
					lease: createLeaseSnapshot(newLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService);

		await leaseClient.requestLease(leaseRequest);
		await leaseClient.releaseLease(oldLeaseId, {
			force: true,
			observedAtMs: 42,
			staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
		});
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 42,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));

		expect(leaseClient.getRetiredLeaseReacquireRequest?.(oldLeaseId)).toEqual({
			observedAtMs: 42,
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'command',
			},
		});
		await expect(
			leaseClient.reacquireLease(oldLeaseId, {
				observedAtMs: 99,
				staleEvidence: { kind: 'tool-vm-ssh', operation: 'file-bridge' },
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: newLeaseId }));

		expect(observedMessages.filter(isLeaseReacquireCommand)).toHaveLength(2);
	});

	it('expires retained retired-lease reacquire hints with injected time', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const oldLeaseId = '01890f00-0000-7000-8000-000000000001';
		let nowMs = 1_000;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			if (payload.operation === 'caller_context_register') {
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create') {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						lease: createLeaseSnapshot(oldLeaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_release');
			return {
				kind: 'command_result',
				operation: 'lease_release',
				payload: {
					lease: createLeaseSnapshot(oldLeaseId),
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createLeaseClient(controlService, {
			now: () => nowMs,
			retiredLeaseReacquireRequestTtlMs: 50,
		});

		await leaseClient.requestLease(leaseRequest);
		nowMs = 2_000;
		await leaseClient.releaseLease(oldLeaseId, {
			force: true,
			observedAtMs: 2_000,
			staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
		});

		expect(typeof leaseClient.getRetiredLeaseReacquireRequest).toBe('function');
		expect(leaseClient.getRetiredLeaseReacquireRequest?.(oldLeaseId)).toEqual({
			observedAtMs: 2_000,
			staleEvidence: {
				kind: 'tool-vm-ssh',
				operation: 'command',
			},
		});
		nowMs = 2_049;
		expect(leaseClient.getRetiredLeaseReacquireRequest?.(oldLeaseId)).toBeDefined();
		nowMs = 2_050;
		expect(leaseClient.getRetiredLeaseReacquireRequest?.(oldLeaseId)).toBeUndefined();
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_release',
		]);
	});
});
