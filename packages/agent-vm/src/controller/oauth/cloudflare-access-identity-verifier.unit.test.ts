import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { createCloudflareAccessIdentityVerifier } from './cloudflare-access-identity-verifier.js';

const issuer = 'https://identity.example.test';
const audience = 'access-application-audience';
const nowMs = 1_800_000_000_000;

async function createSigningKey(kid: string): Promise<{
	readonly privateKey: CryptoKey;
	readonly publicJwk: JWK;
}> {
	const pair = await generateKeyPair('RS256', { extractable: true });
	return {
		privateKey: pair.privateKey,
		publicJwk: { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid, use: 'sig' },
	};
}

async function signAssertion(props: {
	readonly audience?: string;
	readonly assertionIssuer?: string;
	readonly expiresAtSeconds?: number;
	readonly issuedAtSeconds?: number;
	readonly notBeforeSeconds?: number;
	readonly privateKey: CryptoKey;
	readonly kid: string;
	readonly overrides?: Readonly<Record<string, unknown>>;
	readonly subject?: string;
}): Promise<string> {
	const nowSeconds = Math.floor(nowMs / 1000);
	return await new SignJWT({
		type: 'app',
		email: 'person@example.test',
		...props.overrides,
	})
		.setProtectedHeader({ alg: 'RS256', kid: props.kid })
		.setIssuer(props.assertionIssuer ?? issuer)
		.setAudience(props.audience ?? audience)
		.setSubject(props.subject ?? 'access-subject')
		.setIssuedAt(props.issuedAtSeconds ?? nowSeconds - 30)
		.setNotBefore(props.notBeforeSeconds ?? nowSeconds - 30)
		.setExpirationTime(props.expiresAtSeconds ?? nowSeconds + 300)
		.sign(props.privateKey);
}

function requestWithAssertion(assertion: string): Request {
	return new Request('https://permissions.example.test/oauth/agents', {
		headers: { 'Cf-Access-Jwt-Assertion': assertion },
	});
}

