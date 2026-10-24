import { request as httpRequest } from 'node:http';

import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

import {
	workspaceConfigurations,
	organizationOne,
	signingKeyHex,
	startControlledMcpIssuer,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

it('retires the legacy MCP address through the production Worker entry', async () => {
	const guard = startWorkerdSocketGuard();
	const issuer = await startControlledMcpIssuer();
	let runtime: Miniflare | undefined;
	try {
		const bundle = await build({
			entryPoints: ['packages/tool-host-cloudflare/src/index.ts'],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			conditions: ['workerd', 'worker', 'browser'],
			external: ['cloudflare:workers'],
		});
		const script = bundle.outputFiles[0]?.text;
		if (script === undefined) throw new Error('Missing production Worker module.');
		runtime = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: 'production-routing',
						script,
						modules: true,
						compatibilityDate: '2026-08-15',
						bindings: {
							SIGN_IN_ISSUER: issuer.url,
							SIGN_IN_JWKS_URL: `${issuer.url}/jwks`,
							TOOL_PORTAL_ORIGIN: 'https://portal-test.invalid',
							WORKSPACE_CONFIGURATIONS: '{}',
						},
						durableObjects: {
							WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true },
						},
					},
				],
			}),
		);
		const worker = await runtime.getWorker('production-routing');
		// Controlled signing is a hostile legacy-token probe, never positive issuer proof.
		const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const workspaceToken = await issuer.sign({
			changes: {
				aud: `https://portal-test.invalid/workspaces/${workspaceId}/mcp`,
				workspace_id: workspaceId,
			},
		});
		const workspaceResponse = await worker.fetch(`http://routing/workspaces/${workspaceId}/mcp`, {
			method: 'POST',
			headers: { authorization: `Bearer ${workspaceToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'workspace-negative', method: 'tools/list' }),
		});
		const workspaceBody = await workspaceResponse.text();
		process.stdout.write(
			`${JSON.stringify({ path: `/workspaces/${workspaceId}/mcp`, status: workspaceResponse.status, body: workspaceBody, effects: issuer.calls.length })}\n`,
		);
		expect(workspaceBody).toBe('{"error":"unknown-caller"}');
		// No membership was granted. This remains a refusal probe after the cutover.
		expect(workspaceResponse.status).toBe(401);

		const invalid = await worker.fetch(`http://routing/workspaces/${workspaceId}/mcp`, {
			method: 'POST',
			headers: { authorization: 'Bearer invalid-signature' },
			body: '{}',
		});
		expect(invalid.status).toBe(workspaceResponse.status);
		expect(await invalid.text()).toBe(workspaceBody);

		const bearer = await issuer.sign({
			changes: { aud: 'https://portal-test.invalid/mcp', workspace_id: undefined },
		});
		const response = await worker.fetch('http://routing/mcp', {
			method: 'POST',
			headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy', method: 'tools/list' }),
		});
		const body = await response.text();
		process.stdout.write(
			`${JSON.stringify({ path: '/mcp', status: response.status, body, effects: issuer.calls.length })}\n`,
		);
		expect(issuer.calls).toHaveLength(0);
		expect(response.status).toBe(404);
		guard.check();
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			try {
				await issuer.close();
			} finally {
				await guard.stop();
			}
		}
	}
});

it('refuses a Host-matching hostile audience before effects in an otherwise admitted workspace', async () => {
	const guard = startWorkerdSocketGuard();
	const issuer = await startControlledMcpIssuer();
	let runtime: Miniflare | undefined;
	try {
		const bundles = await Promise.all(
			[
				'packages/tool-host-cloudflare/src/index.ts',
				'packages/tool-host-cloudflare/src/test-fixtures/object-proof-entrypoint.ts',
			].map((entry) =>
				build({
					entryPoints: [entry],
					bundle: true,
					write: false,
					format: 'esm',
					platform: 'browser',
					conditions: ['workerd', 'worker', 'browser'],
					external: ['cloudflare:workers'],
				}),
			),
		);
		const production = bundles[0]?.outputFiles[0]?.text;
		const seed = bundles[1]?.outputFiles[0]?.text;
		if (production === undefined || seed === undefined)
			throw new Error('Missing Host-control Worker modules');
		runtime = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: 'host-control',
						unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
						script: production,
						modules: true,
						compatibilityDate: '2026-08-15',
						bindings: {
							SIGN_IN_ISSUER: issuer.url,
							SIGN_IN_JWKS_URL: `${issuer.url}/jwks`,
							TOOL_PORTAL_ORIGIN: 'https://portal-test.invalid',
							WORKSPACE_CONFIGURATIONS: JSON.stringify(workspaceConfigurations(issuer.url)),
							ONE_CREDENTIAL: 'one-secret-canary',
							ONE_APPROVAL_KEY: signingKeyHex,
						},
						durableObjects: { WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true } },
					},
					{
						name: 'seed',
						script: seed,
						modules: true,
						compatibilityDate: '2026-08-15',
						durableObjects: {
							WORKSPACES: {
								className: 'WorkspaceAuthority',
								scriptName: 'host-control',
								useSQLite: true,
							},
						},
					},
				],
			}),
		);
		const token = await issuer.sign({
			changes: {
				aud: `https://attacker.invalid/workspaces/${organizationOne}/mcp`,
				workspace_id: organizationOne,
			},
		});
		// Only this deliberately hostile token is signed by the controlled issuer. No positive product proof.
		const origin = await runtime.unsafeGetDirectURL('host-control');
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 'host-control',
			method: 'tools/call',
			params: {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{
							id: 'host-control',
							namespace: 'same-server',
							toolName: 'read',
							arguments: { value: 'Host must not choose authority' },
						},
					],
				},
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientCapabilities': {},
				},
			},
		});
		const received = await new Promise<{ readonly status: number; readonly body: string }>(
			(resolve, reject) => {
				const request = httpRequest(
					new URL(`/workspaces/${organizationOne}/mcp`, origin),
					{
						method: 'POST',
						signal: AbortSignal.timeout(10_000),
						headers: {
							authorization: `Bearer ${token}`,
							host: 'attacker.invalid',
							'content-type': 'application/json',
							'content-length': String(Buffer.byteLength(body)),
							'MCP-Protocol-Version': '2026-07-28',
							'Mcp-Method': 'tools/call',
							'Mcp-Name': 'mcp_portal_call',
							connection: 'close',
						},
					},
					(response) => {
						const chunks: Buffer[] = [];
						response.on('data', (chunk: Buffer) => chunks.push(chunk));
						response.once('end', () =>
							resolve({
								status: response.statusCode ?? 0,
								body: Buffer.concat(chunks).toString('utf8'),
							}),
						);
						response.once('error', reject);
					},
				);
				request.once('error', reject);
				request.end(body);
			},
		);

		process.stdout.write(
			`${JSON.stringify({ case: 'Host audience', status: received.status, body: received.body, effects: issuer.calls.length, discovery: issuer.discoveryCredentials.length })}\n`,
		);
		expect(received.status).toBe(401);
		expect(received.body).toBe('{"error":"unknown-caller"}');
		expect(issuer.calls).toEqual([]);
		expect(issuer.discoveryCredentials).toEqual([]);
		guard.check();
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			try {
				await issuer.close();
			} finally {
				await guard.stop();
			}
		}
	}
});
