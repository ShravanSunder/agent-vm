import type { ResourceResult } from '@agent-collaboration/tool-engine/dispatch';
import type { McpGateway, PortalBatchResult } from '@agent-collaboration/tool-engine/mcp-gateway';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createNodeMcpServer } from '#node-host/ingress/node-mcp-server';
import { decodedResult } from '#node-host/test-fixtures/node-host-fixture';

const outcomes: readonly ResourceResult[] = [
	{ kind: 'completed', result: { literal: 'leaf-receipt' } },
	{ kind: 'pending', reference: 'approval:1', detail: { literal: 'waiting' } },
	{
		kind: 'denied',
		state: { kind: 'blocked-by-policy', rule: { source: 'profile-selector', ruleId: 'deny-1' } },
	},
	{ kind: 'not-dispatched', reason: 'unavailable' },
	{ kind: 'failed', reason: 'known-leaf-failure' },
	{ kind: 'ambiguous', reason: 'reply-lost' },
	{ kind: 'result-expired' },
];

// This checks only the host's MCP serialization boundary. Admission and effects
// remain real in node-host.integration and J1; this fixture cannot establish them.
describe('Node MCP literal result variants over the pinned SDK protocol', () => {
	it.each(outcomes)(
		'preserves $kind without interpreting transport success as completion',
		async (outcome) => {
			const item =
				outcome.kind === 'completed'
					? { ok: true as const, input: { id: 'item' }, output: { result: outcome.result } }
					: { ok: false as const, input: { id: 'item' }, error: outcome };
			const batch: PortalBatchResult = {
				ok: outcome.kind === 'completed',
				diagnostics: [],
				errors: [],
				results: { item },
			};
			const gateway: McpGateway = {
				listTools: async () => [],
				prepareCatalog: async () => ({ agentScopeId: 'fixture', sourceHash: 'fixture', tools: [] }),
				list: async () => batch,
				search: async () => batch,
				describe: async () => batch,
				call: async () => batch,
				callDirect: async () => batch,
			};
			const server = await createNodeMcpServer({ gateway, exposure: 'compact' });
			const client = new Client({ name: 'result-boundary-client', version: '1.0.0' });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			try {
				const received = await client.callTool({
					name: 'mcp_portal_call',
					arguments: {
						calls: [{ id: 'item', namespace: 'alpha', toolName: 'read', arguments: {} }],
					},
				});
				expect(decodedResult(received)).toEqual({
					ok: outcome.kind === 'completed',
					diagnostics: [],
					errors: [],
					results: { item },
				});
				expect(received.structuredContent).toEqual({
					ok: outcome.kind === 'completed',
					diagnostics: [],
					errors: [],
					results: { item },
				});
				expect(received.isError ?? false).toBe(outcome.kind !== 'completed');
			} finally {
				await client.close();
				await server.close();
			}
		},
	);
});
