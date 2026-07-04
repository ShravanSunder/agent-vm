import {
	PortalCallResultSchema,
	PortalDescribeResultSchema,
	PortalListResultSchema,
	PortalSearchResultSchema,
} from '@agent-vm/agent-portal-sdk';
import type {
	ToolPortalControllerHostActionProjection,
	ToolPortalMcpProjection,
} from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createFakeMcpProviderBackend } from '../../../../tests/harness/agent-portal/fake-mcp-provider-server.js';
import { createToolPortalInProcessEntryPoint, type ToolPortalOperationOptions } from './index.js';

const toolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	profiles: {
		'code-builder': {
			capabilities: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
};

const mixedBackendToolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	profiles: {
		'code-builder': {
			capabilities: {
				controller_host_action: {
					backend: { kind: 'controller_host_action' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['zone_git_push'], deny: [] },
					},
					tools: { allow: ['zone_git_push'], deny: [] },
				},
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
};

const unsupportedToolVmRunnerConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	profiles: {
		'code-builder': {
			capabilities: {
				sandbox_ssh: {
					backend: { kind: 'tool_vm_runner' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['exec'], deny: [] },
					},
					tools: { allow: ['exec'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
};

describe('Tool Portal in-process entrypoint', () => {
	it('derives the MCP projection and delegates the four batch operations through SDK contracts', async () => {
		const capturedProjections: ToolPortalMcpProjection[] = [];
		const capturedMcpBackendCacheKeys: string[] = [];
		const mcpBackend = createFakeMcpProviderBackend({
			capabilities: [
				{
					description: 'Read issue',
					inputSchema: { properties: { number: { type: 'number' } }, type: 'object' },
					namespace: 'github',
					name: 'get_issue',
					value: { number: 42, title: 'Tool Portal proof' },
				},
			],
		});
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: (projection, context) => {
				capturedProjections.push(projection);
				capturedMcpBackendCacheKeys.push(context.entryPointCacheKey);
				return mcpBackend;
			},
		});

		const listResult = await portal.list({ requests: [{ id: 'list-github' }] });
		const callResult = await portal.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'get-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(capturedProjections).toHaveLength(1);
		expect(capturedProjections[0]).toMatchObject({
			agentId: 'agent-a',
			namespaces: { github: expect.any(Object) },
			profile: 'code-builder',
		});
		expect(capturedMcpBackendCacheKeys).toEqual(['agent-a']);
		expect(PortalListResultSchema.parse(listResult)).toMatchObject({ ok: true });
		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{
					id: 'get-issue',
					status: 'ok',
					value: { number: 42, title: 'Tool Portal proof' },
				},
			],
			ok: true,
		});
		expect(JSON.stringify(listResult)).not.toContain('mcp_portal_');
	});

	it('passes explicit entrypoint cache keys to MCP backend construction', () => {
		const capturedMcpBackendCacheKeys: string[] = [];

		createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			entryPointCacheKey: 'session-a',
			createMcpBackend: (_projection, context) => {
				capturedMcpBackendCacheKeys.push(context.entryPointCacheKey);
				return createFakeMcpProviderBackend({
					capabilities: [],
				});
			},
		});

		expect(capturedMcpBackendCacheKeys).toEqual(['session-a']);
	});

	it('rejects model-supplied approval tokens before backend dispatch', async () => {
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: () =>
				createFakeMcpProviderBackend({
					capabilities: [],
				}),
		});

		await expect(
			portal.call({
				calls: [
					{
						arguments: { title: 'Write' },
						id: 'create-issue',
						namespace: 'github',
						name: 'create_issue',
					},
				],
				portalApprovalToken: 'model-token',
			}),
		).rejects.toThrow();
	});

	it('passes cancellation signals through to the selected backend', async () => {
		const abortController = new AbortController();
		const capturedOptions: ToolPortalOperationOptions[] = [];
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: toolPortalConfig,
			createMcpBackend: () => ({
				call: async (_request, options) => {
					if (options !== undefined) {
						capturedOptions.push(options);
					}
					return PortalCallResultSchema.parse({ items: [], ok: true });
				},
				describe: async () => PortalDescribeResultSchema.parse({ items: [], ok: true }),
				list: async () => PortalListResultSchema.parse({ items: [], ok: true }),
				search: async () => PortalSearchResultSchema.parse({ items: [], ok: true }),
			}),
		});

		await portal.call(
			{
				calls: [
					{
						arguments: { number: 42 },
						id: 'get-issue',
						namespace: 'github',
						name: 'get_issue',
					},
				],
			},
			{ signal: abortController.signal },
		);

		expect(capturedOptions).toEqual([{ signal: abortController.signal }]);
	});

	it('routes calls to MCP and controller host action backends by namespace', async () => {
		const capturedMcpProjections: ToolPortalMcpProjection[] = [];
		const capturedControllerHostActionProjections: ToolPortalControllerHostActionProjection[] = [];
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: mixedBackendToolPortalConfig,
			createControllerHostActionBackend: (projection) => {
				capturedControllerHostActionProjections.push(projection);
				return {
					call: async (request) => {
						const parsedRequest = PortalCallResultSchema.parse({
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
						expect(JSON.stringify(request)).toContain('controller_host_action');
						return parsedRequest;
					},
					describe: async () => PortalDescribeResultSchema.parse({ items: [], ok: true }),
					list: async () =>
						PortalListResultSchema.parse({
							items: [
								{
									id: 'list-all',
									status: 'ok',
									value: {
										namespaces: ['controller_host_action'],
										tools: [],
									},
								},
							],
							ok: true,
						}),
					search: async () => PortalSearchResultSchema.parse({ items: [], ok: true }),
				};
			},
			createMcpBackend: (projection) => {
				capturedMcpProjections.push(projection);
				return {
					call: async (request) => {
						const parsedRequest = PortalCallResultSchema.parse({
							items: [
								{
									id: 'get-issue',
									status: 'ok',
									value: { number: 42 },
								},
							],
							ok: true,
						});
						expect(JSON.stringify(request)).toContain('github');
						return parsedRequest;
					},
					describe: async () => PortalDescribeResultSchema.parse({ items: [], ok: true }),
					list: async () =>
						PortalListResultSchema.parse({
							items: [
								{
									id: 'list-all',
									status: 'ok',
									value: {
										namespaces: ['github'],
										tools: [],
									},
								},
							],
							ok: true,
						}),
					search: async () => PortalSearchResultSchema.parse({ items: [], ok: true }),
				};
			},
		});

		const callResult = await portal.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'get-issue',
					namespace: 'github',
					name: 'get_issue',
				},
				{
					arguments: { expectedHead: 'abc123' },
					id: 'push-zone',
					namespace: 'controller_host_action',
					name: 'zone_git_push',
				},
			],
		});
		const listResult = await portal.list({ requests: [{ id: 'list-all' }] });

		expect(capturedMcpProjections[0]?.namespaces).toHaveProperty('github');
		expect(capturedControllerHostActionProjections[0]?.namespaces).toHaveProperty(
			'controller_host_action',
		);
		expect(PortalCallResultSchema.parse(callResult)).toMatchObject({
			items: [
				{ id: 'get-issue', status: 'ok' },
				{ id: 'push-zone', status: 'ok' },
			],
			ok: true,
		});
		expect(PortalListResultSchema.parse(listResult)).toMatchObject({
			items: [
				{
					id: 'list-all',
					status: 'ok',
					value: { namespaces: ['controller_host_action', 'github'] },
				},
			],
			ok: true,
		});
	});

	it('fails closed for tool_vm_runner capabilities until a runtime backend is wired', () => {
		expect(() =>
			createToolPortalInProcessEntryPoint({
				agentId: 'agent-a',
				config: unsupportedToolVmRunnerConfig,
				createMcpBackend: () =>
					createFakeMcpProviderBackend({
						capabilities: [],
					}),
			}),
		).toThrow(/tool_vm_runner.*not configured/u);
	});

	it('preserves backend discovery errors and diagnostics when merging list search and describe', async () => {
		const topLevelDiagnostic = {
			code: 'provider_unavailable' as const,
			level: 'warn' as const,
			safeMessage: 'MCP provider discovery is degraded.',
		};
		const itemDiagnostic = {
			code: 'provider_unavailable' as const,
			level: 'error' as const,
			safeMessage: 'MCP provider did not return discovery data.',
		};
		const discoveryError = {
			code: 'provider_unavailable' as const,
			message: 'MCP provider unavailable.',
			safeDiagnostic: itemDiagnostic,
		};
		const portal = createToolPortalInProcessEntryPoint({
			agentId: 'agent-a',
			config: mixedBackendToolPortalConfig,
			createControllerHostActionBackend: () => ({
				call: async () => PortalCallResultSchema.parse({ items: [], ok: true }),
				describe: async () =>
					PortalDescribeResultSchema.parse({
						items: [
							{
								id: 'describe-all',
								status: 'ok',
								value: { tools: [] },
							},
						],
						ok: true,
					}),
				list: async () =>
					PortalListResultSchema.parse({
						items: [
							{
								id: 'list-all',
								status: 'ok',
								value: {
									namespaces: ['controller_host_action'],
									tools: [],
								},
							},
						],
						ok: true,
					}),
				search: async () =>
					PortalSearchResultSchema.parse({
						items: [
							{
								id: 'search-all',
								status: 'ok',
								value: { tools: [] },
							},
						],
						ok: true,
					}),
			}),
			createMcpBackend: () => ({
				call: async () => PortalCallResultSchema.parse({ items: [], ok: true }),
				describe: async () =>
					PortalDescribeResultSchema.parse({
						auditCorrelationId: 'mcp-audit-describe',
						diagnostics: [topLevelDiagnostic],
						items: [
							{
								diagnostics: [itemDiagnostic],
								error: discoveryError,
								id: 'describe-all',
								status: 'error',
							},
						],
						ok: false,
					}),
				list: async () =>
					PortalListResultSchema.parse({
						auditCorrelationId: 'mcp-audit-list',
						diagnostics: [topLevelDiagnostic],
						items: [
							{
								diagnostics: [itemDiagnostic],
								error: discoveryError,
								id: 'list-all',
								status: 'error',
							},
						],
						ok: false,
					}),
				search: async () =>
					PortalSearchResultSchema.parse({
						auditCorrelationId: 'mcp-audit-search',
						diagnostics: [topLevelDiagnostic],
						items: [
							{
								diagnostics: [itemDiagnostic],
								error: discoveryError,
								id: 'search-all',
								status: 'error',
							},
						],
						ok: false,
					}),
			}),
		});

		const listResult = PortalListResultSchema.parse(
			await portal.list({ requests: [{ id: 'list-all' }] }),
		);
		const searchResult = PortalSearchResultSchema.parse(
			await portal.search({ requests: [{ id: 'search-all' }] }),
		);
		const describeResult = PortalDescribeResultSchema.parse(
			await portal.describe({ requests: [{ id: 'describe-all' }] }),
		);

		expect(listResult).toMatchObject({
			auditCorrelationId: 'mcp-audit-list',
			diagnostics: [topLevelDiagnostic],
			items: [
				{
					diagnostics: [itemDiagnostic],
					error: discoveryError,
					id: 'list-all',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(searchResult).toMatchObject({
			auditCorrelationId: 'mcp-audit-search',
			diagnostics: [topLevelDiagnostic],
			items: [{ error: discoveryError, id: 'search-all', status: 'error' }],
			ok: false,
		});
		expect(describeResult).toMatchObject({
			auditCorrelationId: 'mcp-audit-describe',
			diagnostics: [topLevelDiagnostic],
			items: [{ error: discoveryError, id: 'describe-all', status: 'error' }],
			ok: false,
		});
	});
});
