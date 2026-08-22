import type {
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type { ManagedAgentProjection } from '@agent-vm/agent-portal-sdk/contracts';
import type { GatewayRuntimePortalRequestOptions } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type {
	OpenClawPluginToolContext,
	OpenClawToolRegistration,
	OpenClawToolRegistrationApi,
} from './openclaw-sandbox-sdk-contract.js';
import {
	type OpenClawToolPortalClient,
	registerToolPortalNativeTools,
} from './tool-portal-native-tools.js';

interface ObservedPortalCalls {
	readonly call: Mock<OpenClawToolPortalClient['portal']['call']>;
	readonly describe: Mock<OpenClawToolPortalClient['portal']['describe']>;
	readonly list: Mock<OpenClawToolPortalClient['portal']['list']>;
	readonly search: Mock<OpenClawToolPortalClient['portal']['search']>;
}

function createFakeGatewayRuntimeClient(): {
	readonly client: OpenClawToolPortalClient;
	readonly observed: ObservedPortalCalls;
} {
	const list = vi.fn(
		async (
			_request: PortalListRequest,
			_options: GatewayRuntimePortalRequestOptions,
		): Promise<PortalListResult> => ({ items: [], ok: true }),
	);
	const search = vi.fn(
		async (
			_request: PortalSearchRequest,
			_options: GatewayRuntimePortalRequestOptions,
		): Promise<PortalSearchResult> => ({ items: [], ok: true }),
	);
	const portalDescribe = vi.fn(
		async (
			_request: PortalDescribeRequest,
			_options: GatewayRuntimePortalRequestOptions,
		): Promise<PortalDescribeResult> => ({ items: [], ok: true }),
	);
	const call = vi.fn(
		async (
			_request: PortalCallRequest,
			_options: GatewayRuntimePortalRequestOptions,
		): Promise<PortalCallResult> => ({ items: [], ok: true }),
	);
	return {
		client: {
			portal: {
				call,
				describe: portalDescribe,
				list,
				search,
			},
		},
		observed: { call, describe: portalDescribe, list, search },
	};
}

function registerNativeTools(options: {
	readonly agentProjections?: Readonly<Record<string, ManagedAgentProjection>>;
	readonly client: OpenClawToolPortalClient;
	readonly context: OpenClawPluginToolContext;
}): readonly OpenClawToolRegistration[] {
	let registeredTools: readonly OpenClawToolRegistration[] = [];
	const api: OpenClawToolRegistrationApi = {
		registerTool: (tool) => {
			registeredTools = typeof tool === 'function' ? tool(options.context) : [tool];
		},
	};
	registerToolPortalNativeTools({
		agentProjections: options.agentProjections ?? {
			'agent-a': {
				agentId: 'agent-a',
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-a',
				toolPortalNamespaces: [],
				toolPortalProfileId: 'profile-a',
			},
			'agent-b': {
				agentId: 'agent-b',
				frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-b',
				toolPortalNamespaces: [],
				toolPortalProfileId: 'profile-b',
			},
		},
		api,
		clientProvider: () => options.client,
	});
	return registeredTools;
}

function requireRegisteredTool(
	tools: readonly OpenClawToolRegistration[],
	toolName: string,
): OpenClawToolRegistration {
	const tool = tools.find((candidate) => candidate.name === toolName);
	if (tool === undefined) throw new Error(`Expected ${toolName} to be registered.`);
	return tool;
}

function createTrustedOpenClawContext(
	options: {
		readonly omit?: 'agentId' | 'requesterSenderId' | 'sessionId' | 'workspaceDir';
		readonly overrides?: Partial<OpenClawPluginToolContext>;
	} = {},
): OpenClawPluginToolContext {
	const context = {
		agentAccountId: 'provider-account-that-must-not-be-used-as-subject',
		agentDir: '/state/openclaw/agents/agent-a',
		agentId: 'agent-a',
		requesterSenderId: 'discord-user-42',
		sessionId: 'session-a',
		sessionKey: 'agent:agent-a:discord:channel:123',
		workspaceDir: '/zone/agents/agent-a',
		...options.overrides,
	};
	if (options.omit === 'agentId') {
		const { agentId: _omittedAgentId, ...contextWithoutAgentId } = context;
		return contextWithoutAgentId;
	}
	if (options.omit === 'requesterSenderId') {
		const { requesterSenderId: _omittedRequesterSenderId, ...contextWithoutRequesterSenderId } =
			context;
		return contextWithoutRequesterSenderId;
	}
	if (options.omit === 'sessionId') {
		const { sessionId: _omittedSessionId, ...contextWithoutSessionId } = context;
		return contextWithoutSessionId;
	}
	if (options.omit === 'workspaceDir') {
		const { workspaceDir: _omittedWorkspaceDir, ...contextWithoutWorkspaceDir } = context;
		return contextWithoutWorkspaceDir;
	}
	return context;
}

describe('registerToolPortalNativeTools', () => {
	it('routes all native tools through one GatewayRuntimeClient portal surface', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const tools = registerNativeTools({
			client,
			context: createTrustedOpenClawContext(),
		});
		const cancellation = new AbortController();

		await requireRegisteredTool(tools, 'tool_portal_list').execute(
			'tool-call-list',
			{ requests: [{ id: 'list-a' }] },
			cancellation.signal,
		);
		await requireRegisteredTool(tools, 'tool_portal_search').execute(
			'tool-call-search',
			{ requests: [{ id: 'search-a', query: 'git' }] },
			cancellation.signal,
		);
		await requireRegisteredTool(tools, 'tool_portal_describe').execute(
			'tool-call-describe',
			{ requests: [{ id: 'describe-a', tools: [] }] },
			cancellation.signal,
		);
		await requireRegisteredTool(tools, 'tool_portal_call').execute(
			'tool-call-call',
			{
				calls: [
					{
						arguments: {
							agentId: 'model-injected',
							authenticatedSubjectId: 'model-injected',
							profileAssignmentRevision: 'model-injected',
							profileId: 'model-injected',
							sessionId: 'model-injected',
							workspaceId: '/host',
						},
						id: 'call-a',
						namespace: 'sandbox',
						name: 'exec',
					},
				],
			},
			cancellation.signal,
		);

		expect(observed.list).toHaveBeenCalledOnce();
		expect(observed.search).toHaveBeenCalledOnce();
		expect(observed.describe).toHaveBeenCalledOnce();
		expect(observed.call).toHaveBeenCalledOnce();
		for (const [operation, toolCallId] of [
			[observed.list, 'tool-call-list'],
			[observed.search, 'tool-call-search'],
			[observed.describe, 'tool-call-describe'],
			[observed.call, 'tool-call-call'],
		] as const) {
			expect(operation.mock.calls[0]?.[1]).toEqual({
				signal: cancellation.signal,
				trustedContext: {
					correlation: {
						sessionId: 'session-a',
						sessionKey: 'agent:agent-a:discord:channel:123',
						toolCallId,
					},
					principal: {
						agentId: 'agent-a',
						frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
						profileAssignmentRevision: 'profile-revision-a',
						toolPortalProfileId: 'profile-a',
					},
					requester: { authenticatedSubjectId: 'discord-user-42' },
				},
			});
		}
		expect(observed.call.mock.calls[0]?.[0]).toEqual({
			calls: [
				{
					arguments: {
						agentId: 'model-injected',
						authenticatedSubjectId: 'model-injected',
						profileAssignmentRevision: 'model-injected',
						profileId: 'model-injected',
						sessionId: 'model-injected',
						workspaceId: '/host',
					},
					id: 'call-a',
					namespace: 'sandbox',
					name: 'exec',
				},
			],
		});
	});

	it('derives distinct profile revisions for multiple agents using the same client', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const firstTools = registerNativeTools({
			client,
			context: createTrustedOpenClawContext(),
		});
		const secondTools = registerNativeTools({
			client,
			context: createTrustedOpenClawContext({
				overrides: {
					agentId: 'agent-b',
					requesterSenderId: 'slack-user-7',
					sessionId: 'session-b',
					sessionKey: 'agent:agent-b:slack:channel:456',
					workspaceDir: '/zone/agents/agent-b',
				},
			}),
		});

		await requireRegisteredTool(firstTools, 'tool_portal_list').execute('first-call', {
			requests: [{ id: 'first' }],
		});
		await requireRegisteredTool(secondTools, 'tool_portal_list').execute('second-call', {
			requests: [{ id: 'second' }],
		});

		expect(observed.list.mock.calls.map((call) => call[1]?.trustedContext)).toEqual([
			{
				correlation: {
					sessionId: 'session-a',
					sessionKey: 'agent:agent-a:discord:channel:123',
					toolCallId: 'first-call',
				},
				principal: {
					agentId: 'agent-a',
					frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
					profileAssignmentRevision: 'profile-revision-a',
					toolPortalProfileId: 'profile-a',
				},
				requester: { authenticatedSubjectId: 'discord-user-42' },
			},
			{
				correlation: {
					sessionId: 'session-b',
					sessionKey: 'agent:agent-b:slack:channel:456',
					toolCallId: 'second-call',
				},
				principal: {
					agentId: 'agent-b',
					frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
					profileAssignmentRevision: 'profile-revision-b',
					toolPortalProfileId: 'profile-b',
				},
				requester: { authenticatedSubjectId: 'slack-user-7' },
			},
		]);
	});

	it('accepts trusted calls without requester or session metadata', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const contextWithSessionMetadata = createTrustedOpenClawContext({
			omit: 'requesterSenderId',
		});
		const {
			sessionId: _omittedSessionId,
			sessionKey: _omittedSessionKey,
			...contextWithoutSessionMetadata
		} = contextWithSessionMetadata;
		const tools = registerNativeTools({
			client,
			context: contextWithoutSessionMetadata,
		});

		await requireRegisteredTool(tools, 'tool_portal_list').execute('tool-call-list', {
			requests: [{ id: 'list-a' }],
		});

		expect(observed.list.mock.calls[0]?.[1]?.trustedContext).toEqual({
			correlation: { toolCallId: 'tool-call-list' },
			principal: {
				agentId: 'agent-a',
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-a',
				toolPortalProfileId: 'profile-a',
			},
		});
	});

	it.each([
		{
			context: createTrustedOpenClawContext({ omit: 'agentId' }),
			error: 'trusted agentId',
			name: 'missing agent',
		},
		{
			context: createTrustedOpenClawContext({ overrides: { agentId: 'agent-c' } }),
			error: "agentId 'agent-c' is not configured",
			name: 'unconfigured agent',
		},
	] satisfies readonly {
		readonly context: OpenClawPluginToolContext;
		readonly error: string;
		readonly name: string;
	}[])('rejects $name before client dispatch', async ({ context, error }) => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const tools = registerNativeTools({ client, context });

		await expect(
			requireRegisteredTool(tools, 'tool_portal_list').execute('tool-call-list', {
				requests: [{ id: 'list-a' }],
			}),
		).rejects.toThrow(error);
		expect(observed.list).not.toHaveBeenCalled();
	});

	it('does not use workspaceDir as principal or storage authority', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const tools = registerNativeTools({
			client,
			context: createTrustedOpenClawContext({
				overrides: { workspaceDir: '/zone/agents/agent-b' },
			}),
		});

		await requireRegisteredTool(tools, 'tool_portal_list').execute('tool-call-list', {
			requests: [{ id: 'list-a' }],
		});

		expect(observed.list.mock.calls[0]?.[1]?.trustedContext.principal.agentId).toBe('agent-a');
	});

	it('accepts an authenticated agent when OpenClaw omits workspaceDir', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const tools = registerNativeTools({
			client,
			context: createTrustedOpenClawContext({ omit: 'workspaceDir' }),
		});

		await requireRegisteredTool(tools, 'tool_portal_list').execute('tool-call-list', {
			requests: [{ id: 'list-a' }],
		});

		expect(observed.list).toHaveBeenCalledOnce();
	});

	it('rejects a projection whose framework identity mismatches the authenticated agent', async () => {
		const { client, observed } = createFakeGatewayRuntimeClient();
		const tools = registerNativeTools({
			agentProjections: {
				'agent-a': {
					agentId: 'agent-a',
					frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
					profileAssignmentRevision: 'profile-revision-a',
					toolPortalNamespaces: [],
					toolPortalProfileId: 'profile-a',
				},
			},
			client,
			context: createTrustedOpenClawContext(),
		});

		await expect(
			requireRegisteredTool(tools, 'tool_portal_list').execute('tool-call-list', {
				requests: [{ id: 'list-a' }],
			}),
		).rejects.toThrow(
			"tool-portal: OpenClaw projection identity does not match authenticated agentId 'agent-a'.",
		);
		expect(observed.list).not.toHaveBeenCalled();
	});

	it('registers no client-owned tools when OpenClaw does not expose registerTool', () => {
		const { client } = createFakeGatewayRuntimeClient();
		const warning = vi.fn();

		registerToolPortalNativeTools({
			agentProjections: {
				'agent-a': {
					agentId: 'agent-a',
					frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
					profileAssignmentRevision: 'revision-a',
					toolPortalNamespaces: [],
					toolPortalProfileId: 'profile-a',
				},
			},
			api: {},
			clientProvider: () => client,
			logger: { warn: warning },
		});

		expect(warning).toHaveBeenCalledWith(
			'[tool-portal] skipped native tool registration; OpenClaw registerTool is absent.',
		);
	});
});
