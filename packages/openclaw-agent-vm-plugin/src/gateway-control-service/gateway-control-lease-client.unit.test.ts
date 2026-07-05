import type {
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import type { GatewayControlRpcMessage } from '@agent-vm/gateway-control-contracts';
import { isToolVmSshLease } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayControlCallerContextStore } from './gateway-control-caller-context-store.js';
import {
	buildGatewayControlCallerContextCacheKey,
	createGatewayControlLeaseClient,
} from './gateway-control-lease-client.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

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

describe('createGatewayControlLeaseClient', () => {
	it('does not retain raw session keys in caller context cache keys', () => {
		const cacheKey = buildGatewayControlCallerContextCacheKey({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		});

		expect(cacheKey).not.toContain('agent:main:test-session');
		expect(cacheKey).not.toContain('standard');
		expect(cacheKey).toContain('sessionKeyDigest');
	});

	it('registers caller context and requests a lease over gateway_control without raw authority in lease_create', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
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
			expect(payload.operation).toBe('lease_create');
			expect(payload.payload).toEqual({
				callerContext: {
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				idleTtlHintMs: 120_000,
			});
			return {
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					lease: {
						agentId: 'main',
						expiresAtMs: 120_000,
						idleTtlMs: 120_000,
						leaseId: '01890f00-0000-7000-8000-000000000001',
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
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
					'44444444-4444-4444-8444-444444444444',
					'55555555-5555-4555-8555-555555555555',
					'66666666-6666-4666-8666-666666666666',
					'77777777-7777-4777-8777-777777777777',
					'88888888-8888-4888-8888-888888888888',
				];
				let index = 0;
				return () => {
					const id = ids[index];
					if (id === undefined) {
						throw new Error('test id exhausted');
					}
					index += 1;
					return id;
				};
			})(),
			identity,
			now: () => 1,
		});

		const lease = await leaseClient.requestLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			idleTtlMs: 120_000,
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		});

		expect(isToolVmSshLease(lease)).toBe(true);
		expect(lease.ssh.knownHostsLine).toBe('tool-0.vm.host ssh-ed25519 AAAA');
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
		]);
		expect(observedMessages[0]?.payload).toEqual({
			adapterEvidence: expect.objectContaining({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				proof: expect.objectContaining({
					algorithm: 'hmac-sha256',
				}),
				sessionKey: 'agent:main:test-session',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			}),
		});
		expect(observedMessages[1]?.payload).not.toHaveProperty('agentId');
		expect(observedMessages[1]?.payload).not.toHaveProperty('profileId');
		expect(observedMessages[1]?.payload).not.toHaveProperty('sessionKey');
		expect(observedMessages[1]?.payload).not.toHaveProperty('workMountDir');
	});

	it('retries lease_create once with stable command and message identity after a lost result', async () => {
		const observedEnvelopes: ControlEnvelope[] = [];
		let leaseCreateAttempts = 0;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedEnvelopes.push(envelope);
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
			expect(payload.operation).toBe('lease_create');
			leaseCreateAttempts += 1;
			if (leaseCreateAttempts === 1) {
				throw new Error('simulated lost lease_create result');
			}
			return {
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					lease: {
						agentId: 'main',
						expiresAtMs: 120_000,
						idleTtlMs: 120_000,
						leaseId: '01890f00-0000-7000-8000-000000000001',
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
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
					'44444444-4444-4444-8444-444444444444',
				];
				let index = 0;
				return () => {
					const id = ids[index];
					if (id === undefined) {
						throw new Error('test id exhausted');
					}
					index += 1;
					return id;
				};
			})(),
			identity,
			now: () => 1,
		});

		await expect(
			leaseClient.requestLease({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				sessionKey: 'agent:main:test-session',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			}),
		).resolves.toEqual(
			expect.objectContaining({ leaseId: '01890f00-0000-7000-8000-000000000001' }),
		);

		const leaseCreateEnvelopes = observedEnvelopes.filter(
			(envelope) => envelope.operation === 'lease_create',
		);
		expect(leaseCreateEnvelopes).toHaveLength(2);
		const firstLeaseCreateEnvelope = leaseCreateEnvelopes[0];
		const retriedLeaseCreateEnvelope = leaseCreateEnvelopes[1];
		if (firstLeaseCreateEnvelope === undefined || retriedLeaseCreateEnvelope === undefined) {
			throw new Error('expected two lease_create envelopes');
		}
		expect(retriedLeaseCreateEnvelope.commandId).toBe(firstLeaseCreateEnvelope.commandId);
		expect(retriedLeaseCreateEnvelope.idempotencyKey).toBe(firstLeaseCreateEnvelope.idempotencyKey);
		expect(retriedLeaseCreateEnvelope.messageId).toBe(firstLeaseCreateEnvelope.messageId);
		expect(retriedLeaseCreateEnvelope.sequence).toBe(firstLeaseCreateEnvelope.sequence + 1);
	});

	it('re-registers a cached caller context once when the controller reports it absent', async () => {
		const observedEnvelopes: ControlEnvelope[] = [];
		const observedMessages: GatewayControlRpcMessage[] = [];
		let registeredContextIndex = 0;
		let leaseCreateCount = 0;
		const contextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
		] as const;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedEnvelopes.push(envelope);
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
			expect(payload.operation).toBe('lease_create');
			leaseCreateCount += 1;
			if (leaseCreateCount === 2) {
				return {
					kind: 'command_result',
					operation: 'lease_create',
					payload: {
						leaseRejectionReason: 'absent',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			}
			return {
				kind: 'command_result',
				operation: 'lease_create',
				payload: {
					lease: {
						agentId: 'main',
						expiresAtMs: 120_000,
						idleTtlMs: 120_000,
						leaseId: `01890f00-0000-7000-8000-00000000000${String(leaseCreateCount)}`,
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
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const ids = [
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
		];
		let idIndex = 0;
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			createId: () => {
				const id = ids[idIndex];
				if (id === undefined) {
					throw new Error('test id exhausted');
				}
				idIndex += 1;
				return id;
			},
			identity,
			now: () => 1,
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		};

		await expect(leaseClient.requestLease(request)).resolves.toEqual(
			expect.objectContaining({ leaseId: expect.any(String) }),
		);
		await expect(leaseClient.requestLease(request)).resolves.toEqual(
			expect.objectContaining({ leaseId: expect.any(String) }),
		);

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_create',
			'caller_context_register',
			'lease_create',
		]);
		const staleLeaseCreatePayload = observedMessages[2]?.payload;
		const refreshedLeaseCreatePayload = observedMessages[4]?.payload;
		if (staleLeaseCreatePayload === undefined || refreshedLeaseCreatePayload === undefined) {
			throw new Error('expected stale and refreshed lease_create payloads');
		}
		expect(
			(staleLeaseCreatePayload as { callerContext?: { callerContextId?: string } }).callerContext
				?.callerContextId,
		).toBe('44444444-4444-4444-8444-444444444444');
		expect(
			(refreshedLeaseCreatePayload as { callerContext?: { callerContextId?: string } })
				.callerContext?.callerContextId,
		).toBe('99999999-9999-4999-8999-999999999999');
		const leaseCreateEnvelopes = observedEnvelopes.filter(
			(envelope) => envelope.operation === 'lease_create',
		);
		expect(leaseCreateEnvelopes).toHaveLength(3);
		expect(leaseCreateEnvelopes[2]?.commandId).not.toBe(leaseCreateEnvelopes[1]?.commandId);
		expect(leaseCreateEnvelopes[2]?.idempotencyKey).not.toBe(
			leaseCreateEnvelopes[1]?.idempotencyKey,
		);
		expect(leaseCreateEnvelopes[2]?.messageId).not.toBe(leaseCreateEnvelopes[1]?.messageId);
	});

	it('re-registers caller context for active lease operations when the controller reports it absent', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		let registeredContextIndex = 0;
		let renewCount = 0;
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
						lease: {
							agentId: 'main',
							expiresAtMs: 120_000,
							idleTtlMs: 120_000,
							leaseId: '01890f00-0000-7000-8000-000000000001',
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
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('lease_renew');
			renewCount += 1;
			if (renewCount === 1) {
				return {
					kind: 'command_result',
					operation: 'lease_renew',
					payload: {
						leaseRejectionReason: 'absent',
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			}
			return {
				kind: 'command_result',
				operation: 'lease_renew',
				payload: {
					lease: {
						agentId: 'main',
						expiresAtMs: 120_000,
						idleTtlMs: 120_000,
						leaseId: '01890f00-0000-7000-8000-000000000001',
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
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const ids = [
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
		];
		let idIndex = 0;
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			createId: () => {
				const id = ids[idIndex];
				if (id === undefined) {
					throw new Error('test id exhausted');
				}
				idIndex += 1;
				return id;
			},
			identity,
			now: () => 1,
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		};

		await leaseClient.requestLease(request);
		await expect(leaseClient.renewLease('01890f00-0000-7000-8000-000000000001')).resolves.toEqual(
			expect.objectContaining({ leaseId: '01890f00-0000-7000-8000-000000000001' }),
		);

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_renew',
			'caller_context_register',
			'lease_renew',
		]);
		expect(observedMessages[2]?.payload).toEqual({
			callerContext: {
				callerContextId: '44444444-4444-4444-8444-444444444444',
			},
			leaseId: '01890f00-0000-7000-8000-000000000001',
		});
		expect(observedMessages[4]?.payload).toEqual({
			callerContext: {
				callerContextId: '99999999-9999-4999-8999-999999999999',
			},
			leaseId: '01890f00-0000-7000-8000-000000000001',
		});
	});

	it('evicts refreshed caller context when an active lease operation is still absent', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
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
						lease: {
							agentId: 'main',
							expiresAtMs: 120_000,
							idleTtlMs: 120_000,
							leaseId: '01890f00-0000-7000-8000-000000000001',
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
						},
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
					leaseRejectionReason: 'absent',
					responseToMessageId: envelope.messageId,
					result: 'rejected',
				},
			};
		});
		const ids = [
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
		];
		let idIndex = 0;
		const leaseClient = createGatewayControlLeaseClient({
			callerContextStore,
			controlService,
			createId: () => {
				const id = ids[idIndex];
				if (id === undefined) {
					throw new Error('test id exhausted');
				}
				idIndex += 1;
				return id;
			},
			identity,
			now: () => 1,
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		};
		const callerContextScope = {
			agentId: request.agentId,
			agentWorkspaceDir: request.agentWorkspaceDir,
			purpose: 'tool_vm_lease',
			sessionKey: request.sessionKey,
			workMountDir: request.workMountDir,
			zoneId: request.zoneId,
		} as const;

		await leaseClient.requestLease(request);
		await expect(
			leaseClient.renewLease('01890f00-0000-7000-8000-000000000001'),
		).rejects.toMatchObject({ status: 404 });

		expect(callerContextStore.resolveCallerContextIdForAgent(callerContextScope)).toBeUndefined();
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_renew',
			'caller_context_register',
			'lease_renew',
		]);

		await expect(leaseClient.renewLease('01890f00-0000-7000-8000-000000000001')).rejects.toThrow(
			'has no registered caller context',
		);
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_renew',
			'caller_context_register',
			'lease_renew',
		]);
	});
});
