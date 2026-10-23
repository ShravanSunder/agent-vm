import { createUpstreamMcpError } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { PortalCallResultSchema } from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
	createBackendFixture,
	createFactoryFixture,
	defaultProjection,
} from '#gateway-runtime/backends/managed-mcp-provider-test-fixture';

describe('managed MCP provider calls', () => {
	it('keeps direct Hermes and Tool Portal session provenance at the actual upstream edge', async () => {
		const observed: string[] = [];
		const factory = await createFactoryFixture({
			callUpstreamTool: async (call) => {
				observed.push(call.agentScopeId);
				return { ok: true };
			},
		});
		const direct = factory.createBackend(defaultProjection);
		const sessionA = factory.createBackend(defaultProjection, {
			portalAgentScopeSource: 'tool-portal-service',
			sessionKey: 'session-a',
		});
		const sessionB = factory.createBackend(defaultProjection, {
			portalAgentScopeSource: 'tool-portal-service',
			sessionKey: 'session-b',
		});
		const request = {
			calls: [{ id: 'call', namespace: 'github', name: 'get_issue', arguments: { number: 1 } }],
		};
		expect((await direct.call(request)).ok).toBe(true);
		expect((await sessionA.call(request)).ok).toBe(true);
		expect((await sessionB.call(request)).ok).toBe(true);
		expect(observed).toEqual([
			'mcp-provider:agent-a',
			'mcp-provider:agent-a\nsession-a',
			'mcp-provider:agent-a\nsession-b',
		]);
	});
	it('normalizes allowed calls through MCP Portal core and preserves item ids', async () => {
		const backend = await createBackendFixture();

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					id: 'read-issue',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'ok',
					value: {
						namespace: 'github',
						result: {
							arguments: { number: 42 },
							ok: true,
							upstreamTool: 'github.get_issue',
						},
						name: 'get_issue',
					},
				},
			],
			ok: true,
		});
	});
	it('preserves service-owned operation identities supplied through private call options', async () => {
		// Arrange
		const backend = await createBackendFixture();
		const operationId = '60000000-0000-4000-8000-000000000006';

		// Act
		const result = PortalCallResultSchema.parse(
			await Reflect.apply(backend.call, backend, [
				{
					calls: [
						{
							arguments: { number: 42 },
							id: 'read-issue',
							name: 'get_issue',
							namespace: 'github',
						},
					],
				},
				{ operationIdsByCallId: { 'read-issue': operationId } },
			]),
		);

		// Assert
		expect(result.items[0]?.operationId).toBe(operationId);
	});
	it('preserves a complete private operation identity map for a standalone batch', async () => {
		// Arrange
		const backend = await createBackendFixture();
		const operationIdsByCallId = {
			'read-first': '60000000-0000-4000-8000-000000000006',
			'read-second': '70000000-0000-4000-8000-000000000007',
		};

		// Act
		const result = PortalCallResultSchema.parse(
			await Reflect.apply(backend.call, backend, [
				{
					calls: Object.keys(operationIdsByCallId).map((id, index) => ({
						arguments: { number: index + 1 },
						id,
						name: 'get_issue',
						namespace: 'github',
					})),
				},
				{ operationIdsByCallId },
			]),
		);

		// Assert
		expect(Object.fromEntries(result.items.map((item) => [item.id, item.operationId]))).toEqual(
			operationIdsByCallId,
		);
	});
	it.each([
		{
			name: 'missing call id',
			operationIdsByCallId: { other: '60000000-0000-4000-8000-000000000006' },
		},
		{
			name: 'extra call id',
			operationIdsByCallId: {
				'read-issue': '60000000-0000-4000-8000-000000000006',
				extra: '70000000-0000-4000-8000-000000000007',
			},
		},
		{
			name: 'invalid operation id',
			operationIdsByCallId: { 'read-issue': 'not-an-operation-id' },
		},
	])('rejects a $name operation identity map before upstream dispatch', async (fixture) => {
		// Arrange
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = await createBackendFixture({ callUpstreamTool });

		// Act / Assert
		await expect(
			Reflect.apply(backend.call, backend, [
				{
					calls: [
						{
							arguments: { number: 42 },
							id: 'read-issue',
							name: 'get_issue',
							namespace: 'github',
						},
					],
				},
				{ operationIdsByCallId: fixture.operationIdsByCallId },
			]),
		).rejects.toThrow('operation identity map');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	it('maps upstream call failures to model-safe error codes', async () => {
		const callUpstreamTool = vi.fn(async () => {
			throw new Error(
				'Missing environment secret PERPLEXITY_API_KEY at /Users/alice/.config/tool using https://api.example.test via /usr/local/bin/provider',
			);
		});
		const backend = await createBackendFixture({
			callUpstreamTool,
		});

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'execution_failed',
						message: 'Capability execution failed.',
					},
					id: 'read-issue',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'side-effects-and-termination-unknown',
						kind: 'ambiguous',
						retryClass: 'forbidden',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(callUpstreamTool).toHaveBeenCalledTimes(1);
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toContain('PERPLEXITY_API_KEY');
		expect(serializedResult).not.toContain('/Users/alice');
		expect(serializedResult).not.toContain('api.example.test');
		expect(serializedResult).not.toContain('/usr/local/bin/provider');
	});
	it('gives the model a safe actionable error for remote MCP authentication failures', async () => {
		// Arrange
		const callUpstreamTool = vi.fn(async () => {
			throw createUpstreamMcpError({
				causeMessage: 'Error POSTing to endpoint: credential detail must not escape',
				elapsedMs: 12,
				failureClass: 'authentication',
				httpStatusCode: 401,
				namespace: 'github',
				operation: 'MCP callTool github.get_issue',
				phase: 'call_tool',
				toolName: 'get_issue',
				transport: { kind: 'streamable-http', url: 'https://provider.example.test/mcp' },
			});
		});
		const backend = await createBackendFixture({ callUpstreamTool });

		// Act
		const result = await backend.call({
			calls: [
				{
					arguments: { number: 42 },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		// Assert
		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'not_authorized',
						message:
							'Remote capability authentication failed. Ask the operator to verify its provider credential.',
					},
					id: 'read-issue',
					status: 'error',
				},
			],
			ok: false,
		});
		const serializedResult = JSON.stringify(result);
		expect(serializedResult).not.toContain('credential detail');
		expect(serializedResult).not.toContain('provider.example.test');
	});
	it.each([
		{
			expectedCode: 'not_authorized',
			expectedMessage: 'Remote capability provider denied access.',
			expectedRetryable: undefined,
			failureClass: 'authorization',
		},
		{
			expectedCode: 'validation_failed',
			expectedMessage: 'Remote capability provider rejected the request.',
			expectedRetryable: undefined,
			failureClass: 'invalid_request',
		},
		{
			expectedCode: 'provider_unavailable',
			expectedMessage: 'Remote capability provider is rate limited.',
			expectedRetryable: true,
			failureClass: 'rate_limit',
		},
		{
			expectedCode: 'provider_unavailable',
			expectedMessage: 'Remote capability provider failed.',
			expectedRetryable: true,
			failureClass: 'provider_error',
		},
		{
			expectedCode: 'execution_failed',
			expectedMessage:
				'Remote capability reported an execution error: Input validation failed at $.search_recency: expected day, week, or month.',
			expectedRetryable: undefined,
			failureClass: 'tool_error',
		},
	] as const)(
		'maps remote MCP $failureClass failures to a safe model-facing error',
		async ({ expectedCode, expectedMessage, expectedRetryable, failureClass }) => {
			// Arrange
			const callUpstreamTool = vi.fn(async () => {
				throw createUpstreamMcpError({
					causeMessage: 'provider response detail must not escape',
					elapsedMs: 12,
					failureClass,
					namespace: 'github',
					operation: 'MCP callTool github.get_issue',
					phase: 'call_tool',
					...(failureClass === 'tool_error'
						? {
								providerErrorMessage:
									'Input validation failed at $.search_recency: expected day, week, or month.',
							}
						: {}),
					toolName: 'get_issue',
					transport: { kind: 'streamable-http', url: 'https://provider.example.test/mcp' },
				});
			});
			const backend = await createBackendFixture({ callUpstreamTool });

			// Act
			const result = await backend.call({
				calls: [
					{
						arguments: { number: 42 },
						id: 'read-issue',
						namespace: 'github',
						name: 'get_issue',
					},
				],
			});

			// Assert
			const parsedResult = PortalCallResultSchema.parse(result);
			const firstItem = parsedResult.items[0];
			expect(firstItem).toMatchObject({
				error: {
					code: expectedCode,
					message: expect.stringContaining(expectedMessage),
				},
				status: 'error',
			});
			if (firstItem?.status !== 'error') throw new Error('Expected an error item.');
			expect(firstItem.error.retryable).toBe(expectedRetryable);
			expect(JSON.stringify(parsedResult)).not.toContain('provider response detail');
		},
	);
	it('maps upstream input validation failures to schema errors on the capability surface', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = await createBackendFixture({ callUpstreamTool });

		const result = await backend.call({
			calls: [
				{
					arguments: { number: 'not-a-number' },
					id: 'read-issue',
					namespace: 'github',
					name: 'get_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'validation_failed',
						message: expect.stringMatching(/number.*expected number/u),
					},
					id: 'read-issue',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(JSON.stringify(result)).toContain('validation_failed');
		expect(JSON.stringify(result)).not.toContain('Capability execution failed');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	it('requires approval for projected write calls and rejects model-supplied tokens', async () => {
		const callUpstreamTool = vi.fn(async () => ({ ok: true }));
		const backend = await createBackendFixture({ callUpstreamTool });

		const result = await backend.call({
			calls: [
				{
					arguments: { title: 'Write' },
					id: 'create-issue',
					namespace: 'github',
					name: 'create_issue',
				},
			],
		});

		expect(PortalCallResultSchema.parse(result)).toMatchObject({
			items: [
				{
					error: {
						code: 'approval_required',
					},
					id: 'create-issue',
					operationId: expect.stringMatching(/\S+/u),
					outcome: {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					},
					owningGeneration: 'mcp-provider:agent-a',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(callUpstreamTool).not.toHaveBeenCalled();

		await expect(
			backend.call({
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
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
});
