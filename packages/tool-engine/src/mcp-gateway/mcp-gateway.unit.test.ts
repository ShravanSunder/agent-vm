import { createPortalAgentIdentity } from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import {
	type DispatchInvocation,
	type ToolBackend,
	type BackendKind,
	type ResourceResult,
	type OperationPort,
	type OperationRecord,
	type ApprovalPort,
} from '@agent-collaboration/tool-engine/dispatch';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	createMcpGateway,
	type McpGateway,
	type PreparedGatewayCatalog,
} from '#mcp-gateway/mcp-gateway';
import * as callValidation from '#mcp-gateway/portal-call-validation';
import {
	createPortalSessionManager,
	PortalCatalogPreparationError,
} from '#mcp-gateway/portal-session';
import type { PortalBatchResult } from '#mcp-gateway/portal-tools';

const revision = { owner: 'fixture-authority', revision: 'v1' };
const frozenNames = [
	'alpha__ask__645775a667',
	'alpha__read__151160dc30',
	'beta__ask__7e2e2be604',
	'beta__read__08da93d672',
];
const inputSchema = {
	type: 'object' as const,
	properties: { value: { type: 'integer' } },
	required: ['value'],
	additionalProperties: false,
};
interface GatewayTestHarness {
	gateway: McpGateway;
	effects: DispatchInvocation[];
	inputDigests: string[];
	setDenyRead: () => void;
	changeBinding: () => void;
	changeDuringAdmission: () => void;
	setPrepared: (transform: (catalog: PreparedGatewayCatalog) => PreparedGatewayCatalog) => void;
	setResult: (result: ResourceResult) => void;
}
function retainCatalog(catalog: PreparedGatewayCatalog): PreparedGatewayCatalog {
	return catalog;
}
function createHarness(
	throwAt?: 'access' | 'backend' | 'backend-after-effect',
	discovery: 'complete' | 'incomplete' | 'duplicate' = 'complete',
): GatewayTestHarness {
	const effects: DispatchInvocation[] = [];
	const inputDigests: string[] = [];
	let binding = revision;
	let denyRead = false;
	let changeDuringAdmission = false;
	let preparedTransform = retainCatalog;
	let backendResult: ResourceResult = { kind: 'completed', result: { value: 42 } };
	const records = new Map<string, OperationRecord>();
	const operations: OperationPort = {
		createOrRead: async ({ invocation }) => {
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old !== undefined)
				return old.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: old }
					: { kind: 'conflict' };
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: '2026-10-20T00:00:00.000Z',
				updatedAt: '2026-10-20T00:00:00.000Z',
				revision: '1',
				state: { kind: 'ready' },
			};
			records.set(key, record);
			return { kind: 'created', record };
		},
		lookup: async () => ({ kind: 'not-found' }),
		transition: async ({ invocation, expectedRevision, next }) => {
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old === undefined || old.revision !== expectedRevision) return { kind: 'conflict' };
			const record = { ...old, revision: String(Number(old.revision) + 1), state: next };
			records.set(key, record);
			return { kind: 'found', record };
		},
	};
	const approvals: ApprovalPort = {
		challenge: async (invocation) => ({
			kind: 'pending',
			challenge: {
				authority: invocation.authority,
				approvalId: 'approval:1',
				operationKey: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				callerDisplay: 'Agent A',
				targetDisplay: 'test provider',
				revisions: invocation.admissionRevisions,
				expiresAt: '2026-10-21T00:00:00.000Z',
				permittedDecisions: ['approve', 'deny'],
			},
		}),
		decision: async () => ({ kind: 'denied' }),
		receipt: async () => ({ kind: 'denied' }),
	};
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => ({}),
		describe: async () => ({}),
		search: async () => ({}),
		invoke: async (invocation) => {
			if (invocation.arguments.value === 43 && throwAt === 'backend')
				throw new Error('provider failure');
			effects.push(invocation);
			if (invocation.arguments.value === 43 && throwAt === 'backend-after-effect')
				throw new Error('provider reply lost');
			return backendResult;
		},
	};
	const identity = createPortalAgentIdentity({
		agentId: 'agent-a',
		agentScopeId: 'scope-a',
		source: 'mcp-proxy-bearer',
	});
	const sessions = createPortalSessionManager({
		accessPolicy: {
			enabledNamespaces: ['alpha', 'beta'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {
				'agent-a': [
					{ namespace: 'alpha', toolName: 'hidden' },
					{ namespace: 'beta', toolName: 'hidden' },
				],
			},
		},
		catalogTtlMs: 60000,
		skills: [
			{ title: 'workflow-only-marker', toolRefs: ['mcp:YWxwaGE:cmVhZA', 'mcp:YWxwaGE:aGlkZGVu'] },
		],
		runtime: {
			closeAgentScope: () => {},
			listTools: async ({ namespace }) => {
				if (discovery === 'incomplete' && namespace === 'beta')
					throw new Error('beta discovery unavailable');
				const names =
					discovery === 'duplicate' ? ['read', 'read'] : ['read', 'ask', 'denied', 'hidden'];
				return names.map((name) => ({ name, inputSchema }));
			},
		},
		upstreamNamespaces: ['alpha', 'beta'],
	});
	const gateway = createMcpGateway({
		caller: {
			identity,
			authority: 'authority',
			principal: 'agent-a',
			verifiedContextRef: 'verified-a',
		},
		hostBinding: { workspaceLayer: 'not-configured', config: revision },
		sessions,
		operations,
		approvals,
		backends: new Map([['mcp_provider', backend]]),
		now: () => 0,
		prepareCatalog: async (catalog) => preparedTransform(catalog),
		resolveAccess: async ({ capability, call }): Promise<AssessAccessInput> => {
			if (call !== null) {
				if (
					throwAt === 'access' &&
					typeof call.arguments === 'object' &&
					call.arguments !== null &&
					!Array.isArray(call.arguments) &&
					call.arguments.value === 43
				)
					throw new Error('access facts unavailable');
				inputDigests.push(call.digest);
				if (changeDuringAdmission) binding = { ...revision, revision: 'v2' };
			}
			return assessAccessInput.parse({
				capability,
				call,
				surface: 'mcp',
				facts: {
					workspace: { kind: 'not-configured' },
					assignment: {
						profileRevision: revision,
						revision,
						profile: {
							profileId: 'profile-a',
							namespaces: Object.fromEntries(
								['alpha', 'beta'].map((namespace) => [
									namespace,
									{
										backendKind: 'mcp_provider',
										tools: { allow: '*', deny: ['denied', ...(denyRead ? ['read'] : [])] },
										calls: {
											kind: 'selectors',
											withoutApproval: { allow: ['read'], deny: [] },
											requiresApproval: { allow: ['ask'], deny: [] },
										},
										operations: {},
									},
								]),
							),
						},
					},
					surface: { eligible: ['mcp'], snapshot: revision },
					accounts: [],
					upstream: { status: 'available', credentialNeed: 'none', binding },
				},
			});
		},
	});
	return {
		gateway,
		effects,
		inputDigests,
		setDenyRead: () => {
			denyRead = true;
		},
		changeBinding: () => {
			binding = { ...revision, revision: 'v2' };
		},
		changeDuringAdmission: () => {
			changeDuringAdmission = true;
		},
		setPrepared: (transform: typeof preparedTransform) => {
			preparedTransform = transform;
		},
		setResult: (result: ResourceResult) => {
			backendResult = result;
		},
	};
}
function callInput(
	toolName = 'read',
	id = 'original-item',
	args: unknown = { value: 42 },
): unknown {
	return { calls: [{ id, namespace: 'alpha', toolName, arguments: args }] };
}
function output(result: PortalBatchResult, id: string): Readonly<Record<string, unknown>> {
	const value = result.results[id];
	if (value === undefined || !value.ok) throw new Error(JSON.stringify(result));
	return value.output;
}
function identities(value: unknown): readonly string[] {
	return z
		.object({ tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })) })
		.parse(value)
		.tools.map((tool) => `${tool.namespace}.${tool.toolName}`);
}

