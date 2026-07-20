import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it } from 'vitest';

import {
	createServiceFixture,
	semanticSnapshot,
	udsOptions,
} from './tool-portal-service-test-fixture.js';

describe('ToolPortalCapabilityCore catalog routing', () => {
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

	it('selects mcp_provider, controller_host_action, and tool_vm_runner backend ports without a second router', async () => {
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
						namespace: 'controller_host_action',
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
		expect(fixture.controllerHostAction.invocations).toHaveLength(1);
		expect(fixture.toolVmRunner.invocations).toHaveLength(1);
		expect(
			PortalCallRequestSchema.parse(fixture.mcpProvider.invocations[0]?.request).calls,
		).toHaveLength(1);
		expect(
			PortalCallRequestSchema.parse(fixture.controllerHostAction.invocations[0]?.request).calls,
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
			controllerHostActionInvocationCount: fixture.controllerHostAction.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerHostActionInvocationCount: 0,
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
			controllerHostActionInvocationCount: fixture.controllerHostAction.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerHostActionInvocationCount: 0,
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
			controllerHostActionRequest: fixture.controllerHostAction.invocations[0]?.request,
			mcpProviderRequest: fixture.mcpProvider.invocations[0]?.request,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerRequest: fixture.toolVmRunner.invocations[0]?.request,
		}).toEqual({
			controllerHostActionRequest: request,
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
			controllerHostActionInvocationCount: fixture.controllerHostAction.invocations.length,
			mcpProviderInvocationCount: fixture.mcpProvider.invocations.length,
			mcpProviderRequest,
			resultItemIds: result.items.map(({ id }) => id),
			toolVmRunnerInvocationCount: fixture.toolVmRunner.invocations.length,
			toolVmRunnerRequest,
		}).toEqual({
			controllerHostActionInvocationCount: 0,
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
