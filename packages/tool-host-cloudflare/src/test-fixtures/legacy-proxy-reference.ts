import { execFile } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { promisify } from 'node:util';

import {
	createPortalCore,
	createUpstreamMcpClientRuntime,
	createPortalPolicyApprovalEvaluator,
} from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { resolveWorkerProxyProfile } from '#worker-host/proxy-profile-policy';
import {
	organizationConfigurations,
	organizationOne,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { organizationConfigurationSchema } from '#worker-host/worker-configuration';

function transportShape(transport: unknown): transport is Transport {
	return (
		typeof transport === 'object' &&
		transport !== null &&
		'start' in transport &&
		typeof transport.start === 'function' &&
		'send' in transport &&
		typeof transport.send === 'function' &&
		'close' in transport &&
		typeof transport.close === 'function'
	);
}

/** Real legacy proxy, source-pinned by a Git diff guard; no old host is bundled in the Worker. */
export async function startLegacyProxyReference(
	url: string,
	mode: 'direct' | 'indirect',
): Promise<{ readonly client: Client; readonly close: () => Promise<void> }> {
	await promisify(execFile)('git', [
		'diff',
		'--exit-code',
		'08f9e426',
		'--',
		'packages/mcp-portal/src',
		'packages/config-contracts/src',
	]);
	const configs = z
		.record(z.string(), organizationConfigurationSchema)
		.parse(organizationConfigurations(url));
	const profile = configs[organizationOne]?.portal.profiles.one;
	if (profile === undefined) throw new Error('Missing reference profile.');
	const resolved = resolveWorkerProxyProfile(profile);
	const runtime = createUpstreamMcpClientRuntime({
		servers: [
			{
				namespace: 'same-server',
				transport: 'streamable-http',
				url: `${url}/mcp`,
				headers: { authorization: 'one-secret-canary' },
			},
		],
		additionalRedactionValues: ['one-secret-canary'],
	});
	const core = createPortalCore({
		catalogTtlMs: 60_000,
		upstreamNamespaces: ['same-server'],
		accessPolicy: {
			enabledNamespaces: ['same-server'],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {
				'agent-one': [
					{ namespace: 'same-server', toolName: 'hidden' },
					{ namespace: 'same-server', toolName: 'blocked' },
				],
			},
		},
		approval: createPortalPolicyApprovalEvaluator({
			resolveRecord: () => ({ profile: resolved, hmacKey: Buffer.alloc(32, 0x12) }),
		}),
		runtime: {
			listTools: runtime.listTools,
			closeAgentScope: runtime.closeAgentScope,
			callUpstreamTool: runtime.callTool,
		},
	});
	const key = Buffer.alloc(32, 17);
	const app = createPortalHttpApp({
		core,
		catalogMode: mode === 'direct' ? 'catalog' : 'compact',
		agentBearerAuth: { masterKey: key, authorizationHeaderName: 'authorization' },
		registeredAgentIds: ['agent-one'],
		resolveAgentIdentity: (agentId) =>
			core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' }),
	});
	const server: HttpServer = createServer((request, response) => {
		void (async () => {
			try {
				let body = '';
				for await (const chunk of request) body += String(chunk);
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers))
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(', ') : value);
				const reply = await app.fetch(
					new Request(`http://127.0.0.1${request.url ?? '/'}`, {
						method: request.method ?? 'GET',
						headers,
						...(body ? { body } : {}),
					}),
				);
				response.writeHead(reply.status, Object.fromEntries(reply.headers));
				if (reply.body === null) response.end();
				else {
					const reader = reply.body.getReader();
					for (;;) {
						const next = await reader.read();
						if (next.done) break;
						response.write(next.value);
					}
					response.end();
				}
			} catch {
				response.writeHead(500);
				response.end();
			}
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Missing reference socket.');
	const client = new Client({ name: '08f9e426-reference', version: '1' });
	const transport: unknown = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${String(address.port)}/agents/agent-one/mcp`),
		{
			requestInit: {
				headers: {
					authorization: `Bearer ${deriveAgentBearerToken({ agentId: 'agent-one', credentialVersion: 1, masterKey: key })}`,
				},
			},
		},
	);
	if (!transportShape(transport)) throw new Error('Missing real reference transport.');
	await client.connect(transport);
	return {
		client,
		close: async () => {
			await client.close();
			await app.closePortalSessions();
			await core.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
