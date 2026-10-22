import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';

import { organizationConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import {
	createHostedMcpProxy,
	hostedAgentVerifier,
} from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-proxy';
import { startControlledHostedUpstream } from '#tool-host-core/hosted-mcp-proxy/test-fixtures/controlled-hosted-upstream-test-fixture';
import { createOrganizationAuthority } from '#tool-host-core/organization-authority/organization-authority';
import { createVolatileAuthorityStore } from '#tool-host-core/organization-authority/volatile-authority-store';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';

it.each(['missing assignment', 'dangling profile'])(
	'refuses an admitted caller with %s before any upstream discovery or dispatch',
	async (mode) => {
		const upstream = await startControlledHostedUpstream();
		try {
			const nowMs = Date.now();
			const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
			const authority = createOrganizationAuthority({
				store: createVolatileAuthorityStore(),
				clock,
				cap: 512 * 1024,
			});
			await authority.setAgentAdmission('sender', 'listed');
			const proxy = createHostedMcpProxy({
				verifier: hostedAgentVerifier({
					deployment: upstream.url,
					audience: 'https://portal.invalid/mcp',
					jwksUrl: `${upstream.url}/jwks`,
				}),
				organizations: { forOrganization: () => authority },
				configurations: {
					read: async () =>
						organizationConfigurationSchema.parse({
							organizationName: 'fixture',
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
								agents: {
									assigned: { profile: 'fixture' },
									...(mode === 'missing assignment' ? {} : { sender: { profile: 'missing' } }),
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
			const bearer = await upstream.sign();
			const request = new Request('https://portal.invalid/mcp', {
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
			});
			const assignedRequest = request.clone();
			const response = await proxy.handle(request);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: 'profile-unassigned' });
			const unsupportedRequest = await proxy.handle(
				new Request('https://portal.invalid/mcp', {
					headers: { authorization: `Bearer ${bearer}` },
				}),
			);
			expect(unsupportedRequest.status).toBe(401);
			expect(await unsupportedRequest.json()).toEqual({ error: 'profile-unassigned' });
			expect(upstream.requests).toEqual([]);
			expect(upstream.effects).toEqual([]);
			await authority.setAgentAdmission('assigned', 'listed');
			assignedRequest.headers.set('authorization', `Bearer ${await upstream.sign('assigned')}`);
			const assignedResponse = await proxy.handle(assignedRequest);
			expect(assignedResponse.status).toBe(200);
			expect(await assignedResponse.json()).toMatchObject({ result: { tools: expect.any(Array) } });
			expect(upstream.requests).toContain('tools/list');
			expect(upstream.effects).toEqual([]);
		} finally {
			await upstream.close();
		}
	},
);

it.each(['synchronous', 'asynchronous'])(
	'preserves the existing MCP preparation failure for %s configuration errors',
	async (mode) => {
		const upstream = await startControlledHostedUpstream();
		try {
			const clock = { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() };
			const authority = createOrganizationAuthority({
				store: createVolatileAuthorityStore(),
				clock,
				cap: 512 * 1024,
			});
			await authority.setAgentAdmission('sender', 'listed');
			const proxy = createHostedMcpProxy({
				verifier: hostedAgentVerifier({
					deployment: upstream.url,
					audience: 'https://portal.invalid/mcp',
					jwksUrl: `${upstream.url}/jwks`,
				}),
				organizations: { forOrganization: () => authority },
				configurations: {
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
				new Request('https://portal.invalid/mcp', {
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
			expect(response.status).toBe(500);
			expect(upstream.requests).toEqual([]);
			expect(upstream.effects).toEqual([]);
			await response.body?.cancel();
		} finally {
			await upstream.close();
		}
	},
);
