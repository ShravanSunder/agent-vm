import { request as httpRequest } from 'node:http';

import type { ApprovalPort } from '@agent-collaboration/tool-engine/dispatch';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureConfig,
	fixtureContextRef,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const secrets = {
	resolve: async (secret: { readonly source: string; readonly name?: string }): Promise<string> =>
		secret.name === 'PROVIDER_SECRET' ? secretCanary : headerCanary,
};
const pendingApprovals: ApprovalPort = {
	challenge: async (invocation) => ({
		kind: 'pending',
		challenge: {
			authority: invocation.authority,
			approvalId: 'pending-fixture-1',
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			callerDisplay: 'test caller',
			targetDisplay: 'controlled provider',
			revisions: invocation.admissionRevisions,
			expiresAt: '2099-01-01T00:00:00.000Z',
			permittedDecisions: ['approve', 'deny'],
		},
	}),
	receipt: async () => ({ kind: 'unavailable' }),
	decision: async () => ({ kind: 'unavailable' }),
};
const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} };

for (const mode of ['indirect', 'direct'] as const) {
	it(`${mode}: isolates callers, keeps search tools live, redacts secrets and refuses hidden/invalid/approval-only effects`, async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const diagnostics: string[] = [];
		const host = await startNodeHost({
			configPath,
			secrets,
			approvals: pendingApprovals,
			onDiagnostic: (event) => diagnostics.push(event),
		});
		if (host.http === undefined) throw new Error('Expected HTTP host');
		const endpoint = new URL(host.http.endpoint);
		if (mode === 'direct') endpoint.searchParams.set('tools', 'direct');
		const a = await connectClient(endpoint, 'credential-a', 'brand-claims-admin');
		const b = await connectClient(endpoint, 'credential-b');
		try {
			const searchNames = [
				'mcp_portal_list',
				'mcp_portal_search',
				'mcp_portal_describe',
				'mcp_portal_call',
			];
			const aTools = (await a.client.listTools()).tools;
			const bTools = (await b.client.listTools()).tools;
			expect(aTools.map((tool) => tool.name)).toEqual(
				mode === 'indirect'
					? searchNames
					: [
							'alpha__ask__645775a667',
							'alpha__fail__f7bc995a6f',
							'alpha__read__151160dc30',
							...searchNames,
						],
			);
			expect(bTools.map((tool) => tool.name)).toEqual(
				mode === 'indirect'
					? searchNames
					: [
							'beta__ask__7e2e2be604',
							'beta__fail__25055e8f23',
							'beta__read__08da93d672',
							...searchNames,
						],
			);
			const listed = await a.client.callTool({
				name: 'mcp_portal_list',
				arguments: { requests: [{ id: 'list' }] },
			});
			expect(decodedResult(listed)).toMatchObject({ ok: true });
			const described = await a.client.callTool({
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
			});
			expect(decodedResult(described)).toMatchObject({ ok: true });
			expect(JSON.stringify(described)).toContain('typescriptHelper');
			const request = (
				tool: string,
				value: unknown = 42,
			): { readonly name: string; readonly arguments: Record<string, unknown> } =>
				mode === 'indirect'
					? {
							name: 'mcp_portal_call',
							arguments: {
								calls: [
									{ id: `call-${tool}`, namespace: 'alpha', toolName: tool, arguments: { value } },
								],
							},
						}
					: {
							name:
								{
									read: 'alpha__read__151160dc30',
									ask: 'alpha__ask__645775a667',
									fail: 'alpha__fail__f7bc995a6f',
									hidden: 'alpha__hidden__ba2f2074fe',
									blocked: 'alpha__blocked__72eb8870ea',
								}[tool] ?? 'guessed-secret-tool',
							arguments: { value },
						};
			const first = await a.client.callTool(request('read'));
			expect(decodedResult(first)).toMatchObject({ ok: true });
			expect(alpha.effects.map((effect) => effect.arguments)).toEqual([{ value: 42 }]);
			const output = z
				.record(z.string(), z.object({ output: z.unknown() }))
				.parse(decodedResult(first).results);
			expect(Object.values(output)[0]?.output).toMatchObject({
				namespace: 'alpha',
				toolName: 'read',
				result: {
					structuredContent: {
						value: 42,
						nested: { credential: '[REDACTED]', header: '[REDACTED]' },
					},
				},
			});
			await Promise.all(
				['hidden', 'blocked', 'guessed'].map(async (tool) =>
					expect(await a.client.callTool(request(tool))).toMatchObject({ isError: true }),
				),
			);
			expect(await a.client.callTool(request('read', 'invalid'))).toMatchObject({ isError: true });
			expect(await a.client.callTool(request('ask'))).toMatchObject({ isError: true });
			expect(await b.client.callTool(request('read'))).toMatchObject({ isError: true });
			expect(alpha.effects).toHaveLength(1);
			expect(decodedResult(await a.client.callTool(request('fail')))).toMatchObject({ ok: false });
			expect(alpha.effects).toHaveLength(2);
			await a.client.callTool(request('read'));
			expect(alpha.effects).toHaveLength(3); // Unprotected calls are intentionally not recorded.
			expect(
				await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'call-read' },
					verifiedContextRef: fixtureContextRef(config),
				}),
			).toEqual({ kind: 'not-found' });
			expect(
				await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'call-read' },
					verifiedContextRef: fixtureContextRef(config, 'agent-b'),
				}),
			).toEqual({ kind: 'denied' });
			expect(
				JSON.stringify({ aTools, bTools, listed, described, first, diagnostics }),
			).not.toContain(secretCanary);
			expect(
				JSON.stringify({ aTools, bTools, listed, described, first, diagnostics }),
			).not.toContain(headerCanary);
		} finally {
			await Promise.all([a.client.close(), b.client.close()]);
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
}

