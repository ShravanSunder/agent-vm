import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import {
	oauthAccountProfileToolRequirementSchema,
	oauthToolAvailabilityBatchResultSchema,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createRecordingApprovalPort,
	createRecordingBackendPort,
	createServiceFixture,
	mixedBackendConfig,
	semanticSnapshot,
	udsOptions,
} from './tool-portal-service-test-fixture.js';
import { createManagedToolPortalCapabilityCore } from './tool-portal-service.js';

describe('ToolPortalCapabilityCore catalog routing', () => {
	it.each([
		['ready', false],
		['authorization-status-unavailable', true],
	] as const)(
		'attaches %s OAuth availability to a visible static requirement',
		async (expectedAvailabilityKind, failStatusLookup) => {
			// Arrange
			const config = gatewayRuntimeManagedToolPortalConfigSchema.parse({
				agents: { 'agent-a': { profile: 'code-builder' } },
				mode: 'managed',
				profiles: {
					'code-builder': {
						namespaces: {
							gog: {
								backend: {
									kind: 'controller_execution',
									operations: {
										gog_cli: {
											authorization: {
												kind: 'oauth_account_profile',
												rules: [
													{
														match: { flags: [], path: ['gmail', 'search'] },
														requirement: {
															applicationId: 'gmail-app',
															kind: 'oauth',
															minimumPermission: 'read',
															serviceId: 'gmail',
														},
													},
												],
											},
											calls: {
												deny: [],
												requiresApproval: [],
												withoutApproval: 'remaining_admitted',
											},
											commands: [{ flagRules: [], path: ['gmail', 'search'] }],
											deniedPatterns: [],
											kind: 'configured_cli',
											safeHelp: 'Search Gmail.',
											stdin: { kind: 'none' },
											targetKind: 'ephemeral_managed_vm',
											timeout: { kind: 'quick' },
										},
									},
								},
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['gog_cli'] },
								},
								discovery: { summary: 'Use Gog with assigned Google accounts.' },
								tools: { allow: ['gog_cli'] },
							},
						},
					},
				},
				schemaVersion: 1,
			});
			const oauthSemanticSnapshot = {
				...semanticSnapshot,
				agentProjections: {
					'agent-a': {
						...semanticSnapshot.agentProjections['agent-a'],
						toolPortalNamespaces: [{ namespace: 'gog', summary: 'Use Gog.' }],
					},
				},
				surfaceEligibilityByProfile: { 'code-builder': { gog: ['protected_uds'] } },
			} satisfies GatewayRuntimePortalSemanticSnapshot;
			const controllerExecution = createRecordingBackendPort('controller_execution', 'gog', {
				toolName: 'gog_cli',
			});
			const requirement = oauthAccountProfileToolRequirementSchema.parse({
				applicationId: 'gmail-app',
				kind: 'oauth-account-profile',
				minimumPermission: 'read',
				serviceId: 'gmail',
			});
			const resolve = vi.fn(async () => {
				if (failStatusLookup) throw new Error('controller unavailable');
				return oauthToolAvailabilityBatchResultSchema.parse({
					items: [
						{
							availability: {
								accountProfiles: [
									{
										accountLabel: 'Personal Google',
										accountProfileId: 'personal-google',
									},
								],
								kind: 'ready' as const,
							},
							requirement,
						},
					],
				});
			});
			const core = createManagedToolPortalCapabilityCore({
				approvalPort: createRecordingApprovalPort().port,
				backendPorts: {
					controllerExecution: controllerExecution.port,
					mcpProvider: createRecordingBackendPort('mcp_provider', 'unused').port,
					toolVmRunner: createRecordingBackendPort('tool_vm_runner', 'unused').port,
				},
				config,
				oauthAvailabilityPort: { resolve },
				semanticSnapshot: oauthSemanticSnapshot,
			});

			// Act
			const result = await core.search(
				PortalSearchRequestSchema.parse({
					requests: [{ id: 'search-gog', namespaces: ['gog'], query: 'gmail' }],
				}),
				udsOptions(),
			);

			// Assert
			const item = result.items[0];
			if (item?.status !== 'ok') throw new Error('Expected successful OAuth search result.');
			expect(item.value.tools[0]).toMatchObject({
				oauthAvailability: { kind: expectedAvailabilityKind },
				oauthRequirement: {
					applicationId: 'gmail-app',
					kind: 'oauth-account-profile',
					minimumPermission: 'read',
					serviceId: 'gmail',
				},
			});
			expect(resolve).toHaveBeenCalledTimes(1);
		},
	);

	it('rejects authored managed policy that has not passed through effective discovery compilation', () => {
		// Arrange
		const { discovery: _discovery, ...authoredGithubPolicy } =
			mixedBackendConfig.profiles['code-builder'].namespaces.github;
		const authoredConfig = {
			...mixedBackendConfig,
			profiles: {
				...mixedBackendConfig.profiles,
				'code-builder': {
					...mixedBackendConfig.profiles['code-builder'],
					namespaces: {
						...mixedBackendConfig.profiles['code-builder'].namespaces,
						github: authoredGithubPolicy,
					},
				},
			},
		};
		const approval = createRecordingApprovalPort();
		const controllerExecution = createRecordingBackendPort(
			'controller_execution',
			'controller_execution',
		);
		const mcpProvider = createRecordingBackendPort('mcp_provider', 'github');
		const toolVmRunner = createRecordingBackendPort('tool_vm_runner', 'sandbox');
		const untypedCreateCapabilityCore: unknown = createManagedToolPortalCapabilityCore;
		if (typeof untypedCreateCapabilityCore !== 'function') {
			throw new Error('Expected the managed Tool Portal capability-core factory.');
		}

		// Act
		const createFromAuthoredPolicy = (): unknown =>
			Reflect.apply(untypedCreateCapabilityCore, undefined, [
				{
					approvalPort: approval.port,
					backendPorts: {
						controllerExecution: controllerExecution.port,
						mcpProvider: mcpProvider.port,
						toolVmRunner: toolVmRunner.port,
					},
					config: authoredConfig,
					semanticSnapshot,
				},
			]);

		// Assert
		expect(createFromAuthoredPolicy).toThrow(/discovery/u);
	});

	it('owns one immutable semantic snapshot and serves all four operations with trusted options', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const serviceInvocationOptions = udsOptions();
		const backendInvocationOptions = {
			surfaceClass: serviceInvocationOptions.surfaceClass,
			trustedContext: serviceInvocationOptions.origin.trustedContext,
		};

		// Act
		await fixture.capabilityCore.list(
			PortalListRequestSchema.parse({
				requests: [{ id: 'list-github', namespaces: ['github'] }],
			}),
			udsOptions(),
		);
		await fixture.capabilityCore.search(
			PortalSearchRequestSchema.parse({
				requests: [{ id: 'search-github', namespaces: ['github'], query: 'issue' }],
			}),
			udsOptions(),
		);
		await fixture.capabilityCore.describe(
			PortalDescribeRequestSchema.parse({
				requests: [{ id: 'describe-github', refs: ['github.get_issue'] }],
			}),
			udsOptions(),
		);
		await fixture.capabilityCore.call(
			{
				calls: [
					{ arguments: { number: 42 }, id: 'call-github', namespace: 'github', name: 'get_issue' },
				],
			},
			udsOptions(),
		);

		// Assert
		expect(fixture.capabilityCore.semanticSnapshot).toEqual(semanticSnapshot);
		expect(Object.isFrozen(fixture.capabilityCore.semanticSnapshot)).toBe(true);
		expect(Object.isFrozen(fixture.capabilityCore.semanticSnapshot.agentProjections)).toBe(true);
		expect(
			Object.isFrozen(fixture.capabilityCore.semanticSnapshot.surfaceEligibilityByProfile),
		).toBe(true);
		expect(fixture.mcpProvider.invocations.map(({ operation }) => operation)).toEqual([
			'list',
			'search',
			'describe',
			'call',
		]);
		expect(fixture.mcpProvider.invocations.slice(0, 3).map(({ options }) => options)).toEqual([
			backendInvocationOptions,
			backendInvocationOptions,
			backendInvocationOptions,
		]);
		expect(fixture.mcpProvider.invocations[3]?.options).toMatchObject({
			...backendInvocationOptions,
			dispatchAuthority: { kind: 'without-approval' },
		});
	});

	it('selects mcp_provider, controller_execution, and tool_vm_runner backend ports without a second router', async () => {
		// Arrange
		const fixture = createServiceFixture();

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{ arguments: {}, id: 'mcp-call', namespace: 'github', name: 'get_issue' },
					{
						arguments: {},
						id: 'host-call',
						namespace: 'controller_execution',
						name: 'workspace_git_push',
					},
					{ arguments: {}, id: 'vm-call', namespace: 'sandbox', name: 'exec' },
				],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items.map(({ id }) => id)).toEqual(['mcp-call', 'host-call', 'vm-call']);
		expect(fixture.mcpProvider.invocations).toHaveLength(1);
		expect(fixture.controllerExecution.invocations).toHaveLength(1);
		expect(fixture.toolVmRunner.invocations).toHaveLength(1);
		expect(
			PortalCallRequestSchema.parse(fixture.mcpProvider.invocations[0]?.request).calls,
		).toHaveLength(1);
		expect(
			PortalCallRequestSchema.parse(fixture.controllerExecution.invocations[0]?.request).calls,
		).toHaveLength(1);
		expect(
			PortalCallRequestSchema.parse(fixture.toolVmRunner.invocations[0]?.request).calls,
		).toHaveLength(1);
	});

	it('admits only namespace-intersecting list cohorts to each backend port', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const request = PortalListRequestSchema.parse({
			requestId: 'list-batch',
			requests: [
				{ id: 'list-github', namespaces: ['github'] },
				{ id: 'list-sandbox', namespaces: ['sandbox'] },
			],
		});

		// Act
		const result = await fixture.capabilityCore.list(request, udsOptions());
		const mcpProviderRequest = PortalListRequestSchema.parse(
			fixture.mcpProvider.invocations[0]?.request,
		);
		const toolVmRunnerRequest = PortalListRequestSchema.parse(
			fixture.toolVmRunner.invocations[0]?.request,
		);

		// Assert
		expect({
			controllerExecutionInvocationCount: fixture.controllerExecution.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerExecutionInvocationCount: 0,
			mcpProviderInvocationCount: 1,
			mcpProviderRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'list-github'),
			},
			resultItemIds: request.requests.map(({ id }) => id),
			toolVmRunnerInvocationCount: 1,
			toolVmRunnerRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'list-sandbox'),
			},
		});
	});

	it('attaches one effective namespace-discovery projection only after backend list, search, and describe results return', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const expectedNamespaceDiscovery = [
			{ namespace: 'controller_execution', summary: 'Controller-operated repository actions.' },
			{ namespace: 'github', summary: 'GitHub repository tools.' },
			{ namespace: 'sandbox', summary: 'Leased Tool VM operations.' },
		];

		// Act
		const [listResult, searchResult, describeResult] = await Promise.all([
			fixture.capabilityCore.list({ requests: [{ id: 'list', limit: 20 }] }, udsOptions()),
			fixture.capabilityCore.search(
				{ requests: [{ id: 'search', limit: 20, query: 'issue', schemaDetail: 'summary' }] },
				udsOptions(),
			),
			fixture.capabilityCore.describe(
				{
					requests: [
						{
							id: 'describe',
							includeJsonSchema: false,
							includeRelated: false,
							includeTypescriptHelper: false,
							includeZod: false,
						},
					],
				},
				udsOptions(),
			),
		]);
		const backendListResult = await fixture.mcpProvider.port.list(
			{ requests: [{ id: 'backend-list', limit: 20 }] },
			{ surfaceClass: 'protected_uds', trustedContext: udsOptions().origin.trustedContext },
		);

		// Assert
		expect(listResult.items).toEqual([
			expect.objectContaining({
				value: expect.objectContaining({ namespaceDiscovery: expectedNamespaceDiscovery }),
			}),
		]);
		for (const result of [searchResult, describeResult]) {
			expect(result.items).toEqual([
				expect.objectContaining({
					value: expect.objectContaining({ namespaceDiscovery: expectedNamespaceDiscovery }),
				}),
			]);
		}
		expect(backendListResult.items).toEqual([
			expect.objectContaining({ value: { namespaces: ['github'], tools: [] } }),
		]);
		expect(backendListResult.items[0]).not.toHaveProperty('namespaceDiscovery');
		expect(
			backendListResult.items[0]?.status === 'ok' && backendListResult.items[0].value,
		).not.toHaveProperty('namespaceDiscovery');
	});

	it('projects authored call disposition onto visible search summaries', async () => {
		// Arrange
		const withoutApprovalFixture = createServiceFixture();
		const requiresApprovalFixture = createServiceFixture({
			controllerExecution: createRecordingBackendPort(
				'controller_execution',
				'controller_execution',
				{ toolName: 'controller_host_probe' },
			),
		});

		// Act
		const [withoutApprovalResult, requiresApprovalResult] = await Promise.all([
			withoutApprovalFixture.capabilityCore.search(
				{
					requests: [
						{
							id: 'without-approval',
							limit: 20,
							namespaces: ['github'],
							query: 'issue',
							schemaDetail: 'summary',
						},
					],
				},
				udsOptions(),
			),
			requiresApprovalFixture.capabilityCore.search(
				{
					requests: [
						{
							id: 'requires-approval',
							limit: 20,
							namespaces: ['controller_execution'],
							query: 'probe',
							schemaDetail: 'summary',
						},
					],
				},
				udsOptions(),
			),
		]);
		const withoutApprovalTool =
			withoutApprovalResult.items[0]?.status === 'ok'
				? withoutApprovalResult.items[0].value.tools[0]
				: undefined;
		const requiresApprovalTool =
			requiresApprovalResult.items[0]?.status === 'ok'
				? requiresApprovalResult.items[0].value.tools[0]
				: undefined;

		// Assert
		expect(withoutApprovalTool?.callDisposition).toEqual({ kind: 'without-approval' });
		expect(requiresApprovalTool?.callDisposition).toEqual({ kind: 'requires-approval' });
	});

	it('projects represented discovery for successful search and describe items without fabricating metadata on partial errors', async () => {
		// Arrange
		const controllerExecution = createRecordingBackendPort(
			'controller_execution',
			'controller_execution',
			{
				readErrorOperations: ['describe', 'search'],
				toolName: 'workspace_git_push',
			},
		);
		const fixture = createServiceFixture({ controllerExecution });
		const expectedGithubDiscovery = [{ namespace: 'github', summary: 'GitHub repository tools.' }];

		// Act
		const [searchResult, describeResult] = await Promise.all([
			fixture.capabilityCore.search(
				{
					requests: [
						{
							id: 'search-success',
							limit: 20,
							namespaces: ['github'],
							query: 'issue',
							schemaDetail: 'summary',
						},
						{
							id: 'search-error',
							limit: 20,
							namespaces: ['controller_execution'],
							query: 'workspace',
							schemaDetail: 'summary',
						},
					],
				},
				udsOptions(),
			),
			fixture.capabilityCore.describe(
				{
					requests: [
						{
							id: 'describe-success',
							includeJsonSchema: false,
							includeRelated: false,
							includeTypescriptHelper: false,
							includeZod: false,
							tools: [{ name: 'get_issue', namespace: 'github' }],
						},
						{
							id: 'describe-error',
							includeJsonSchema: false,
							includeRelated: false,
							includeTypescriptHelper: false,
							includeZod: false,
							tools: [{ name: 'workspace_git_push', namespace: 'controller_execution' }],
						},
					],
				},
				udsOptions(),
			),
		]);

		// Assert
		for (const result of [searchResult, describeResult]) {
			expect(result.ok).toBe(false);
			expect(result.items[0]).toMatchObject({
				status: 'ok',
				value: { namespaceDiscovery: expectedGithubDiscovery },
			});
			expect(result.items[1]).toMatchObject({
				error: { code: 'provider_unavailable' },
				status: 'error',
			});
			expect(result.items[1]).not.toHaveProperty('value');
			expect(JSON.stringify(result.items[1])).not.toContain('namespaceDiscovery');
		}
	});

	it('admits only namespace-intersecting search cohorts to each backend port', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const request = PortalSearchRequestSchema.parse({
			requestId: 'search-batch',
			requests: [
				{ id: 'search-github', namespaces: ['github'], query: 'issue' },
				{ id: 'search-sandbox', namespaces: ['sandbox'], query: 'process' },
			],
		});

		// Act
		const result = await fixture.capabilityCore.search(request, udsOptions());
		const mcpProviderRequest = PortalSearchRequestSchema.parse(
			fixture.mcpProvider.invocations[0]?.request,
		);
		const toolVmRunnerRequest = PortalSearchRequestSchema.parse(
			fixture.toolVmRunner.invocations[0]?.request,
		);

		// Assert
		expect({
			controllerExecutionInvocationCount: fixture.controllerExecution.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerExecutionInvocationCount: 0,
			mcpProviderInvocationCount: 1,
			mcpProviderRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'search-github'),
			},
			resultItemIds: request.requests.map(({ id }) => id),
			toolVmRunnerInvocationCount: 1,
			toolVmRunnerRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'search-sandbox'),
			},
		});
	});

	it('treats an explicit empty search namespace list as all authorized namespaces', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const request = PortalSearchRequestSchema.parse({
			requestId: 'search-all',
			requests: [{ id: 'search-all', namespaces: [], query: 'tool' }],
		});

		// Act
		const result = await fixture.capabilityCore.search(request, udsOptions());

		// Assert
		expect({
			controllerExecutionRequest: fixture.controllerExecution.invocations[0]?.request,
			mcpProviderRequest: fixture.mcpProvider.invocations[0]?.request,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerRequest: fixture.toolVmRunner.invocations[0]?.request,
		}).toEqual({
			controllerExecutionRequest: request,
			mcpProviderRequest: request,
			resultItemIds: ['search-all'],
			toolVmRunnerRequest: request,
		});
	});

	it('admits only namespace-intersecting describe cohorts to each backend port', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const request = PortalDescribeRequestSchema.parse({
			requestId: 'describe-batch',
			requests: [
				{
					id: 'describe-github',
					tools: [{ name: 'get_issue', namespace: 'github' }],
				},
				{
					id: 'describe-sandbox',
					tools: [{ name: 'exec', namespace: 'sandbox' }],
				},
			],
		});

		// Act
		const result = await fixture.capabilityCore.describe(request, udsOptions());
		const mcpProviderRequest = PortalDescribeRequestSchema.parse(
			fixture.mcpProvider.invocations[0]?.request,
		);
		const toolVmRunnerRequest = PortalDescribeRequestSchema.parse(
			fixture.toolVmRunner.invocations[0]?.request,
		);

		// Assert
		expect({
			controllerExecutionInvocationCount: fixture.controllerExecution.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerExecutionInvocationCount: 0,
			mcpProviderInvocationCount: 1,
			mcpProviderRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'describe-github'),
			},
			resultItemIds: request.requests.map(({ id }) => id),
			toolVmRunnerInvocationCount: 1,
			toolVmRunnerRequest: {
				...request,
				requests: request.requests.filter(({ id }) => id === 'describe-sandbox'),
			},
		});
	});
});
