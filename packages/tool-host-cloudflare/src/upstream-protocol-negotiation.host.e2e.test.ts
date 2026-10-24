import { startFakeUpstreamMcpServer } from '@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { organizationOne, organizationTwo } from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

function mixedOrganizations(modernUrl: string, legacyUrl: string): unknown {
	return Object.fromEntries(
		[organizationOne, organizationTwo].map((organizationId, index) => {
			const binding = index === 0 ? 'ONE_CREDENTIAL' : 'TWO_CREDENTIAL';
			return [
				organizationId,
				{
					organizationId,
					workspaceName: `mixed-${String(index)}`,
					approvalKeyBinding: index === 0 ? 'ONE_APPROVAL_KEY' : 'TWO_APPROVAL_KEY',
					mcp: {
						schemaVersion: 1,
						providers: Object.fromEntries(
							[
								['modern', 'read_thing', modernUrl],
								['legacy', 'read', `${legacyUrl}/mcp`],
							].map(([namespace, , url]) => [
								namespace,
								{
									kind: 'mcp',
									namespace,
									transport: {
										kind: 'streamable-http',
										url,
										connectionTimeoutMs: 3000,
										headers: { authorization: { source: 'environment', name: binding } },
									},
								},
							]),
						),
					},
					portal: {
						schemaVersion: 1,
						agents: {
							'agent-one': { credentialVersion: 1 },
							'agent-two': { credentialVersion: 1 },
						},
						profiles: {
							mixed: {
								namespaces: Object.fromEntries(
									[
										['modern', 'read_thing'],
										['legacy', 'read'],
									].map(([namespace, toolName]) => [
										namespace,
										{
											tools: { allow: [toolName], deny: [] },
											calls: {
												withoutApproval: { allow: [toolName] },
												requiresApproval: { allow: [] },
											},
										},
									]),
								),
							},
						},
					},
				},
			];
		}),
	);
}

it('real workerd discovers modern and legacy upstreams, calls each twice through fresh request clients, and reaps every client', async () => {
	// Arrange: the modern server rejects initialize; the independent issuer server only speaks legacy.
	const modern = await startFakeUpstreamMcpServer();
	let harness: LocalWorkerHarness | undefined;
	try {
		const activeHarness = await startLocalWorkerHarness({
			configurations: (legacyUrl) => mixedOrganizations(modern.url, legacyUrl),
			persona: 'mixed',
		});
		harness = activeHarness;
		async function invokeRound(round: number): Promise<number> {
			// Act: each authenticated HTTP request creates its own real upstream runtime.
			const listed = await rpcResult(
				await activeHarness.rpc(
					'tools/list',
					{},
					{ path: '/workspaces/11111111-1111-4111-8111-111111111111/mcp?tools=direct' },
				),
			);
			const names = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse(listed)
				.tools.map((tool) => tool.name);
			expect(names.some((name) => name.startsWith('modern__read_thing__'))).toBe(true);
			expect(names.some((name) => name.startsWith('legacy__read__'))).toBe(true);
			const result = await rpcResult(
				await activeHarness.rpc('tools/call', {
					name: 'mcp_portal_call',
					arguments: {
						calls: [
							{
								id: `modern-${String(round)}`,
								namespace: 'modern',
								toolName: 'read_thing',
								arguments: { title: `modern-${String(round)}` },
							},
							{
								id: `legacy-${String(round)}`,
								namespace: 'legacy',
								toolName: 'read',
								arguments: { value: `legacy-${String(round)}` },
							},
						],
					},
				}),
			);
			// Assert: literal request order, success and independent provider effect records are the oracle.
			const text = z.object({ content: z.tuple([z.object({ text: z.string() })]) }).parse(result)
				.content[0].text;
			const projected = z
				.object({ items: z.array(z.object({ requestId: z.string(), status: z.string() })) })
				.parse(JSON.parse(text));
			expect(projected.items.map(({ requestId, status }) => ({ requestId, status }))).toEqual([
				{ requestId: `modern-${String(round)}`, status: 'success' },
				{ requestId: `legacy-${String(round)}`, status: 'success' },
			]);
			expect(modern.calls).toHaveLength(round + 1);
			expect(activeHarness.fixture.calls).toHaveLength(round + 1);
			const clients = z
				.array(z.object({ id: z.number(), closed: z.literal(1) }))
				.parse(await (await activeHarness.worker.fetch('/__clients')).json());
			return clients.length;
		}
		const firstClientCount = await invokeRound(0);
		const secondClientCount = await invokeRound(1);
		expect(secondClientCount).toBeGreaterThan(firstClientCount);
		expect(modern.calls).toEqual(
			[0, 1].map((round) => ({
				name: 'read_thing',
				argumentsValue: { title: `modern-${String(round)}` },
			})),
		);
		expect(
			harness.fixture.calls.map((call) => ({ name: call.name, value: call.arguments.value })),
		).toEqual([0, 1].map((round) => ({ name: 'read', value: `legacy-${String(round)}` })));
		expect(
			modern.requests.filter(
				(request) => request.method === 'GET' || request.jsonRpcMethods.includes('initialize'),
			),
		).toEqual([]);
		expect(harness.fixture.initializations.length).toBeGreaterThan(0);
		expect(new Set(modern.authorizationHeaders)).toEqual(new Set(['one-secret-canary']));
		expect(new Set(harness.fixture.discoveryCredentials)).toEqual(new Set(['one-secret-canary']));
	} finally {
		await harness?.close();
		await modern.close();
	}
});
