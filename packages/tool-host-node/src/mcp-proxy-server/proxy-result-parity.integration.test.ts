import { once } from 'node:events';

import * as dispatch from '@agent-collaboration/tool-engine/capability-dispatch';
import { createPortalCore, createUpstreamMcpClientRuntime } from '@agent-vm/mcp-portal/core';
import { createPortalHttpApp, createPortalApprovalVerifier } from '@agent-vm/mcp-portal/mcp-proxy';
import { deriveAgentBearerToken } from '@agent-vm/mcp-portal/portal-auth/agent-bearer-token';
import { hashCallArguments, signApprovalToken } from '@agent-vm/mcp-portal/portal-auth/hmac-token';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

function isTransport(value: unknown): value is Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}
const call = (id: string, toolName = 'read', value: unknown = 42): Record<string, unknown> => ({
	id,
	namespace: 'alpha',
	toolName,
	arguments: { value },
});
const cases = [
	{ name: 'mcp_portal_list', arguments: { requests: [{ id: 'list' }] } },
	{ name: 'mcp_portal_search', arguments: { requests: [{ id: 'search', query: 'read' }] } },
	{
		name: 'mcp_portal_describe',
		arguments: {
			requests: [
				{
					id: 'describe',
					tools: [{ namespace: 'alpha', toolName: 'read' }],
					includeTypescriptHelper: true,
				},
			],
		},
	},
	{ name: 'mcp_portal_call', arguments: { calls: [call('allowed')] } },
	{ name: 'mcp_portal_call', arguments: { calls: [] } },
	{ name: 'mcp_portal_call', arguments: { calls: [call('duplicate'), call('duplicate')] } },
	{
		name: 'mcp_portal_call',
		arguments: {
			calls: [call('z-read'), call('a-hidden', 'hidden'), call('bad-arguments', 'read', 'invalid')],
		},
	},
] satisfies readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];

