import { expect, it } from 'vitest';
import { z } from 'zod';

import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import {
	createHostedMcpProxy,
	hostedAgentVerifier,
} from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-proxy';
import { startControlledHostedUpstream } from '#tool-host-core/hosted-mcp-proxy/test-fixtures/controlled-hosted-upstream-test-fixture';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

it.each([200, 100])(
	'keeps the first published catalog when delayed discovery started at or before %i',
	async (laterStart) => {
		// Arrange: A starts at 100 and stays held while B discovers and publishes.
		// Lead ruling r4354684720: a settled catalog replaces another only with a strictly later start.
		const upstream = await startControlledHostedUpstream();
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let nowMs = 100;
		let discoveries = 0;
		try {
			const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
			const authority = createWorkspaceAuthority({
				store: createVolatileAuthorityStore(),
				clock,
				cap: 512 * 1024,
			});
			await authority.setMembership('sender', 'fixture');
			const configuration = workspaceConfigurationSchema.parse({
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
					agents: { sender: { credentialVersion: 1 } },
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
					read: async () => configuration,
				},
				secrets: { read: () => '12'.repeat(32) },
				analytics: { write: () => {} },
				log: () => {},
				clock,
				newId: () => crypto.randomUUID(),
				limits: testHostedProxyLimits,
				createClient: () => ({
					connect: async () => {},
					close: async () => {},
					callTool: async () => ({}),
					listTools: async () => {
						discoveries += 1;
						const discoveryNumber = discoveries;
						const generation =
							discoveryNumber === 1 ? 'earlier' : discoveryNumber === 2 ? 'published' : 'refreshed';
						if (discoveryNumber === 1) {
							firstEntered.resolve();
							await releaseFirst.promise;
						}
						if (discoveryNumber === 2) nowMs = 300;
						return {
							tools: [
								{ name: generation, description: generation, inputSchema: { type: 'object' } },
							],
						};
					},
				}),
				createUpstreamMcpTransport: () => ({
					start: async () => {},
					send: async () => {},
					close: async () => {},
				}),
			});
			const bearer = await upstream.sign();
			async function listTools(): Promise<readonly string[]> {
				const response = await proxy.handle(
					new Request(
						'https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp?tools=direct',
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
								id: crypto.randomUUID(),
								method: 'tools/list',
								params: {
									_meta: {
										'io.modelcontextprotocol/protocolVersion': '2026-07-28',
										'io.modelcontextprotocol/clientCapabilities': {},
									},
								},
							}),
						},
					),
				);
				expect(response.status).toBe(200);
				const result = z
					.object({
						result: z.object({
							tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
						}),
					})
					.parse(await response.json());
				return result.result.tools
					.filter((tool) => tool.name.startsWith('provider__'))
					.map((tool) => tool.description ?? 'missing');
			}

			// Act: B finishes first; A finishes later with its earlier snapshot.
			const earlierRequest = listTools();
			await firstEntered.promise;
			nowMs = laterStart;
			const publishedRequest = await listTools();
			nowMs = 400;
			releaseFirst.resolve();
			const earlierResult = await earlierRequest;

			// Assert request pinning and the shared cache through actual proxy responses.
			expect(publishedRequest).toEqual(['published']);
			expect(earlierResult).toEqual(['earlier']);
			expect(await listTools()).toEqual(['published']);
			expect(discoveries).toBe(2);
			// TTL begins at B's discovery start, not its completion at a later clock value.
			nowMs = laterStart + 59_999;
			expect(await listTools()).toEqual(['published']);
			expect(discoveries).toBe(2);
			nowMs = laterStart + 60_000;
			expect(await listTools()).toEqual(['refreshed']);
			expect(discoveries).toBe(3);
		} finally {
			releaseFirst.resolve();
			await upstream.close();
		}
	},
);
