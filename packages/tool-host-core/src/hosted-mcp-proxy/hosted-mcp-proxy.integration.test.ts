import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

import type { CallAnalytics } from '#tool-host-core/call-analytics/models/call-analytics';
import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import {
	createHostedMcpProxy,
	hostedAgentVerifier,
} from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-proxy';
import { startControlledHostedUpstream } from '#tool-host-core/hosted-mcp-proxy/test-fixtures/controlled-hosted-upstream-test-fixture';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

it('authenticates a real Node MCP request, invokes the controlled HTTP upstream, and commits approval before refusing replay', async () => {
	const upstream = await startControlledHostedUpstream();
	try {
		const nowMs = Date.now();
		const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
		const store = createVolatileAuthorityStore();
		const authority = createWorkspaceAuthority({ store, clock, cap: 512 * 1024 });
		const events: CallAnalytics[] = [];
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
						workspaceName: 'fixture-organization',
						approvalKeyBinding: 'APPROVAL_KEY',
						mcp: {
							schemaVersion: 1,
							providers: {
								fixture: {
									kind: 'mcp',
									namespace: 'provider',
									transport: {
										kind: 'streamable-http',
										url: `${upstream.url}/mcp`,
										headers: {
											authorization: { source: 'environment', name: 'PROVIDER_CREDENTIAL' },
										},
									},
								},
							},
						},
						portal: {
							schemaVersion: 1,
							sessionDefaultProfile: 'fixture',
							agents: { sender: { credentialVersion: 1 } },
							profiles: {
								fixture: {
									namespaces: {
										provider: {
											tools: { allow: '*' },
											calls: {
												withoutApproval: { allow: ['read'] },
												requiresApproval: { allow: ['ask'] },
											},
										},
									},
								},
							},
						},
					}),
			},
			secrets: {
				read: (name) => (name === 'APPROVAL_KEY' ? '12'.repeat(32) : 'Bearer fixture-credential'),
			},
			analytics: { write: (event) => events.push(event) },
			log: () => {},
			clock,
			newId: () => crypto.randomUUID(),
			limits: testHostedProxyLimits,
			createUpstreamMcpTransport: (server) =>
				new StreamableHTTPClientTransport(
					new URL(server.url),
					server.requestInit === undefined ? {} : { requestInit: server.requestInit },
				),
		});
		let bearer = await upstream.sign();
		async function rpc(
			method: string,
			params: Readonly<Record<string, unknown>> = {},
			direct = false,
		): Promise<Record<string, unknown>> {
			const response = await proxy.handle(
				new Request(
					`https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp${direct ? '?tools=direct' : ''}`,
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${bearer}`,
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
							'MCP-Protocol-Version': '2026-07-28',
							'Mcp-Method': method,
							...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 'proof',
							method,
							params: {
								_meta: {
									'io.modelcontextprotocol/protocolVersion': '2026-07-28',
									'io.modelcontextprotocol/clientCapabilities': {},
								},
								...params,
							},
						}),
					},
				),
			);
			if (response.status !== 200)
				throw new Error(`MCP ${String(response.status)}: ${await response.text()}`);
			return z.object({ result: z.record(z.string(), z.unknown()) }).parse(await response.json())
				.result;
		}
		const listed = await rpc('tools/list', {}, true);
		const tools = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(listed).tools;
		expect(tools.map((tool) => tool.name)).toEqual([
			expect.stringMatching(/^provider__ask__/u),
			expect.stringMatching(/^provider__read__/u),
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		const readName = tools.find((tool) => tool.name.startsWith('provider__read__'))?.name;
		if (readName === undefined) throw new Error('Read tool missing from actual catalog.');
		const read = await rpc(
			'tools/call',
			{ name: readName, arguments: { value: 'plain-node' } },
			true,
		);
		expect(JSON.stringify(read)).toContain('effect:read:plain-node');
		expect(upstream.effects).toEqual([
			{ name: 'read', arguments: { value: 'plain-node' }, credential: 'Bearer fixture-credential' },
		]);
		const approval = await signApprovalToken({
			agentId: '["bot","22222222-2222-4222-8222-222222222222"]',
			key: new Uint8Array(32).fill(0x12),
			jti: 'one-use',
			issuedAtMs: nowMs,
			expiresAtMs: nowMs + 60_000,
			calls: [
				{
					namespace: 'provider',
					toolName: 'ask',
					argumentsHash: await hashCallArguments({ value: 'approved' }),
				},
			],
		});
		const ask = {
			name: 'mcp_portal_call',
			arguments: {
				portalApprovalToken: approval,
				calls: [
					{ id: 'ask', namespace: 'provider', toolName: 'ask', arguments: { value: 'approved' } },
				],
			},
		};
		const first = await rpc('tools/call', ask);
		expect(JSON.stringify(first)).toContain('effect:ask:approved');
		expect(await store.read('approval-uses-v1')).toEqual({
			'["bot","22222222-2222-4222-8222-222222222222"]:one-use': nowMs + 60_000,
		});
		// The second credential is the same principal and cannot get another use.
		bearer = await upstream.sign('credential-two');
		const replay = await rpc('tools/call', ask);
		expect(JSON.stringify(replay)).toContain('approval_token_invalid');
		expect(JSON.stringify(replay)).toContain('replayed');
		expect(upstream.effects).toEqual([
			{ name: 'read', arguments: { value: 'plain-node' }, credential: 'Bearer fixture-credential' },
			{ name: 'ask', arguments: { value: 'approved' }, credential: 'Bearer fixture-credential' },
		]);
		// Two sessions share central's OAuth client, but never share approval authority.
		const session = {
			kind: 'fleetHarnessSession',
			session_ref: {
				installation: '33333333-3333-4333-8333-333333333333',
				harness_endpoint: 'codex-local',
				conversation_id: 'session-one',
			},
			machine_environment: { kind: 'physical' },
			project_id: 'project-one',
			isolation: { kind: 'host', instance_id: 'launch-one' },
		};
		const sessionApproval = await signApprovalToken({
			agentId:
				'["fleetHarnessSession","33333333-3333-4333-8333-333333333333","codex-local","session-one"]',
			key: new Uint8Array(32).fill(0x12),
			jti: 'session-use',
			issuedAtMs: nowMs,
			expiresAtMs: nowMs + 60_000,
			calls: [
				{
					namespace: 'provider',
					toolName: 'ask',
					argumentsHash: await hashCallArguments({ value: 'session-approved' }),
				},
			],
		});
		const sessionCall = {
			name: 'mcp_portal_call',
			arguments: {
				portalApprovalToken: sessionApproval,
				calls: [
					{
						id: 'session',
						namespace: 'provider',
						toolName: 'ask',
						arguments: { value: 'session-approved' },
					},
				],
			},
		};
		bearer = await upstream.sign('central', {
			principal: {
				...session,
				session_ref: { ...session.session_ref, conversation_id: 'session-two' },
			},
		});
		expect(JSON.stringify(await rpc('tools/call', sessionCall))).toContain('agent-mismatch');
		expect(upstream.effects).toHaveLength(2);
		bearer = await upstream.sign('central', { principal: session });
		expect(JSON.stringify(await rpc('tools/call', sessionCall))).toContain(
			'effect:ask:session-approved',
		);
		expect(JSON.stringify(await rpc('tools/call', sessionCall))).toContain('replayed');
		expect(upstream.effects).toHaveLength(3);
		expect(events.map((event) => [event.toolName, event.outcome])).toEqual([
			['read', 'ran'],
			['ask', 'ran'],
			['ask', 'needs approval'],
			['ask', 'needs approval'],
			['ask', 'ran'],
			['ask', 'needs approval'],
		]);
	} finally {
		await upstream.close();
	}
});