for (const mode of ['indirect', 'direct'] as const) {
	it(`${mode}: keeps real Node list/search/describe/call text bytes identical to the 08f9e426 proxy`, async ({
		onTestFinished,
	}) => {
		// Pin only the diagnostics clock; real HTTP, connector timers and effects remain real.
		const observed = new Map<string, dispatch.ResourceResult>();
		const createDispatcher = dispatch.createCapabilityDispatcher;
		// Observe the actual dispatcher result; no backend, connector or transport is replaced.
		const factory = vi
			.spyOn(dispatch, 'createCapabilityDispatcher')
			.mockImplementation((options) => {
				const dispatcher = createDispatcher(options);
				return {
					...dispatcher,
					dispatch: async (request) => {
						const result = await dispatcher.dispatch(request);
						observed.set(request.item, result);
						return result;
					},
				};
			});
		onTestFinished(() => {
			factory.mockRestore();
		});
		const clock = vi.spyOn(Date, 'now').mockReturnValue(1792551600000);
		onTestFinished(() => {
			clock.mockRestore();
		});
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		let alphaClosed = false;
		const masterKey = Buffer.alloc(32, 17);
		const runtime = createUpstreamMcpClientRuntime({
			servers: [{ namespace: 'alpha', transport: 'streamable-http', url: alpha.url }],
			additionalRedactionValues: [secretCanary, headerCanary],
		});
		const core = createPortalCore({
			catalogTtlMs: 60_000,
			upstreamNamespaces: ['alpha'],
			accessPolicy: {
				enabledNamespaces: ['alpha'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {
					'agent-a': [
						{ namespace: 'alpha', toolName: 'hidden' },
						{ namespace: 'alpha', toolName: 'blocked' },
					],
				},
			},
			approval: (calls) => ({
				decisionsByCallId: Object.fromEntries(calls.map((entry) => [entry.id, { kind: 'allow' }])),
			}),
			runtime: {
				listTools: runtime.listTools,
				closeAgentScope: runtime.closeAgentScope,
				callUpstreamTool: async (entry) =>
					runtime.callTool({
						agentScopeId: entry.agentScopeId,
						namespace: entry.namespace,
						toolName: entry.toolName,
						arguments: entry.arguments,
						requestId: entry.requestId,
					}),
			},
		});
		const identity = (agentId: string): ReturnType<typeof core.createAgentScope> | null =>
			agentId === 'agent-a'
				? core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' })
				: null;
		const oldApp = createPortalHttpApp({
			agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
			core,
			registeredAgentIds: ['agent-a'],
			resolveAgentIdentity: identity,
		});
		const oldServer = serve({ fetch: oldApp.fetch, hostname: '127.0.0.1', port: 0 });
		if (!oldServer.listening) await once(oldServer, 'listening');
		const oldAddress = oldServer.address();
		if (oldAddress === null || typeof oldAddress === 'string')
			throw new Error('Missing reference listener');
		const oldClient = new Client({ name: 'old-reference', version: '1' });
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({
			configPath,
			secrets: {
				resolve: async (secret): Promise<string> =>
					secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
						? secretCanary
						: headerCanary,
			},
		});
		if (host.http === undefined) throw new Error('Missing replacement listener');
		const address = new URL(host.http.endpoint);
		if (mode === 'direct') address.searchParams.set('tools', 'direct');
		const current = await connectClient(address, 'credential-a');
		const bearer = deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey });
		try {
			const transport: unknown = new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${oldAddress.port}/agents/agent-a/mcp`),
				{ requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
			);
			if (!isTransport(transport)) throw new Error('Missing legacy transport');
			await oldClient.connect(transport);
			const compare = async (request: {
				readonly name: string;
				readonly arguments: Record<string, unknown>;
			}): Promise<void> => {
				const expected = await oldClient.callTool(request);
				const actual = await current.client.callTool(request);
				const { ['_meta']: metadata, ...surface } = actual;
				expect(metadata).toMatchObject({
					'io.modelcontextprotocol/serverInfo': { name: 'tool-host-node', version: '0.0.153' },
				});
				if (JSON.stringify(request).includes('provider-error'))
					process.stdout.write(
						JSON.stringify({ mode, case: 'isError:true', old: expected, current: surface }) + '\n',
					);
				expect.soft(surface, JSON.stringify(request)).toEqual(expected);
				expect(JSON.stringify(surface)).not.toContain(secretCanary);
				expect(JSON.stringify(surface)).not.toContain(headerCanary);
			};
			await Promise.all(cases.map(compare));
			// isError closes the connector client; keep it after concurrent healthy requests.
			await compare({
				name: 'mcp_portal_call',
				arguments: { calls: [call('provider-error', 'fail')] },
			});
			if (mode === 'direct') {
				const directApp = createPortalHttpApp({
					agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
					core,
					registeredAgentIds: ['agent-a'],
					resolveAgentIdentity: identity,
					catalogMode: 'catalog',
				});
				const directServer = serve({ fetch: directApp.fetch, hostname: '127.0.0.1', port: 0 });
				if (!directServer.listening) await once(directServer, 'listening');
				const directAddress = directServer.address();
				if (directAddress === null || typeof directAddress === 'string')
					throw new Error('Missing native reference listener');
				const directClient = new Client({ name: 'old-native-reference', version: '1' });
				try {
					const candidate: unknown = new StreamableHTTPClientTransport(
						new URL(`http://127.0.0.1:${directAddress.port}/agents/agent-a/mcp`),
						{ requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
					);
					if (!isTransport(candidate)) throw new Error('Missing legacy native transport');
					await directClient.connect(candidate);
					const request = { name: 'alpha__read__151160dc30', arguments: { value: 42 } };
					const { ['_meta']: metadata, ...surface } = await current.client.callTool(request);
					expect(metadata).toMatchObject({
						'io.modelcontextprotocol/serverInfo': { name: 'tool-host-node', version: '0.0.153' },
					});
					expect(surface).toEqual(await directClient.callTool(request));
				} finally {
					await directClient.close();
					await directApp.closePortalSessions();
					if ('closeAllConnections' in directServer) directServer.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						directServer.close((error) => (error === undefined ? resolve() : reject(error))),
					);
				}
			}
			alpha.breakCalls();
			const brokenRequest = {
				name: 'mcp_portal_call',
				arguments: { calls: [call('broken-stream')] },
			};
			expect(observed.get('provider-error')).toMatchObject({
				kind: 'failed',
				detail: { kind: 'mcp-upstream-failure', upstream: { failureClass: 'tool_error' } },
			});
			const beforeBroken = alpha.effects.length;
			const expectedBroken = await oldClient.callTool(brokenRequest);
			const { ['_meta']: brokenMetadata, ...actualBroken } =
				await current.client.callTool(brokenRequest);
			expect(brokenMetadata).toBeDefined();
			expect(actualBroken).toEqual(expectedBroken);
			expect(JSON.stringify(actualBroken)).toContain('upstream_call_failed');
			expect(alpha.effects).toHaveLength(beforeBroken + 2);
			expect(observed.get('broken-stream')).toMatchObject({
				kind: 'ambiguous',
				detail: { kind: 'mcp-upstream-failure', upstream: { phase: 'call_tool' } },
			});
			const effectsBefore = alpha.effects.length;
			await alpha.close();
			alphaClosed = true;
			const transportRequest = {
				name: 'mcp_portal_call',
				arguments: { calls: [call('transport-failure')] },
			};
			const expectedTransport = await oldClient.callTool(transportRequest);
			const { ['_meta']: transportMetadata, ...currentTransport } =
				await current.client.callTool(transportRequest);
			expect(transportMetadata).toBeDefined();
			process.stdout.write(
				JSON.stringify({
					mode,
					case: 'refused transport after catalog discovery',
					old: expectedTransport,
					current: currentTransport,
				}) + '\n',
			);
			expect.soft(currentTransport).toEqual(expectedTransport);
			expect(alpha.effects).toHaveLength(effectsBefore);
			expect(observed.get('transport-failure')).toMatchObject({
				kind: 'failed',
				detail: { kind: 'mcp-upstream-failure', upstream: { phase: 'connect' } },
			});
		} finally {
			await current.client.close();
			await oldClient.close();
			await oldApp.closePortalSessions();
			await core.close();
			if ('closeAllConnections' in oldServer) oldServer.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				oldServer.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await host.retire();
			await Promise.all([...(alphaClosed ? [] : [alpha.close()]), beta.close()]);
		}
	});
}

