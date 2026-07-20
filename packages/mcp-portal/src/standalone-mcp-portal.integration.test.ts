import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';

import { startPortalServer } from './cli/serve-command.js';
import { deriveAgentBearerToken } from './portal-auth/agent-bearer-token.js';
import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
} from './testing/fake-upstream-mcp-server.js';

const agentId = 'standalone-agent';
const masterKey = Buffer.from('0123456789abcdef0123456789abcdef');
const portalToolNames = [
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
] as const;

function asClientTransport(transport: StreamableHTTPClientTransport): Transport {
	return transport as unknown as Transport;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstTextContent(value: unknown): string {
	if (!isObjectRecord(value) || !Array.isArray(value.content)) {
		return '';
	}
	const firstContent = value.content[0];
	if (
		!isObjectRecord(firstContent) ||
		firstContent.type !== 'text' ||
		typeof firstContent.text !== 'string'
	) {
		return '';
	}
	return firstContent.text;
}

describe('standalone MCP Portal', () => {
	it('boots independently and serves all four mcp_portal tools over authenticated HTTP', async () => {
		const upstream = await startFakeUpstreamMcpServer();
		const configDir = await mkdtemp(join(tmpdir(), 'standalone-mcp-portal-'));
		let upstreamClosed = false;
		let portal: Awaited<ReturnType<typeof startPortalServer>> | undefined;
		let client: Client | undefined;
		try {
			await writeFile(
				join(configDir, 'mcp.config.jsonc'),
				JSON.stringify({
					providers: {
						standaloneFixture: {
							discovery: {},
							kind: 'mcp',
							namespace: fakeUpstreamNamespace,
							transport: {
								kind: 'streamable-http',
								requiredEgressHosts: [],
								url: upstream.url,
							},
						},
					},
					schemaVersion: 1,
				}),
			);
			await writeFile(
				join(configDir, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { [agentId]: { profile: 'standalone' } },
					externalAuth: {
						masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
					},
					mcpProxy: {
						auth: { headerName: 'authorization' },
						server: { host: '127.0.0.1', port: 18_791 },
					},
					profiles: {
						standalone: {
							namespaces: {
								[fakeUpstreamNamespace]: {
									calls: {
										requiresApproval: { allow: [] },
										withoutApproval: { allow: ['read_thing'] },
									},
									tools: { allow: ['read_thing'] },
								},
							},
						},
					},
					schemaVersion: 1,
				}),
			);
			portal = await startPortalServer({
				args: { agentOverrides: [], configDir, port: 0 },
				env: { MCP_PORTAL_MASTER_KEY: masterKey.toString('base64url') },
				logger: { log: () => undefined },
			});
			const endpoint = `http://127.0.0.1:${String(portal.port)}/agents/${agentId}/mcp`;
			await expect(fetch(endpoint)).resolves.toMatchObject({ status: 401 });

			const bearer = deriveAgentBearerToken({ agentId, credentialVersion: 1, masterKey });
			const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
				requestInit: { headers: { authorization: `Bearer ${bearer}` } },
			});
			client = new Client({ name: 'standalone-mcp-portal-regression', version: '1.0.0' });
			await client.connect(asClientTransport(transport));
			expect(transport.sessionId).toMatch(/\S+/u);

			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toEqual(portalToolNames);

			const listResult = await client.callTool({
				arguments: {
					requests: [{ id: 'list-standalone', limit: 10, namespaces: [fakeUpstreamNamespace] }],
				},
				name: 'mcp_portal_list',
			});
			expect(JSON.parse(firstTextContent(listResult))).toMatchObject({
				structuredContent: {
					ok: true,
					results: {
						'list-standalone': {
							ok: true,
							output: {
								namespaces: [fakeUpstreamNamespace],
								tools: [
									expect.objectContaining({
										namespace: fakeUpstreamNamespace,
										toolName: 'read_thing',
									}),
								],
							},
						},
					},
				},
			});

			const callResult = await client.callTool({
				arguments: {
					calls: [
						{
							arguments: { title: 'standalone call' },
							id: 'call-standalone',
							namespace: fakeUpstreamNamespace,
							toolName: 'read_thing',
						},
					],
				},
				name: 'mcp_portal_call',
			});
			expect(JSON.parse(firstTextContent(callResult))).toMatchObject({
				items: [
					{
						requestId: 'call-standalone',
						status: 'success',
						structuredContent: {
							namespace: fakeUpstreamNamespace,
							result: { structuredContent: { name: 'read_thing', ok: true } },
							toolName: 'read_thing',
						},
					},
				],
			});
			expect(upstream.calls).toEqual([
				{ argumentsValue: { title: 'standalone call' }, name: 'read_thing' },
			]);

			await client.close();
			client = undefined;
			await portal.close();
			portal = undefined;
			await upstream.close();
			upstreamClosed = true;
		} finally {
			await Promise.allSettled([
				...(client === undefined ? [] : [client.close()]),
				...(portal === undefined ? [] : [portal.close()]),
				...(upstreamClosed ? [] : [upstream.close()]),
			]);
		}
	});
});
