import { PortalCallResultSchema, PortalListResultSchema } from '@agent-vm/agent-portal-sdk';
import type {
	ControlEnvelope,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import type { GatewayControlRpcMessage } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayControlCallerContextStore } from './gateway-control-caller-context-store.js';
import { createGatewayControlControllerHostActionBackend } from './gateway-control-controller-host-action-backend.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {
		'agent-a': 'test-agent-a-authority-key-with-enough-length',
	},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	zoneId: 'zone-a',
} satisfies GatewayControlIdentity;

const projection = {
	agentId: 'agent-a',
	namespaces: {
		controller_host_action: {
			calls: {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: ['zone_git_push', 'controller_host_probe'], deny: [] },
			},
			tools: { allow: ['zone_git_push', 'controller_host_probe'], deny: [] },
		},
	},
	profile: 'default',
};

const callerContextScope = {
	agentId: 'agent-a',
	agentWorkspaceDir: '/zone/agents/agent-a',
	purpose: 'tool_portal_controller_host_action',
	sessionKey: 'agent:agent-a:discord:channel:123',
	workMountDir: '/zone/agents/agent-a',
	zoneId: identity.zoneId,
} as const;

function createFakeGatewayControlService(
	handleMessage: (params: {
		readonly domainMessage: DomainControlMessageIdentity;
		readonly envelope: ControlEnvelope;
		readonly payload: GatewayControlRpcMessage;
	}) => GatewayControlRpcMessage | Promise<GatewayControlRpcMessage>,
): GatewayControlService {
	let sequence = 0;
	return {
		close: vi.fn(async () => {}),
		emitApplicationMessage: vi.fn(
			async (envelope, domainMessage, payload) =>
				await handleMessage({
					domainMessage,
					envelope,
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

describe('createGatewayControlControllerHostActionBackend', () => {
	it('lists and calls zone_git_push through gateway control without git pack data', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		const controlService = createFakeGatewayControlService(
			({ payload, envelope, domainMessage }) => {
				observedMessages.push(payload);
				expect(domainMessage).toEqual({
					kind: 'command',
					operation: 'tool_portal_controller_host_action',
				});
				expect(envelope).toMatchObject({
					deliveryPolicy: 'single_use_critical',
					domain: 'gateway_control',
					operation: 'tool_portal_controller_host_action',
					peerId: identity.peerId,
					zoneId: identity.zoneId,
				});
				expect(payload).toEqual({
					kind: 'command',
					operation: 'tool_portal_controller_host_action',
					payload: {
						actionId: 'zone_git_push',
						callerContext: {
							callerContextId: '44444444-4444-4444-8444-444444444444',
						},
						correlation: {
							capability: {
								name: 'zone_git_push',
								namespace: 'controller_host_action',
							},
						},
						expectedHead: 'abc123',
					},
				});
				return {
					kind: 'command_result',
					operation: 'tool_portal_controller_host_action',
					payload: {
						controllerHostAction: {
							actionId: 'zone_git_push',
							result: {
								branch: 'main',
								localHead: 'abc123',
								pushedCommits: [{ sha: 'abc123', subject: 'docs: update' }],
								remoteHead: 'abc123',
							},
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			},
		);
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
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
			now: () => 1_000,
			projection,
		});

		const listResult = await backend.list({ requests: [{ id: 'list-actions' }] });
		const callResult = await backend.call({
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});

		expect(PortalListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-actions',
					status: 'ok',
					value: {
						namespaces: ['controller_host_action'],
						tools: expect.arrayContaining([
							expect.objectContaining({ name: 'zone_git_push' }),
							expect.objectContaining({ name: 'controller_host_probe' }),
						]),
					},
				},
			],
			ok: true,
		});
		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{
					id: 'push-zone',
					status: 'ok',
					value: {
						actionId: 'zone_git_push',
						result: { branch: 'main', localHead: 'abc123' },
					},
				},
			],
			ok: true,
		});
		expect(JSON.stringify(observedMessages)).not.toContain('PACK');
		expect(JSON.stringify(observedMessages)).not.toContain('git-upload-pack');
		expect(JSON.stringify(observedMessages)).not.toContain('git-receive-pack');
		expect(callerContextStore.resolveCallerContextIdForAgent(callerContextScope)).toBeUndefined();
	});

	it('calls a fixed controller host probe through gateway control without a shell command', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			observedMessages.push(payload);
			expect(payload).toEqual({
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'controller_host_probe',
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
					correlation: {
						capability: {
							name: 'controller_host_probe',
							namespace: 'controller_host_action',
						},
					},
				},
			});
			return {
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: {
						actionId: 'controller_host_probe',
						result: {
							entryNames: ['agent-vm-host-probe.txt'],
							probeKind: 'controller_cache_dir_listing',
						},
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
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
			now: () => 1_000,
			projection,
		});

		const callResult = await backend.call({
			calls: [
				{
					arguments: {},
					id: 'probe-host',
					namespace: 'controller_host_action',
					name: 'controller_host_probe',
				},
			],
		});

		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{
					id: 'probe-host',
					status: 'ok',
					value: {
						actionId: 'controller_host_probe',
						result: {
							entryNames: ['agent-vm-host-probe.txt'],
							probeKind: 'controller_cache_dir_listing',
						},
					},
				},
			],
			ok: true,
		});
		expect(JSON.stringify(observedMessages)).not.toContain('ls');
		expect(JSON.stringify(observedMessages)).not.toContain('cwd');
		expect(callerContextStore.resolveCallerContextIdForAgent(callerContextScope)).toBeUndefined();
	});

	it('registers a fresh caller context for each terminal host-action call', async () => {
		let registerCount = 0;
		const callerContextStore = createGatewayControlCallerContextStore();
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			if (payload.operation === 'caller_context_register') {
				registerCount += 1;
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							callerContextId:
								registerCount === 1
									? '44444444-4444-4444-8444-444444444444'
									: '55555555-5555-4555-8555-555555555555',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			expect(payload.operation).toBe('tool_portal_controller_host_action');
			return {
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: {
						actionId: 'zone_git_push',
						result: {
							branch: 'main',
							localHead: 'abc123',
							pushedCommits: [],
							remoteHead: 'abc123',
						},
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			identity,
			projection,
		});

		await expect(
			backend.call({
				calls: [
					{
						arguments: { expectedHead: 'abc123' },
						id: 'push-zone-a',
						namespace: 'controller_host_action',
						name: 'zone_git_push',
					},
				],
			}),
		).resolves.toMatchObject({
			items: [{ id: 'push-zone-a', status: 'ok' }],
			ok: true,
		});
		await expect(
			backend.call({
				calls: [
					{
						arguments: { expectedHead: 'abc123' },
						id: 'push-zone-b',
						namespace: 'controller_host_action',
						name: 'zone_git_push',
					},
				],
			}),
		).resolves.toMatchObject({
			items: [{ id: 'push-zone-b', status: 'ok' }],
			ok: true,
		});

		expect(registerCount).toBe(2);
		expect(callerContextStore.resolveCallerContextIdForAgent(callerContextScope)).toBeUndefined();
	});

	it('rejects unexpected zone_git_push arguments before gateway control dispatch', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
		const controlService = createFakeGatewayControlService(({ payload }) => {
			observedMessages.push(payload);
			throw new Error('gateway control should not be called');
		});
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			identity,
			projection,
		});

		const callResult = await backend.call({
			calls: [
				{
					arguments: { expectedHead: 'abc123', unexpected: 'ignored-before-fix' },
					id: 'push-zone',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});

		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{
					id: 'push-zone',
					status: 'error',
					error: {
						code: 'validation_failed',
					},
				},
			],
			ok: false,
		});
		expect(observedMessages).toEqual([]);
		expect(controlService.emitApplicationMessage).not.toHaveBeenCalled();
	});

	it('reuses zone_git_push command identity when an accepted result is lost', async () => {
		const observedEnvelopes: ControlEnvelope[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		let zoneGitPushAttempt = 0;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			if (payload.operation !== 'tool_portal_controller_host_action') {
				throw new Error('test expected only zone_git_push messages');
			}
			observedEnvelopes.push(envelope);
			zoneGitPushAttempt += 1;
			if (zoneGitPushAttempt === 1) {
				throw new Error('simulated accepted-result loss');
			}
			return {
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: {
						actionId: 'zone_git_push',
						result: {
							branch: 'main',
							localHead: 'abc123',
							pushedCommits: [],
							remoteHead: 'abc123',
						},
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
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
			now: () => 1_000,
			projection,
		});
		const request = {
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		};

		await expect(backend.call(request)).resolves.toMatchObject({
			items: [{ id: 'push-zone', status: 'error' }],
			ok: false,
		});
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		await expect(backend.call(request)).resolves.toMatchObject({
			items: [{ id: 'push-zone', status: 'ok' }],
			ok: true,
		});

		expect(observedEnvelopes).toHaveLength(2);
		expect(observedEnvelopes[1]).toMatchObject({
			commandId: observedEnvelopes[0]?.commandId,
			idempotencyKey: observedEnvelopes[0]?.idempotencyKey,
			messageId: observedEnvelopes[0]?.messageId,
		});
	});

	it('refreshes caller context and command identity after stale caller-context rejection', async () => {
		const observedPushEnvelopes: ControlEnvelope[] = [];
		const observedRegisterEnvelopes: ControlEnvelope[] = [];
		const callerContextStore = createGatewayControlCallerContextStore();
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		let zoneGitPushAttempt = 0;
		const controlService = createFakeGatewayControlService(({ payload, envelope }) => {
			if (payload.operation === 'caller_context_register') {
				observedRegisterEnvelopes.push(envelope);
				return {
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							callerContextId: '99999999-9999-4999-8999-999999999999',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				};
			}
			if (payload.operation !== 'tool_portal_controller_host_action') {
				throw new Error('test expected caller context registration or zone_git_push messages');
			}
			observedPushEnvelopes.push(envelope);
			zoneGitPushAttempt += 1;
			if (zoneGitPushAttempt === 1) {
				return {
					kind: 'command_result',
					operation: 'tool_portal_controller_host_action',
					payload: {
						error: {
							errorClass: 'controller_host_action_caller_context_stale',
							retryable: true,
							safeMessage: 'caller context is stale',
						},
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				};
			}
			return {
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: {
					controllerHostAction: {
						actionId: 'zone_git_push',
						result: {
							branch: 'agent/zone-files',
							localHead: 'abc123',
							pushedCommits: [],
							remoteHead: 'abc123',
						},
					},
					responseToMessageId: envelope.messageId,
					result: 'ok',
				},
			};
		});
		const backend = createGatewayControlControllerHostActionBackend({
			callerContextStore,
			callerContextScope,
			controlService,
			createId: (() => {
				const ids = [
					'11111111-1111-4111-8111-111111111111',
					'22222222-2222-4222-8222-222222222222',
					'33333333-3333-4333-8333-333333333333',
					'66666666-6666-4666-8666-666666666666',
					'77777777-7777-4777-8777-777777777777',
					'88888888-8888-4888-8888-888888888888',
					'99999999-9999-4999-8999-999999999999',
					'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
			now: () => 1_000,
			projection,
		});

		await expect(
			backend.call({
				calls: [
					{
						arguments: { expectedHead: 'abc123' },
						id: 'push-zone',
						namespace: 'controller_host_action',
						name: 'zone_git_push',
					},
				],
			}),
		).resolves.toMatchObject({
			items: [{ id: 'push-zone', status: 'ok' }],
			ok: true,
		});

		expect(observedRegisterEnvelopes).toHaveLength(1);
		expect(observedPushEnvelopes).toHaveLength(2);
		const firstPushEnvelope = observedPushEnvelopes[0];
		const secondPushEnvelope = observedPushEnvelopes[1];
		if (firstPushEnvelope === undefined || secondPushEnvelope === undefined) {
			throw new Error('test expected two zone_git_push envelopes');
		}
		expect(secondPushEnvelope).toMatchObject({
			idempotencyKey: [
				'zone_git_push',
				'controller_host_action',
				'abc123',
				'77777777-7777-4777-8777-777777777777',
			].join('\u0000'),
		});
		expect(secondPushEnvelope.commandId).not.toBe(firstPushEnvelope.commandId);
		expect(secondPushEnvelope.messageId).not.toBe(firstPushEnvelope.messageId);
	});
});
