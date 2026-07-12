import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGatewayControlCallerContextStore } from './gateway-control-service/gateway-control-caller-context-store.js';
import type {
	GatewayControlIdentity,
	GatewayControlService,
} from './gateway-control-service/gateway-control-service.js';
import type {
	OpenClawPluginToolContext,
	OpenClawToolRegistration,
	OpenClawToolRegistrationApi,
} from './openclaw-sandbox-sdk-contract.js';
import { registerToolPortalNativeTools } from './tool-portal-native-tools.js';

const identity = {
	bootId: 'gateway-boot-a',
	callerContextAgentAuthorityKeys: {
		'agent-a': 'test-agent-a-authority-key-with-enough-length',
	},
	callerContextProofKey: 'test-caller-context-proof-key',
	controllerEpoch: 'controller-epoch-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-epoch-a',
	zoneId: 'zone-a',
} satisfies GatewayControlIdentity;

const callerContextScope = {
	agentId: 'agent-a',
	agentWorkspaceDir: '/zone/agents/agent-a',
	purpose: 'tool_portal_controller_host_action',
	sessionKey: 'agent:agent-a:discord:channel:123',
	workMountDir: '/zone/agents/agent-a',
	zoneId: identity.zoneId,
} as const;

let testRoot: string;

beforeEach(async () => {
	testRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-tool-portal-native-'));
});

afterEach(async () => {
	await rm(testRoot, { force: true, recursive: true });
});

