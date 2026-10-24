import {
	createAgentTokenVerifier,
	type Principal,
} from '@agent-collaboration/tool-access/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkHostedCaller } from '#tool-host-core/caller-admission/caller-check';

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const toolPortalOrigin = 'https://portal.invalid';
const deployment = 'https://issuer.invalid';
const principal: Principal = {
	kind: 'fleetHarnessSession',
	session_ref: {
		installation: '33333333-3333-4333-8333-333333333333',
		harness_endpoint: 'codex-local',
		conversation_id: 'session-one',
	},
	machine_environment: { kind: 'physical' },
	project_id: 'project-one',
	isolation: { kind: 'host', instance_id: 'launch-one' },
};
const persona = { kind: 'named', name: 'operator' } as const;
const now = 1_800_000_000;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let forgedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let verifier: ReturnType<typeof createAgentTokenVerifier>;
beforeAll(async () => {
	keys = await generateKeyPair('ES256');
	forgedKeys = await generateKeyPair('ES256');
	const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' }] };
	verifier = createAgentTokenVerifier({
		deployment,
		jwksUrl: new URL(`${deployment}/jwks`),
		now: () => now * 1000,
		jwksFetch: async () => Response.json(jwks),
	});
});
async function token(changes: JWTPayload = {}, forged = false): Promise<string> {
	return new SignJWT({
		iss: deployment,
		sub: 'central',
		client_id: 'central',
		aud: `${toolPortalOrigin}/workspaces/${workspaceId}/mcp`,
		iat: now,
		exp: now + 3600,
		jti: 'test-token',
		scope: 'tool-portal:agent',
		organization_id: organizationId,
		workspace_id: workspaceId,
		principal,
		persona,
		grant_revision: 7,
		grant_expires_at: now + 300,
		...changes,
	})
		.setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'test-key' })
		.sign(forged ? forgedKeys.privateKey : keys.privateKey);
}
async function check(bearer: string | undefined): ReturnType<typeof checkHostedCaller> {
	return checkHostedCaller({
		request: new Request(
			`https://attacker.invalid/workspaces/${workspaceId}/mcp?organizationId=other&agent=other`,
			{
				headers: {
					...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
					'x-agent-id': 'other',
				},
			},
		),
		workspaceId,
		organizationId,
		toolPortalOrigin,
		verifier,
		sessionClientId: 'central',
	});
}
describe('token-only hosted admission (C1)', () => {
	it('uses signed principal and persona without a membership store or Fleet client', async () => {
		// Arrange / Act: no membership or central client exists at this boundary.
		const admitted = await check(await token());
		// Assert: request labels and the shared authenticated client cannot replace the session.
		expect(admitted).toEqual({
			kind: 'verified',
			organizationId,
			workspaceId,
			principal,
			persona,
			grantRevision: 7,
			grantExpiresAt: now + 300,
		});
	});
	it.each([
		{ label: 'missing bearer', reason: 'missing-token', missing: true },
		{ label: 'forged signature', reason: 'bad-signature', forged: true },
		{
			label: 'wrong audience',
			reason: 'wrong-audience',
			changes: { aud: 'https://other.invalid/mcp' },
		},
		{
			label: 'foreign workspace',
			reason: 'wrong-workspace',
			changes: { workspace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
		},
		{
			label: 'foreign organization',
			reason: 'wrong-organization',
			changes: { organization_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
		},
		{
			label: 'session issued by an unpinned client',
			reason: 'wrong-session-client',
			changes: { sub: 'bot-client', client_id: 'bot-client' },
		},
		{ label: 'JWT expiry beyond allowed leeway', reason: 'expired', changes: { exp: now - 60 } },
		{ label: 'exact grant end', reason: 'expired', changes: { grant_expires_at: now } },
		{ label: 'past grant end', reason: 'expired', changes: { grant_expires_at: now - 1 } },
	])('refuses $label before granting any caller', async ({ reason, changes, missing, forged }) => {
		const bearer = missing ? undefined : await token(changes, forged);
		expect(await check(bearer)).toEqual({ kind: 'refused', reason });
	});
	it('admits the same bot through two distinct credentials as one principal', async () => {
		const botPrincipal = { kind: 'bot', bot_id: '22222222-2222-4222-8222-222222222222' };
		const admitted = await Promise.all(
			['credential-one', 'credential-two'].map(async (clientId) =>
				check(await token({ sub: clientId, client_id: clientId, principal: botPrincipal })),
			),
		);
		expect(admitted[0]).toEqual(admitted[1]);
		expect(admitted[0]).toMatchObject({ kind: 'verified', principal: botPrincipal });
	});
});
