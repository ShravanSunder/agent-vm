import { proxyUpstreamFailureResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { PortalCallResultSchema, type PortalCallResult } from '@agent-vm/agent-portal-sdk';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { createManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import type { ToolPortalBackendPort } from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';
import {
	semanticSnapshot,
	toolPortalConfig,
	trustedContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.js';
import { describe, expect, it, vi } from 'vitest';

const identity = {
	id: 'original-item',
	operationId: '68fb821b-bea9-5148-b8b5-c47b614e4e25',
	owningGeneration: 'semantic-gate-c-1',
};
const diagnostic = {
	code: 'execution_failed',
	level: 'error',
	safeMessage: 'Backend safe detail.',
} as const;
const error = {
	code: 'execution_failed',
	message: 'Backend reported a terminal result.',
	safeDiagnostic: diagnostic,
};
const errorItem = { ...identity, status: 'error', error, diagnostics: [diagnostic] } as const;
const outcomes = [
	{
		...errorItem,
		outcome: {
			kind: 'cancelled-proven',
			certainty: 'proven-terminated',
			retryClass: 'manual-only',
		},
	},
	{
		...errorItem,
		outcome: {
			kind: 'timed-out-proven',
			certainty: 'proven-terminated',
			retryClass: 'manual-only',
		},
	},
	{
		...errorItem,
		outcome: {
			kind: 'replaced-proven',
			certainty: 'proven-terminated',
			priorSideEffects: 'possible',
			retryClass: 'manual-only',
		},
	},
	{
		...errorItem,
		outcome: { kind: 'not-dispatched', certainty: 'proven', retryClass: 'safe-before-dispatch' },
	},
	{
		...errorItem,
		outcome: {
			kind: 'ambiguous',
			certainty: 'side-effects-and-termination-unknown',
			retryClass: 'forbidden',
		},
	},
	{
		...errorItem,
		outcome: {
			kind: 'completed',
			certainty: 'proven',
			completion: 'failed',
			retryClass: 'policy-gated',
		},
	},
	{
		...errorItem,
		outcome: {
			kind: 'completed',
			certainty: 'proven',
			completion: 'failed',
			retryClass: 'forbidden',
		},
		value: { safeFailure: 'retained' },
	},
	{
		...identity,
		status: 'ok',
		outcome: {
			kind: 'completed',
			certainty: 'proven',
			completion: 'succeeded',
			retryClass: 'forbidden',
		},
		value: { safeResult: ['retained', 42] },
		diagnostics: [diagnostic],
		truncation: { truncated: true, omittedBytes: 12 },
		artifacts: [
			{
				id: 'safe-artifact',
				byteLength: 42,
				fingerprint: `sha256:${'a'.repeat(64)}`,
				expiresAt: '2026-10-21T12:00:00.000Z',
			},
		],
	},
] as const;

describe('managed backend terminal result round trip', () => {
	// Oracle: SDK operation-contracts terminal union + baseline dispatchCall returns the matched item.
	it.each(
		outcomes.flatMap((expectedItem) => [
			{ expectedItem, withFailureDetail: false },
			...(expectedItem.outcome.kind === 'ambiguous'
				? [{ expectedItem, withFailureDetail: true }]
				: []),
		]),
	)(
		'preserves backend $expectedItem.outcome.kind $expectedItem.outcome.retryClass with detail=$withFailureDetail',
		async ({ expectedItem, withFailureDetail }) => {
			// Arrange: only execution is doubled; adapter, dispatcher and wire projection are real.
			const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(toolPortalConfig);
			const github = config.profiles['gate-c-profile']?.namespaces.github;
			if (github === undefined) throw new Error('Missing fixture policy.');
			github.calls = {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: '*', deny: [] },
			};
			const backendResult: PortalCallResult = PortalCallResultSchema.parse({
				ok: expectedItem.status === 'ok',
				items: [expectedItem],
			});
			const execute = vi.fn(async (): Promise<PortalCallResult> => backendResult);
			function backend<
				TBackendKind extends 'mcp_provider' | 'controller_execution' | 'tool_vm_runner',
			>(backendKind: TBackendKind): ToolPortalBackendPort<TBackendKind> {
				return {
					backendKind,
					call: execute,
					list: async () => {
						throw new Error('Unexpected discovery');
					},
					describe: async () => {
						throw new Error('Unexpected discovery');
					},
					search: async () => {
						throw new Error('Unexpected discovery');
					},
				};
			}
			const adapter = createManagedToolEngineAdapter({
				authority: 'managed-zone',
				configuration: { config, revision: { owner: 'controller', revision: 'host-config:9' } },
				semanticSnapshot,
				approvalPort: {
					reserveDispatch: async () => {
						throw new Error('Unexpected approval');
					},
					armDispatch: async () => {
						throw new Error('Unexpected approval');
					},
				},
				backendPorts: {
					mcpProvider: backend('mcp_provider'),
					controllerExecution: backend('controller_execution'),
					toolVmRunner: backend('tool_vm_runner'),
				},
				now: () => Date.parse('2026-07-13T12:00:00.000Z'),
			});
			const neutralBackend = adapter.backends.get('mcp_provider');
			if (neutralBackend === undefined) throw new Error('Missing neutral backend.');
			const originalInvoke = neutralBackend.invoke;
			const invoke = vi.spyOn(neutralBackend, 'invoke');
			if (withFailureDetail)
				invoke.mockImplementation(async (invocation) => {
					const result = await originalInvoke(invocation);
					const failure = proxyUpstreamFailureResult({
						namespace: 'github',
						toolName: 'get_issue',
						failure: {
							kind: 'upstream_mcp_failed',
							phase: 'call_tool',
							namespace: 'github',
							toolName: 'get_issue',
							operation: 'MCP callTool github.get_issue',
							causeMessage: 'redacted',
							elapsedMs: 1,
							transport: { kind: 'streamable-http' },
						},
					});
					if (result.kind !== 'ambiguous' || failure.kind !== 'ambiguous')
						throw new Error('Expected uncertain managed failure');
					return { ...result, detail: failure.detail };
				});
			// Act
			const result = await adapter.call(
				{
					calls: [
						{
							id: 'original-item',
							namespace: 'github',
							name: 'get_issue',
							arguments: { issue: 42 },
						},
					],
				},
				{ trustedContext, surfaceClass: 'protected_uds' },
			);
			// Assert: retain certainty, retry policy, identity, error, diagnostics and safe data exactly.
			expect(result).toEqual({ ok: expectedItem.status === 'ok', items: [expectedItem] });
			expect(execute).toHaveBeenCalledOnce();
			const neutralResult = await invoke.mock.results[0]?.value;
			expect(neutralResult?.kind).toBe(
				expectedItem.outcome.certainty === 'proven-terminated'
					? 'failed'
					: expectedItem.outcome.kind,
			);
		},
	);
});
