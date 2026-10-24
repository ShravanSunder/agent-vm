import { request as httpRequest } from 'node:http';

import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	workspaceConfigurations,
	portalAudience,
	signingKeyHex,
	organizationTwoSigningKeyHex,
	startControlledMcpIssuer,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { portalRead } from '#worker-host/test-fixtures/local-worker-harness';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

async function protocolEvent<TValue>(promise: Promise<TValue>, label: string): Promise<TValue> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Protocol deadline: ${label}`)), 3_000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

it.each(['cold', 'expired'] as const)(
	'does not retain discovery after an actual workerd %s request disconnect',
	async (state) => {
		const guard = startWorkerdSocketGuard();
		const fixture = await startControlledMcpIssuer();
		const release = Promise.withResolvers<void>();
		let runtime: Miniflare | undefined;
		try {
			const bundle = await build({
				entryPoints: ['packages/tool-host-cloudflare/src/test-fixtures/worker-proof-entrypoint.ts'],
				bundle: true,
				write: false,
				format: 'esm',
				platform: 'browser',
				conditions: ['workerd', 'worker', 'browser'],
				external: ['cloudflare:workers'],
			});
			const script = bundle.outputFiles[0]?.text;
			if (script === undefined) throw new Error('Missing proof bundle.');
			const now = Date.now();
			runtime = new Miniflare(
				convertV4MiniflareOptions({
					workers: [
						{
							name: 'discovery-cancellation',
							script,
							modules: true,
							compatibilityDate: '2025-09-24',
							unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
							bindings: {
								SIGN_IN_ISSUER: fixture.url,
								SIGN_IN_JWKS_URL: `${fixture.url}/jwks`,
								TOOL_PORTAL_ORIGIN: new URL(portalAudience).origin,
								WORKSPACE_CONFIGURATIONS: JSON.stringify(workspaceConfigurations(fixture.url)),
								ONE_CREDENTIAL: 'one-secret-canary',
								TWO_CREDENTIAL: 'two-secret-canary',
								ONE_APPROVAL_KEY: signingKeyHex,
								TWO_APPROVAL_KEY: organizationTwoSigningKeyHex,
								FIXED_CLOCK: String(now),
							},
							durableObjects: {
								WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true },
							},
						},
					],
				}),
			);
			const origin = await runtime.unsafeGetDirectURL('discovery-cancellation');
			const token = await fixture.sign();
			const headers = {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
				connection: 'close',
			};
			function body(value: string): string {
				return JSON.stringify({
					jsonrpc: '2.0',
					id: value,
					method: 'tools/call',
					params: {
						...portalRead(value),
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientCapabilities': {},
						},
					},
				});
			}
			async function call(value: string): Promise<Record<string, unknown>> {
				const response = await fetch(
					new URL('/workspaces/11111111-1111-4111-8111-111111111111/mcp', origin),
					{
						method: 'POST',
						headers,
						body: body(value),
						signal: AbortSignal.timeout(3_000),
					},
				);
				expect(response.status).toBe(200);
				return z.object({ result: z.record(z.string(), z.unknown()) }).parse(await response.json())
					.result;
			}
			if (state === 'expired') {
				expect((await call('warm')).isError).not.toBe(true);
				fixture.setCatalog([
					{
						name: 'read',
						description: 'refreshed-generation',
						inputSchema: { type: 'object', additionalProperties: true },
					},
				]);
				await (await fetch(new URL(`/__clock?now=${String(now + 60_001)}`, origin))).body?.cancel();
			}
			const entered = Promise.withResolvers<void>();
			let upstreamCancelled = false;
			let discoveries = 0;
			let held = false;
			fixture.setDiscovery(async (props) => {
				discoveries += 1;
				if (held) return;
				held = true;
				void props.disconnected.then(() => {
					upstreamCancelled = true;
				});
				entered.resolve();
				await release.promise;
			});
			const first = httpRequest(
				new URL('/workspaces/11111111-1111-4111-8111-111111111111/mcp', origin),
				{ method: 'POST', headers },
			);
			const clientClosed = new Promise<void>((resolve) => first.once('close', resolve));
			first.on('error', () => {});
			first.end(body('cancel'));
			await protocolEvent(entered.promise, 'upstream tools/list entered');
			first.destroy();
			await protocolEvent(clientClosed, 'incoming client socket closed');
			// Local workerd may keep the upstream alive after disconnect. B must still own its discovery,
			// not depend on A finishing; native deployed continuation dropping is a separate observation.
			// B must succeed while A is STILL held; releasing A first would conceal the poisoned promise.
			const result = await call('after-cancel');
			expect(result.isError).not.toBe(true);
			expect(discoveries).toBe(2);
			if (state === 'expired') {
				const catalogResponse = await fetch(
					new URL('/workspaces/11111111-1111-4111-8111-111111111111/mcp?tools=direct', origin),
					{
						method: 'POST',
						headers: { ...headers, 'Mcp-Method': 'tools/list' },
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 'fresh-catalog',
							method: 'tools/list',
							params: {
								_meta: {
									'io.modelcontextprotocol/protocolVersion': '2026-07-28',
									'io.modelcontextprotocol/clientCapabilities': {},
								},
							},
						}),
						signal: AbortSignal.timeout(3_000),
					},
				);
				const refreshed: unknown = await catalogResponse.json();
				expect(JSON.stringify(refreshed)).toContain('refreshed-generation');
			}
			const listings = fixture.discoveryCredentials.length;
			expect((await call('cached-followup')).isError).not.toBe(true);
			expect(fixture.discoveryCredentials).toHaveLength(listings);
			expect(
				fixture.calls.filter((entry) => entry.arguments.value === 'after-cancel'),
			).toHaveLength(1);
			const logs = z
				.array(z.object({ event: z.string(), isolateId: z.string(), requestId: z.string() }))
				.parse(await (await fetch(new URL('/__logs', origin))).json());
			expect(
				new Set(
					logs.filter((entry) => entry.event === 'request-started').map((entry) => entry.isolateId),
				).size,
			).toBe(1);
			process.stdout.write(
				`${JSON.stringify({ discoveryCancellation: state, clientSocketClosed: true, nativeUpstreamCancellationObserved: upstreamCancelled, independentDiscoveries: discoveries, followupEffect: 1 })}\n`,
			);
		} finally {
			release.resolve();
			await runtime?.dispose();
			await fixture.close();
			await guard.stop();
		}
	},
	30_000,
);
