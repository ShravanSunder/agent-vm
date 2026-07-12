import type {
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import type {
	GatewayControlLeaseSnapshot,
	GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import { gatewayControlCommandExecutionTimeoutMsByOperation } from '@agent-vm/gateway-control-contracts';
import { isToolVmSshLease } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayControlCallerContextStore } from './gateway-control-caller-context-store.js';
import {
	buildGatewayControlCallerContextCacheKey,
	createGatewayControlLeaseClient,
} from './gateway-control-lease-client.js';
import {
	GatewayControlSessionUnavailableError,
	type GatewayControlIdentity,
	type GatewayControlService,
} from './gateway-control-service.js';

const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {
		main: 'test-main-agent-authority-key-with-enough-length',
	},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-epoch-a',
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
	const acceptedSession = {
		...identity,
		bootId: identity.processEpoch,
		attachmentGeneration: 1,
		connectionId: '55555555-5555-4555-8555-555555555555',
		gatewayEpoch: identity.generationId,
		processEpoch: identity.processEpoch,
		sessionId: '33333333-3333-4333-8333-333333333333',
	};
	return {
		close: vi.fn(async () => {}),
		emitApplicationMessage: vi.fn(async (intent) => {
			sequence += 1;
			return handleMessage({
				domainMessage: intent.domainMessage,
				envelope: intent.buildEnvelope({ acceptedSession, sequence }),
				payload: intent.payload,
			});
		}),
		getCurrentAcceptedSession: vi.fn(() => acceptedSession),
		waitForAcceptedSession: vi.fn(async () => acceptedSession),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => false),
		handleUpgrade: vi.fn(() => false),
	};
}

