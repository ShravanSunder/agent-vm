import { createHash, randomBytes } from 'node:crypto';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { expectNoIssuedCredentials } from '#auth/test-fixtures/credential-free-refusal';
import {
	startLocalAuthHarness,
	workspaceOne,
	workspaceAudience,
	registrationRequestId,
} from '#auth/test-fixtures/local-auth-harness';
import { addWorkspaceAgent } from '#auth/test-fixtures/workspace-agent-proof';

it('agent: a Person code client deliberately linked and scoped to a workspace still receives invalid_target and no proof', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		expect(
			(
				await addWorkspaceAgent({
					harness,
					owner,
					workspaceId: workspaceOne,
					requestId: registrationRequestId,
				})
			).status,
		).toBe(200);
		// Bypass only link/scope policy in the test composition so the production Person issuance guard decides.
		await harness.database
			.prepare(
				'INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt) VALUES (?, ?, ?, ?)',
			)
			.bind(
				crypto.randomUUID(),
				harness.target.ownerCliClientId,
				workspaceAudience(workspaceOne),
				Date.now(),
			)
			.run();
		await harness.database
			.prepare('UPDATE oauthClient SET scopes = ? WHERE clientId = ?')
			.bind(
				JSON.stringify(['tool-portal:management', 'tool-portal:agent']),
				harness.target.ownerCliClientId,
			)
			.run();
		const verifier = randomBytes(32).toString('base64url');
		const redirect = 'http://127.0.0.1:49152/callback';
		const params = new URLSearchParams({
			client_id: harness.target.ownerCliClientId,
			response_type: 'code',
			redirect_uri: redirect,
			scope: 'tool-portal:agent',
			resource: workspaceAudience(workspaceOne),
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
			state: crypto.randomUUID(),
		});
		const authorization = await harness.auth(`/api/auth/oauth2/authorize?${params.toString()}`, {
			headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
		});
		expect(authorization.status).toBe(302);
		const callback = new URL(z.string().parse(authorization.headers.get('location')));
		expect(callback.origin + callback.pathname).toBe(redirect);
		const code = z.string().min(1).parse(callback.searchParams.get('code'));
		const exchange = await harness.auth('/api/auth/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: harness.target.ownerCliClientId,
				code,
				code_verifier: verifier,
				redirect_uri: redirect,
				resource: workspaceAudience(workspaceOne),
			}),
		});
		expect(exchange.status).toBe(400);
		const refused: unknown = await exchange.json();
		expect(refused).toMatchObject({ error: 'invalid_target' });
		expectNoIssuedCredentials(refused);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
});
