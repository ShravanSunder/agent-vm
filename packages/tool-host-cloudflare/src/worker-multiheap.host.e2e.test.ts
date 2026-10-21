import { hashCallArguments } from '@agent-collaboration/tool-access/contracts';
import { signApprovalToken } from '@agent-collaboration/tool-engine/mcp-gateway';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

import {
	organizationConfigurations,
	organizationOne,
	portalAudience,
	signingKeyHex,
	organizationTwoSigningKeyHex,
	startControlledMcpIssuer,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

it('independent Worker heaps share real organization storage and admit one approval effect', async () => {
	const guard = startWorkerdSocketGuard();
	const fixture = await startControlledMcpIssuer();
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
	if (script === undefined) throw new Error('Missing local Worker bundle.');
	const bindings = {
		SIGN_IN_ISSUER: fixture.url,
		SIGN_IN_JWKS_URL: `${fixture.url}/jwks`,
		TOOL_PORTAL_AUDIENCE: portalAudience,
		ORGANIZATION_CONFIGURATIONS: JSON.stringify(organizationConfigurations(fixture.url)),
		ONE_CREDENTIAL: 'one-secret-canary',
		TWO_CREDENTIAL: 'two-secret-canary',
		ONE_APPROVAL_KEY: signingKeyHex,
		TWO_APPROVAL_KEY: organizationTwoSigningKeyHex,
	};
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			workers: ['authority', 'copy-one', 'copy-two'].map((name) => ({
				name,
				script,
				modules: true,
				compatibilityDate: '2026-08-15',
				bindings,
				durableObjects: {
					ORGANIZATIONS: {
						className: 'OrganizationAuthorization',
						scriptName: 'authority',
						useSQLite: true,
					},
				},
			})),
		}),
	);
	try {
		const first = await runtime.getWorker('copy-one');
		const second = await runtime.getWorker('copy-two');
		const admission = await first.fetch('http://proof/__proof', {
			method: 'POST',
			body: JSON.stringify({
				kind: 'admission',
				organizationId: organizationOne,
				agentId: 'agent-one',
				state: 'listed',
			}),
		});
		await admission.body?.cancel();
		const bearer = await fixture.sign();
		const approval = await signApprovalToken({
			agentId: 'agent-one',
			key: new Uint8Array(32).fill(0x12),
			jti: 'cross-heap-token',
			issuedAtMs: Date.now(),
			expiresAtMs: Date.now() + 60_000,
			calls: [
				{
					namespace: 'same-server',
					toolName: 'ask',
					argumentsHash: await hashCallArguments({ value: 42 }),
				},
			],
		});
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 'one',
			method: 'tools/call',
			params: {
				name: 'mcp_portal_call',
				arguments: {
					calls: [
						{ id: 'ask', namespace: 'same-server', toolName: 'ask', arguments: { value: 42 } },
					],
					portalApprovalToken: approval,
				},
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientCapabilities': {},
				},
			},
		});
		const options = {
			method: 'POST',
			headers: {
				authorization: `Bearer ${bearer}`,
				'content-type': 'application/json',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			},
			body,
		};
		const results = await Promise.all(
			[first, second].map(async (worker) => {
				const response = await worker.fetch('http://proof/mcp', options);
				expect(response.status).toBe(200);
				return response.text();
			}),
		);
		expect(fixture.calls).toHaveLength(1);
		expect(results.filter((result) => result.includes('approval_token_invalid'))).toHaveLength(1);
		const logs = await Promise.all(
			[first, second].map(async (worker) => (await worker.fetch('http://proof/__logs')).json()),
		);
		const identifiers = logs.map((log) => JSON.stringify(log).match(/"isolateId":"([^"]+)"/u)?.[1]);
		expect(new Set(identifiers).size).toBe(2);
		const removal = await second.fetch('http://proof/__proof', {
			method: 'POST',
			body: JSON.stringify({
				kind: 'admission',
				organizationId: organizationOne,
				agentId: 'agent-one',
				state: 'removed',
			}),
		});
		await removal.body?.cancel();
		const refused = await first.fetch('http://proof/mcp', options);
		expect(refused.status).toBe(401);
		await refused.body?.cancel();
		expect(fixture.calls).toHaveLength(1);
		process.stdout.write(
			`${JSON.stringify({ topology: 'three distinct Worker heaps; both copies bind authority/OrganizationAuthorization', identifiers, effects: fixture.calls.length })}\n`,
		);
	} finally {
		try {
			await guard.stop();
		} finally {
			await runtime.dispose();
			await fixture.close();
		}
	}
});
