import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { agentRegistrationSchema } from '#auth/sign-in-core/agent-clients/agent-registration';
import {
	accessTokenReleaseClaimsSchema,
	releaseSignInResponse,
	type AccessTokenReleaseClaims,
	type SignInResponseReleasePorts,
} from '#auth/sign-in-core/response-release/sign-in-response-release';

const issuer = 'https://sign-in.invalid';
const agentAudience = 'https://portal.invalid/mcp';
const managementAudience = 'https://portal.invalid/management';
const organizationId = '11111111-1111-4111-8111-111111111111';
const now = 1_800_000_000;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
	keys = await generateKeyPair('EdDSA');
});
const agentClaims = {
	iss: issuer,
	sub: 'agent-one',
	aud: agentAudience,
	iat: now,
	exp: now + 300,
	client_id: 'agent-one',
	azp: 'agent-one',
	organization_id: organizationId,
};

function ports(changes: Partial<SignInResponseReleasePorts> = {}): SignInResponseReleasePorts {
	return {
		issuer,
		agentAudience,
		managementAudience,
		accessTokenSeconds: 300,
		now: () => now * 1000,
		inspectSignedToken: (token: string): AccessTokenReleaseClaims =>
			accessTokenReleaseClaimsSchema.parse(decodeJwt(token)),
		readAgent: async () =>
			agentRegistrationSchema.parse({
				clientId: 'agent-one',
				metadata: { kind: 'agent', organizationId },
				grantTypes: ['client_credentials'],
				clientCredentialsScopes: ['tool-portal:agent'],
				tokenEndpointAuthMethod: 'client_secret_basic',
				resourceIds: [agentAudience],
				disabled: false,
				registrationComplete: true,
			}),
		isPersonSessionActive: async () => true,
		deleteSession: async () => {},
		cleanupUnboundPerson: async () => {},
		...changes,
	};
}
async function tokenResponse(changes: Readonly<Record<string, unknown>> = {}): Promise<Response> {
	const token = await new SignJWT({ ...agentClaims, ...changes })
		.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
		.sign(keys.privateKey);
	return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 300 });
}

describe('outer response release after the signing effect', () => {
	it('releases the real signed token only when the current registration permits it', async () => {
		const response = await tokenResponse();
		const result = await releaseSignInResponse({
			response,
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(result).toBe(response);
		expect(
			z.object({ access_token: z.string() }).parse(await result.json()).access_token,
		).toBeTypeOf('string');
	});
	it('withholds the signed token when removal is visible at the final read', async () => {
		const response = await tokenResponse();
		const current = await ports().readAgent('agent-one');
		const result = await releaseSignInResponse({
			response,
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readAgent: async () => (current === null ? null : { ...current, disabled: true }),
			}),
		});
		expect(result.status).toBe(400);
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it.each([
		{ organization_id: '22222222-2222-4222-8222-222222222222' },
		{ aud: managementAudience },
		{ sid: 'forged-person-session' },
		{ sub: 'different-agent' },
		{ azp: 'different-agent' },
		{ exp: now + 301 },
		{ exp: now },
	])('withholds signed conflicting or overlong claims %j', async (claims) => {
		const result = await releaseSignInResponse({
			response: await tokenResponse(claims),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('fails closed when the post-signing registration read is unavailable', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse(),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readAgent: async () => {
					throw new Error('controlled read unavailable');
				},
			}),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('a person token requires its live Person and exact session', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse({
				sub: 'owner-person',
				client_id: 'owner-cli',
				azp: 'owner-cli',
				sid: 'owner-session',
				aud: managementAudience,
			}),
			tokenGrant: 'person',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({ isPersonSessionActive: async () => false }),
		});
		expect(await result.json()).toEqual({ error: 'invalid_grant' });
	});
	it('cleans an inserted session before refusing its cookie response', async () => {
		const sessions = new Set(['new-session']);
		const result = await releaseSignInResponse({
			response: new Response(null, {
				status: 302,
				headers: { 'set-cookie': 'session=synthetic-test-cookie' },
			}),
			tokenGrant: 'none',
			issuedSessions: [{ personId: 'new-person', sessionId: 'new-session' }],
			createdUserIds: [],
			ports: ports({
				isPersonSessionActive: async () => false,
				deleteSession: async (id: string): Promise<void> => {
					sessions.delete(id);
				},
			}),
		});
		expect(result.headers.has('set-cookie')).toBe(false);
		expect(await result.json()).toEqual({ error: 'not-allowed' });
		expect(sessions.size).toBe(0);
	});
});