async function writeToolPortalControllerHostActionConfig(): Promise<string> {
	const configDir = path.join(testRoot, 'tool-portal');
	await mkdir(configDir, { recursive: true });
	await writeFile(
		path.join(configDir, 'mcp.config.jsonc'),
		`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		path.join(configDir, 'tool-portal.config.jsonc'),
		`${JSON.stringify(
			{
				agents: { 'agent-a': { profile: 'default' } },
				profiles: {
					default: {
						capabilities: {
							controller_host_action: {
								backend: { kind: 'controller_host_action' },
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: ['zone_git_push'], deny: [] },
								},
								tools: { allow: ['zone_git_push'], deny: [] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	return configDir;
}

function createFakeGatewayControlService(
	observedMessages: GatewayControlRpcMessage[],
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
			const envelope = intent.buildEnvelope({ acceptedSession, sequence });
			const domainMessage = intent.domainMessage;
			const message = GatewayControlRpcMessageSchema.parse(intent.payload);
			observedMessages.push(message);
			if (message.kind === 'command' && message.operation === 'caller_context_register') {
				expect(domainMessage).toEqual({
					kind: 'command',
					operation: 'caller_context_register',
				});
				expect(message.payload.adapterEvidence).toEqual(
					expect.objectContaining({
						agentId: 'agent-a',
						agentWorkspaceDir: '/zone/agents/agent-a',
						proof: expect.objectContaining({
							algorithm: 'hmac-sha256',
						}),
						purpose: 'tool_portal_controller_host_action',
						sessionKey: 'agent:agent-a:discord:channel:123',
						workMountDir: '/zone/agents/agent-a',
						zoneId: identity.zoneId,
					}),
				);
				return GatewayControlRpcCommandResultMessageSchema.parse({
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
				});
			}
			expect(domainMessage).toEqual({
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
			});
			if (
				message.kind !== 'command' ||
				message.operation !== 'tool_portal_controller_host_action'
			) {
				throw new Error(`Unexpected gateway control message ${message.operation}.`);
			}
			expect(message.payload).toMatchObject({
				callerContext: {
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				expectedHead: 'abc123',
			});
			return GatewayControlRpcCommandResultMessageSchema.parse({
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
			});
		}),
		getCurrentAcceptedSession: vi.fn(() => acceptedSession),
		waitForAcceptedSession: vi.fn(async () => acceptedSession),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => false),
		handleUpgrade: vi.fn(() => false),
	};
}

function registerNativeTools(
	context: OpenClawPluginToolContext,
	props: Omit<Parameters<typeof registerToolPortalNativeTools>[0], 'api'>,
): readonly OpenClawToolRegistration[] {
	let registeredTools: readonly OpenClawToolRegistration[] = [];
	const api: OpenClawToolRegistrationApi = {
		registerTool: (tool) => {
			registeredTools = typeof tool === 'function' ? tool(context) : [tool];
		},
	};
	registerToolPortalNativeTools({ ...props, api });
	return registeredTools;
}

describe('registerToolPortalNativeTools', () => {
	it('does not register controller-host-action caller context for discovery tools', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const configDir = await writeToolPortalControllerHostActionConfig();
		const registeredTools = registerNativeTools(
			{
				agentDir: '/zone/agents/agent-a',
				agentId: 'agent-a',
				sessionKey: 'agent:agent-a:discord:channel:123',
				workspaceDir: '/zone/agents/agent-a',
			},
			{
				configDir,
				gatewayControl: {
					callerContextStore: createGatewayControlCallerContextStore(),
					identity,
					service: createFakeGatewayControlService(observedMessages),
				},
			},
		);
		const listTool = registeredTools.find((tool) => tool.name === 'tool_portal_list');
		const searchTool = registeredTools.find((tool) => tool.name === 'tool_portal_search');
		const describeTool = registeredTools.find((tool) => tool.name === 'tool_portal_describe');
		if (listTool === undefined || searchTool === undefined || describeTool === undefined) {
			throw new Error('Expected Tool Portal discovery tools to be registered.');
		}

		await listTool.execute('tool-call-list', { requests: [{ id: 'list-all' }] });
		await searchTool.execute('tool-call-search', {
			requests: [{ id: 'search-zone-git', query: 'zone git' }],
		});
		await describeTool.execute('tool-call-describe', {
			requests: [
				{
					id: 'describe-zone-git',
					tools: [
						{
							namespace: 'controller_host_action',
							name: 'zone_git_push',
						},
					],
				},
			],
		});

		expect(observedMessages).toEqual([]);
	});

	it('registers a fresh controller-host-action caller context before calling zone_git_push', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const configDir = await writeToolPortalControllerHostActionConfig();
		const callerContextStore = createGatewayControlCallerContextStore();
		const registeredTools = registerNativeTools(
			{
				agentDir: '/zone/agents/agent-a',
				agentId: 'agent-a',
				sessionKey: 'agent:agent-a:discord:channel:123',
				workspaceDir: '/zone/agents/agent-a',
			},
			{
				configDir,
				gatewayControl: {
					callerContextStore,
					identity,
					service: createFakeGatewayControlService(observedMessages),
				},
			},
		);
		const callTool = registeredTools.find((tool) => tool.name === 'tool_portal_call');
		if (callTool === undefined) {
			throw new Error('Expected tool_portal_call to be registered.');
		}

		const result = await callTool.execute('tool-call-a', {
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});

		expect(result.content).toContain('"status":"ok"');
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'tool_portal_controller_host_action',
		]);
	});

	it('keeps controller-host-action caller contexts separate for same-agent sessions', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const configDir = await writeToolPortalControllerHostActionConfig();
		const callerContextStore = createGatewayControlCallerContextStore();
		const controlService =
			createFakeGatewayControlServiceForDistinctSessionContexts(observedMessages);
		const firstRegisteredTools = registerNativeTools(
			{
				agentDir: '/zone/agents/agent-a',
				agentId: 'agent-a',
				sessionKey: 'agent:agent-a:discord:channel:123',
				workspaceDir: '/zone/agents/agent-a',
			},
			{
				configDir,
				gatewayControl: {
					callerContextStore,
					identity,
					service: controlService,
				},
			},
		);
		const secondRegisteredTools = registerNativeTools(
			{
				agentDir: '/zone/agents/agent-a-second',
				agentId: 'agent-a',
				sessionKey: 'agent:agent-a:discord:channel:456',
				workspaceDir: '/zone/agents/agent-a-second',
			},
			{
				configDir,
				gatewayControl: {
					callerContextStore,
					identity,
					service: controlService,
				},
			},
		);
		const firstCallTool = firstRegisteredTools.find((tool) => tool.name === 'tool_portal_call');
		const secondCallTool = secondRegisteredTools.find((tool) => tool.name === 'tool_portal_call');
		if (firstCallTool === undefined || secondCallTool === undefined) {
			throw new Error('Expected tool_portal_call to be registered for both sessions.');
		}

		await firstCallTool.execute('tool-call-first', {
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone-first',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});
		await secondCallTool.execute('tool-call-second', {
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone-second',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});

		const registrationMessages = observedMessages.filter(
			(message) => message.operation === 'caller_context_register',
		);
		const hostActionMessages = observedMessages.filter(
			(message) => message.operation === 'tool_portal_controller_host_action',
		);
		expect(registrationMessages).toHaveLength(2);
		expect(hostActionMessages).toHaveLength(2);
		expect(
			hostActionMessages.map((message) =>
				message.kind === 'command'
					? message.payload.callerContext.callerContextId
					: '<not-command>',
			),
		).toEqual(['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']);
	});

	it('refreshes a stale controller-host-action caller context and retries the same call', async () => {
		const observedMessages: GatewayControlRpcMessage[] = [];
		const configDir = await writeToolPortalControllerHostActionConfig();
		const callerContextStore = createGatewayControlCallerContextStore();
		callerContextStore.rememberCallerContextForAgent({
			callerContextId: '44444444-4444-4444-8444-444444444444',
			...callerContextScope,
		});
		const controlService = createFakeGatewayControlServiceForStaleRefresh(observedMessages);
		const registeredTools = registerNativeTools(
			{
				agentDir: '/zone/agents/agent-a',
				agentId: 'agent-a',
				sessionKey: 'agent:agent-a:discord:channel:123',
				workspaceDir: '/zone/agents/agent-a',
			},
			{
				configDir,
				gatewayControl: {
					callerContextStore,
					identity,
					service: controlService,
				},
			},
		);
		const callTool = registeredTools.find((tool) => tool.name === 'tool_portal_call');
		if (callTool === undefined) {
			throw new Error('Expected tool_portal_call to be registered.');
		}

		const result = await callTool.execute('tool-call-stale', {
			calls: [
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone-stale',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});

		expect(result.content).toContain('"status":"ok"');
		expect(observedMessages.map((message) => message.operation)).toEqual([
			'caller_context_register',
			'tool_portal_controller_host_action',
		]);
		expect(controlService.emitApplicationMessage).toHaveBeenCalledTimes(2);
	});
});

function createFakeGatewayControlServiceForStaleRefresh(
	observedMessages: GatewayControlRpcMessage[],
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
			const envelope = intent.buildEnvelope({ acceptedSession, sequence });
			const domainMessage = intent.domainMessage;
			const message = GatewayControlRpcMessageSchema.parse(intent.payload);
			observedMessages.push(message);
			if (message.kind === 'command' && message.operation === 'caller_context_register') {
				expect(domainMessage).toEqual({
					kind: 'command',
					operation: 'caller_context_register',
				});
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'caller_context_register',
					payload: {
						callerContext: {
							admissionPrincipal:
								'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							callerContextId: '55555555-5555-4555-8555-555555555555',
						},
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				});
			}
			expect(domainMessage).toEqual({
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
			});
			if (
				message.kind !== 'command' ||
				message.operation !== 'tool_portal_controller_host_action'
			) {
				throw new Error(`Unexpected gateway control message ${message.operation}.`);
			}
			if (
				message.payload.callerContext.callerContextId === '44444444-4444-4444-8444-444444444444'
			) {
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'tool_portal_controller_host_action',
					payload: {
						error: {
							errorClass: 'controller_host_action_caller_context_stale',
							retryable: false,
							safeMessage: 'controller host action caller context does not match session',
						},
						responseToMessageId: envelope.messageId,
						result: 'rejected',
					},
				});
			}
			expect(message.payload).toMatchObject({
				callerContext: {
					callerContextId: '55555555-5555-4555-8555-555555555555',
				},
				expectedHead: 'abc123',
			});
			return GatewayControlRpcCommandResultMessageSchema.parse({
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
			});
		}),
		getCurrentAcceptedSession: vi.fn(() => acceptedSession),
		waitForAcceptedSession: vi.fn(async () => acceptedSession),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => false),
		handleUpgrade: vi.fn(() => false),
	};
}

