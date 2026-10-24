import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	privateDeployFileSchema,
	type PrivateDeployFile,
} from '#worker-host/deployed-checks/deploy-configuration/models/private-deploy-file';
import { privateDeployFixture } from '#worker-host/deployed-checks/deploy-configuration/test-fixtures/private-deploy-fixture';
import {
	agentToken,
	portalRpc,
} from '#worker-host/deployed-checks/deployed-check-suites/deployed-portal-client';

async function signedFixture(): Promise<{
	readonly configuration: PrivateDeployFile;
	readonly publicKey: CryptoKey;
}> {
	const keys = await generateKeyPair('ES256', { extractable: true });
	return {
		configuration: privateDeployFileSchema.parse({
			...privateDeployFixture('/tmp/synthetic-client-evidence'),
			privateSigningJwk: await exportJWK(keys.privateKey),
		}),
		publicKey: keys.publicKey,
	};
}
afterEach(() => vi.restoreAllMocks());
describe('controlled deployed client workspace wire contract', () => {
	it('signs each workspace audience and both workspace and organization claims, including sibling workspaces', async () => {
		const { configuration, publicKey } = await signedFixture();
		const tokens = await Promise.all(
			configuration.workspaces.map(async (workspace) => {
				const token = await agentToken(configuration, { workspace });
				const expected = `${configuration.portalA.origin}/workspaces/${workspace.workspaceId}/mcp`;
				const verified = await jwtVerify(token, publicKey, {
					issuer: configuration.helper.origin,
					audience: expected,
				});
				expect(verified.payload).toMatchObject({
					aud: expected,
					workspace_id: workspace.workspaceId,
					organization_id: workspace.organizationId,
					client_id: configuration.agentId,
				});
				await expect(
					jwtVerify(token, publicKey, {
						audience: `${configuration.portalB.origin}/workspaces/${workspace.workspaceId}/mcp`,
					}),
				).rejects.toThrow();
				return token;
			}),
		);
		expect(new Set(tokens).size).toBe(3);
		expect(configuration.workspaces[0].organizationId).toBe(
			configuration.workspaces[1].organizationId,
		);
		await expect(
			jwtVerify(tokens[0] ?? '', publicKey, {
				audience: `${configuration.portalA.origin}/workspaces/${configuration.workspaces[1].workspaceId}/mcp`,
			}),
		).rejects.toThrow();
	});
	it('sends B transport the A logical audience and workspace address despite spoofed request labels', async () => {
		const { configuration, publicKey } = await signedFixture();
		const workspace = configuration.workspaces[1];
		const requests: { url: string; headers: Headers }[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async (
				input: Parameters<typeof fetch>[0],
				init: Parameters<typeof fetch>[1],
			): Promise<Response> => {
				requests.push({
					url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					headers: new Headers(init?.headers),
				});
				return Response.json({
					jsonrpc: '2.0',
					id: 'unit',
					result: { content: [{ type: 'text', text: 'wire-only-result' }] },
				});
			},
		);
		const response = await portalRpc(
			configuration,
			'tools/list',
			{},
			{ copy: 'b', workspace, headers: { host: 'spoof.invalid' }, query: 'workspace_id=spoof' },
		);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (request === undefined) throw new Error('No outgoing request captured.');
		const url = new URL(request.url);
		expect(url.origin).toBe(configuration.portalB.origin);
		expect(url.pathname).toBe(`/workspaces/${workspace.workspaceId}/mcp`);
		const authorization = request.headers.get('authorization');
		if (!authorization?.startsWith('Bearer ')) throw new Error('No signed bearer token.');
		const verified = await jwtVerify(authorization.slice(7), publicKey, {
			issuer: configuration.helper.origin,
			audience: `${configuration.portalA.origin}/workspaces/${workspace.workspaceId}/mcp`,
		});
		expect(verified.payload.workspace_id).toBe(workspace.workspaceId);
		expect(verified.payload.organization_id).toBe(workspace.organizationId);
	});
	it('keeps forged and expired controls cryptographically distinguishable', async () => {
		const { configuration, publicKey } = await signedFixture();
		await expect(
			jwtVerify(await agentToken(configuration, { forged: true }), publicKey),
		).rejects.toThrow();
		await expect(
			jwtVerify(await agentToken(configuration, { changes: { exp: 1 } }), publicKey),
		).rejects.toThrow();
	});
});