function gatewayControlLeaseSnapshot(
	leaseId: string,
	state: 'idle' | 'released' = 'idle',
): GatewayControlLeaseSnapshot {
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
		state,
		tcpSlot: 0,
		transport: 'ssh-sandbox',
		workdir: '/workspace',
		zoneId: 'zone-a',
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

	it('refuses a disconnected lease-request flood without waiting for session readiness', async () => {
		const connectedService = createFakeGatewayControlService(() => {
			throw new Error('disconnected lease producer must not emit');
		});
		const waitForAcceptedSession = vi.fn(async () => {
			throw new Error('disconnected lease producer must not await readiness');
		});
		const controlService = {
			...connectedService,
			getCurrentAcceptedSession: vi.fn(() => undefined),
			waitForAcceptedSession,
		} satisfies GatewayControlService;
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			identity,
			now: () => 1,
		});
		const floodCount = 512;
		let settledCount = 0;
		const errors: unknown[] = [];
		const submissions = Array.from({ length: floodCount }, () =>
			leaseClient
				.requestLease({
					agentId: 'main',
					agentWorkspaceDir: '/home/openclaw/workspace',
					idleTtlMs: 120_000,
					profileId: 'standard',
					sessionKey: 'agent:main:test-session',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
					zoneId: 'zone-a',
				})
				.then(
					() => {
						settledCount += 1;
					},
					(error: unknown) => {
						errors.push(error);
						settledCount += 1;
					},
				),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settledCount).toBe(floodCount);
		await Promise.all(submissions);
		expect(errors).toHaveLength(floodCount);
		expect(errors.every((error) => error instanceof GatewayControlSessionUnavailableError)).toBe(
			true,
		);
		expect(waitForAcceptedSession).not.toHaveBeenCalled();
		expect(controlService.emitApplicationMessage).not.toHaveBeenCalled();
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
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

	it('keeps lease reads bounded by the operation timeout', async () => {
		const observedEnvelopes: ControlEnvelope[] = [];
		const leaseId = '01890f00-0000-7000-8000-000000000001';
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedEnvelopes.push(envelope);
			if (payload.operation === 'caller_context_register') {
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation === 'lease_create' || payload.operation === 'lease_peek') {
				return {
					kind: 'command_result',
					operation: payload.operation,
					payload: {
						lease: gatewayControlLeaseSnapshot(leaseId),
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			throw new Error(`unexpected operation: ${payload.operation}`);
		});
		let nextId = 1;
		const leaseClient = createGatewayControlLeaseClient({
			controlService,
			createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
			identity,
			now: () => 2_000,
		});
		await leaseClient.requestLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			profileId: 'standard',
			sessionKey: 'agent:main:test-session',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		});

		await expect(leaseClient.peekLease(leaseId)).resolves.toEqual(
			expect.objectContaining({ leaseId }),
		);

		for (const operation of ['caller_context_register', 'lease_create', 'lease_peek'] as const) {
			const envelope = observedEnvelopes.find(
				(candidateEnvelope) => candidateEnvelope.operation === operation,
			);
			expect(envelope?.expiresAtMs).toBe(
				2_000 + gatewayControlCommandExecutionTimeoutMsByOperation[operation],
			);
		}
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
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
		let senderClockMs = 1_000;
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
			now: () => senderClockMs++,
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
		for (const envelope of leaseCreateEnvelopes) {
			expect(envelope.expiresAtMs).toBe(
				envelope.createdAtMs + gatewayControlCommandExecutionTimeoutMsByOperation.lease_create,
			);
		}
		expect(retriedLeaseCreateEnvelope.createdAtMs).toBeGreaterThan(
			firstLeaseCreateEnvelope.createdAtMs,
		);
	});

	it.each([
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) =>
				await leaseClient.reacquireLease(leaseId, {
					observedAtMs: 1,
					staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
				}),
			operation: 'lease_reacquire',
		},
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) => await leaseClient.renewLease(leaseId),
			operation: 'lease_renew',
		},
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) => await leaseClient.releaseLease(leaseId),
			operation: 'lease_release',
		},
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) =>
				await leaseClient.startActiveUse(leaseId, {
					useId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				}),
			operation: 'lease_use_start',
		},
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) =>
				await leaseClient.heartbeatActiveUse(leaseId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {}),
			operation: 'lease_use_heartbeat',
		},
		{
			invoke: async (
				leaseClient: ReturnType<typeof createGatewayControlLeaseClient>,
				leaseId: string,
			) =>
				await leaseClient.endActiveUse(leaseId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
					outcome: 'completed',
				}),
			operation: 'lease_use_end',
		},
	] as const)(
		'retries $operation once with the same semantic command identity after a lost result',
		async ({ invoke, operation }) => {
			const observedEnvelopes: ControlEnvelope[] = [];
			const leaseId = '01890f00-0000-7000-8000-000000000001';
			const replacementLeaseId = '01890f00-0000-7000-8000-000000000002';
			let targetAttempts = 0;
			const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
				observedEnvelopes.push(envelope);
				if (payload.operation === 'caller_context_register') {
					return {
						kind: 'command_result',
						operation: 'caller_context_register',
						payload: {
							callerContext: {
								admissionPrincipal:
									'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
							lease: gatewayControlLeaseSnapshot(leaseId),
							responseToMessageId: envelope.messageId,
							result: 'ok',
						},
					};
				}
				expect(payload.operation).toBe(operation);
				targetAttempts += 1;
				if (targetAttempts === 1) {
					throw new Error(`simulated lost ${operation} result`);
				}
				switch (operation) {
					case 'lease_reacquire':
					case 'lease_renew':
					case 'lease_release':
						return {
							kind: 'command_result',
							operation,
							payload: {
								lease: gatewayControlLeaseSnapshot(
									operation === 'lease_reacquire' ? replacementLeaseId : leaseId,
									operation === 'lease_release' ? 'released' : 'idle',
								),
								responseToMessageId: envelope.messageId,
								result: 'ok',
							},
						};
					case 'lease_use_start':
					case 'lease_use_heartbeat':
						return {
							kind: 'command_result',
							operation,
							payload: {
								leaseUse: {
									expiresAt: 60_000,
									heartbeatAfterMs: 5_000,
									leaseId,
									state: 'active',
									useId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
								},
								responseToMessageId: envelope.messageId,
								result: 'ok',
							},
						};
					case 'lease_use_end':
						return {
							kind: 'command_result',
							operation,
							payload: {
								leaseUse: {
									leaseId,
									state: 'ended',
									useId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
								},
								responseToMessageId: envelope.messageId,
								result: 'ok',
							},
						};
				}
				throw new Error('unsupported retry test operation');
			});
			let nextId = 1;
			let senderClockMs = 1_000;
			const leaseClient = createGatewayControlLeaseClient({
				controlService,
				createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
				identity,
				now: () => senderClockMs++,
			});
			await leaseClient.requestLease({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				sessionKey: 'agent:main:test-session',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				zoneId: 'zone-a',
			});

			await invoke(leaseClient, leaseId);

			const targetEnvelopes = observedEnvelopes.filter(
				(envelope) => envelope.operation === operation,
			);
			expect(targetEnvelopes).toHaveLength(2);
			expect(targetEnvelopes[1]?.commandId).toBe(targetEnvelopes[0]?.commandId);
			expect(targetEnvelopes[1]?.idempotencyKey).toBe(targetEnvelopes[0]?.idempotencyKey);
			expect(targetEnvelopes[1]?.messageId).toBe(targetEnvelopes[0]?.messageId);
			expect(targetEnvelopes[1]?.sequence).toBe((targetEnvelopes[0]?.sequence ?? 0) + 1);
			for (const envelope of targetEnvelopes) {
				expect(envelope.expiresAtMs).toBe(
					envelope.createdAtMs + gatewayControlCommandExecutionTimeoutMsByOperation[operation],
				);
			}
			expect(targetEnvelopes[1]?.createdAtMs).toBeGreaterThan(targetEnvelopes[0]?.createdAtMs ?? 0);
		},
	);

	it.each(['lease_create', 'lease_reacquire', 'lease_release', 'lease_renew'] as const)(
		'refreshes S2 caller authority for $operation without replacing uncertain identity A',
		async (operation) => {
			const leaseId = '01890f00-0000-7000-8000-000000000001';
			const replacementLeaseId = '01890f00-0000-7000-8000-000000000002';
			const sessionOne = {
				...identity,
				attachmentGeneration: 1,
				bootId: identity.processEpoch,
				connectionId: '11111111-1111-4111-8111-111111111111',
				gatewayEpoch: identity.generationId,
				processEpoch: identity.processEpoch,
				sessionId: '22222222-2222-4222-8222-222222222222',
			};
			const sessionTwo = {
				...sessionOne,
				attachmentGeneration: 2,
				connectionId: '33333333-3333-4333-8333-333333333333',
				sessionId: '44444444-4444-4444-8444-444444444444',
			};
			let acceptedSession = sessionOne;
			const sequenceBySessionId = new Map<string, number>();
			const observedOperations: string[] = [];
			const observedMutationAttempts: Array<{
				readonly admissionPrincipal: string | undefined;
				readonly callerContextId: string;
				readonly envelope: ControlEnvelope;
			}> = [];
			const controlService = {
				close: vi.fn(async () => {}),
				emitApplicationMessage: vi.fn(async (intent, admissionOptions) => {
					const sequence = (sequenceBySessionId.get(acceptedSession.sessionId) ?? 0) + 1;
					sequenceBySessionId.set(acceptedSession.sessionId, sequence);
					const envelope = intent.buildEnvelope({ acceptedSession, sequence });
					const payload = intent.payload;
					observedOperations.push(payload.operation ?? payload.kind);
					if (payload.operation === 'caller_context_register') {
						const callerContextId =
							acceptedSession.sessionId === sessionOne.sessionId
								? '55555555-5555-4555-8555-555555555555'
								: '66666666-6666-4666-8666-666666666666';
						const admissionPrincipal =
							acceptedSession.sessionId === sessionOne.sessionId
								? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
								: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
						return {
							kind: 'command_result',
							operation: 'caller_context_register',
							payload: {
								callerContext: { admissionPrincipal, callerContextId },
								responseToMessageId: envelope.messageId,
								result: 'ok',
							},
						};
					}
					const lease = {
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
						state: 'idle' as const,
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',
						zoneId: 'zone-a',
					};
					if (payload.operation === 'lease_create' && operation !== 'lease_create') {
						return {
							kind: 'command_result',
							operation: 'lease_create',
							payload: { lease, responseToMessageId: envelope.messageId, result: 'ok' },
						};
					}
					expect(payload.operation).toBe(operation);
					const callerContextId = payload.payload.callerContext.callerContextId;
					observedMutationAttempts.push({
						admissionPrincipal: admissionOptions?.admissionPrincipal,
						callerContextId,
						envelope,
					});
					if (observedMutationAttempts.length === 1) {
						acceptedSession = sessionTwo;
						throw new Error('S1 result lost while the mutation outcome is uncertain');
					}
					if (callerContextId !== '66666666-6666-4666-8666-666666666666') {
						return {
							kind: 'command_result',
							operation,
							payload: {
								leaseRejectionReason: 'caller_context_session_mismatch',
								responseToMessageId: envelope.messageId,
								result: 'rejected',
							},
						};
					}
					switch (operation) {
						case 'lease_create':
						case 'lease_renew':
							return {
								kind: 'command_result',
								operation,
								payload: { lease, responseToMessageId: envelope.messageId, result: 'ok' },
							};
						case 'lease_reacquire':
							return {
								kind: 'command_result',
								operation,
								payload: {
									lease: { ...lease, leaseId: replacementLeaseId },
									responseToMessageId: envelope.messageId,
									result: 'ok',
								},
							};
						case 'lease_release':
							return {
								kind: 'command_result',
								operation,
								payload: {
									lease: { ...lease, state: 'released' },
									responseToMessageId: envelope.messageId,
									result: 'ok',
								},
							};
					}
					throw new Error('unsupported S1 to S2 retry test operation');
				}),
				getCurrentAcceptedSession: vi.fn(() => acceptedSession),
				waitForAcceptedSession: vi.fn(async () => acceptedSession),
				getCredentialState: vi.fn(() => undefined),
				handleReadyRequest: vi.fn(() => false),
				handleUpgrade: vi.fn(() => false),
			} satisfies GatewayControlService;
			let nextId = 1;
			const leaseClient = createGatewayControlLeaseClient({
				controlService,
				createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
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
			if (operation !== 'lease_create') {
				await leaseClient.requestLease(request);
			}
			switch (operation) {
				case 'lease_create':
					await leaseClient.requestLease(request);
					break;
				case 'lease_reacquire':
					await leaseClient.reacquireLease(leaseId, {
						observedAtMs: 1,
						staleEvidence: { kind: 'tool-vm-ssh', operation: 'command' },
					});
					break;
				case 'lease_release':
					await leaseClient.releaseLease(leaseId);
					break;
				case 'lease_renew':
					await leaseClient.renewLease(leaseId);
					break;
			}

			expect(observedOperations).toEqual(
				operation === 'lease_create'
					? ['caller_context_register', operation, 'caller_context_register', operation]
					: [
							'caller_context_register',
							'lease_create',
							operation,
							'caller_context_register',
							operation,
						],
			);
			expect(observedMutationAttempts).toHaveLength(2);
			const [uncertainAttempt, retriedAttempt] = observedMutationAttempts;
			expect(uncertainAttempt?.callerContextId).toBe('55555555-5555-4555-8555-555555555555');
			expect(retriedAttempt?.callerContextId).toBe('66666666-6666-4666-8666-666666666666');
			expect(retriedAttempt?.admissionPrincipal).toBe(
				'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			);
			expect(retriedAttempt?.envelope.sessionId).toBe(sessionTwo.sessionId);
			expect(retriedAttempt?.envelope.connectionId).toBe(sessionTwo.connectionId);
			expect(retriedAttempt?.envelope.commandId).toBe(uncertainAttempt?.envelope.commandId);
			expect(retriedAttempt?.envelope.idempotencyKey).toBe(
				uncertainAttempt?.envelope.idempotencyKey,
			);
			expect(retriedAttempt?.envelope.messageId).toBe(uncertainAttempt?.envelope.messageId);
		},
	);

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
						callerContext: {
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							callerContextId,
						},
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
						leaseRejectionReason: 'caller_context_absent',
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
			'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
		const observedEnvelopes: ControlEnvelope[] = [];
		const observedMessages: GatewayControlRpcMessage[] = [];
		let registeredContextIndex = 0;
		let renewCount = 0;
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
						callerContext: {
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							callerContextId,
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
						leaseRejectionReason: 'caller_context_absent',
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
			'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
		await expect(leaseClient.renewLease('01890f00-0000-7000-8000-000000000001')).resolves.toEqual(
			expect.objectContaining({ leaseId: '01890f00-0000-7000-8000-000000000001' }),
		);

		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_renew',
			'caller_context_register',
			'lease_renew',
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
		const renewalEnvelopes = observedEnvelopes.filter(
			(envelope) => envelope.operation === 'lease_renew',
		);
		expect(renewalEnvelopes).toHaveLength(3);
		expect(renewalEnvelopes[1]?.commandId).not.toBe(renewalEnvelopes[0]?.commandId);
		expect(renewalEnvelopes[1]?.idempotencyKey).not.toBe(renewalEnvelopes[0]?.idempotencyKey);
		expect(renewalEnvelopes[2]?.commandId).not.toBe(renewalEnvelopes[1]?.commandId);
		expect(renewalEnvelopes[2]?.idempotencyKey).not.toBe(renewalEnvelopes[1]?.idempotencyKey);
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
						callerContext: {
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							callerContextId,
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
					leaseRejectionReason: 'caller_context_absent',
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
			'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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

		await expect(
			leaseClient.renewLease('01890f00-0000-7000-8000-000000000001'),
		).rejects.toMatchObject({
			leaseRejectionReason: 'lease_authority_absent',
			status: 410,
		});
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'lease_create',
			'lease_renew',
			'caller_context_register',
			'lease_renew',
		]);
	});
});
