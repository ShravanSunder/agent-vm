import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';

import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import {
	createHostedMcpProxy,
	hostedAgentVerifier,
} from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-proxy';
import { startControlledHostedUpstream } from '#tool-host-core/hosted-mcp-proxy/test-fixtures/controlled-hosted-upstream-test-fixture';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

it('refuses an undefined token persona before any upstream discovery or dispatch', async () => {
	const upstream = await startControlledHostedUpstream();
	try {
		const nowMs = Date.now();
		const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
		const authority = createWorkspaceAuthority({
			store: createVolatileAuthorityStore(),
			clock,
			cap: 512 * 1024,
		});

		const proxy = createHostedMcpProxy({
			sessionClientId: 'central',
			toolPortalOrigin: 'https://portal.invalid',
			verifier: hostedAgentVerifier({
				deployment: upstream.url,

				jwksUrl: `${upstream.url}/jwks`,
			}),
			workspaces: { forWorkspace: () => authority },
			configurations: {
				workspaceIdsForOrganization: async () => [],
				read: async () =>
					workspaceConfigurationSchema.parse({
						organizationId: '11111111-1111-4111-8111-111111111111',
						workspaceName: 'fixture',
						approvalKeyBinding: 'KEY',
						mcp: {
							schemaVersion: 1,
							providers: {
								fixture: {
									kind: 'mcp',
									namespace: 'provider',
									transport: { kind: 'streamable-http', url: `${upstream.url}/mcp` },
								},
							},
						},
						portal: {
							schemaVersion: 1,
							sessionDefaultProfile: 'fixture',
							agents: {
								assigned: { credentialVersion: 1 },
							},
							profiles: {
								fixture: {
									namespaces: {
										provider: {
											tools: { allow: '*' },
											calls: { withoutApproval: { allow: '*' }, requiresApproval: { allow: [] } },
										},
									},
								},
							},
						},
					}),
			},
			secrets: { read: () => '12'.repeat(32) },
			analytics: { write: () => {} },
			log: () => {},
			clock,
			newId: () => crypto.randomUUID(),
			limits: testHostedProxyLimits,
			createUpstreamMcpTransport: (server) =>
				new StreamableHTTPClientTransport(new URL(server.url)),
		});
		const bearer = await upstream.sign('sender', { persona: { kind: 'named', name: 'missing' } });
		const request = new Request(
			'https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp',
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${bearer}`,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'MCP-Protocol-Version': '2026-07-28',
					'Mcp-Method': 'tools/list',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'profile',
					method: 'tools/list',
					params: {
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientCapabilities': {},
						},
					},
				}),
			},
		);
		const assignedRequest = request.clone();
		const response = await proxy.handle(request);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: 'profile-unassigned',
		});
		const unsupportedRequest = await proxy.handle(
			new Request('https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp', {
				headers: { authorization: `Bearer ${bearer}` },
			}),
		);
		expect(unsupportedRequest.status).toBe(403);
		expect(await unsupportedRequest.json()).toEqual({
			error: 'profile-unassigned',
		});
		expect(upstream.requests).toEqual([]);
		expect(upstream.effects).toEqual([]);
		await authority.setMembership('assigned', 'fixture');
		assignedRequest.headers.set('authorization', `Bearer ${await upstream.sign('assigned')}`);
		const assignedResponse = await proxy.handle(assignedRequest);
		expect(assignedResponse.status).toBe(200);
		expect(await assignedResponse.json()).toMatchObject({ result: { tools: expect.any(Array) } });
		expect(upstream.requests).toContain('tools/list');
		expect(upstream.effects).toEqual([]);
	} finally {
		await upstream.close();
	}
});

it.each(['synchronous', 'asynchronous'])(
	'fails closed before discovery for %s workspace authority configuration errors',
	async (mode) => {
		const upstream = await startControlledHostedUpstream();
		try {
			const clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
			const authority = createWorkspaceAuthority({
				store: createVolatileAuthorityStore(),
				clock,
				cap: 512 * 1024,
			});
			await authority.setMembership('sender', 'fixture');
			const proxy = createHostedMcpProxy({
				sessionClientId: 'central',
				toolPortalOrigin: 'https://portal.invalid',
				verifier: hostedAgentVerifier({
					deployment: upstream.url,

					jwksUrl: `${upstream.url}/jwks`,
				}),
				workspaces: { forWorkspace: () => authority },
				configurations: {
					workspaceIdsForOrganization: async () => [],
					read: () => {
						const failure = new Error('controlled-configuration-failure');
						if (mode === 'synchronous') throw failure;
						return Promise.reject(failure);
					},
				},
				secrets: {
					read: () => {
						throw new Error('Must not read secrets.');
					},
				},
				analytics: { write: () => {} },
				log: () => {},
				clock,
				newId: () => crypto.randomUUID(),
				limits: testHostedProxyLimits,
				createUpstreamMcpTransport: () => {
					throw new Error('Must not construct transport.');
				},
			});
			const response = await proxy.handle(
				new Request('https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${await upstream.sign()}`,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream',
						'MCP-Protocol-Version': '2026-07-28',
						'Mcp-Method': 'tools/list',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 'config',
						method: 'tools/list',
						params: {
							_meta: {
								'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								'io.modelcontextprotocol/clientCapabilities': {},
							},
						},
					}),
				}),
			);
			expect(response.status).toBe(503);
			expect(upstream.requests).toEqual([]);
			expect(upstream.effects).toEqual([]);
			await response.body?.cancel();
		} finally {
			await upstream.close();
		}
	},
);
