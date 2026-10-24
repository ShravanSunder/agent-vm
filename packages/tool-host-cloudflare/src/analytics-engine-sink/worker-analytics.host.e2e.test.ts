import { workspaceConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	workspaceConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

const pointSchema = z.object({
	indexes: z.array(z.string()).length(1),
	blobs: z.array(z.string()).length(9),
	doubles: z.array(z.number().finite()).length(3),
});
const analyticsOrganizationId = '33333333-3333-4333-8333-333333333333';
const workspaceName = 'a'.repeat(253) + '𐀀'.repeat(600);
let analyticsToken: string;
const toolName = '工具'.repeat(100);
const serverName = '服务器'.repeat(80);
const canaries = [
	'argument-private-canary',
	'result-private-canary',
	'one-secret-canary',
	'binding-secret-canary',
];
let harness: LocalWorkerHarness;
function configurations(url: string): unknown {
	const parsed = z
		.record(z.string(), workspaceConfigurationSchema)
		.parse(workspaceConfigurations(url));
	const selected = parsed[organizationOne];
	if (selected === undefined) throw new Error('Missing fixture organization.');
	const provider = Object.values(selected.mcp.providers)[0];
	if (provider === undefined) throw new Error('Missing fixture provider.');
	return {
		...parsed,
		[organizationOne]: {
			...selected,
			organizationId: '44444444-4444-4444-8444-444444444444',
			workspaceName,
			mcp: { schemaVersion: 1, providers: { fixture: { ...provider, namespace: serverName } } },
			portal: {
				schemaVersion: 1,
				agents: { 'agent-one': { credentialVersion: 1 }, 'agent-two': { credentialVersion: 1 } },
				profiles: {
					one: {
						namespaces: {
							[serverName]: {
								tools: { allow: '*' },
								calls: {
									withoutApproval: { allow: [toolName] },
									requiresApproval: { allow: ['ask'] },
								},
							},
						},
					},
				},
			},
		},
	};
}
async function points(): Promise<z.infer<typeof pointSchema>[]> {
	return z.array(pointSchema).parse(await (await harness.worker.fetch('/__points')).json());
}
describe('exact local Worker analytics capture and canary exclusion', () => {
	beforeAll(async () => {
		harness = await startLocalWorkerHarness({
			configurations,
			setup: (fixture) => {
				fixture.setCatalog(
					[toolName, 'ask', 'blocked'].map((name) => ({
						name,
						inputSchema: { type: 'object', additionalProperties: true },
					})),
				);
				fixture.setCall(async () => ({
					content: [{ type: 'text', text: 'result-private-canary one-secret-canary' }],
				}));
			},
		});
		analyticsToken = await harness.fixture.sign({
			changes: { organization_id: analyticsOrganizationId },
		});
	});
	afterAll(async () => {
		await harness?.close();
	});
	it.each(['indirect', 'direct'] as const)(
		'writes one safe point for each ran, refused, needs-approval and failed call in %s mode',
		async (mode) => {
			const initialPoints = (await points()).length;
			harness.fixture.setCall(async () => ({
				content: [{ type: 'text', text: 'result-private-canary one-secret-canary' }],
			}));
			const call = async (name: string): Promise<void> => {
				const before = (await points()).length;
				await rpcResult(
					await harness.rpc(
						'tools/call',
						{
							name: 'mcp_portal_call',
							arguments: {
								calls: [
									{
										id: name,
										namespace: serverName,
										toolName: name,
										arguments: { value: 'argument-private-canary' },
									},
								],
							},
						},
						{ token: analyticsToken, path: `/workspaces/${organizationOne}/mcp?tools=${mode}` },
					),
				);
				expect(await points()).toHaveLength(before + 1);
			};
			await call(toolName);
			await call('blocked');
			await call('ask');
			harness.fixture.setCall(async () => ({
				isError: true,
				content: [{ type: 'text', text: 'result-private-canary' }],
			}));
			await call(toolName);
			const captured = (await points()).slice(initialPoints);
			expect(captured).toHaveLength(4);
			expect(captured.map((point) => point.blobs)).toEqual(
				[
					['工具'.repeat(42) + '工', 'ran', 'none'],
					['blocked', 'refused', 'authorization'],
					['ask', 'needs approval', 'approval'],
					['工具'.repeat(42) + '工', 'failed', 'upstream'],
				].map(([tool, outcome, failure]) => [
					analyticsOrganizationId,
					'a'.repeat(253),
					'agent-one',
					mode,
					'服务器'.repeat(28) + '服',
					tool,
					outcome,
					failure,
					'no',
				]),
			);
			for (const point of captured) {
				expect(point.indexes).toEqual([organizationOne]);
				expect(point.blobs.slice(0, 4)).toEqual([
					analyticsOrganizationId,
					'a'.repeat(253),
					'agent-one',
					mode,
				]);
				expect(point.blobs[4]).toBe('服务器'.repeat(28) + '服');
				expect(point.blobs[8]).toBe('no');
				if (point.blobs[6] !== 'needs approval' && point.blobs[6] !== 'refused')
					expect(point.blobs[5]).toBe('工具'.repeat(42) + '工');
				for (const text of point.blobs) {
					const bytes = new TextEncoder().encode(text);
					expect(bytes.byteLength).toBeLessThanOrEqual(256);
					expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(text);
				}
				expect(new TextEncoder().encode(point.blobs.join('')).byteLength).toBeLessThanOrEqual(
					16 * 1024,
				);
			}
			const logs = await (await harness.worker.fetch('/__logs')).text();
			for (const canary of [...canaries, harness.token, analyticsToken]) {
				expect(JSON.stringify(captured)).not.toContain(canary);
				expect(logs).not.toContain(canary);
			}
		},
	);
	it('drops a failing analytics write without changing an allowed result or leaking its error', async () => {
		harness.fixture.setCall(async () => ({ content: [{ type: 'text', text: 'allowed' }] }));
		const invoke = async (): Promise<Record<string, unknown>> =>
			rpcResult(
				await harness.rpc(
					'tools/call',
					{
						name: 'mcp_portal_call',
						arguments: { calls: [{ id: 'drop', namespace: serverName, toolName, arguments: {} }] },
					},
					{ token: analyticsToken },
				),
			);
		const baseline = await invoke();
		await harness.worker.fetch('/__fail-analytics?fail');
		const before = (await points()).length;
		const effectsBefore = harness.fixture.calls.length;
		const response = await invoke();
		expect(response).toEqual(baseline);
		expect(harness.fixture.calls).toHaveLength(effectsBefore + 1);
		expect(JSON.stringify(response)).toContain('allowed');
		expect(await points()).toHaveLength(before);
		const logs = await (await harness.worker.fetch('/__logs')).text();
		expect(logs).toContain('analytics-write-dropped');
		for (const canary of canaries) expect(logs).not.toContain(canary);
	});
});
