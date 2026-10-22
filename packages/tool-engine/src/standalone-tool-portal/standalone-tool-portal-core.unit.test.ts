import { readFile } from 'node:fs/promises';

import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
} from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createStandaloneToolPortalCore } from '#standalone-tool-portal/standalone-tool-portal-core';
import {
	createStandaloneCoreFixture,
	fixtureRevision,
	type CoreFixtureOptions,
} from '#standalone-tool-portal/test-fixtures/standalone-portal-core-fixture';

const verified = { authenticatedRef: 'host-verified-agent' };
const call = { id: 'call', namespace: 'example', name: 'read', arguments: {} };
const oracleSchema = z.object({
	baseline: z.literal('d25be0465427008f1b55f44264ba72fe102e6b92'),
	operationIds: z.record(z.string(), z.string()),
	owningGeneration: z.string(),
	requests: z.object({
		call: PortalCallRequestSchema,
		list: PortalListRequestSchema,
		search: PortalSearchRequestSchema,
		describe: PortalDescribeRequestSchema,
	}),
	results: z.object({
		call: PortalCallResultSchema,
		list: PortalListResultSchema,
		search: PortalSearchResultSchema,
		describe: PortalDescribeResultSchema,
	}),
});

describe('neutral standalone Tool Portal core', () => {
	it('matches the frozen d25 built core for all four operations and mixed canonical outcomes', async () => {
		const oracle = oracleSchema.parse(
			JSON.parse(
				await readFile(
					new URL('./standalone-portal-d25be046.snapshot.json', import.meta.url),
					'utf8',
				),
			),
		);
		const fixture = createStandaloneCoreFixture(oracle);

		const results = {
			list: await fixture.core.list(oracle.requests.list, verified),
			search: await fixture.core.search(oracle.requests.search, verified),
			describe: await fixture.core.describe(oracle.requests.describe, verified),
			call: await fixture.core.call(oracle.requests.call, verified),
		};

		for (const operation of ['list', 'search', 'describe', 'call'] as const) {
			expect(JSON.stringify(results[operation]), operation).toBe(
				JSON.stringify(oracle.results[operation]),
			);
		}
		expect(fixture.effects.map((invocation) => invocation.capability.tool)).toEqual([
			'read',
			'failed',
			'uncertain',
		]);
		expect(fixture.batches).toEqual([[oracle.operationIds['write']]]);
	});

	it('requires real S2 operation arming and matching receipts for approved effects', async () => {
		const fixture = createStandaloneCoreFixture();

		const result = await fixture.core.call(
			{ calls: [{ ...call, name: 'write' }] },
			{ ...verified, approved: true },
		);

		expect(result.items[0]).toMatchObject({ status: 'ok', owningGeneration: 'backend-generation' });
		expect(fixture.effects).toHaveLength(1);
		expect(fixture.effects[0]?.approvalReceiptRef).toBe('receipt:operation:call');
		expect(fixture.transitions).toEqual(['armed', 'completed']);
	});

	it('preserves a resource-proven cancellation without upgrading it to uncertainty', async () => {
		const fixture = createStandaloneCoreFixture();

		const result = await fixture.core.call({ calls: [{ ...call, name: 'cancelled' }] }, verified);

		expect(result.items[0]).toMatchObject({
			status: 'error',
			owningGeneration: 'backend-generation',
			error: { code: 'cancelled' },
			outcome: {
				kind: 'cancelled-proven',
				certainty: 'proven-terminated',
				retryClass: 'manual-only',
			},
		});
		expect(fixture.effects).toHaveLength(1);
	});

	it('lets S2 refuse a receipt revoked after batch preparation before the resource effect', async () => {
		const fixture = createStandaloneCoreFixture();
		const core = createStandaloneToolPortalCore<CoreFixtureOptions, undefined>({
			binding: { workspaceLayer: 'not-configured', config: fixtureRevision },
			now: () => Date.parse('2026-10-21T00:00:00.000Z'),
			resolveInvocation: async (options) => {
				const invocation = await fixture.resolve(options);
				return {
					...invocation,
					prepareBatch: async (plans) => {
						const prepared = await invocation.prepareBatch(plans);
						return {
							...prepared,
							approvals: { ...prepared.approvals, receipt: async () => ({ kind: 'denied' }) },
						};
					},
				};
			},
		});

		const result = await core.call(
			{ calls: [{ ...call, name: 'write' }] },
			{ ...verified, approved: true },
		);

		expect(fixture.effects).toHaveLength(0);
		expect(result.items[0]).toMatchObject({ status: 'error', outcome: { kind: 'not-dispatched' } });
		expect(fixture.transitions).toHaveLength(0);
	});

	it('binds a 50-item protected batch once and rejects oversized or duplicate batches before effects', async () => {
		const fixture = createStandaloneCoreFixture();
		const calls = Array.from({ length: 50 }, (_, index) => ({
			...call,
			id: `write-${index}`,
			name: 'write',
		}));

		const result = await fixture.core.call({ calls }, { ...verified, approved: true });
		await expect(
			fixture.core.call({ calls: [...calls, { ...call, id: 'extra', name: 'write' }] }, verified),
		).rejects.toThrow();
		await expect(fixture.core.call({ calls: [call, call] }, verified)).rejects.toThrow();

		expect(result.ok).toBe(true);
		expect(fixture.batches).toHaveLength(1);
		expect(fixture.batches[0]).toHaveLength(50);
		expect(fixture.effects).toHaveLength(50);
	});

	it('refuses hidden authority fields and unknown host references before invoking the resource', async () => {
		const fixture = createStandaloneCoreFixture();

		await expect(
			fixture.core.call(
				PortalCallRequestSchema.passthrough().parse({ calls: [call], principal: 'agent-b' }),
				verified,
			),
		).rejects.toThrow();
		await expect(
			fixture.core.call({ calls: [call] }, { authenticatedRef: 'model-selected-agent' }),
		).rejects.toThrow('Unknown authenticated context');

		expect(fixture.effects).toHaveLength(0);
		expect(fixture.batches).toHaveLength(0);
	});

	it('does not dispatch a host fact projection for a different capability or argument', async () => {
		const fixture = createStandaloneCoreFixture();
		const core = createStandaloneToolPortalCore<CoreFixtureOptions, undefined>({
			binding: { workspaceLayer: 'not-configured', config: fixtureRevision },
			now: () => 0,
			resolveInvocation: async (options) => {
				const invocation = await fixture.resolve(options);
				return {
					...invocation,
					accessForCall: async (requestedCall) =>
						await invocation.accessForCall({ ...requestedCall, arguments: { widened: true } }),
				};
			},
		});

		const result = await core.call({ calls: [call] }, verified);

		expect(result.items[0]).toMatchObject({
			status: 'error',
			error: { code: 'capability_denied' },
		});
		expect(fixture.effects).toHaveLength(0);
	});

	it.each(['id', 'operationId'] as const)(
		'keeps a wrong backend %s ambiguous after an effect',
		async (field) => {
			const fixture = createStandaloneCoreFixture();
			const core = createStandaloneToolPortalCore<CoreFixtureOptions, undefined>({
				binding: { workspaceLayer: 'not-configured', config: fixtureRevision },
				now: () => 0,
				resolveInvocation: async (options) => {
					const invocation = await fixture.resolve(options);
					return {
						...invocation,
						prepareBatch: async (plans) => {
							const prepared = await invocation.prepareBatch(plans);
							return {
								...prepared,
								backends: new Map(
									[...prepared.backends].map(([kind, backend]) => [
										kind,
										{
											...backend,
											invoke: async (request) => {
												const result = await backend.invoke(request);
												if (
													result.kind !== 'completed' ||
													typeof result.result !== 'object' ||
													result.result === null ||
													Array.isArray(result.result)
												)
													throw new Error('Expected canonical fixture object.');
												return { ...result, result: { ...result.result, [field]: 'mismatched' } };
											},
										},
									]),
								),
							};
						},
					};
				},
			});

			const result = await core.call({ calls: [call] }, verified);

			expect(result.items[0]).toMatchObject({
				id: call.id,
				operationId: 'operation:call',
				status: 'error',
				outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
			});
			expect(fixture.effects).toHaveLength(1);
		},
	);
});