function createFakeGatewayControlServiceForDistinctSessionContexts(
	observedMessages: GatewayControlRpcMessage[],
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
			const envelope = intent.buildEnvelope({ acceptedSession, sequence });
			const domainMessage = intent.domainMessage;
			const message = GatewayControlRpcMessageSchema.parse(intent.payload);
			observedMessages.push(message);
			if (message.kind === 'command' && message.operation === 'caller_context_register') {
				expect(domainMessage).toEqual({
					kind: 'command',
					operation: 'caller_context_register',
				});
				const callerContextId =
					message.payload.adapterEvidence.sessionKey === 'agent:agent-a:discord:channel:123'
						? '44444444-4444-4444-8444-444444444444'
						: '55555555-5555-4555-8555-555555555555';
				return GatewayControlRpcCommandResultMessageSchema.parse({
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
				});
			}
			expect(domainMessage).toEqual({
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
			});
			if (
				message.kind !== 'command' ||
				message.operation !== 'tool_portal_controller_host_action'
			) {
				throw new Error(`Unexpected gateway control message ${message.operation}.`);
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
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
			});
		}),
		getCurrentAcceptedSession: vi.fn(() => acceptedSession),
		waitForAcceptedSession: vi.fn(async () => acceptedSession),
		getCredentialState: vi.fn(() => undefined),
		handleReadyRequest: vi.fn(() => false),
		handleUpgrade: vi.fn(() => false),
	};
}
