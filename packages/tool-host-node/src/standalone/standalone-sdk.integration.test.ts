import {
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';
import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { describe, expect, it } from 'vitest';

import { createStandaloneToolPortalApprovalToken } from '#node-host/standalone/standalone-batch-approval';
import { startStandaloneToolPortalMcpHttpServer } from '#node-host/standalone/standalone-http-servers';
import {
	startControlledProvider,
	secretCanary,
	toolInputSchema,
} from '#node-host/test-fixtures/node-host-fixture';
import { createNodeToolPortalMcpTransport as createOldNodeToolPortalMcpTransport } from '#node-host/test-fixtures/old-node-tool-portal-mcp-transport';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
	standaloneKey,
} from '#node-host/test-fixtures/standalone-host-fixture';

async function sdkClient(endpoint: URL, agent = 'agent-a'): Promise<ToolPortalMcpClient> {
	const client = new ToolPortalMcpClient({
		transport: createNodeToolPortalMcpTransport({
			kind: 'http',
			endpoint,
			authorization: `credential-${agent}`,
		}),
	});
	await client.connect();
	return client;
}

describe('Portal SDK through the real standalone Node route', () => {
	it('lists, searches, describes, calls, approves exactly once, and reads caller-owned artifact bytes', async () => {
		const provider = await startControlledProvider(
			'standalone',
			['read', 'ask', 'binary', 'hidden', 'blocked'].map((name) => ({
				name,
				inputSchema: toolInputSchema,
				description: `${name} capability`,
			})),
		);
		const fixture = await createStandaloneHostFixture(provider);
		expect(provider.listings).toEqual(['standalone']);
		const host = await startStandaloneToolPortalMcpHttpServer({
			hostname: '127.0.0.1',
			port: 0,
			routePath: '/portal',
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: [],
			credentialSet: standaloneCredentials,
			artifactReader: fixture.artifactReader,
			service: fixture.service,
		});
		const client = await sdkClient(host.endpoint);
		const peer = await sdkClient(host.endpoint, 'agent-b');
		try {
			const list = await client.list(
				PortalListRequestSchema.parse({ requests: [{ id: 'list' }] }),
				{ signal: AbortSignal.timeout(2000) },
			);
			const search = await client.search(
				PortalSearchRequestSchema.parse({ requests: [{ id: 'search', query: 'read' }] }),
			);
			const description = await client.describe(
				PortalDescribeRequestSchema.parse({
					requests: [
						{
							id: 'describe',
							tools: [{ namespace: 'example', name: 'read' }],
							includeTypescriptHelper: true,
						},
					],
				}),
			);
			expect(JSON.stringify(list)).toContain('read');
			expect(JSON.stringify(search)).toContain('read');
			expect(JSON.stringify(list)).not.toContain('hidden');
			expect(JSON.stringify(list)).not.toContain('blocked');
			expect(description.items[0]?.status).toBe('ok');
			if (description.items[0]?.status !== 'ok') throw new Error('Expected descriptor.');
			expect(description.items[0].value.tools[0]?.typescriptHelper).toBeTypeOf('string');
			const read = await client.call({
				calls: [{ id: 'read', namespace: 'example', name: 'read', arguments: { value: 42 } }],
			});
			expect(read.ok).toBe(true);
			expect(JSON.stringify(read)).not.toContain(secretCanary);
			expect(provider.effects).toHaveLength(1);
			const request = {
				calls: [{ id: 'ask', namespace: 'example', name: 'ask', arguments: { value: 7 } }],
			};
			const challenge = await client.call(request);
			expect(challenge.items[0]?.status).toBe('approval_required');
			expect(provider.effects).toHaveLength(1);
			const intent = fixture.approvalIntents.at(-1);
			if (intent === undefined) throw new Error('Missing actual protected batch.');
			const token = createStandaloneToolPortalApprovalToken({
				intent,
				expiresAt: new Date(fixture.now() + 60_000).toISOString(),
				hmacKey: standaloneKey,
				keyVersion: 1,
				tokenId: '10000000-0000-4000-8000-000000000051',
			});
			expect((await client.call(request, { approvalToken: token })).ok).toBe(true);
			expect(provider.effects).toHaveLength(2);
			const replay = await client.call(request, { approvalToken: token });
			expect(replay.items[0]?.outcome.kind).toBe('ambiguous');
			expect(provider.effects).toHaveLength(2);
			const binary = await client.call({
				calls: [{ id: 'binary', namespace: 'example', name: 'binary', arguments: { value: 8 } }],
			});
			expect(binary.items[0]).toMatchObject({ status: 'ok', artifacts: [fixture.reference] });
			const artifact = await client.artifacts.read({
				reference: fixture.reference,
				maxBytes: 8,
				offsetBytes: 0,
			});
			expect(Buffer.from(artifact.contentBase64, 'base64')).toEqual(fixture.artifactBytes);
			expect(artifact.mediaType).toBe('application/octet-stream');
			const partial = await client.artifacts.read({
				reference: fixture.reference,
				maxBytes: 2,
				offsetBytes: 2,
			});
			expect(Buffer.from(partial.contentBase64, 'base64')).toEqual(
				fixture.artifactBytes.subarray(2, 4),
			);
			expect(partial.truncated).toBe(true);
			await expect(
				peer.artifacts.read({ reference: fixture.reference, maxBytes: 8, offsetBytes: 0 }),
			).rejects.toThrow('artifact read failed');
			await expect(
				client.artifacts.read({
					reference: { ...fixture.reference, fingerprint: `sha256:${'b'.repeat(64)}` },
					maxBytes: 8,
					offsetBytes: 0,
				}),
			).rejects.toThrow('artifact read failed');
			await expect(
				client.artifacts.read({ reference: fixture.reference, maxBytes: 8, offsetBytes: 9 }),
			).rejects.toThrow('artifact read failed');
			fixture.setNow(Date.parse(fixture.reference.expiresAt) + 1);
			await expect(
				client.artifacts.read({ reference: fixture.reference, maxBytes: 8, offsetBytes: 0 }),
			).rejects.toThrow('artifact read failed');
			expect(provider.effects).toHaveLength(3);
			const reconnect = await sdkClient(host.endpoint);
			try {
				expect(
					(
						await reconnect.list(
							PortalListRequestSchema.parse({ requests: [{ id: 'reconnect' }] }),
							{ signal: AbortSignal.timeout(2000) },
						)
					).ok,
				).toBe(true);
			} finally {
				await reconnect.close();
			}
			expect(provider.effects).toHaveLength(3);
		} finally {
			await Promise.all([client.close(), peer.close()]);
			await host.retire();
			await fixture.close();
			await provider.close();
		}
	});

	it('HTTP provisional A preserves the old grace-expired error identity with one effect and no replay', async () => {
		const oldProvider = await startControlledProvider('old-grace');
		const provider = await startControlledProvider('new-grace');
		const fixture = await createStandaloneHostFixture(provider);
		const host = await startStandaloneToolPortalMcpHttpServer({
			hostname: '127.0.0.1',
			port: 0,
			routePath: '/portal',
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: [],
			credentialSet: standaloneCredentials,
			artifactReader: fixture.artifactReader,
			service: fixture.service,
		});
		const old = createOldNodeToolPortalMcpTransport({
			kind: 'http',
			endpoint: new URL(oldProvider.url),
			authorization: 'fixture',
		});
		const client = await sdkClient(host.endpoint);
		const oldHold = oldProvider.holdCalls();
		const hold = provider.holdCalls();
		try {
			await old.connect();
			const oldAbort = new AbortController();
			const abort = new AbortController();
			const reason = { kind: 'interrupted', outcome: 'uncertain', retryClass: 'forbidden' };
			const oldResult = old
				.callTool(
					{ name: 'read', arguments: { value: 1 } },
					{ signal: oldAbort.signal, resultGraceAfterAbortMs: 1 },
				)
				.catch((error: unknown) => error);
			await oldHold.entered;
			oldAbort.abort(reason);
			const oldError: unknown = await oldResult;
			const result = client
				.call(
					{ calls: [{ id: 'abort', namespace: 'example', name: 'read', arguments: { value: 1 } }] },
					{ signal: abort.signal, resultGraceAfterAbortMs: 1000 },
				)
				.catch((error: unknown) => error);
			await hold.entered;
			abort.abort(reason);
			const error: unknown = await result;
			expect(oldError).toBe(reason);
			expect(error).toBe(oldError);
			expect(error).toEqual({ kind: 'interrupted', outcome: 'uncertain', retryClass: 'forbidden' });
			expect(oldProvider.effects).toHaveLength(1);
			expect(provider.effects).toHaveLength(1);
		} finally {
			oldHold.release();
			hold.release();
			await Promise.all([old.close(), client.close()]);
			await host.retire();
			await fixture.close();
			await Promise.all([oldProvider.close(), provider.close()]);
		}
	});
});
