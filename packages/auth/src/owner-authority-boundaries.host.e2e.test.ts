import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';

it('agent: real non-owner E7, forged actor input and public binding URLs never acquire owner authority across concurrent requests', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const ownerPerson = z.object({ sub: z.string() }).parse(decodeJwt(owner));
		const endpoint = `/management/organizations/${organizationOne}/agents`;
		const legitimate = {
			method: 'POST',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: registrationRequestId }),
		};
		expect((await harness.gateway(endpoint, legitimate)).status).toBe(200);
		// A test precondition only: S2's allowlist mutation API is outside S1's claim.
		await harness.database
			.prepare(
				'INSERT INTO allowed_email (email, person_id, added_by, added_at, removed_at) VALUES (?, NULL, ?, ?, NULL)',
			)
			.bind('member@example.invalid', ownerPerson.sub, Date.now())
			.run();
		const member = await harness.personToken('member@example.invalid');
		const memberPerson = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(member));
		expect(memberPerson.sub).not.toBe(ownerPerson.sub);
		expect(
			await harness.database.prepare('SELECT user_id FROM deployment_owner').all(),
		).toMatchObject({
			results: [{ user_id: ownerPerson.sub }],
		});
		const rowsBefore = await harness.database
			.prepare('SELECT clientId, metadata, grantTypes FROM oauthClient ORDER BY clientId')
			.all();
		const admissionBefore = await (
			await harness.gateway(
				`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
			)
		).json();
		const forgedHeaders = {
			authorization: `Bearer ${member}`,
			'content-type': 'application/json',
			'x-owner-id': ownerPerson.sub,
			'x-actor-id': ownerPerson.sub,
			'x-organization-id': organizationOne,
		};
		const responses = await Promise.all([
			harness.gateway(endpoint, {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, { headers: forgedHeaders }),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				method: 'DELETE',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			}),
		]);
		expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
		const forgedBody = await harness.gateway(endpoint, {
			method: 'POST',
			headers: forgedHeaders,
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				actor: ownerPerson.sub,
				owner: true,
				organizationId: organizationOne,
			}),
		});
		expect([400, 403].includes(forgedBody.status)).toBe(true);
		const publicResponses = await Promise.all(
			[
				'/changeClient',
				'/isLiveOwner',
				'/AgentClientManagement/changeClient',
				'/api/auth/AgentClientManagement/changeClient',
			].map((pathname) =>
				harness.auth(pathname, {
					method: 'POST',
					headers: { ...forgedHeaders, cookie: '' },
					body: JSON.stringify({
						actor: ownerPerson.sub,
						owner: true,
						organizationId: organizationOne,
					}),
				}),
			),
		);
		expect(publicResponses.every((response) => [403, 404].includes(response.status))).toBe(true);
		// A legitimate named-binding request overlaps public/no-hook and non-owner requests.
		const [accepted, isolated, noHook] = await Promise.all([
			harness.gateway(endpoint, legitimate),
			harness.gateway(endpoint, {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			}),
			harness.auth('/__auth-proof/no-hook'),
		]);
		expect(accepted.status).toBe(200);
		expect(isolated.status).toBe(403);
		expect(await noHook.json()).toEqual({ refused: true });
		expect(
			await harness.database
				.prepare('SELECT clientId, metadata, grantTypes FROM oauthClient ORDER BY clientId')
				.all(),
		).toEqual(rowsBefore);
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
				)
			).json(),
		).toEqual(admissionBefore);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
}, 120_000);
