import { fileURLToPath } from 'node:url';

import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLocalAuthHarness,
	organizationOne,
	registrationRequestId,
	registeredClientId,
} from '#auth/test-fixtures/local-auth-harness';
import { runCachedNativeOwnerCommand } from '#auth/test-fixtures/native-cli-proof';

it.each([
	'revoked-session',
	'expired-session',
	'removed-person',
	'unbound-owner',
	'unavailable-session-store',
] as const)(
	'agent: the next delivered CLI command refuses the already issued E7 after $0',
	async (change) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const person = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(owner));
			const endpoint = `/management/organizations/${organizationOne}/agents`;
			const registered = await harness.gateway(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId }),
			});
			expect(registered.status).toBe(200);
			const before = await (
				await harness.gateway(
					`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
				)
			).json();
			const command = {
				target: harness.target,
				repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
				args: ['agent-status', '--client-id', registeredClientId],
			};
			const admitted = await runCachedNativeOwnerCommand(command);
			expect(admitted.code).toBe(0);
			expect(admitted.stdout).toBe(`listed: ${registeredClientId}\n`);
			switch (change) {
				case 'revoked-session':
					await harness.database.prepare('DELETE FROM session WHERE id = ?').bind(person.sid).run();
					break;
				case 'expired-session':
					await harness.database
						.prepare('UPDATE session SET expiresAt = 0 WHERE id = ?')
						.bind(person.sid)
						.run();
					break;
				case 'removed-person':
					await harness.database
						.prepare('UPDATE allowed_email SET removed_at = 1 WHERE person_id = ?')
						.bind(person.sub)
						.run();
					break;
				case 'unbound-owner':
					await harness.database
						.prepare('DELETE FROM deployment_owner WHERE user_id = ?')
						.bind(person.sub)
						.run();
					break;
				case 'unavailable-session-store':
					await harness.database.exec('ALTER TABLE session RENAME TO unavailable_session');
					break;
			}
			const refused = await runCachedNativeOwnerCommand(command);
			expect(refused.code).toBe(1);
			expect(refused.stdout).toBe('');
			expect(refused.stderr.includes('Owner management refused')).toBe(true);
			expect(refused.stderr.includes(owner)).toBe(false);
			expect(refused.stderr.includes(harness.cookie())).toBe(false);
			expect(harness.effects).toHaveLength(0);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?organization=${organizationOne}&client=${registeredClientId}`,
					)
				).json(),
			).toEqual(before);
		} finally {
			await harness.close();
		}
	},
	120_000,
);
