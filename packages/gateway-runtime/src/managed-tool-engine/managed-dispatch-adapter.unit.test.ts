import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import type { DispatchInvocation } from '@agent-collaboration/tool-engine/dispatch';
import {
	CapabilityDescriptorSchema,
	CapabilitySummarySchema,
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
	PortalCallResultSchema,
} from '@agent-vm/agent-portal-sdk';
import {
	gatewayRuntimeManagedToolPortalConfigSchema,
	type GatewayRuntimeManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimeTrustedInvocationContextSchema,
	GatewayRuntimePortalSemanticSnapshotSchema,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import { createManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-dispatch-adapter.js';
import {
	semanticSnapshot,
	toolPortalConfig,
	trustedContext,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-profile-test-fixture.js';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
import { describe, expect, it } from 'vitest';

const now = Date.parse('2026-07-13T12:00:00.000Z');
const configRevision = { owner: 'controller', revision: 'host-config:9' };
const call = {
	id: 'original-item',
	namespace: 'github',
	name: 'get_issue',
	arguments: { issue: 42 },
};
function harness(
	options: {
		readonly config?: GatewayRuntimeManagedToolPortalConfig;
		readonly snapshot?: GatewayRuntimePortalSemanticSnapshot;
	} = {},
): {
	readonly adapter: ReturnType<typeof createManagedToolEngineAdapter>;
	readonly effects: {
		kind: string;
		options: unknown;
	}[];
} {
	const effects: {
		kind: string;
		options: unknown;
	}[] = [];
	const tools = [
		{ namespace: 'github', name: 'get_issue' },
		{ namespace: 'github', name: 'hidden' },
		{ namespace: 'controller', name: 'push_branch' },
		{ namespace: 'controller', name: 'workspace_git_push' },
		{ namespace: 'sandbox', name: 'exec' },
		{ namespace: 'sandbox', name: 'hidden' },
	];
	function backend<TBackendKind extends 'controller_execution' | 'mcp_provider' | 'tool_vm_runner'>(
		backendKind: TBackendKind,
	): ToolPortalBackendPort<TBackendKind> {
		return {
			backendKind,
			call: async (request, invocationOptions) => {
				effects.push({ kind: backendKind, options: invocationOptions });
				const authority = invocationOptions.dispatchAuthority;
				const operationId =
					authority.kind === 'without-approval'
						? authority.operationId
						: authority.kind === 'approval-grant'
							? authority.grant.operationId
							: authority.reservation.operationId;
				return PortalCallResultSchema.parse({
					ok: true,
					items: request.calls.map((item) => ({
						id: item.id,
						operationId,
						owningGeneration: 'semantic-gate-c-1',
						status: 'ok',
						outcome: {
							kind: 'completed',
							certainty: 'proven',
							completion: 'succeeded',
							retryClass: 'forbidden',
						},
						value: { forwarded: backendKind },
					})),
				});
			},
			list: async (request) =>
				PortalBackendListResultSchema.parse({
					ok: true,
					items: request.requests.map((item) => ({
						id: item.id,
						status: 'ok',
						value: {
							namespaces: ['github', 'controller', 'sandbox', 'unregistered'],
							tools: tools.map((tool) =>
								CapabilitySummarySchema.parse({
									...tool,
									toolRef: `${tool.namespace}:${tool.name}`,
									input: { type: 'object', propertyCount: 0, required: [], optional: [] },
									safety: {},
								}),
							),
						},
					})),
				}),
			describe: async (request) =>
				PortalBackendDescribeResultSchema.parse({
					ok: true,
					items: request.requests.map((item) => ({
						id: item.id,
						status: 'ok',
						value: {
							tools: tools.map((tool) =>
								CapabilityDescriptorSchema.parse({
									...tool,
									toolRef: `${tool.namespace}:${tool.name}`,
								}),
							),
						},
					})),
				}),
			search: async (request) =>
				PortalBackendSearchResultSchema.parse({
					ok: true,
					items: request.requests.map((item) => ({
						id: item.id,
						status: 'ok',
						value: {
							tools: tools.map((tool) =>
								CapabilitySummarySchema.parse({
									...tool,
									toolRef: `${tool.namespace}:${tool.name}`,
									input: { type: 'object', propertyCount: 0, required: [], optional: [] },
									safety: {},
								}),
							),
						},
					})),
				}),
		};
	}
	return {
		effects,
		adapter: createManagedToolEngineAdapter({
			authority: 'managed-zone',
			configuration: { config: options.config ?? toolPortalConfig, revision: configRevision },
			semanticSnapshot: options.snapshot ?? semanticSnapshot,
			approvalPort: {
				reserveDispatch: async () => {
					throw new Error('Approval reserve outside this direct-call proof.');
				},
				armDispatch: async () => {
					throw new Error('Approval arm outside this direct-call proof.');
				},
			},
			backendPorts: {
				controllerExecution: backend('controller_execution'),
				mcpProvider: backend('mcp_provider'),
				toolVmRunner: backend('tool_vm_runner'),
			},
			now: () => now,
		}),
	};
}
function directConfig(): GatewayRuntimeManagedToolPortalConfig {
	const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(toolPortalConfig);
	for (const profile of Object.values(config.profiles))
		for (const policy of Object.values(profile.namespaces))
			policy.calls = {
				requiresApproval: { allow: [], deny: [] },
				withoutApproval: { allow: '*', deny: [] },
			};
	return config;
}
function invocation(
	adapter: ReturnType<typeof createManagedToolEngineAdapter>,
	reference: string,
	kind: DispatchInvocation['backendKind'] = 'mcp_provider',
): DispatchInvocation {
	const input = adapter.request(reference);
	const assessed = adapter.assessAccess(input.access);
	if (assessed.kind !== 'assessed') throw new Error('Fixture facts rejected');
	return {
		version: 'tool-dispatch-v1',
		authority: input.authority,
		operationKey: { authority: input.authority, principal: input.principal, item: input.item },
		capability: input.access.capability,
		arguments: jsonObjectSchema.parse(input.access.call?.arguments),
		backendKind: kind,
		bindingRevision: input.access.facts.upstream.binding,
		admissionRevisions: assessed.assessment.revisions,
		verifiedContextRef: reference,
		approvalReceiptRef: null,
		surface: input.access.surface,
		correlation: input.correlation,
		intentDigest: 'a'.repeat(64),
	};
}

describe('managed dispatch authority', () => {
	it('preserves literal managed ID and fingerprint bytes from the untouched baseline', async () => {
		const subject = harness();
		await subject.adapter.call(
			{ calls: [call] },
			{ trustedContext, surfaceClass: 'protected_uds' },
		);
		expect(subject.effects[0]).toMatchObject({
			options: {
				dispatchAuthority: {
					operationId: '68fb821b-bea9-5148-b8b5-c47b614e4e25',
					fingerprint: 'sha256:1adba29d9dc872ad329a379d1a106fbe7a5c376e04f3bca07e7aaee61bfa0e52',
				},
			},
		});
	});
	it('refuses an explicitly denied profile in admission and all discovery operations', async () => {
		const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(toolPortalConfig);
		const policy = config.profiles['gate-c-profile']?.namespaces.github;
		if (policy === undefined) throw new Error('Missing managed policy.');
		policy.tools = { allow: '*', deny: ['get_issue'] };
		const subject = harness({ config });
		expect(
			await subject.adapter.call(
				{ calls: [call] },
				{ trustedContext, surfaceClass: 'protected_uds' },
			),
		).toMatchObject({ ok: false, items: [{ status: 'error' }] });
		const reference = subject.adapter.register({
			context: { trustedContext, surfaceClass: 'protected_uds' },
			call,
		});
		const backend = subject.adapter.backends.get('mcp_provider');
		if (backend === undefined) throw new Error('Missing managed backend.');
		const listed = PortalBackendListResultSchema.parse(
			await backend.list({
				verifiedContextRef: reference,
				request: { requests: [{ id: 'list' }] },
			}),
		);
		const described = PortalBackendDescribeResultSchema.parse(
			await backend.describe({
				verifiedContextRef: reference,
				request: { requests: [{ id: 'describe' }] },
			}),
		);
		const searched = PortalBackendSearchResultSchema.parse(
			await backend.search({
				verifiedContextRef: reference,
				request: { requests: [{ id: 'search' }] },
			}),
		);
		for (const result of [listed, described, searched])
			expect(
				result.items.flatMap((item) =>
					item.status === 'ok' ? item.value.tools.map((tool) => tool.name) : [],
				),
			).toEqual(['hidden']);
		expect(subject.effects).toEqual([]);
	});
	it('binds the assessor from host configuration and refuses a configured workspace fact', async () => {
		const subject = harness();
		const reference = subject.adapter.register({
			context: { trustedContext, surfaceClass: 'protected_uds' },
			call,
		});
		const input = subject.adapter.request(reference);
		expect(subject.adapter.assessAccess(input.access)).toMatchObject({
			kind: 'assessed',
			assessment: { revisions: { hostConfig: configRevision } },
		});
		input.access.facts.workspace = {
			kind: 'configured',
			registration: { status: 'active', revision: configRevision },
			allowance: {
				allowed: true,
				revision: configRevision,
				rule: { source: 'workspace-allowance', ruleId: 'workspace' },
			},
		};
		expect(await subject.adapter.dispatcher.dispatch(input)).toEqual({
			kind: 'denied',
			state: { kind: 'not-usable', firstUnmet: 'service-unavailable' },
		});
		expect(subject.effects).toEqual([]);
	});
	it.each(['forged-principal', 'assignment-mismatch', 'inactive-snapshot'] as const)(
		'refuses %s at the adapter invoke boundary',
		async (scenario) => {
			const context = GatewayRuntimeTrustedInvocationContextSchema.parse(trustedContext);
			const snapshot = GatewayRuntimePortalSemanticSnapshotSchema.parse(semanticSnapshot);
			if (scenario === 'forged-principal') context.principal.agentId = 'not-configured-agent';
			if (scenario === 'assignment-mismatch')
				context.principal.profileAssignmentRevision = 'stale-assignment';
			if (scenario === 'inactive-snapshot') snapshot.desiredRevision = 'not-active';
			const subject = harness({ snapshot });
			// Build a valid neutral shape with a good context, then substitute the independently forged context reference.
			const good = harness();
			const goodReference = good.adapter.register({
				context: { trustedContext, surfaceClass: 'protected_uds' },
				call,
			});
			const incoming = invocation(good.adapter, goodReference);
			const badReference = subject.adapter.register({
				context: { trustedContext: context, surfaceClass: 'protected_uds' },
				call,
			});
			expect(
				await subject.adapter.backends
					.get('mcp_provider')
					?.invoke({ ...incoming, verifiedContextRef: badReference }),
			).toMatchObject({ kind: 'not-dispatched', reason: 'managed-authority-refused' });
			expect(subject.effects).toEqual([]);
		},
	);
	it('independently fences an ineligible arrival surface despite a permissive upstream invocation', async () => {
		const subject = harness();
		const reference = subject.adapter.register({
			context: { trustedContext, surfaceClass: 'mcp' },
			call,
		});
		const incoming = invocation(subject.adapter, reference);
		expect(await subject.adapter.backends.get('mcp_provider')?.invoke(incoming)).toMatchObject({
			kind: 'not-dispatched',
		});
		expect(subject.effects).toEqual([]);
	});
	it('returns unsupported public lookup without dispatch', async () => {
		const subject = harness();
		expect(
			await subject.adapter.operations.lookup({
				version: 'tool-operation-v1',
				key: { authority: 'managed-zone', principal: 'agent', item: 'item' },
				verifiedContextRef: 'arbitrary-reference',
			}),
		).toEqual({ kind: 'unsupported-version' });
		expect(subject.effects).toEqual([]);
	});
	it.each([
		['mcp_provider', 'github', 'get_issue'],
		['controller_execution', 'controller', 'push_branch'],
		['tool_vm_runner', 'sandbox', 'exec'],
	] as const)(
		'forwards usable %s calls with adapter-owned managed authority',
		async (kind, namespace, name) => {
			const subject = harness({ config: directConfig() });
			const selectedCall = { ...call, namespace, name };
			expect(
				await subject.adapter.call(
					{ calls: [selectedCall] },
					{ trustedContext, surfaceClass: 'protected_uds' },
				),
			).toMatchObject({ ok: true, items: [{ status: 'ok', value: { forwarded: kind } }] });
			expect(subject.effects).toHaveLength(1);
			expect(subject.effects[0]).toMatchObject({
				kind,
				options: {
					surfaceClass: 'protected_uds',
					trustedContext,
					dispatchAuthority: { kind: 'without-approval', backendKind: kind },
				},
			});
		},
	);
	it.each(['mcp_provider', 'controller_execution', 'tool_vm_runner'] as const)(
		'filters all discovery operations for %s',
		async (kind) => {
			const subject = harness();
			const reference = subject.adapter.register({
				context: { trustedContext, surfaceClass: 'protected_uds' },
				call,
			});
			const backend = subject.adapter.backends.get(kind);
			if (backend === undefined) throw new Error('Missing backend.');
			const expected =
				kind === 'mcp_provider'
					? ['get_issue']
					: kind === 'controller_execution'
						? ['push_branch']
						: ['exec'];
			const requests = [
				await backend.list({
					verifiedContextRef: reference,
					request: { requests: [{ id: 'list' }] },
				}),
				await backend.describe({
					verifiedContextRef: reference,
					request: { requests: [{ id: 'describe' }] },
				}),
				await backend.search({
					verifiedContextRef: reference,
					request: { requests: [{ id: 'search', query: 'all' }] },
				}),
			];
			for (const output of requests) {
				const parsed = PortalBackendDescribeResultSchema.safeParse(output);
				const listed = PortalBackendListResultSchema.safeParse(output);
				const searched = PortalBackendSearchResultSchema.safeParse(output);
				const items = parsed.success
					? parsed.data.items
					: listed.success
						? listed.data.items
						: searched.success
							? searched.data.items
							: [];
				expect(
					items.flatMap((item) =>
						item.status === 'ok' ? item.value.tools.map((tool) => tool.name) : [],
					),
				).toEqual(expected);
			}
			expect(subject.effects).toEqual([]);
		},
	);
});
