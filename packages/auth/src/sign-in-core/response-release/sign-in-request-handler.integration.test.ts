import { createServer, type Server } from 'node:http';

import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentRegistrationSchema } from '#auth/sign-in-core/agent-clients/agent-registration';
import { handleSignInRequest } from '#auth/sign-in-core/response-release/sign-in-request-handler';
import {
	accessTokenReleaseClaimsSchema,
	type SignInResponseReleasePorts,
} from '#auth/sign-in-core/response-release/sign-in-response-release';

// C2: real Node HTTP and portable response wiring, with an explicit synthetic provider/storage edge.
// This does not prove Better Auth, D1, a service binding or Gateway dispatch; C3 owns those claims.
const issuer = 'https://sign-in.invalid';
const agentAudience = 'https://portal.invalid/mcp';
const managementAudience = 'https://portal.invalid/management';
const organizationId = '11111111-1111-4111-8111-111111111111';
const now = 1_800_000_000;
let server: Server;
let endpoint: string;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let active = true;
let upstreamEffects = 0;
let beforeFinalCheck: (() => Promise<void>) | undefined;
const registration = agentRegistrationSchema.parse({
	clientId: 'agent-one',
	metadata: { kind: 'agent', organizationId },
	grantTypes: ['client_credentials'],
	clientCredentialsScopes: ['tool-portal:agent'],
	tokenEndpointAuthMethod: 'client_secret_basic',
	resourceIds: [agentAudience],
	disabled: false,
	registrationComplete: true,
});
const ports: SignInResponseReleasePorts = {
	issuer,
	agentAudience,
	managementAudience,
	accessTokenSeconds: 300,
	now: () => now * 1000,
	inspectSignedToken: (token) => accessTokenReleaseClaimsSchema.parse(decodeJwt(token)),
	readAgent: async () => ({ ...registration, disabled: !active }),
	isPersonSessionActive: async () => active,
	deleteSession: async () => {},
	cleanupUnboundPerson: async () => {},
};

beforeAll(async () => {
	keys = await generateKeyPair('EdDSA');
	server = createServer((request, response) => {
		void (async (): Promise<void> => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const pathname = request.url ?? '/';
			const input = new Request(`${endpoint}${pathname}`, {
				method: request.method ?? 'GET',
				...(request.method === 'POST'
					? {
							body: Buffer.concat(chunks).toString('utf8'),
							headers: { 'content-type': 'application/x-www-form-urlencoded' },
						}
					: {}),
			});
			const result = await handleSignInRequest({
				request: input,
				ports,
				issuedSessions: [],
				createdUserIds: [],
				...(beforeFinalCheck === undefined ? {} : { beforeFinalCheck }),
				providerHandler: async () => {
					upstreamEffects += 1;
					if (pathname === '/api/auth/oauth2/introspect')
						return Response.json({
							active: true,
							sub: 'owner',
							sid: 'owner-session',
							aud: managementAudience,
							exp: now + 300,
						});
					const token = await new SignJWT({
						iss: issuer,
						sub: 'agent-one',
						aud: agentAudience,
						iat: now,
						exp: now + 300,
						client_id: 'agent-one',
						azp: 'agent-one',
						organization_id: organizationId,
					})
						.setProtectedHeader({ typ: 'at+jwt', alg: 'EdDSA' })
						.sign(keys.privateKey);
					return Response.json({ access_token: token, token_type: 'Bearer' });
				},
			});
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(Buffer.from(await result.arrayBuffer()));
		})().catch(() => {
			response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('HTTP fixture did not bind a TCP port');
	endpoint = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
});

describe('C2 sign-in HTTP composition', () => {
	it('releases a signed response through the real HTTP boundary', async () => {
		active = true;
		const response = await fetch(`${endpoint}/api/auth/oauth2/token`, {
			method: 'POST',
			body: 'grant_type=client_credentials',
			signal: AbortSignal.timeout(3000),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty('access_token');
	});
	it('holds after the signing effect, then reads the current status before release', async () => {
		active = true;
		const signed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		beforeFinalCheck = async (): Promise<void> => {
			signed.resolve();
			await release.promise;
		};
		try {
			const pending = fetch(`${endpoint}/api/auth/oauth2/token`, {
				method: 'POST',
				body: 'grant_type=client_credentials',
				signal: AbortSignal.timeout(3000),
			});
			await signed.promise;
			active = false;
			release.resolve();
			const response = await pending;
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'invalid_client' });
		} finally {
			release.resolve();
			beforeFinalCheck = undefined;
		}
	});
	it('reports a current person/session confirmation on introspection', async () => {
		active = true;
		const response = await fetch(`${endpoint}/api/auth/oauth2/introspect`, {
			method: 'POST',
			body: 'token=synthetic',
			signal: AbortSignal.timeout(3000),
		});
		expect(await response.json()).toMatchObject({ active: true, checkedAt: now * 1000 });
		active = false;
		const removed = await fetch(`${endpoint}/api/auth/oauth2/introspect`, {
			method: 'POST',
			body: 'token=synthetic',
			signal: AbortSignal.timeout(3000),
		});
		expect(await removed.json()).toEqual({ active: false });
	});
	it.each([
		'/api/auth/admin/oauth2/create-client',
		'/api/auth/oauth2/create-client',
		'/api/auth/oauth2/register',
		'/api/auth/passkey/register',
	])('never dispatches the unavailable public management route %s', async (pathname) => {
		const effects = upstreamEffects;
		const response = await fetch(`${endpoint}${pathname}`, {
			method: 'POST',
			body: '{}',
			signal: AbortSignal.timeout(3000),
		});
		expect(response.status).toBe(404);
		expect(upstreamEffects).toBe(effects);
	});
});
