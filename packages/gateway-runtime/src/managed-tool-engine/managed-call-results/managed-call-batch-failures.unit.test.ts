import { PortalCallResultSchema, type PortalCallResult } from '@agent-vm/agent-portal-sdk';
import { gatewayRuntimeManagedToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { GatewayRuntimeApprovalAdmissionResultSchema } from '@agent-vm/gateway-control-contracts';
import * as callProjection from '@agent-vm/gateway-runtime/managed-tool-engine/managed-call-results/managed-call-projection.js';
import { createManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import type { ToolPortalBackendPort } from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';
import {
	semanticSnapshot,
	toolPortalConfig,
	trustedContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createProjection = callProjection.createManagedPortalCallProjection;
const now = Date.parse('2026-07-13T12:00:00.000Z');
// Golden identity from the unchanged f1e9e589 operation-id/principal functions and fixture.
const completedSibling = {
	id: 'original-item',
	operationId: '68fb821b-bea9-5148-b8b5-c47b614e4e25',
	owningGeneration: 'semantic-gate-c-1',
	status: 'ok',
	outcome: {
		kind: 'completed',
		certainty: 'proven',
		completion: 'succeeded',
		retryClass: 'forbidden',
	},
	value: { effect: 'sibling-completed' },
} satisfies PortalCallResult['items'][number];
const refusedItem = {
	id: 'failing-item',
	operationId: '9f5462f8-5eae-5d91-b6ad-334759c874fd',
	owningGeneration: 'semantic-gate-c-1',
	status: 'error',
	outcome: { certainty: 'proven', kind: 'not-dispatched', retryClass: 'safe-before-dispatch' },
	error: {
		code: 'not_authorized',
		message: 'Capability execution was not dispatched: Managed dispatch preparation failed.',
		safeDiagnostic: {
			code: 'capability_denied',
			level: 'error',
			safeMessage: 'Capability execution was not authorized for dispatch.',
		},
	},
} satisfies PortalCallResult['items'][number];
const ambiguousItem = {
	id: 'failing-item',
	operationId: '9f5462f8-5eae-5d91-b6ad-334759c874fd',
	owningGeneration: 'semantic-gate-c-1',
	status: 'error',
	outcome: {
		certainty: 'side-effects-and-termination-unknown',
		kind: 'ambiguous',
		retryClass: 'forbidden',
	},
	error: {
		code: 'execution_failed',
		message: 'Capability dispatch outcome is ambiguous and must not be replayed.',
		safeDiagnostic: {
			code: 'execution_failed',
			level: 'error',
			safeMessage: 'Capability dispatch outcome is ambiguous.',
		},
	},
} satisfies PortalCallResult['items'][number];

afterEach(() => vi.restoreAllMocks());

describe('managed call batch failure isolation', () => {
	it.each(['request-rebuild', 'missing-challenge', 'invalid-completed-item'] as const)(
		'preserves the completed sibling and literal failure outcome at %s',
		async (failureSite) => {
			// Arrange: retain the real registry, adapter, dispatcher and projection. Fault only
			// the selected projection boundary; the protected item never reaches a leaf.
			const references = new Map<string, string>();
			const released: string[] = [];
			const effects: string[] = [];
			const dispatched: string[] = [];
			const dispatchResults = new Map<string, string>();
			const allReleased = Promise.withResolvers<void>();
			vi.spyOn(callProjection, 'createManagedPortalCallProjection').mockImplementation((props) =>
				createProjection({
					...props,
					register: async (input) => {
						const reference = await props.register(input);
						references.set(reference, input.call.id);
						return reference;
					},
					request: (reference) => {
						const request = props.request(reference);
						if (failureSite === 'request-rebuild' && references.get(reference) === 'failing-item')
							throw new Error('Injected request rebuild failure with private details');
						return request;
					},
					admission: (reference) =>
						failureSite === 'missing-challenge' && references.get(reference) === 'failing-item'
							? null
							: props.admission(reference),
					dispatcher: {
						...props.dispatcher,
						dispatch: async (request) => {
							dispatched.push(request.item);
							const result = await props.dispatcher.dispatch(request);
							dispatchResults.set(request.item, result.kind);
							if (failureSite === 'invalid-completed-item' && request.item === 'failing-item') {
								// Corrupt the returned wire item after the real protected dispatch.
								return { kind: 'completed', result: { invalid: 'managed wire item' } };
							}
							return result;
						},
					},
					release: (reference) => {
						props.release(reference);
						released.push(reference);
						if (released.length === 2) allReleased.resolve();
					},
				}),
			);
			function backend<TKind extends 'mcp_provider' | 'controller_execution' | 'tool_vm_runner'>(
				backendKind: TKind,
			): ToolPortalBackendPort<TKind> {
				return {
					backendKind,
					call: async (request) => {
						expect(request.calls.map((call) => call.id)).toEqual(['original-item']);
						effects.push('original-item');
						return PortalCallResultSchema.parse({ ok: true, items: [completedSibling] });
					},
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
			const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(toolPortalConfig);
			const githubPolicy = config.profiles['gate-c-profile']?.namespaces.github;
			if (githubPolicy === undefined) throw new Error('Missing fixture github policy');
			githubPolicy.tools.allow = ['get_issue', 'protected_issue'];
			githubPolicy.calls = {
				requiresApproval: { allow: ['protected_issue'], deny: [] },
				withoutApproval: { allow: ['get_issue'], deny: [] },
			};
			const adapter = createManagedToolEngineAdapter({
				authority: 'managed-zone',
				configuration: { config, revision: { owner: 'controller', revision: 'host-config:9' } },
				semanticSnapshot,
				approvalPort: {
					reserveDispatch: async ({ intent }) =>
						GatewayRuntimeApprovalAdmissionResultSchema.parse({
							kind: 'approval-required',
							challenge: {
								approvalId: '11111111-1111-4111-8111-111111111111',
								createdAt: new Date(now).toISOString(),
								expiresAt: '2026-07-13T13:00:00.000Z',
								fingerprint: `sha256:${'a'.repeat(64)}`,
								intent,
							},
						}),
					armDispatch: async () => {
						throw new Error('Protected item must not be armed');
					},
				},
				backendPorts: {
					mcpProvider: backend('mcp_provider'),
					controllerExecution: backend('controller_execution'),
					toolVmRunner: backend('tool_vm_runner'),
				},
				now: () => now,
			});

			// Act: observe settlement rather than allowing a rejected batch to abandon
			// the already-running sibling. Registry release is the completion event.
			const settlement = await adapter
				.call(
					{
						calls: [
							{
								id: 'original-item',
								namespace: 'github',
								name: 'get_issue',
								arguments: { issue: 42 },
							},
							{
								id: 'failing-item',
								namespace: 'github',
								name: 'protected_issue',
								arguments: { issue: 43 },
							},
						],
					},
					{ trustedContext, surfaceClass: 'protected_uds' },
				)
				.then(
					(value) => ({ kind: 'resolved', value }),
					(error: unknown) => ({ kind: 'rejected', error }),
				);
			await allReleased.promise;

			// Assert: literal managed shapes are the oracle, including certainty/retry.
			expect(effects).toEqual(['original-item']);
			expect(dispatched).toHaveLength(failureSite === 'request-rebuild' ? 1 : 2);
			expect(dispatched.toSorted()).toEqual(
				failureSite === 'request-rebuild' ? ['original-item'] : ['failing-item', 'original-item'],
			);
			expect(dispatchResults.get('original-item')).toBe('completed');
			if (failureSite !== 'request-rebuild')
				expect(dispatchResults.get('failing-item')).toBe('pending');
			expect(released).toHaveLength(2);
			for (const reference of released) expect(() => adapter.request(reference)).toThrow();
			expect(settlement).toEqual({
				kind: 'resolved',
				value: {
					ok: false,
					items: [
						completedSibling,
						failureSite === 'request-rebuild' ? refusedItem : ambiguousItem,
					],
				},
			});
		},
	);
});
