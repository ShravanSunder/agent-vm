import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAgentTokenVerifier } from '#tool-access/contracts/agent-proof';

const deployment = 'https://issuer.invalid';
const toolPortalOrigin = 'https://portal.invalid';
const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const audienceOne = `${toolPortalOrigin}/workspaces/${workspaceOne}/mcp`;
const audienceTwo = `${toolPortalOrigin}/workspaces/${workspaceTwo}/mcp`;
const principal = { kind: 'bot', bot_id: '22222222-2222-4222-8222-222222222222' } as const;
const persona = { kind: 'named', name: 'operator' } as const;
const now = 1_800_000_000;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;

beforeAll(async () => {
	keys = await generateKeyPair('ES256');
	jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'workspace-key', alg: 'ES256' }] };
});

async function signedWorkspaceToken(changes: JWTPayload = {}): Promise<string> {
	return new SignJWT({
		iss: deployment,
		sub: 'agent-one',
		azp: 'agent-one',
		client_id: 'agent-one',
		aud: audienceOne,
		exp: now + 60,
		iat: now,
		jti: 'workspace-test',
		scope: 'tool-portal:agent',
		organization_id: organizationId,
		workspace_id: workspaceOne,
		principal,
		persona,
		grant_revision: 7,
		grant_expires_at: now + 300,
		...changes,
	})
		.setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'workspace-key' })
		.sign(keys.privateKey);
}

function workspaceVerifier(): (
	token: string,
	expected: {
		readonly audience: string;
		readonly workspaceId: string;
	},
) => ReturnType<ReturnType<typeof createAgentTokenVerifier>['verify']> {
	return createAgentTokenVerifier({
		deployment,
		jwksUrl: new URL(`${deployment}/jwks`),
		now: () => now * 1000,
		jwksFetch: async () => Response.json(jwks),
	}).verify;
}

describe('per-call workspace agent proof with real JOSE signatures', () => {
	it('uses each call expectation on one verifier instance, including both crossed requests', async () => {
		const verify = workspaceVerifier();
		const first = await signedWorkspaceToken();
		const second = await signedWorkspaceToken({ aud: audienceTwo, workspace_id: workspaceTwo });
		const expectedOne = { audience: audienceOne, workspaceId: workspaceOne };
		const expectedTwo = { audience: audienceTwo, workspaceId: workspaceTwo };
		expect(await verify(first, expectedOne)).toEqual({
			kind: 'verified',
			proof: {
				deployment,
				clientId: 'agent-one',
				organizationId,
				workspaceId: workspaceOne,
				audience: audienceOne,
				expiresAt: now + 60,
				principal,
				persona,
				grantRevision: 7,
				grantExpiresAt: now + 300,
			},
		});
		expect(await verify(second, expectedTwo)).toEqual({
			kind: 'verified',
			proof: {
				deployment,
				clientId: 'agent-one',
				organizationId,
				workspaceId: workspaceTwo,
				audience: audienceTwo,
				expiresAt: now + 60,
				principal,
				persona,
				grantRevision: 7,
				grantExpiresAt: now + 300,
			},
		});
		expect(await verify(first, expectedTwo)).toEqual({ kind: 'refused', reason: 'wrong-audience' });
		expect(await verify(second, expectedOne)).toEqual({
			kind: 'refused',
			reason: 'wrong-audience',
		});
	});

	it.each([
		{ label: 'missing workspace', changes: { workspace_id: undefined }, reason: 'not-an-agent' },
		{ label: 'malformed workspace', changes: { workspace_id: 'invalid' }, reason: 'not-an-agent' },
		{
			label: 'sibling workspace claim',
			changes: { workspace_id: workspaceTwo },
			reason: 'wrong-workspace',
		},
		{
			label: 'legacy Worker audience',
			changes: { aud: `${toolPortalOrigin}/mcp`, workspace_id: undefined },
			reason: 'wrong-audience',
		},
		{ label: 'array audience', changes: { aud: [audienceOne] }, reason: 'wrong-audience' },
		{ label: 'sibling audience', changes: { aud: audienceTwo }, reason: 'wrong-audience' },
	])('refuses $label', async ({ changes, reason }) => {
		expect(
			await workspaceVerifier()(await signedWorkspaceToken(changes), {
				audience: audienceOne,
				workspaceId: workspaceOne,
			}),
		).toEqual({ kind: 'refused', reason });
	});
});
