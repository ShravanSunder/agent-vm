import {
	SANDBOX_METHOD_CONTRACTS,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayRuntimePrivateUdsDispatcher,
	resolveGatewayRuntimeOperationGroup,
	type GatewayRuntimeTraceContextDispatch,
} from './gateway-runtime-private-uds-dispatcher.js';

const trustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment-a-1',
		toolPortalProfileId: 'profile-a',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} satisfies GatewayRuntimeTrustedInvocationContext;

const sampledTraceContext = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
	tracestate: '\tvendor=opaque-value,\t, tenant@system=value-2\t',
} as const;

const unsampledTraceContext = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
} as const;

describe('Gateway runtime private UDS dispatcher', () => {
	it('maps every frozen method family to one server-authorized operation group', () => {
		// Arrange
		const expectedGroups = new Map([
			['portal.list', 'portal'],
			['artifact.read', 'artifact.read'],
			['sandbox.environment.open', 'sandbox.environment'],
			['sandbox.exec.start', 'sandbox.execution'],
			['sandbox.fs.read', 'sandbox.filesystem'],
			['sandbox.process.start', 'sandbox.process'],
			['sandbox.retained-result.lookup', 'sandbox.retained-results'],
			['sandbox.stream.read', 'sandbox.stream'],
			['sandbox.terminal.attach', 'sandbox.terminal'],
		]);

		// Act
		const resolvedGroups = [...expectedGroups.keys()].map((method) => [
			method,
			resolveGatewayRuntimeOperationGroup(method),
		]);

		// Assert
		expect(resolvedGroups).toEqual([...expectedGroups.entries()]);
		expect(resolveGatewayRuntimeOperationGroup('unknown.method')).toBeUndefined();
		expect(
			Object.keys(SANDBOX_METHOD_CONTRACTS).map((method) => [
				method,
				resolveGatewayRuntimeOperationGroup(method),
			]),
		).toEqual([
			['sandbox.environment.close', 'sandbox.environment'],
			['sandbox.environment.open', 'sandbox.environment'],
			['sandbox.environment.status', 'sandbox.environment'],
			['sandbox.exec.cancel', 'sandbox.execution'],
			['sandbox.exec.start', 'sandbox.execution'],
			['sandbox.exec.wait', 'sandbox.execution'],
			['sandbox.retained-result.lookup', 'sandbox.retained-results'],
			['sandbox.fs.list', 'sandbox.filesystem'],
			['sandbox.fs.mkdir', 'sandbox.filesystem'],
			['sandbox.fs.read', 'sandbox.filesystem'],
			['sandbox.fs.remove', 'sandbox.filesystem'],
			['sandbox.fs.rename', 'sandbox.filesystem'],
			['sandbox.fs.stat', 'sandbox.filesystem'],
			['sandbox.fs.write', 'sandbox.filesystem'],
			['sandbox.process.cancel', 'sandbox.process'],
			['sandbox.process.logs', 'sandbox.process'],
			['sandbox.process.start', 'sandbox.process'],
			['sandbox.process.status', 'sandbox.process'],
			['sandbox.process.wait', 'sandbox.process'],
			['sandbox.stream.close', 'sandbox.stream'],
			['sandbox.stream.read', 'sandbox.stream'],
			['sandbox.stream.write', 'sandbox.stream'],
			['sandbox.terminal.attach', 'sandbox.terminal'],
			['sandbox.terminal.resize', 'sandbox.terminal'],
		]);
	});

	it('validates the trusted envelope and routes portal plus sandbox calls through one projection', async () => {
		// Arrange
		const list = vi.fn(async () => ({
			items: [{ id: 'list-1', status: 'ok' as const, value: { namespaces: [], tools: [] } }],
			ok: true,
		}));
		const sandboxDispatch = vi.fn(async () => ({
			environment: {
				handleId: 'environment-1',
				kind: 'environment' as const,
				owningGeneration: 'environment-generation-1',
			},
			kind: 'opened' as const,
			logicalCwd: 'workspace',
		}));
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: {
				call: vi.fn(),
				describe: vi.fn(),
				list,
				search: vi.fn(),
			},
			sandboxDispatch,
		});

		// Act
		const listResult = await dispatcher.dispatch({
			connectionId: 'connection-1',
			method: 'portal.list',
			params: {
				publicRequest: { requests: [{ id: 'list-1', limit: 20, namespaces: [] }] },
				trustedContext,
			},
			signal: new AbortController().signal,
		});
		const sandboxResult = await dispatcher.dispatch({
			connectionId: 'connection-1',
			method: 'sandbox.environment.open',
			params: {
				publicRequest: { logicalCwd: 'workspace' },
				trustedContext,
			},
			signal: new AbortController().signal,
		});

		// Assert
		expect(listResult).toMatchObject({ ok: true });
		expect(list).toHaveBeenCalledWith({
			publicRequest: { requests: [{ id: 'list-1', limit: 20, namespaces: [] }] },
			trustedContext,
		});
		expect(sandboxResult).toMatchObject({ kind: 'opened' });
		expect(sandboxDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				method: 'sandbox.environment.open',
				publicRequest: { logicalCwd: 'workspace' },
				trustedContext,
			}),
		);
	});

	it('delivers validated sampled and unsampled context through one narrow dispatch wrapper', async () => {
		// Arrange
		const traceDispatches: Parameters<GatewayRuntimeTraceContextDispatch>[0][] = [];
		const traceContextDispatch: GatewayRuntimeTraceContextDispatch = async (options, dispatch) => {
			traceDispatches.push(options);
			return await dispatch();
		};
		const list = vi.fn(async () => ({ items: [], ok: true as const }));
		const sandboxDispatch = vi.fn(async () => ({
			environment: {
				handleId: 'environment-1',
				kind: 'environment' as const,
				owningGeneration: 'environment-generation-1',
			},
			kind: 'opened' as const,
			logicalCwd: 'workspace',
		}));
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: { call: vi.fn(), describe: vi.fn(), list, search: vi.fn() },
			sandboxDispatch,
			traceContextDispatch,
		});

		// Act
		await dispatcher.dispatch({
			connectionId: 'connection-1',
			method: 'portal.list',
			params: {
				publicRequest: { requests: [{ id: 'list-1', limit: 20 }] },
				traceContext: sampledTraceContext,
				trustedContext,
			},
			signal: new AbortController().signal,
		});
		await dispatcher.dispatch({
			connectionId: 'connection-1',
			method: 'sandbox.environment.open',
			params: {
				publicRequest: { logicalCwd: 'workspace' },
				traceContext: unsampledTraceContext,
				trustedContext,
			},
			signal: new AbortController().signal,
		});

		// Assert
		expect(traceDispatches).toEqual([
			{
				connectionId: 'connection-1',
				method: 'portal.list',
				traceContext: sampledTraceContext,
				trustedContext,
			},
			{
				connectionId: 'connection-1',
				method: 'sandbox.environment.open',
				traceContext: unsampledTraceContext,
				trustedContext,
			},
		]);
		expect(list).toHaveBeenCalledWith({
			publicRequest: { requests: [{ id: 'list-1', limit: 20 }] },
			trustedContext,
		});
		expect(sandboxDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				publicRequest: { logicalCwd: 'workspace' },
				trustedContext,
			}),
		);
	});

	it('preserves omitted trace context compatibility', async () => {
		// Arrange
		const traceDispatches: Parameters<GatewayRuntimeTraceContextDispatch>[0][] = [];
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: {
				call: vi.fn(),
				describe: vi.fn(),
				list: vi.fn(async () => ({ items: [], ok: true as const })),
				search: vi.fn(),
			},
			sandboxDispatch: vi.fn(),
			traceContextDispatch: async (options, dispatch) => {
				traceDispatches.push(options);
				return await dispatch();
			},
		});

		// Act
		await dispatcher.dispatch({
			connectionId: 'connection-1',
			method: 'portal.list',
			params: {
				publicRequest: { requests: [{ id: 'list-1', limit: 20 }] },
				trustedContext,
			},
			signal: new AbortController().signal,
		});

		// Assert
		expect(traceDispatches).toEqual([
			{
				connectionId: 'connection-1',
				method: 'portal.list',
				traceContext: undefined,
				trustedContext,
			},
		]);
	});

	it.each([
		['unknown envelope field', { unexpected: true }],
		['top-level baggage', { baggage: 'secret=value' }],
		[
			'nested baggage',
			{ traceContext: { baggage: 'secret=value', traceparent: sampledTraceContext.traceparent } },
		],
		[
			'zero trace id',
			{ traceContext: { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' } },
		],
		[
			'oversized tracestate',
			{
				traceContext: {
					traceparent: sampledTraceContext.traceparent,
					tracestate: `vendor=${'a'.repeat(506)}`,
				},
			},
		],
		[
			'duplicate tracestate keys',
			{
				traceContext: {
					traceparent: sampledTraceContext.traceparent,
					tracestate: 'vendor=one,vendor=two',
				},
			},
		],
	] as const)('rejects %s before trace or backend dispatch', async (_caseName, envelopeFields) => {
		// Arrange
		const list = vi.fn();
		const traceContextDispatch = vi.fn();
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: { call: vi.fn(), describe: vi.fn(), list, search: vi.fn() },
			sandboxDispatch: vi.fn(),
			traceContextDispatch,
		});

		// Act / Assert
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-1',
				method: 'portal.list',
				params: {
					publicRequest: { requests: [{ id: 'list-1', limit: 20 }] },
					trustedContext,
					...envelopeFields,
				},
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'invalid-request' });
		expect(traceContextDispatch).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	});

	it('rejects unknown methods and public authority injection before dispatch', async () => {
		// Arrange
		const sandboxDispatch = vi.fn();
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: {
				call: vi.fn(),
				describe: vi.fn(),
				list: vi.fn(),
				search: vi.fn(),
			},
			sandboxDispatch,
		});

		// Act / Assert
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-1',
				method: 'unknown.method',
				params: {},
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'method-not-found' });
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-1',
				method: 'sandbox.environment.open',
				params: {
					publicRequest: { authority: 'forged', logicalCwd: 'workspace' },
					trustedContext,
				},
				signal: new AbortController().signal,
			}),
		).rejects.toBeDefined();
		expect(sandboxDispatch).not.toHaveBeenCalled();
	});

	it('rejects an invalid sandbox backend result at the boundary', async () => {
		// Arrange
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: { read: vi.fn() },
			portalOperations: {
				call: vi.fn(),
				describe: vi.fn(),
				list: vi.fn(),
				search: vi.fn(),
			},
			sandboxDispatch: vi.fn(async () => ({ kind: 'forged-success' })),
		});

		// Act / Assert
		await expect(
			dispatcher.dispatch({
				connectionId: 'connection-1',
				method: 'sandbox.environment.open',
				params: { publicRequest: { logicalCwd: 'workspace' }, trustedContext },
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'invalid-backend-result' });
	});
});