// Oracles: Spec R3/R5/R8/R15, S3a proof 1/2/7/8/9. No host/auth/durable-store claim.
describe('portable MCP gateway through the neutral dispatcher', () => {
	it.each(['prepare', 'list'] as const)(
		'refuses incomplete full catalog discovery through %s before publication',
		async (path) => {
			const publisher = vi.fn(retainCatalog);
			const harness = createHarness(undefined, 'incomplete');
			harness.setPrepared(publisher);
			const preparation =
				path === 'prepare'
					? harness.gateway.prepareCatalog()
					: harness.gateway.listTools('catalog');
			await expect(preparation).rejects.toThrowError(
				new PortalCatalogPreparationError([
					{
						namespace: 'beta',
						kind: 'upstream_discovery_failed',
						message: 'beta discovery unavailable',
					},
				]),
			);
			await expect(preparation).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
				failedNamespaces: ['beta'],
				message:
					'MCP Portal catalog preparation failed for namespace(s): beta. Run live MCP validation or use compact mode for partial discovery diagnostics.',
			});
			expect(publisher).not.toHaveBeenCalled();
		},
	);
	it.each(['prepare', 'list'] as const)(
		'refuses duplicate exported full catalog names through %s before publication',
		async (path) => {
			const harness = createHarness(undefined, 'duplicate');
			const publisher = vi.fn(retainCatalog);
			harness.setPrepared(publisher);
			const preparation =
				path === 'prepare'
					? harness.gateway.prepareCatalog()
					: harness.gateway.listTools('catalog');
			await expect(preparation).rejects.toBeInstanceOf(PortalCatalogPreparationError);
			await expect(preparation).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
				failedNamespaces: ['alpha'],
				message:
					'MCP Portal catalog preparation failed for namespace(s): alpha. Run live MCP validation or use compact mode for partial discovery diagnostics.',
			});
			expect(publisher).not.toHaveBeenCalled();
		},
	);
	it('publishes a complete allowed full catalog', async () => {
		const harness = createHarness();
		const publisher = vi.fn(retainCatalog);
		harness.setPrepared(publisher);
		expect((await harness.gateway.listTools('catalog')).map((tool) => tool.name)).toEqual(
			frozenNames,
		);
		expect(publisher).toHaveBeenCalledOnce();
	});
	it('keeps healthy compact discovery, describe and calls available with failure diagnostics', async () => {
		const harness = createHarness(undefined, 'incomplete');
		const publisher = vi.fn(retainCatalog);
		harness.setPrepared(publisher);
		const listed = await harness.gateway.list({ requests: [{ id: 'r' }] });
		expect(identities(output(listed, 'r'))).toEqual(['alpha.ask', 'alpha.read']);
		const described = await harness.gateway.describe({
			requests: [{ id: 'r', tools: [{ namespace: 'alpha', toolName: 'read' }] }],
		});
		expect(identities(output(described, 'r'))).toEqual(['alpha.read']);
		const called = await harness.gateway.call(callInput());
		expect(called.results['original-item']?.ok).toBe(true);
		expect(harness.effects).toHaveLength(1);
		for (const result of [listed, described, called]) {
			expect(result.diagnostics).toMatchObject([
				{ kind: 'upstream_discovery_failed', namespace: 'beta' },
			]);
		}
		expect((await harness.gateway.listTools('compact')).map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(publisher).not.toHaveBeenCalled();
	});

	it('keeps the same literal allowed corpus across list, search, describe and native catalog', async () => {
		const { gateway } = createHarness();
		expect(identities(output(await gateway.list({ requests: [{ id: 'r' }] }), 'r'))).toEqual([
			'alpha.ask',
			'alpha.read',
			'beta.ask',
			'beta.read',
		]);
		expect(
			identities(output(await gateway.search({ requests: [{ id: 'r', query: 'read' }] }), 'r')),
		).toEqual(['alpha.read', 'beta.read']);
		const catalog = await gateway.prepareCatalog();
		expect(catalog.tools.map((tool) => tool.descriptor.name)).toEqual(frozenNames);
		expect((await gateway.listTools('catalog')).map((tool) => tool.name)).toEqual(frozenNames);
		expect((await gateway.listTools('compact')).map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect((await gateway.listTools('compact'))[0]?.description).toBe(
			'List authorized MCP namespaces and compact tool summaries. Allowed namespaces for this agent: alpha, beta.',
		);
		expect(
			identities(
				output(
					await gateway.describe({ requests: [{ id: 'r', refs: ['mcp:YWxwaGE:cmVhZA'] }] }),
					'r',
				),
			),
		).toEqual(['alpha.read']);
	});
	it('keeps configured skill search hints while filtering hidden references', async () => {
		const h = createHarness();
		expect(
			identities(
				output(
					await h.gateway.search({ requests: [{ id: 'r', query: 'workflow-only-marker' }] }),
					'r',
				),
			),
		).toEqual(['alpha.read']);
		h.setDenyRead();
		expect(
			identities(
				output(
					await h.gateway.search({ requests: [{ id: 'r', query: 'workflow-only-marker' }] }),
					'r',
				),
			),
		).toEqual([]);
	});
	it.each(['compact', 'direct'] as const)(
		'runs the allowed control in %s and records the literal normalized digest and effect',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const result =
				mode === 'compact'
					? await h.gateway.call(callInput())
					: await h.gateway.callDirect({
							name: 'alpha__read__151160dc30',
							arguments: { value: 42 },
							item: 'original-item',
							catalog,
						});
			expect(result).toEqual({
				diagnostics: [],
				errors: [],
				ok: true,
				results: {
					'original-item': {
						ok: true,
						input: {
							id: 'original-item',
							namespace: 'alpha',
							toolName: 'read',
							arguments: { value: 42 },
						},
						output: { namespace: 'alpha', toolName: 'read', result: { value: 42 } },
					},
				},
			});
			expect(
				h.effects.map((effect) => ({
					capability: effect.capability,
					arguments: effect.arguments,
					principal: effect.operationKey.principal,
					item: effect.operationKey.item,
				})),
			).toEqual([
				{
					capability: { namespace: 'alpha', tool: 'read' },
					arguments: { value: 42 },
					principal: 'agent-a',
					item: 'original-item',
				},
			]);
			expect(h.inputDigests).toEqual([
				'dc60e632a90329ccfd34fbe904d94704dbbb6669575185e26389854ff64139c3',
			]);
		},
	);
	it('binds the consumer digest to normalized arguments', async () => {
		const h = createHarness();
		expect((await h.gateway.call(callInput('read', 'normalized', { value: '42' }))).ok).toBe(true);
		expect(h.effects.map((effect) => effect.arguments)).toEqual([{ value: 42 }]);
		expect(h.inputDigests).toEqual([
			'dc60e632a90329ccfd34fbe904d94704dbbb6669575185e26389854ff64139c3',
		]);
	});
	it.each(['compact', 'direct'] as const)(
		'pending approval and invalid arguments cause zero effects in %s',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const pending =
				mode === 'compact'
					? await h.gateway.call(callInput('ask'))
					: await h.gateway.callDirect({
							name: 'alpha__ask__645775a667',
							arguments: { value: 42 },
							item: 'original-item',
							catalog,
						});
			expect(pending.results['original-item']).toMatchObject({
				ok: false,
				error: {
					kind: 'pending',
					reference: 'approval:1',
					detail: {
						approvalId: 'approval:1',
						operationKey: { authority: 'authority', principal: 'agent-a', item: 'original-item' },
					},
				},
			});
			const invalid =
				mode === 'compact'
					? await h.gateway.call(callInput('read', 'invalid', {}))
					: await h.gateway.callDirect({
							name: 'alpha__read__151160dc30',
							arguments: {},
							item: 'invalid',
							catalog,
						});
			expect(invalid.results.invalid).toMatchObject({
				ok: false,
				error: { kind: 'input_validation' },
			});
			expect(h.effects).toEqual([]);
		},
	);
	it.each(['denied', 'hidden'])(
		'refuses registered %s names, selectors, encoded references and aliases',
		async (toolName) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			expect((await h.gateway.call(callInput(toolName))).ok).toBe(false);
			expect(
				(
					await h.gateway.describe({
						requests: [{ id: 'r', tools: [{ namespace: 'alpha', toolName }] }],
					})
				).ok,
			).toBe(false);
			const guesses = [
				`alpha__${toolName}__${toolName === 'denied' ? 'aa19f18792' : 'ba2f2074fe'}`,
				`alpha.${toolName}`,
				toolName,
			];
			expect(
				await Promise.all(
					guesses.map(
						async (name) =>
							(
								await h.gateway.callDirect({
									name,
									arguments: { value: 42 },
									item: 'guess',
									catalog,
								})
							).ok,
					),
				),
			).toEqual([false, false, false]);
			const ref = toolName === 'denied' ? 'mcp:YWxwaGE:ZGVuaWVk' : 'mcp:YWxwaGE:aGlkZGVu';
			expect((await h.gateway.describe({ requests: [{ id: 'r', refs: [ref] }] })).ok).toBe(false);
			expect(
				(await h.gateway.call({ calls: [{ id: 'guess', ref, arguments: { value: 42 } }] })).ok,
			).toBe(false);
			expect(h.effects).toEqual([]);
			expect((await h.gateway.call(callInput())).ok).toBe(true);
			expect(h.effects).toHaveLength(1);
		},
	);
	it('does not trust a stale assignment or reference in either mode', async () => {
		const h = createHarness();
		const catalog = await h.gateway.prepareCatalog();
		h.setDenyRead();
		expect((await h.gateway.call(callInput())).ok).toBe(false);
		expect(
			(
				await h.gateway.callDirect({
					name: 'alpha__read__151160dc30',
					arguments: { value: 42 },
					item: 'stale',
					catalog,
				})
			).ok,
		).toBe(false);
		expect(
			(await h.gateway.describe({ requests: [{ id: 'r', refs: ['mcp:YWxwaGE:cmVhZA'] }] })).ok,
		).toBe(false);
		expect(h.effects).toEqual([]);
	});
	it.each(['compact', 'direct'] as const)(
		'holds a binding that changes during %s preparation',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			h.changeDuringAdmission();
			const result =
				mode === 'compact'
					? await h.gateway.call(callInput())
					: await h.gateway.callDirect({
							name: 'alpha__read__151160dc30',
							arguments: { value: 42 },
							item: 'stale',
							catalog,
						});
			expect(result.ok).toBe(false);
			expect(h.effects).toEqual([]);
		},
	);
	it('refuses previously prepared binding bytes after rebinding', async () => {
		const h = createHarness();
		const catalog = await h.gateway.prepareCatalog();
		h.changeBinding();
		expect(
			(
				await h.gateway.callDirect({
					name: 'alpha__read__151160dc30',
					arguments: { value: 42 },
					item: 'stale',
					catalog,
				})
			).ok,
		).toBe(false);
		expect(h.effects).toEqual([]);
	});
	it.each(['foreign-caller', 'wrong-hash'] as const)(
		'refuses a %s prepared catalog, with an admitted control',
		async (kind) => {
			const h = createHarness();
			h.setPrepared((catalog) => ({
				...catalog,
				...(kind === 'foreign-caller' ? { agentScopeId: 'scope-b' } : { sourceHash: 'wrong' }),
			}));
			expect(await h.gateway.listTools('catalog')).toEqual([]);
			expect(
				(
					await h.gateway.callDirect({
						name: 'alpha__read__151160dc30',
						arguments: { value: 42 },
						item: 'foreign',
						catalog: await h.gateway.prepareCatalog(),
					})
				).ok,
			).toBe(false);
			expect(h.effects).toEqual([]);
			h.setPrepared((catalog) => catalog);
			expect(
				(
					await h.gateway.callDirect({
						name: 'alpha__read__151160dc30',
						arguments: { value: 42 },
						item: 'control',
						catalog: await h.gateway.prepareCatalog(),
					})
				).ok,
			).toBe(true);
			expect(h.effects).toHaveLength(1);
		},
	);
	it('a prepared catalog cannot add a registered hidden capability or replace its native descriptor', async () => {
		const h = createHarness();
		h.setPrepared((catalog) => ({
			...catalog,
			tools: [
				...catalog.tools,
				{
					namespace: 'alpha',
					toolName: 'hidden',
					bindingRevision: revision,
					descriptor: { name: 'alpha__hidden__ba2f2074fe', inputSchema },
				},
			],
		}));
		const catalog = await h.gateway.prepareCatalog();
		expect(catalog.tools.map((tool) => tool.descriptor.name)).toEqual(frozenNames);
		expect(
			(
				await h.gateway.callDirect({
					name: 'alpha__hidden__ba2f2074fe',
					arguments: { value: 42 },
					item: 'hidden',
					catalog,
				})
			).ok,
		).toBe(false);
		expect(h.effects).toEqual([]);
	});
	it('continues a permitted sibling in a mixed batch', async () => {
		const h = createHarness();
		const result = await h.gateway.call({
			calls: [
				{ id: 'pending', namespace: 'alpha', toolName: 'ask', arguments: { value: 42 } },
				{ id: 'denied', namespace: 'alpha', toolName: 'denied', arguments: { value: 42 } },
				{ id: 'permitted', namespace: 'beta', toolName: 'read', arguments: { value: 42 } },
			],
		});
		expect(result.ok).toBe(false);
		expect(h.effects.map((effect) => effect.operationKey.item)).toEqual(['permitted']);
		expect(result.results.pending).toMatchObject({ ok: false, error: { kind: 'pending' } });
		expect(result.results.permitted).toMatchObject({ ok: true, output: { result: { value: 42 } } });
	});
	it.each(['compact', 'direct'] as const)(
		'rejects an unauthorized effect from a direct-backend bypass in %s',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const result =
				mode === 'compact'
					? await h.gateway.call(callInput('ask'))
					: await h.gateway.callDirect({
							name: 'alpha__ask__645775a667',
							arguments: { value: 42 },
							item: 'original-item',
							catalog,
						});
			expect(h.effects).toEqual([]);
			expect(result.results['original-item']).toMatchObject({
				ok: false,
				error: { kind: 'pending' },
			});
		},
	);
	it('serves host-prepared helper bytes only after caller/catalog validation', async () => {
		const h = createHarness();
		h.setPrepared((catalog) => ({
			...catalog,
			typescriptHelpersByToolRef: { 'mcp:YWxwaGE:cmVhZA': '// frozen prepared helper' },
		}));
		const result = await h.gateway.describe({
			requests: [{ id: 'r', refs: ['mcp:YWxwaGE:cmVhZA'], includeTypescriptHelper: true }],
		});
		expect(output(result, 'r')).toMatchObject({
			tools: [{ typescriptHelper: '// frozen prepared helper' }],
		});
		h.setPrepared((catalog) => ({
			...catalog,
			agentScopeId: 'scope-b',
			typescriptHelpersByToolRef: { 'mcp:YWxwaGE:cmVhZA': 'foreign-helper' },
		}));
		expect(
			JSON.stringify(
				await h.gateway.describe({
					requests: [{ id: 'r', refs: ['mcp:YWxwaGE:cmVhZA'], includeTypescriptHelper: true }],
				}),
			),
		).not.toContain('foreign-helper');
		expect(h.effects).toEqual([]);
	});

	for (const throwAt of [
		'digest',
		'validation',
		'access',
		'backend',
		'backend-after-effect',
	] as const)
		it.each(['compact', 'direct'] as const)(
			`preserves a completed sibling when ${throwAt} throws in %s`,
			async (mode) => {
				const h = createHarness(
					throwAt === 'digest' || throwAt === 'validation' ? undefined : throwAt,
				);
				const catalog = await h.gateway.prepareCatalog();
				const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
				const validate = callValidation.validatePortalToolArguments;
				const validationSpy =
					throwAt === 'validation'
						? vi
								.spyOn(callValidation, 'validatePortalToolArguments')
								.mockImplementation((tool, args) => {
									if (args.value === 43) throw new Error('validator unavailable');
									return validate(tool, args);
								})
						: undefined;
				const digestSpy =
					throwAt === 'digest'
						? vi
								.spyOn(globalThis.crypto.subtle, 'digest')
								.mockImplementation(async (algorithm, data) => {
									const bytes = ArrayBuffer.isView(data)
										? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
										: new Uint8Array(data);
									if (new TextDecoder().decode(bytes) === '{"value":43}')
										throw new Error('digest unavailable');
									return digest(algorithm, data);
								})
						: undefined;
				try {
					const bad = {
						id: 'failure',
						namespace: 'alpha',
						toolName: 'read',
						arguments: { value: 43 },
					};
					const good = {
						id: 'sibling',
						namespace: 'beta',
						toolName: 'read',
						arguments: { value: 42 },
					};
					const results =
						mode === 'compact'
							? [await h.gateway.call({ calls: [good, bad] })]
							: await Promise.all([
									h.gateway.callDirect({
										name: 'beta__read__08da93d672',
										arguments: { value: 42 },
										item: 'sibling',
										catalog,
									}),
									h.gateway.callDirect({
										name: 'alpha__read__151160dc30',
										arguments: { value: 43 },
										item: 'failure',
										catalog,
									}),
								]);
					const items = Object.fromEntries(
						results.flatMap((result) => Object.entries(result.results)),
					);
					expect(items.sibling).toEqual({
						ok: true,
						input: good,
						output: { namespace: 'beta', toolName: 'read', result: { value: 42 } },
					});
					expect(items.failure).toMatchObject({
						ok: false,
						error: {
							kind:
								throwAt === 'digest' || throwAt === 'validation' || throwAt === 'access'
									? 'not-dispatched'
									: 'ambiguous',
						},
					});
					expect(h.effects.filter((effect) => effect.operationKey.item === 'sibling')).toHaveLength(
						1,
					);
					expect(h.effects.filter((effect) => effect.operationKey.item === 'failure')).toHaveLength(
						throwAt === 'backend-after-effect' ? 1 : 0,
					);
				} finally {
					digestSpy?.mockRestore();
					validationSpy?.mockRestore();
				}
			},
		);

	const outcomes: readonly ResourceResult[] = [
		{ kind: 'completed', result: { literal: 'ok' } },
		{ kind: 'pending', reference: 'provider:pending', detail: { status: 'waiting' } },
		{
			kind: 'denied',
			state: {
				kind: 'blocked-by-policy',
				rule: { source: 'profile-selector', ruleId: 'literal:deny' },
			},
		},
		{ kind: 'not-dispatched', reason: 'literal:held' },
		{ kind: 'failed', reason: 'literal:failed' },
		{ kind: 'ambiguous', reason: 'literal:uncertain' },
		{ kind: 'result-expired' },
	];
	for (const outcome of outcomes)
		it.each(['compact', 'direct'] as const)(
			`preserves every field of ${outcome.kind} in %s`,
			async (mode) => {
				const h = createHarness();
				h.setResult(outcome);
				const result =
					mode === 'compact'
						? await h.gateway.call(callInput())
						: await h.gateway.callDirect({
								name: 'alpha__read__151160dc30',
								arguments: { value: 42 },
								item: 'original-item',
								catalog: await h.gateway.prepareCatalog(),
							});
				expect(h.effects).toHaveLength(1);
				expect(result.results['original-item']).toEqual(
					outcome.kind === 'completed'
						? {
								ok: true,
								input: {
									id: 'original-item',
									namespace: 'alpha',
									toolName: 'read',
									arguments: { value: 42 },
								},
								output: { namespace: 'alpha', toolName: 'read', result: outcome.result },
							}
						: {
								ok: false,
								input: {
									id: 'original-item',
									namespace: 'alpha',
									toolName: 'read',
									arguments: { value: 42 },
								},
								error: outcome,
							},
				);
			},
		);
});
