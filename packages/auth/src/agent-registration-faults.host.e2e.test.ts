import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
	agentAudience,
} from '#auth/test-fixtures/local-auth-harness';

const faults = [
	{
		name: 'intent',
		table: 'sign_in_audit',
		condition: `NEW.target_id = '${registeredClientId}' AND NEW.phase = 'intent'`,
		clients: 0,
		links: 0,
		intents: 0,
	},
	{
		name: 'client',
		table: 'oauthClient',
		condition: `NEW.clientId = '${registeredClientId}'`,
		clients: 0,
		links: 0,
		intents: 1,
	},
	{
		name: 'link',
		table: 'oauthClientResource',
		condition: `NEW.clientId = '${registeredClientId}'`,
		clients: 1,
		links: 0,
		intents: 1,
	},
	{
		name: 'outcome',
		table: 'sign_in_audit',
		condition: `NEW.target_id = '${registeredClientId}' AND NEW.phase = 'outcome'`,
		clients: 1,
		links: 1,
		intents: 1,
	},
] as const;

// Each SQL trigger rejects the actual D1 write, not a mocked record method or a preflight decision.
it.each(faults)(
	'agent: fails closed at the actual $name write and owner retry leaves exactly one linked working client',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const endpoint = `/management/organizations/${organizationOne}/agents`;
			const operation = {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId }),
			};
			await harness.database.exec(
				`CREATE TRIGGER fail_registration BEFORE INSERT ON ${fault.table} WHEN ${fault.condition} BEGIN SELECT RAISE(FAIL, 'controlled-${fault.name}-fault'); END;`,
			);
			const failed = await harness.gateway(endpoint, operation);
			expect(failed.status).toBe(503);
			expect(await failed.json()).not.toHaveProperty('clientSecret');
			const before = await harness.database
				.prepare('SELECT clientId, clientSecret FROM oauthClient WHERE clientId = ?')
				.bind(registeredClientId)
				.all();
			expect(before.results).toHaveLength(fault.clients);
			expect(
				(
					await harness.database
						.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
						.bind(registeredClientId)
						.all()
				).results,
			).toHaveLength(fault.links);
			expect(
				(
					await harness.database
						.prepare("SELECT id FROM sign_in_audit WHERE target_id = ? AND phase = 'intent'")
						.bind(registeredClientId)
						.all()
				).results,
			).toHaveLength(fault.intents);
			expect(
				(
					await harness.database
						.prepare("SELECT id FROM sign_in_audit WHERE target_id = ? AND phase = 'outcome'")
						.bind(registeredClientId)
						.all()
				).results,
			).toHaveLength(0);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
					)
				).json(),
			).not.toHaveProperty(`agent:${registeredClientId}`);
			await harness.database.exec('DROP TRIGGER fail_registration');
			const repeated = await harness.gateway(endpoint, operation);
			expect(repeated.status).toBe(200);
			const credentials = z
				.strictObject({
					kind: z.literal('registered'),
					clientId: z.literal(registeredClientId),
					clientSecret: z.string().min(1),
				})
				.parse(await repeated.json());
			const after = await harness.database
				.prepare('SELECT clientId, clientSecret FROM oauthClient WHERE clientId = ?')
				.bind(registeredClientId)
				.all();
			expect(after.results).toHaveLength(1);
			if (fault.clients > 0)
				expect(after.results[0]?.clientSecret).not.toBe(before.results[0]?.clientSecret);
			expect(
				(
					await harness.database
						.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
						.bind(registeredClientId)
						.all()
				).results,
			).toEqual([{ resourceId: agentAudience }]);
			const token = await harness.auth('/api/auth/oauth2/token', {
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
			expect(token.status).toBe(200);
			expect(await token.json()).toHaveProperty('access_token');
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
					)
				).json(),
			).toMatchObject({ [`agent:${registeredClientId}`]: { state: 'listed' } });
		} finally {
			await harness.close();
		}
	},
	90_000,
);
