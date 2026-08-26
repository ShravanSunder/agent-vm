import { PortalListResultSchema } from '@agent-vm/agent-portal-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalAuthenticatedEnvelope,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES,
	type StandaloneToolPortalProjectionService,
} from './standalone-tool-portal-mcp-projection.js';
import { startStandaloneToolPortalMcpStdioServer } from './standalone-tool-portal-mcp-stdio-server.js';

const principal = {
	agentId: 'agent-a',
	credentialVersion: 1,
	profileAssignmentRevision: 'profile-assignment:1',
	toolPortalProfileId: 'builder',
} as const;

const authenticatedEnvelope = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	principal: { ...principal },
	serviceGeneration: 'standalone-service:1',
} satisfies StandaloneToolPortalAuthenticatedEnvelope;

function createService(): StandaloneToolPortalProjectionService {
	return {
		call: vi.fn(async () => ({ items: [], ok: true })),
		describe: vi.fn(async () => ({ items: [], ok: true })),
		list: vi.fn(async (request: Parameters<StandaloneToolPortalProjectionService['list']>[0]) => ({
			items: request.requests.map(({ id }) => ({
				id,
				status: 'ok' as const,
				value: { namespaceDiscovery: [], namespaces: ['github'], tools: [] },
			})),
			ok: true,
		})),
		search: vi.fn(async () => ({ items: [], ok: true })),
	};
}

describe('standalone Tool Portal scoped stdio projection', () => {
	it('projects the same service under one immutable principal and retires the channel', async () => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const service = createService();
		const server = await startStandaloneToolPortalMcpStdioServer({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			authenticatedEnvelope,
			service,
			transport: serverTransport,
		});
		const client = new Client({ name: 'stdio-test', version: '1.0.0' });
		await client.connect(clientTransport);

		const tools = await client.listTools();
		const result = await client.callTool({
			arguments: { requests: [{ id: 'list-a' }] },
			name: 'tool_portal_list',
		});

		expect(tools.tools.map(({ name }) => name)).toEqual(STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES);
		expect(result.structuredContent).toMatchObject({ ok: true });
		expect(result.isError).toBe(false);
		expect(service.list).toHaveBeenCalledWith(
			{ requests: [{ id: 'list-a', limit: 20 }] },
			expect.objectContaining({
				surfaceClass: 'mcp',
				authenticatedEnvelope,
				correlation: { sessionId: 'standalone-scoped-stdio' },
			}),
		);
		expect(server.service).toBe(service);
		expect(server.authenticatedEnvelope).toEqual(authenticatedEnvelope);
		expect(server.authenticatedEnvelope).not.toBe(authenticatedEnvelope);
		expect(Object.isFrozen(server.authenticatedEnvelope)).toBe(true);
		expect(Object.isFrozen(server.authenticatedEnvelope.principal)).toBe(true);

		await client.close();
		await expect(server.retire()).resolves.toBeUndefined();
	});

	it('derives MCP error state from mixed and all-error canonical item statuses', async () => {
		const mixedListResult = PortalListResultSchema.parse({
			items: [
				{
					id: 'list-ok',
					status: 'ok',
					value: { namespaceDiscovery: [], namespaces: ['github'], tools: [] },
				},
				{
					error: { code: 'provider_unavailable', message: 'Provider is unavailable.' },
					id: 'list-error',
					status: 'error',
				},
			],
			ok: false,
		});
		const allErrorListResult = PortalListResultSchema.parse({
			items: [
				{
					error: { code: 'provider_unavailable', message: 'Provider is unavailable.' },
					id: 'list-error',
					status: 'error',
				},
			],
			ok: false,
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		let invocationCount = 0;
		const service = {
			...createService(),
			list: vi.fn(async () => {
				invocationCount += 1;
				return invocationCount === 1 ? mixedListResult : allErrorListResult;
			}),
		} satisfies StandaloneToolPortalProjectionService;
		const server = await startStandaloneToolPortalMcpStdioServer({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			authenticatedEnvelope,
			service,
			transport: serverTransport,
		});
		const client = new Client({ name: 'stdio-error-status-test', version: '1.0.0' });
		await client.connect(clientTransport);

		try {
			const mixedResult = await client.callTool({
				arguments: { requests: [{ id: 'list-ok' }, { id: 'list-error' }] },
				name: 'tool_portal_list',
			});
			const allErrorResult = await client.callTool({
				arguments: { requests: [{ id: 'list-error' }] },
				name: 'tool_portal_list',
			});

			expect(mixedResult.isError).toBe(true);
			expect(mixedResult.structuredContent).toEqual(mixedListResult);
			expect(allErrorResult.isError).toBe(true);
			expect(allErrorResult.structuredContent).toEqual(allErrorListResult);
		} finally {
			await client.close();
			await server.retire();
		}
	});

	it('bounds oversized text while retaining the canonical structured result', async () => {
		const canonicalResult = PortalListResultSchema.parse({
			items: [
				{
					id: 'oversized-list',
					status: 'ok',
					value: { namespaceDiscovery: [], namespaces: ['n'.repeat(5_000)], tools: [] },
				},
			],
			ok: true,
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const service = {
			...createService(),
			list: vi.fn(async () => canonicalResult),
		} satisfies StandaloneToolPortalProjectionService;
		const server = await startStandaloneToolPortalMcpStdioServer({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			authenticatedEnvelope,
			service,
			transport: serverTransport,
		});
		const client = new Client({ name: 'stdio-oversized-result-test', version: '1.0.0' });
		await client.connect(clientTransport);

		try {
			const result = CallToolResultSchema.parse(
				await client.callTool({
					arguments: { requests: [{ id: 'oversized-list' }] },
					name: 'tool_portal_list',
				}),
			);
			const textContent = result.content[0];

			expect(textContent).toEqual({
				text: 'Tool Portal result exceeded the MCP response bound.',
				type: 'text',
			});
			expect(
				Buffer.byteLength(textContent?.type === 'text' ? textContent.text : '', 'utf8'),
			).toBeLessThanOrEqual(4_096);
			expect(result.isError).toBe(false);
			expect(PortalListResultSchema.parse(result.structuredContent)).toEqual(canonicalResult);
		} finally {
			await client.close();
			await server.retire();
		}
	});

	it('copies identity before startup so caller mutation cannot change admitted requests', async () => {
		const [, serverTransport] = InMemoryTransport.createLinkedPair();
		const service = createService();
		const authenticatedEnvelope = {
			audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
			principal: {
				agentId: 'agent-before-start',
				credentialVersion: 1,
				profileAssignmentRevision: 'profile-assignment:1',
				toolPortalProfileId: 'builder',
			},
			serviceGeneration: 'standalone-service:1',
		} satisfies StandaloneToolPortalAuthenticatedEnvelope;
		const server = await startStandaloneToolPortalMcpStdioServer({
			artifactReader: { read: vi.fn(async () => Promise.reject(new Error('not expected'))) },
			authenticatedEnvelope,
			service,
			transport: serverTransport,
		});

		authenticatedEnvelope.principal.agentId = 'mutated-after-start';

		expect(server.authenticatedEnvelope.principal.agentId).toBe('agent-before-start');
		await expect(server.retire()).resolves.toBeUndefined();
	});
});
