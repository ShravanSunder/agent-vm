import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { createRemovalNoticeTokenVerifier } from '#tool-access/contracts/removal-notice-token';

const issuer = 'https://issuer.invalid';
const audience = 'https://portal.invalid/internal/v1/removal-notices';
const now = 1_800_000_000;
let oldKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let newKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let oldJwk: Awaited<ReturnType<typeof exportJWK>>;
let newJwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
	[oldKeys, newKeys] = await Promise.all([generateKeyPair('ES256'), generateKeyPair('ES256')]);
	[oldJwk, newJwk] = await Promise.all([
		exportJWK(oldKeys.publicKey),
		exportJWK(newKeys.publicKey),
	]);
});
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now * 1000);
});
afterEach(() => vi.useRealTimers());

async function signed(changes: JWTPayload = {}, useNewKey = false): Promise<string> {
	return new SignJWT({
		iss: issuer,
		aud: audience,
		client_id: 'central',
		sub: 'central',
		scope: 'removal-notices',
		iat: now,
		exp: now + 300,
		...changes,
	})
		.setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: useNewKey ? 'new-key' : 'old-key' })
		.sign(useNewKey ? newKeys.privateKey : oldKeys.privateKey);
}
function keySet(includeNew = false): unknown {
	return {
		keys: [
			{ ...oldJwk, kid: 'old-key', alg: 'ES256' },
			...(includeNew ? [{ ...newJwk, kid: 'new-key', alg: 'ES256' }] : []),
		],
	};
}
it.each([
	{ label: 'another caller', changes: { client_id: 'other' } },
	{ label: 'another operation', changes: { scope: 'credential-management' } },
	{
		label: 'another receiver',
		changes: { aud: 'https://other.invalid/internal/v1/removal-notices' },
	},
	{ label: 'another issuer', changes: { iss: 'https://other.invalid' } },
	{ label: 'more than five minutes', changes: { exp: now + 301 } },
	{ label: 'expired beyond leeway', changes: { exp: now - 60, iat: now - 360 } },
	{ label: 'future issue time beyond leeway', changes: { iat: now + 61, exp: now + 361 } },
	{ label: 'negative lifetime', changes: { exp: now - 1, iat: now } },
])('refuses a signed notice token for $label', async ({ changes }) => {
	const verifier = createRemovalNoticeTokenVerifier({
		issuer,
		audience,
		clientId: 'central',
		jwksUrl: new URL(`${issuer}/jwks`),
		jwksFetch: async () => Response.json(keySet()),
	});
	expect(await verifier.verify(await signed(changes))).toBe(false);
	expect(await verifier.verify(await signed())).toBe(true);
});
it('refuses unknown signing keys and accepts the newly rotated key during overlap', async () => {
	let overlap = false;
	const verifier = createRemovalNoticeTokenVerifier({
		issuer,
		audience,
		clientId: 'central',
		jwksUrl: new URL(`${issuer}/jwks`),
		jwksFetch: async () => Response.json(keySet(overlap)),
	});
	expect(await verifier.verify(await signed())).toBe(true);
	expect(await verifier.verify(await signed({}, true))).toBe(false);
	overlap = true;
	expect(await verifier.verify(await signed({}, true))).toBe(true);
	expect(await verifier.verify(await signed())).toBe(true);
});
it.each([false, true])(
	'withdraws a warm key after the five-minute cache bound with source unreachable=%s',
	async (unreachable) => {
		let withdrawn = false;
		const verifier = createRemovalNoticeTokenVerifier({
			issuer,
			audience,
			clientId: 'central',
			jwksUrl: new URL(`${issuer}/jwks`),
			jwksFetch: async () => {
				if (withdrawn && unreachable) throw new Error('controlled-key-source-unreachable');
				return Response.json(withdrawn ? { keys: [] } : keySet());
			},
		});
		const token = await signed();
		expect(await verifier.verify(token)).toBe(true);
		withdrawn = true;
		vi.setSystemTime((now + 299) * 1000);
		expect(await verifier.verify(token)).toBe(true);
		vi.setSystemTime((now + 301) * 1000);
		expect(await verifier.verify(token)).toBe(false);
	},
);
