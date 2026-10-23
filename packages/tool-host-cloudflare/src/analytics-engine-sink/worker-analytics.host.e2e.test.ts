import { organizationConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	organizationConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import {
	rpcResult,
	startLocalWorkerHarness,
	type LocalWorkerHarness,
} from '#worker-host/test-fixtures/local-worker-harness';

const pointSchema = z.object({
	indexes: z.array(z.string()).length(1),
	blobs: z.array(z.string()).length(8),
	doubles: z.array(z.number().finite()).length(3),
});
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
		.record(z.string(), organizationConfigurationSchema)
		.parse(organizationConfigurations(url));
	const selected = parsed[organizationOne];
	if (selected === undefined) throw new Error('Missing fixture organization.');
	const provider = Object.values(selected.mcp.providers)[0];
	if (provider === undefined) throw new Error('Missing fixture provider.');
	return {
		...parsed,
		[organizationOne]: {
			...selected,
			organizationName: '组织'.repeat(600),
			mcp: { schemaVersion: 1, providers: { fixture: { ...provider, namespace: serverName } } },
			portal: {
				schemaVersion: 1,
				agents: { 'agent-one': { profile: 'one' }, 'agent-two': { profile: 'one' } },
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
	});
	afterAll(async () => {
		await harness?.close();
	});
	it('writes one safe point for each ran, refused, needs-approval and failed call', async () => {
		const call = async (name: string): Promise<void> => {
			await rpcResult(
				await harness.rpc('tools/call', {
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
				}),
			);
		};
		await call(toolName);
		await call('blocked');
		await call('ask');
		harness.fixture.setCall(async () => ({
			isError: true,
			content: [{ type: 'text', text: 'result-private-canary' }],
		}));
		await call(toolName);
		const captured = await points();
		expect(captured).toHaveLength(4);
		expect(captured.map((point) => point.blobs[5])).toEqual([
			'ran',
			'refused',
			'needs approval',
			'failed',
		]);
		for (const point of captured) {
			expect(point.indexes).toEqual([organizationOne]);
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
		for (const canary of [...canaries, harness.token]) {
			expect(JSON.stringify(captured)).not.toContain(canary);
			expect(logs).not.toContain(canary);
		}
	});
	it('drops a failing analytics write without changing an allowed result or leaking its error', async () => {
		harness.fixture.setCall(async () => ({ content: [{ type: 'text', text: 'allowed' }] }));
		await harness.worker.fetch('/__fail-analytics?fail');
		const before = (await points()).length;
		const response = await rpcResult(
			await harness.rpc('tools/call', {
				name: 'mcp_portal_call',
				arguments: { calls: [{ id: 'drop', namespace: serverName, toolName, arguments: {} }] },
			}),
		);
		expect(JSON.stringify(response)).toContain('allowed');
		expect(await points()).toHaveLength(before);
		const logs = await (await harness.worker.fetch('/__logs')).text();
		expect(logs).toContain('analytics-write-dropped');
		for (const canary of canaries) expect(logs).not.toContain(canary);
	});
});