describe('per-request authentication and host/origin policy', () => {
	it('refuses absent, foreign-audience and wrong credentials, Host, Origin and argument overrides without effects', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const configPath = await writeFixtureConfig(
			fixtureConfig(directory, [alpha.url, beta.url]),
			directory,
		);
		const host = await startNodeHost({ configPath, secrets });
		try {
			if (host.http === undefined) throw new Error('Missing HTTP listener');
			const endpoint = host.http.endpoint;
			const body = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: { _meta: meta },
			});
			const headers = {
				authorization: 'Bearer credential-a',
				accept: 'application/json, text/event-stream',
				'content-type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/list',
			};
			await Promise.all(
				['', 'unknown', 'credential-for-another-audience'].map(async (token) => {
					const response = await fetch(endpoint, {
						method: 'POST',
						headers: { ...headers, authorization: token === '' ? '' : `Bearer ${token}` },
						body,
					});
					expect(response.status).toBe(401);
					await response.text();
				}),
			);
			const allowed = await fetch(endpoint, { method: 'POST', headers, body });
			expect(allowed.status).toBe(200);
			await allowed.text();
			await Promise.all(
				[{ host: 'evil.example' }, { origin: 'https://evil.example' }].map(async (override) => {
					const status = await new Promise<number>((resolve, reject) => {
						const request = httpRequest(
							endpoint,
							{ method: 'POST', headers: { ...headers, ...override } },
							(response) => {
								response.resume();
								response.once('end', () => resolve(response.statusCode ?? 0));
							},
						);
						request.once('error', reject);
						request.end(body);
					});
					expect(status).toBe(400);
				}),
			);
			const client = await connectClient(endpoint, 'credential-a');
			try {
				await Promise.all(
					['profile', 'principal', 'backend', 'account', 'url'].map(async (field) => {
						expect(
							decodedResult(
								await client.client.callTool({
									name: 'mcp_portal_call',
									arguments: {
										[field]: 'untrusted',
										calls: [
											{
												id: 'override',
												namespace: 'alpha',
												toolName: 'read',
												arguments: { value: 42 },
											},
										],
									},
								}),
							).ok,
						).toBe(false);
					}),
				);
			} finally {
				await client.client.close();
			}
			const malformed = await fetch(endpoint, { method: 'POST', headers, body: '{invalid' });
			expect(malformed.status).toBe(400);
			await malformed.text();
			expect(alpha.effects).toHaveLength(0);
			expect(beta.effects).toHaveLength(0);
		} finally {
			await host.retire();
			await Promise.all([alpha.close(), beta.close()]);
		}
	});
});
