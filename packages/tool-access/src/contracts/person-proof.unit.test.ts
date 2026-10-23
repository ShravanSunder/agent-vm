import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAgentTokenVerifier } from '#tool-access/contracts/agent-proof';
import { createPersonTokenVerifier } from '#tool-access/contracts/person-proof';

const deployment = 'https://test-issuer.invalid';
const audience = 'https://tool-portal.invalid/management';
const now = 1_800_000_000;
let issuerKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let forgedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: unknown;
const personClaims = {
	iss: deployment,
	sub: 'owner-person',
	aud: audience,
	exp: now + 300,
	iat: now,
	scope: 'tool-portal:management',
	client_id: 'owner-cli',
	azp: 'owner-cli',
	sid: 'owner-session',
	jti: 'person-token',
};

beforeAll(async () => {
	issuerKeys = await generateKeyPair('EdDSA');
	forgedKeys = await generateKeyPair('EdDSA');
	jwks = {
		keys: [{ ...(await exportJWK(issuerKeys.publicKey)), kid: 'person-key', alg: 'EdDSA' }],
	};
});

async function signToken(
	props: {
		readonly changes?: JWTPayload;
		readonly typ?: string;
		readonly forge?: boolean;
	} = {},
): Promise<string> {
	return new SignJWT({ ...personClaims, ...props.changes })
		.setProtectedHeader({ alg: 'EdDSA', kid: 'person-key', typ: props.typ ?? 'at+jwt' })
		.sign(props.forge ? forgedKeys.privateKey : issuerKeys.privateKey);
}

function verifier(): ReturnType<typeof createPersonTokenVerifier> {
	return createPersonTokenVerifier({
		deployment,
		audience,
		now: () => now * 1000,
		jwksUrl: new URL(`${deployment}/jwks`),
		jwksFetch: async () => Response.json(jwks),
	});
}

// Program Design's ordered E7 rules and Verification Design G are the oracle.
// Real signatures stay in-process; these tests do not establish issuance or live status.
describe('E7 person proof with real JOSE signatures', () => {
	it('projects a person proof with signature freshness, never live confirmation', async () => {
		expect(await verifier().verify(await signToken())).toEqual({
			kind: 'verified',
			proof: {
				issuer: deployment,
				subject: 'owner-person',
				audience,
				sessionRef: 'owner-session',
				clientId: 'owner-cli',
				expiresAt: now + 300,
			},
			freshness: { kind: 'signature' },
		});
	});
	it.each([
		{ reason: 'wrong-token-type', token: { typ: 'JWT' } },
		{ reason: 'bad-signature', token: { forge: true } },
		{ reason: 'wrong-issuer', token: { changes: { iss: 'https://other.invalid' } } },
		{ reason: 'wrong-audience', token: { changes: { aud: 'https://other.invalid/control' } } },
		{ reason: 'wrong-audience', token: { changes: { aud: [audience] } } },
		{ reason: 'wrong-audience', token: { changes: { aud: [audience, 'other'] } } },
		{ reason: 'expired', token: { changes: { exp: now } } },
		{ reason: 'expired', token: { changes: { exp: now - 1 } } },
		{ reason: 'not-a-person', token: { changes: { sid: undefined } } },
		{ reason: 'not-a-person', token: { changes: { sid: null } } },
		{ reason: 'not-a-person', token: { changes: { sid: '' } } },
		{ reason: 'malformed', token: { changes: { client_id: undefined } } },
	])('refuses a signed token for its contracted reason: $reason', async ({ reason, token }) => {
		expect(await verifier().verify(await signToken(token))).toEqual({ kind: 'refused', reason });
	});
	it('checks the signature before trusting issuer, audience, expiry or session claims', async () => {
		expect(
			await verifier().verify(await signToken({ forge: true, changes: { iss: 'other', exp: 0 } })),
		).toEqual({ kind: 'refused', reason: 'bad-signature' });
	});
	it('refuses a correctly signed agent token as not-a-person', async () => {
		const token = await signToken({
			changes: {
				sub: 'agent-one',
				client_id: 'agent-one',
				azp: 'agent-one',
				sid: undefined,
				scope: 'tool-portal:agent',
				organization_id: '11111111-1111-4111-8111-111111111111',
			},
		});
		expect(await verifier().verify(token)).toEqual({ kind: 'refused', reason: 'not-a-person' });
	});
	it('the existing agent verifier refuses the same valid person token', async () => {
		const agentVerifier = createAgentTokenVerifier({
			deployment,
			audience,
			now: () => now * 1000,
			jwksUrl: new URL(`${deployment}/jwks`),
			jwksFetch: async () => Response.json(jwks),
		});
		expect(await agentVerifier.verify(await signToken())).toEqual({
			kind: 'refused',
			reason: 'not-an-agent',
		});
	});
	it('reports unavailable keys without granting a person proof', async () => {
		const offline = createPersonTokenVerifier({
			deployment,
			audience,
			jwksUrl: new URL(`${deployment}/jwks`),
			jwksFetch: async () => {
				throw new Error('controlled key service failure');
			},
		});
		expect(await offline.verify(await signToken())).toEqual({
			kind: 'unavailable',
			reason: 'keys-unreachable',
		});
	});
});