for (const mode of ['indirect', 'direct'] as const) {
	it(`${mode}: matches whole missing, replayed and forged approval items from the real 08f9e426 proxy`, async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const approvalKey = Buffer.alloc(32, 23);
		const masterKey = Buffer.alloc(32, 17);
		const records: Parameters<typeof createPortalApprovalVerifier>[0]['records'] = new Map([
			[
				'agent-a',
				{
					agentId: 'agent-a',
					hmacKey: approvalKey,
					profileName: 'profile-a',
					profile: {
						approval: {
							allowWithoutApprovalTools: [{ namespace: 'alpha', toolName: 'read' }],
							alwaysAskTools: [{ namespace: 'alpha', toolName: 'ask' }],
							annotationPolicy: 'destructive-requires-approval',
							callPoliciesByNamespace: {},
							trustedAnnotationNamespaces: [],
							writeTools: [],
						},
						cache: { catalogTtlMs: 60_000 },
						enabledNamespaces: ['alpha'],
						enabledToolsByNamespace: {},
						hiddenToolsByNamespace: {},
						logging: { enabled: false },
						promptContext: { enabled: true, maxNamespaces: 12 },
					},
				},
			],
		]);
		const verifier = createPortalApprovalVerifier({ records });
		const runtime = createUpstreamMcpClientRuntime({
			servers: [{ namespace: 'alpha', transport: 'streamable-http', url: alpha.url }],
			additionalRedactionValues: [secretCanary, headerCanary],
		});
		const core = createPortalCore({
			catalogTtlMs: 60_000,
			upstreamNamespaces: ['alpha'],
			accessPolicy: {
				enabledNamespaces: ['alpha'],
				enabledNamespacesByAgent: {},
				hiddenToolsByAgent: {},
			},
			approval: (calls, identity, token) => verifier(calls, identity.agentId, token),
			runtime: {
				listTools: runtime.listTools,
				closeAgentScope: runtime.closeAgentScope,
				callUpstreamTool: async (entry) =>
					runtime.callTool({
						agentScopeId: entry.agentScopeId,
						namespace: entry.namespace,
						toolName: entry.toolName,
						arguments: entry.arguments,
						requestId: entry.requestId,
					}),
			},
		});
		const oldApp = createPortalHttpApp({
			agentBearerAuth: { masterKey, authorizationHeaderName: 'authorization' },
			core,
			registeredAgentIds: ['agent-a'],
			catalogMode: mode === 'direct' ? 'catalog' : 'compact',
			resolveAgentIdentity: (agentId) =>
				agentId === 'agent-a'
					? core.createAgentScope({ agentId, agentScopeId: agentId, source: 'mcp-proxy-bearer' })
					: null,
		});
		const oldServer = serve({ fetch: oldApp.fetch, hostname: '127.0.0.1', port: 0 });
		if (!oldServer.listening) await once(oldServer, 'listening');
		const address = oldServer.address();
		if (address === null || typeof address === 'string') throw new Error('Missing legacy listener');
		const oldClient = new Client({ name: 'legacy-approval-reference', version: '1' });
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({
			configPath,
			approvalKeysByAgent: new Map([['agent-a', approvalKey]]),
			secrets: {
				resolve: async (secret): Promise<string> =>
					secret.source === 'environment' && secret.name === 'PROVIDER_SECRET'
						? secretCanary
						: headerCanary,
			},
		});
		if (host.http === undefined) throw new Error('Missing replacement listener');
		const endpoint = new URL(host.http.endpoint);
		if (mode === 'direct') endpoint.searchParams.set('tools', 'direct');
		const current = await connectClient(endpoint, 'credential-a');
		const bearer = deriveAgentBearerToken({ agentId: 'agent-a', credentialVersion: 1, masterKey });
		const legacyTransport: unknown = new StreamableHTTPClientTransport(
			new URL(`http://127.0.0.1:${address.port}/agents/agent-a/mcp`),
			{ requestInit: { headers: { authorization: `Bearer ${bearer}` } } },
		);
		function request(token?: string): {
			readonly name: string;
			readonly arguments: Record<string, unknown>;
			readonly _meta?: Record<string, string>;
		} {
			return mode === 'indirect'
				? {
						name: 'mcp_portal_call',
						arguments: {
							calls: [call('protected', 'ask')],
							...(token === undefined ? {} : { portalApprovalToken: token }),
						},
					}
				: {
						name: 'alpha__ask__645775a667',
						arguments: { value: 42 },
						...(token === undefined
							? {}
							: { _meta: { 'agent-vm/tool-portal-approval-token': token } }),
					};
		}
		const itemSchema = z.object({
			content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
		});
		function items(result: unknown): unknown {
			const text = itemSchema.parse(result).content[0]?.text;
			if (text === undefined) throw new Error('Missing proxy item text');
			return z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(text)).items;
		}
		async function compareRefusal(
			token: string | undefined,
			expectedError: Record<string, string>,
		): Promise<void> {
			const effectsBefore = alpha.effects.length;
			const expected = await oldClient.callTool(request(token));
			const actual = await current.client.callTool(request(token));
			const expectedItem = [
				{
					error: expectedError,
					requestId: mode === 'direct' ? 'catalog-call' : 'protected',
					status: 'failed',
				},
			];
			expect(items(expected)).toEqual(expectedItem);
			expect.soft(items(actual)).toEqual(items(expected));
			expect.soft(items(actual)).toEqual(expectedItem);
			const { ['_meta']: metadata, ...surface } = actual;
			expect(metadata).toBeDefined();
			expect.soft(surface).toEqual(expected);
			expect(alpha.effects).toHaveLength(effectsBefore);
		}
		try {
			if (!isTransport(legacyTransport)) throw new Error('Missing legacy approval transport');
			await oldClient.connect(legacyTransport);
			await compareRefusal(undefined, {
				code: 'approval_token_missing',
				message: 'An MCP Portal approval token is required before this MCP Portal call can run.',
				namespace: 'alpha',
				toolName: 'ask',
			});
			const now = Date.now();
			const signingInput = {
				agentId: 'agent-a',
				calls: [
					{ namespace: 'alpha', toolName: 'ask', argumentsHash: hashCallArguments({ value: 42 }) },
				],
				issuedAtMs: now,
				expiresAtMs: now + 60_000,
				jti: 'legacy-refused-token-parity',
			};
			const approved = signApprovalToken({ ...signingInput, key: approvalKey });
			expect(items(await oldClient.callTool(request(approved)))).toMatchObject([
				{ status: 'success' },
			]);
			expect(items(await current.client.callTool(request(approved)))).toMatchObject([
				{ status: 'success' },
			]);
			expect(alpha.effects).toHaveLength(2);
			await compareRefusal(approved, {
				code: 'approval_token_invalid',
				message: 'MCP Portal approval token is invalid: replayed.',
				namespace: 'alpha',
				toolName: 'ask',
			});
			const forged = signApprovalToken({
				...signingInput,
				key: Buffer.alloc(32, 47),
				jti: 'forged-token-parity',
			});
			await compareRefusal(forged, {
				code: 'approval_token_invalid',
				message: 'MCP Portal approval token is invalid: signature-mismatch.',
				namespace: 'alpha',
				toolName: 'ask',
			});
			expect(alpha.effects).toHaveLength(2);
		} finally {
			await Promise.all([current.client.close(), oldClient.close()]);
			await oldApp.closePortalSessions();
			await core.close();
			if ('closeAllConnections' in oldServer) oldServer.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				oldServer.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
}
