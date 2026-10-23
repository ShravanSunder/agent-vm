import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';
import type { AgentClientManagement } from '#auth/test-fixtures/management-observation-holds';

it('agent: real non-owner E7, forged actor input and public binding URLs never acquire owner authority across concurrent requests', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const ownerPerson = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(owner));
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
		const binding = await harness.miniflare.getBindings<{
			readonly SIGN_IN: AgentClientManagement;
		}>('gateway-one');
		// A public request cannot install or trigger the named-entry-only observer.
		const publicHoldId = crypto.randomUUID();
		await Promise.all(
			[
				'/__auth-proof/management/arm',
				'/armManagementHold',
				'/AgentClientManagement/armManagementHold',
			].map(async (pathname) => {
				const response = await harness.auth(pathname, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: publicHoldId, observeManagement: true }),
				});
				expect([403, 404].includes(response.status)).toBe(true);
			}),
		);
		expect(await binding.SIGN_IN.managementHoldStatus(publicHoldId)).toEqual({
			armed: false,
			observed: false,
		});
		await binding.SIGN_IN.armManagementHold(publicHoldId);
		try {
			const publicAttempt = await harness.auth('/api/auth/admin/oauth2/create-client', {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: publicHoldId, observeManagement: true }),
			});
			expect([403, 404].includes(publicAttempt.status)).toBe(true);
			expect(await binding.SIGN_IN.managementHoldStatus(publicHoldId)).toEqual({
				armed: true,
				observed: false,
			});
		} finally {
			await binding.SIGN_IN.releaseManagementHold(publicHoldId);
		}
		async function refusedCallerB(): Promise<void> {
			const clientsBeforeB = await harness.database
				.prepare(
					'SELECT clientId, clientSecret, metadata, grantTypes FROM oauthClient ORDER BY clientId',
				)
				.all();
			const isolated = await harness.gateway(endpoint, {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: crypto.randomUUID() }),
			});
			expect(isolated.status).toBe(403);
			const noHook = await harness.auth('/__auth-proof/no-hook');
			expect(noHook.status).toBe(200);
			expect(await noHook.json()).toEqual({ refused: true });
			expect(
				await harness.database
					.prepare(
						'SELECT clientId, clientSecret, metadata, grantTypes FROM oauthClient ORDER BY clientId',
					)
					.all(),
			).toEqual(clientsBeforeB);
		}
		async function heldOwnerA(revoke: boolean): Promise<void> {
			const clientBeforeA = await harness.database
				.prepare('SELECT clientId, clientSecret FROM oauthClient WHERE clientId = ?')
				.bind(registeredClientId)
				.first();
			// Reusing the completed operation makes A enter the real provider link/rotation path.
			await binding.SIGN_IN.armManagementHold(registrationRequestId);
			const accepted = harness.gateway(endpoint, legitimate);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const entered = await Promise.race([
					binding.SIGN_IN.enteredManagementHold(registrationRequestId),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('Authorized management hold was not entered')),
							30_000,
						);
					}),
				]);
				expect(entered).toEqual({
					point: 'before-provider-owner-read',
					requestId: registrationRequestId,
				});
				await refusedCallerB();
				if (revoke)
					await harness.database
						.prepare('DELETE FROM session WHERE id = ?')
						.bind(ownerPerson.sid)
						.run();
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				await binding.SIGN_IN.releaseManagementHold(registrationRequestId);
				await accepted;
			}
			const settled = await accepted;
			expect(settled.status).toBe(revoke ? 503 : 200);
			if (revoke) expect(await settled.json()).not.toHaveProperty('clientSecret');
			if (revoke)
				expect(
					await harness.database
						.prepare('SELECT clientId, clientSecret FROM oauthClient WHERE clientId = ?')
						.bind(registeredClientId)
						.first(),
				).toEqual(clientBeforeA);
			await refusedCallerB();
		}
		await heldOwnerA(false);
		await heldOwnerA(true);
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