describe('Cloudflare Access identity verifier', () => {
	it('verifies a signed human application assertion and returns display email as metadata', async () => {
		const key = await createSigningKey('key-one');
		const assertion = await signAssertion({ privateKey: key.privateKey, kid: 'key-one' });
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () => Response.json({ keys: [key.publicJwk] }),
		});

		const result = await verifier.verifyRequest(requestWithAssertion(assertion));

		expect(result).toEqual({
			kind: 'verified',
			human: {
				authenticationExpiresAtMs: nowMs + 300_000,
				emailAddress: 'person@example.test',
				identity: { issuer, subject: 'access-subject' },
			},
		});
	});

	it.each([
		['malformed', 'not-an-email'],
		['overlong', `${'a'.repeat(310)}@example.test`],
	])(
		'omits a %s optional display email without rejecting the human identity',
		async (_label, email) => {
			const key = await createSigningKey('key-one');
			const assertion = await signAssertion({
				privateKey: key.privateKey,
				kid: 'key-one',
				overrides: { email },
			});
			const verifier = createCloudflareAccessIdentityVerifier({
				audience,
				issuer,
				now: () => nowMs,
				fetch: async () => Response.json({ keys: [key.publicJwk] }),
			});

			expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
				kind: 'verified',
				human: {
					authenticationExpiresAtMs: nowMs + 300_000,
					identity: { issuer, subject: 'access-subject' },
				},
			});
		},
	);

	it('fails closed for missing, forged, wrong-audience, service, and expired assertions', async () => {
		const trusted = await createSigningKey('trusted');
		const untrusted = await createSigningKey('untrusted');
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () => Response.json({ keys: [trusted.publicJwk] }),
		});
		const invalidAssertions = [
			await signAssertion({ privateKey: untrusted.privateKey, kid: 'untrusted' }),
			await signAssertion({
				audience: 'wrong-audience',
				privateKey: trusted.privateKey,
				kid: 'trusted',
			}),
			await signAssertion({
				privateKey: trusted.privateKey,
				kid: 'trusted',
				overrides: { type: 'service' },
			}),
			await new SignJWT({ type: 'app' })
				.setProtectedHeader({ alg: 'RS256', kid: 'trusted' })
				.setIssuer(issuer)
				.setAudience(audience)
				.setSubject('access-subject')
				.setIssuedAt(Math.floor(nowMs / 1000) - 600)
				.setNotBefore(Math.floor(nowMs / 1000) - 600)
				.setExpirationTime(Math.floor(nowMs / 1000) - 1)
				.sign(trusted.privateKey),
		];

		expect(await verifier.verifyRequest(new Request('https://permissions.example.test'))).toEqual({
			kind: 'denied',
		});
		for (const assertion of invalidAssertions)
			expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
				kind: 'denied',
			});
	});

	it('rejects an otherwise valid assertion from the wrong issuer', async () => {
		const key = await createSigningKey('key-one');
		const assertion = await signAssertion({
			assertionIssuer: 'https://other-identity.example.test',
			privateKey: key.privateKey,
			kid: 'key-one',
		});
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () => Response.json({ keys: [key.publicJwk] }),
		});

		expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
			kind: 'denied',
		});
	});

	it('rejects future temporal claims and an empty human subject', async () => {
		const key = await createSigningKey('key-one');
		const nowSeconds = Math.floor(nowMs / 1000);
		const invalidAssertions = await Promise.all([
			signAssertion({
				issuedAtSeconds: nowSeconds + 1,
				privateKey: key.privateKey,
				kid: 'key-one',
			}),
			signAssertion({
				privateKey: key.privateKey,
				kid: 'key-one',
				notBeforeSeconds: nowSeconds + 1,
			}),
			signAssertion({ privateKey: key.privateKey, kid: 'key-one', subject: '' }),
		]);
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () => Response.json({ keys: [key.publicJwk] }),
		});

		expect(
			await Promise.all(
				invalidAssertions.map((assertion) =>
					verifier.verifyRequest(requestWithAssertion(assertion)),
				),
			),
		).toEqual(invalidAssertions.map(() => ({ kind: 'denied' })));
	});

	it('refreshes the remote JWKS after cooldown when Access rotates to an unknown key', async () => {
		const firstKey = await createSigningKey('key-one');
		const rotatedKey = await createSigningKey('key-two');
		const firstAssertion = await signAssertion({
			privateKey: firstKey.privateKey,
			kid: 'key-one',
		});
		const rotatedAssertion = await signAssertion({
			privateKey: rotatedKey.privateKey,
			kid: 'key-two',
		});
		let fetchCount = 0;
		let joseClockMs = nowMs;
		const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => joseClockMs);
		try {
			const verifier = createCloudflareAccessIdentityVerifier({
				audience,
				issuer,
				now: () => nowMs,
				fetch: async () => {
					fetchCount += 1;
					return Response.json({
						keys: [fetchCount === 1 ? firstKey.publicJwk : rotatedKey.publicJwk],
					});
				},
			});

			expect((await verifier.verifyRequest(requestWithAssertion(firstAssertion))).kind).toBe(
				'verified',
			);
			joseClockMs += 30_001;
			expect((await verifier.verifyRequest(requestWithAssertion(rotatedAssertion))).kind).toBe(
				'verified',
			);
			expect(fetchCount).toBe(2);
		} finally {
			dateNow.mockRestore();
		}
	});

	it('classifies the maintained JWKS transport timeout as verification unavailable', async () => {
		const key = await createSigningKey('key-one');
		const assertion = await signAssertion({ privateKey: key.privateKey, kid: 'key-one' });
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () => {
				throw new DOMException('synthetic transport timeout', 'TimeoutError');
			},
		});

		expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
			kind: 'verification-unavailable',
		});
	});

	it.each([
		['a non-200 response', new Response('unavailable', { status: 503 })],
		['a 204 response', new Response(null, { status: 204 })],
		['malformed JSON', new Response('{"keys":')],
		['a malformed service response', Response.json({ status: 'ok' })],
	])(
		'classifies %s from the JWKS service as verification unavailable',
		async (_label, response) => {
			const key = await createSigningKey('key-one');
			const assertion = await signAssertion({ privateKey: key.privateKey, kid: 'key-one' });
			const verifier = createCloudflareAccessIdentityVerifier({
				audience,
				issuer,
				now: () => nowMs,
				fetch: async () => response.clone(),
			});

			expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
				kind: 'verification-unavailable',
			});
		},
	);

	it('uses the fixed issuer JWKS URL without redirects and cancels a chunked response at the bound', async () => {
		const key = await createSigningKey('key-one');
		const assertion = await signAssertion({ privateKey: key.privateKey, kid: 'key-one' });
		const requested: string[] = [];
		let chunkReadCount = 0;
		let cancellationObserved = false;
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async (url, options) => {
				requested.push(url);
				expect(options.redirect).toBe('manual');
				return new Response(
					new ReadableStream<Uint8Array>(
						{
							cancel: () => {
								cancellationObserved = true;
							},
							pull: (controller) => {
								chunkReadCount += 1;
								if (chunkReadCount > 2)
									throw new Error('The bounded reader requested bytes after overflow.');
								controller.enqueue(new Uint8Array(chunkReadCount === 1 ? 48 * 1024 : 20 * 1024));
							},
						},
						{ highWaterMark: 0 },
					),
				);
			},
		});

		expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
			kind: 'verification-unavailable',
		});
		expect(requested).toEqual([`${issuer}/cdn-cgi/access/certs`]);
		expect(chunkReadCount).toBe(2);
		expect(cancellationObserved).toBe(true);
	});

	it('classifies a streamed JWKS body read failure as verification unavailable', async () => {
		const key = await createSigningKey('key-one');
		const assertion = await signAssertion({ privateKey: key.privateKey, kid: 'key-one' });
		const verifier = createCloudflareAccessIdentityVerifier({
			audience,
			issuer,
			now: () => nowMs,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull: (controller) => controller.error(new Error('read failed')),
					}),
				),
		});

		expect(await verifier.verifyRequest(requestWithAssertion(assertion))).toEqual({
			kind: 'verification-unavailable',
		});
	});
});
