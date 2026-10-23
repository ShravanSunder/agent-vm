import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { organizationOne, organizationTwo } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	portalRead,
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

let harness: LocalWorkerHarness;
describe('Worker organization engines and stateless MCP in local workerd', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness();
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('discovers on authenticated server/discover before any tool request', async () => {
		expect(harness.fixture.discoveryCredentials).toEqual([]);
		const result = await rpcResult(await harness.rpc('server/discover'));
		expect(result.cacheScope).toBe('private');
		expect(result.supportedVersions).toEqual(['2026-07-28']);
		expect(harness.fixture.discoveryCredentials).toEqual(['one-secret-canary']);
		expect(harness.fixture.calls).toEqual([]);
	});
	it('chooses each request case from its address without changing another caller', async () => {
		const lists = await Promise.all(
			['/mcp?tools=direct', '/mcp'].map(async (address) =>
				rpcResult(await harness.rpc('tools/list', {}, { path: address })),
			),
		);
		const names = (result: unknown): string[] =>
			z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(result)
				.tools.map((tool) => tool.name);
		expect(names(lists[0])).toHaveLength(6);
		expect(names(lists[1])).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(
			names(await rpcResult(await harness.rpc('tools/list', {}, { path: '/mcp?tools=direct' }))),
		).toEqual(names(lists[0]));
	});
	it('runs two sequential requests with request-scoped clients and one cached catalog', async () => {
		await rpcResult(await harness.rpc('tools/call', portalRead('first')));
		const initializations = harness.fixture.initializations.length;
		const discoveries = harness.fixture.discoveryCredentials.length;
		await rpcResult(await harness.rpc('tools/call', portalRead('second')));
		expect(harness.fixture.calls.slice(-2).map((call) => call.arguments.value)).toEqual([
			'first',
			'second',
		]);
		expect(harness.fixture.initializations).toHaveLength(initializations + 1);
		expect(harness.fixture.discoveryCredentials).toHaveLength(discoveries);
	});
	it('routes the same names to each token organization and sender policies', async () => {
		const tokenTwo = await harness.fixture.sign({ organizationId: organizationTwo });
		await rpcResult(await harness.rpc('tools/call', portalRead('two'), { token: tokenTwo }));
		await rpcResult(
			await harness.rpc('tools/call', portalRead('false-labels'), {
				path: `/mcp?organization_id=${organizationTwo}&agent=agent-two&sessionId=spoof`,
				headers: {
					'x-organization-id': organizationTwo,
					'x-agent-id': 'agent-two',
					'Mcp-Session-Id': 'spoof',
				},
			}),
		);
		expect(harness.fixture.calls.slice(-2).map((call) => call.credential)).toEqual([
			'two-secret-canary',
			'one-secret-canary',
		]);
		const otherAgent = await harness.fixture.sign({ agentId: 'agent-two' });
		const before = harness.fixture.calls.length;
		await rpcResult(await harness.rpc('tools/call', portalRead('denied'), { token: otherAgent }));
		expect(harness.fixture.calls).toHaveLength(before);
	});
	it.each(['missing', 'forged', 'expired', 'wrong-audience', 'missing-organization'])(
		'refuses %s before a tool effect',
		async (kind) => {
			const before = harness.fixture.calls.length;
			const token =
				kind === 'forged'
					? await harness.fixture.sign({ forge: true })
					: await harness.fixture.sign({
							changes:
								kind === 'expired'
									? { exp: 1 }
									: kind === 'wrong-audience'
										? { aud: 'other' }
										: kind === 'missing-organization'
											? { organization_id: undefined }
											: {},
						});
			const response = await harness.rpc('tools/call', portalRead(), {
				token,
				...(kind === 'missing' ? { headers: { authorization: '' } } : {}),
			});
			expect(response.status).toBe(401);
			expect(harness.fixture.calls).toHaveLength(before);
		},
	);
	it('refuses a removed warm agent on its very next request', async () => {
		await harness.control({
			kind: 'admission',
			organizationId: organizationOne,
			agentId: 'agent-one',
			state: 'removed',
		});
		const before = harness.fixture.calls.length;
		expect((await harness.rpc('tools/call', portalRead())).status).toBe(401);
		expect(harness.fixture.calls).toHaveLength(before);
		await harness.control({
			kind: 'admission',
			organizationId: organizationOne,
			agentId: 'agent-one',
			state: 'listed',
		});
	});
});
