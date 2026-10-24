import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	organizationOne,
	organizationTwo,
	registrationRequestId,
	registeredClientId,
	agentAudience,
} from '#auth/test-fixtures/local-auth-harness';

it.each(['disable', 'resource-organization'] as const)(
	'agent: discards the actual signed token after a held $0 race before the final D1 read',
	async (race) => {
		const harness = await startLocalAuthHarness();
		let pending: Promise<Response> | undefined;
		try {
			const owner = await harness.ownerToken();
			const registration = await harness.gateway(
				`/management/organizations/${organizationOne}/agents`,
				{
					method: 'POST',
					headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: registrationRequestId }),
				},
			);
			expect(registration.status).toBe(200);
			const credentials = z
				.object({ clientId: z.literal(registeredClientId), clientSecret: z.string().min(1) })
				.parse(await registration.json());
			if (race === 'resource-organization') {
				await harness.database
					.prepare('UPDATE oauthResource SET customClaims = ? WHERE identifier = ?')
					.bind(JSON.stringify({ organization_id: organizationTwo }), agentAudience)
					.run();
				expect(
					await harness.database
						.prepare('SELECT customClaims FROM oauthResource WHERE identifier = ?')
						.bind(agentAudience)
						.first(),
				).toEqual({ customClaims: JSON.stringify({ organization_id: organizationTwo }) });
			}
			const control = `/__auth-proof/hold/`;
			expect(
				(await harness.auth(`${control}arm?client=${registeredClientId}`, { method: 'POST' }))
					.status,
			).toBe(200);
			pending = harness.auth('/api/auth/oauth2/token', {
				method: 'POST',
				headers: {
					authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					scope: 'tool-portal:agent',
					resource: agentAudience,
				}),
			});
			// Attach rejection handling immediately while the protocol event is awaited.
			void pending.catch(() => undefined);
			const signed = await harness.auth(`${control}entered?client=${registeredClientId}`);
			expect(signed.status).toBe(200);
			expect(await signed.json()).toEqual({
				signed: true,
				clientId: registeredClientId,
				organizationId: race === 'disable' ? organizationOne : organizationTwo,
			});
			if (race === 'disable') {
				await harness.database
					.prepare('UPDATE oauthClient SET disabled = 1 WHERE clientId = ?')
					.bind(registeredClientId)
					.run();
				expect(
					await harness.database
						.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?')
						.bind(registeredClientId)
						.first(),
				).toEqual({ disabled: 1 });
			}
			expect(
				(await harness.auth(`${control}release?client=${registeredClientId}`, { method: 'POST' }))
					.status,
			).toBe(200);
			const refused = await pending;
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ error: 'invalid_client' });
			expect(refused.headers.has('set-cookie')).toBe(false);
			expect(harness.effects).toHaveLength(0);
		} finally {
			try {
				await harness.auth(`/__auth-proof/hold/release?client=${registeredClientId}`, {
					method: 'POST',
				});
				await pending?.catch(() => undefined);
			} finally {
				await harness.close();
			}
		}
	},
	120_000,
);
