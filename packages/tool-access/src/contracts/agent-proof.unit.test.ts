import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	agentTokenClaimsSchema,
	createAgentTokenVerifier,
} from '#tool-access/contracts/agent-proof';

const deployment = 'https://test-issuer.invalid';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const audience = `https://tool-portal.invalid/workspaces/${workspaceId}/mcp`;
const expected = { audience, workspaceId };
const now = 1_800_000_000;
const organizationId = '11111111-1111-4111-8111-111111111111';
// Stand-in for the unbuilt sign-in service: test keys issue the complete E10 shape.
// These tests establish signature/claim rules, not the real issuer's behavior.
let issuerKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let forgedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;
const claims = {
	iss: deployment,
	sub: 'agent-one',
	aud: audience,
	exp: now + 60,
	iat: now,
	scope: 'tool-portal:agent',
	client_id: 'agent-one',
	azp: 'agent-one',
	jti: 'test-token',
	organization_id: organizationId,
	workspace_id: workspaceId,
};
beforeAll(async () => {
	issuerKeys = await generateKeyPair('ES256');
	forgedKeys = await generateKeyPair('ES256');
	jwks = {
		keys: [
			{ ...(await exportJWK(issuerKeys.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' },
		],
	};
});

async function signToken(
	props: {
		readonly changes?: JWTPayload;
		readonly typ?: string;
		readonly forge?: boolean;
	} = {},
): Promise<string> {
	return new SignJWT({ ...claims, ...props.changes })
		.setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: props.typ ?? 'at+jwt' })
		.sign(props.forge ? forgedKeys.privateKey : issuerKeys.privateKey);
}

function verifier(): ReturnType<typeof createAgentTokenVerifier> {
	return createAgentTokenVerifier({
		deployment,
		now: () => now * 1000,
		jwksUrl: new URL(`${deployment}/jwks`),
		jwksFetch: async (url) => {
			expect(url).toBe(`${deployment}/jwks`);
			return Response.json(jwks);
		},
	});
}

describe('E10 agent proof with real JOSE signatures', () => {
	it('parses the E10 token and projects only the six proof fields', async () => {
		expect(agentTokenClaimsSchema.parse(claims)).toEqual(claims);
		expect(await verifier().verify(await signToken(), expected)).toEqual({
			kind: 'verified',
			proof: {
				deployment,
				clientId: 'agent-one',
				organizationId,
				workspaceId,
				audience,
				expiresAt: now + 60,
			},
		});
	});
	it.each([
		{ reason: 'wrong-token-type', token: { typ: 'JWT' } },
		{ reason: 'bad-signature', token: { forge: true } },
		{ reason: 'wrong-issuer', token: { changes: { iss: 'https://other.invalid' } } },
		{ reason: 'wrong-audience', token: { changes: { aud: 'https://other.invalid/mcp' } } },
		{ reason: 'expired', token: { changes: { exp: now - 1 } } },
		{ reason: 'not-an-agent', token: { changes: { sid: 'person-session' } } },
		{ reason: 'wrong-scope', token: { changes: { scope: 'tool-portal:person' } } },
	])('refuses an independently signed bad token: $reason', async ({ reason, token }) => {
		expect(await verifier().verify(await signToken(token), expected)).toEqual({
			kind: 'refused',
			reason,
		});
	});
	it.each([
		{ changes: { aud: [audience] }, reason: 'wrong-audience' },
		{ changes: { organization_id: undefined }, reason: 'not-an-agent' },
		{ changes: { organization_id: 'not-a-uuid' }, reason: 'not-an-agent' },
		{ changes: { sid: null }, reason: 'not-an-agent' },
		{ changes: { sub: 'other-agent' }, reason: 'not-an-agent' },
		{ changes: { azp: 'other-agent' }, reason: 'not-an-agent' },
		{ changes: { scope: 'not-tool-portal:agent-extra' }, reason: 'wrong-scope' },
		{ changes: { exp: now }, reason: 'expired' },
	])('refuses malformed/near-match claims $changes', async ({ changes, reason }) => {
		expect(await verifier().verify(await signToken({ changes }), expected)).toEqual({
			kind: 'refused',
			reason,
		});
	});
	it('accepts the exact scope among other scopes', async () => {
		expect(
			(
				await verifier().verify(
					await signToken({ changes: { scope: 'other tool-portal:agent more' } }),
					expected,
				)
			).kind,
		).toBe('verified');
	});
	it('does not use attacker claims before signature verification', async () => {
		expect(
			await verifier().verify(
				await signToken({ forge: true, changes: { iss: 'https://other.invalid', exp: now - 1 } }),
				expected,
			),
		).toEqual({ kind: 'refused', reason: 'bad-signature' });
	});
});
