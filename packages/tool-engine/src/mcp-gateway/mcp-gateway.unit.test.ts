import type { ResourceResult } from '@agent-collaboration/tool-engine/capability-dispatch';
import { describe, it, vi, expect } from 'vitest';

import * as callValidation from '#mcp-gateway/portal-tools/portal-call-validation';
import {
	createHarness,
	frozenNames,
	callInput,
	revision,
	inputSchema,
} from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

describe('portable MCP gateway through the neutral dispatcher', () => {
	it.each(['indirect', 'direct'] as const)(
		'runs the allowed control in %s and records the literal normalized digest and effect',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const result =
				mode === 'indirect'
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

	it.each(['indirect', 'direct'] as const)(
		'pending approval and invalid arguments cause zero effects in %s',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const pending =
				mode === 'indirect'
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
				mode === 'indirect'
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

	it.each(['indirect', 'direct'] as const)(
		'holds a binding that changes during %s preparation',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			h.changeDuringAdmission();
			const result =
				mode === 'indirect'
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
			expect((await h.gateway.listTools('direct')).tools.map((tool) => tool.name)).toEqual([
				'mcp_portal_list',
				'mcp_portal_search',
				'mcp_portal_describe',
				'mcp_portal_call',
			]);
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

	it.each(['indirect', 'direct'] as const)(
		'rejects an unauthorized effect from a direct-backend bypass in %s',
		async (mode) => {
			const h = createHarness();
			const catalog = await h.gateway.prepareCatalog();
			const result =
				mode === 'indirect'
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

	for (const throwAt of [
		'digest',
		'validation',
		'access',
		'backend',
		'backend-after-effect',
	] as const)
		it.each(['indirect', 'direct'] as const)(
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
						mode === 'indirect'
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
		it.each(['indirect', 'direct'] as const)(
			`preserves every field of ${outcome.kind} in %s`,
			async (mode) => {
				const h = createHarness();
				h.setResult(outcome);
				const result =
					mode === 'indirect'
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
