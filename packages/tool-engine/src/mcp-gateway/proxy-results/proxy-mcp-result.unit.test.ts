import { createPortalAgentIdentity, createPortalSessionManager } from '@agent-vm/mcp-portal';
import { createPortalCore, createPortalToolHandlers } from '@agent-vm/mcp-portal/core';
import { createPortalMcpServer } from '@agent-vm/mcp-portal/mcp-proxy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import {
	projectProxyMcpResult,
	type ProxyMcpOperation,
} from '#mcp-gateway/proxy-results/proxy-mcp-result';

const identity = createPortalAgentIdentity({
	agentId: 'agent-a',
	agentScopeId: 'agent-a',
	source: 'mcp-proxy-bearer',
});
const inputSchema = {
	type: 'object' as const,
	properties: Object.fromEntries(
		Array.from({ length: 7 }, (_, index) => [`field${index}`, { type: 'integer' }]),
	),
	required: Array.from({ length: 7 }, (_, index) => `field${index}`),
	additionalProperties: false,
};
const validArguments = Object.fromEntries(
	Array.from({ length: 7 }, (_, index) => [`field${index}`, index]),
);
const invalidArguments = Object.fromEntries(
	Array.from({ length: 7 }, (_, index) => [`field${index}`, 'invalid']),
);
const call = (
	id: string,
	toolName = 'read',
	argumentsValue: Record<string, unknown> = validArguments,
): Record<string, unknown> => ({ id, namespace: 'alpha', toolName, arguments: argumentsValue });
const scenarios: readonly {
	readonly name: string;
	readonly operation: Exclude<ProxyMcpOperation, 'direct'>;
	readonly input: unknown;
}[] = [
	{
		name: 'list with discovery diagnostics',
		operation: 'mcp_portal_list',
		input: { requests: [{ id: 'list' }] },
	},
	{
		name: 'search',
		operation: 'mcp_portal_search',
		input: { requests: [{ id: 'search', query: 'read' }] },
	},
	{
		name: 'describe and helper bytes',
		operation: 'mcp_portal_describe',
		input: {
			requests: [
				{
					id: 'describe',
					tools: [{ namespace: 'alpha', toolName: 'read' }],
					includeTypescriptHelper: true,
				},
			],
		},
	},
	{ name: 'successful call', operation: 'mcp_portal_call', input: { calls: [call('success')] } },
	{ name: 'malformed call uses scalar result', operation: 'mcp_portal_call', input: { calls: [] } },
	{
		name: 'duplicate ID batch errors use scalar result',
		operation: 'mcp_portal_call',
		input: { calls: [call('duplicate'), call('duplicate')] },
	},
	{
		name: 'mixed request order, hidden, failed, approval and truncated validation errors',
		operation: 'mcp_portal_call',
		input: {
			calls: [
				call('z-success'),
				call('a-invalid', 'read', invalidArguments),
				call('hidden', 'hidden'),
				call('failed', 'fail'),
				call('approval', 'ask'),
			],
		},
	},
];

// The oracle is the real, unchanged 08f9e426 core and MCP projection over an
// in-memory protocol transport. Provider behavior is literal; this proves the
// pure result mapping, not provider HTTP delivery or dispatch authority.
const approval: Parameters<typeof createPortalCore>[0]['approval'] = (calls) => ({
	decisionsByCallId: Object.fromEntries(
		calls.map((entry) => [
			entry.id,
			entry.toolName === 'ask'
				? { kind: 'approval_required', level: 'standard' }
				: { kind: 'allow' },
		]),
	),
});

function referenceFixture(): {
	readonly core: ReturnType<typeof createPortalCore>;
	readonly handlers: ReturnType<typeof createPortalToolHandlers>;
} {
	const runtime = {
		listTools: async ({ namespace }: { readonly namespace: string }) => {
			if (namespace === 'unavailable') throw new Error('controlled discovery failure');
			return ['read', 'fail', 'ask', 'hidden'].map((name) => ({ name, inputSchema }));
		},
		closeAgentScope: async (): Promise<void> => {},
		callUpstreamTool: async ({ toolName }: { readonly toolName: string }): Promise<unknown> => {
			if (toolName === 'fail') throw new Error('controlled provider failure');
			return { literal: 42 };
		},
	};

	const options = {
		accessPolicy: {
			enabledNamespaces: ['alpha', 'unavailable'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: { 'agent-a': [{ namespace: 'alpha', toolName: 'hidden' }] },
		},
		catalogTtlMs: 60_000,
		runtime,
		upstreamNamespaces: ['alpha', 'unavailable'],
	};
	const sessions = createPortalSessionManager(options);
	return {
		core: createPortalCore({ ...options, approval }),
		handlers: createPortalToolHandlers({
			approval,
			callUpstreamTool: runtime.callUpstreamTool,
			getSession: sessions.getSession,
		}),
	};
}

describe('result shape and text bytes at the legacy proxy consumer', () => {
	it.each(scenarios)('$name', async ({ operation, input }) => {
		const reference = referenceFixture();
		const oldServer = createPortalMcpServer({ core: reference.core, scope: identity });
		const client = new Client({ name: 'reference-projection', version: '1' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await oldServer.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			const args =
				typeof input === 'object' && input !== null && !Array.isArray(input)
					? Object.fromEntries(Object.entries(input))
					: {};
			const oldResult = await client.callTool({ name: operation, arguments: args });
			const handler =
				operation === 'mcp_portal_list'
					? reference.handlers.list
					: operation === 'mcp_portal_search'
						? reference.handlers.search
						: operation === 'mcp_portal_describe'
							? reference.handlers.describe
							: reference.handlers.call;
			const batch = await handler({ identity, input });
			const actual = projectProxyMcpResult({ operation, input, result: batch });
			expect(actual).toEqual(oldResult);
		} finally {
			await client.close();
			await oldServer.close();
			await reference.core.close();
		}
	});
});

it('keeps the fixed public catalog-call ID while private approval-entry IDs stay internal', async () => {
	const reference = referenceFixture();
	const completeCore = createPortalCore({
		accessPolicy: {
			enabledNamespaces: ['alpha'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		catalogTtlMs: 60_000,
		upstreamNamespaces: ['alpha'],
		approval: (calls) => ({
			decisionsByCallId: Object.fromEntries(calls.map((entry) => [entry.id, { kind: 'allow' }])),
		}),
		runtime: {
			closeAgentScope: async (): Promise<void> => {},
			listTools: async () => [{ name: 'read', inputSchema }],
			callUpstreamTool: async () => ({ literal: 42 }),
		},
	});
	const catalog = await completeCore.prepareCatalog(identity);
	const oldServer = createPortalMcpServer({
		catalogMode: 'catalog',
		catalog,
		core: completeCore,
		scope: identity,
	});
	const client = new Client({ name: 'reference-direct-projection', version: '1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await oldServer.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		const oldResult = await client.callTool({
			name: 'alpha__read__151160dc30',
			arguments: validArguments,
		});
		const batch = await reference.handlers.call({
			identity,
			input: { calls: [call('private-operation-entry')] },
		});
		const actual = projectProxyMcpResult({
			operation: 'direct',
			input: validArguments,
			result: { ...batch, diagnostics: [] },
		});
		expect(actual).toEqual(oldResult);
		expect(JSON.stringify(actual)).not.toContain('private-operation-entry');
	} finally {
		await client.close();
		await oldServer.close();
		await completeCore.close();
		await reference.core.close();
	}
});
