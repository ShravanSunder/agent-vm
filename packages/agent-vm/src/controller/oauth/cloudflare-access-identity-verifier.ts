import {
	oauthAuthenticatedHumanSchema,
	type OAuthAuthenticatedHuman,
} from '@agent-vm/oauth-broker-contracts';
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type FetchImplementation } from 'jose';
import { z } from 'zod';

const accessAssertionHeader = 'cf-access-jwt-assertion';
const maximumAssertionBytes = 16 * 1024;
const maximumJwksBytes = 64 * 1024;
const accessJwksSchema = z.object({ keys: z.array(z.unknown()) }).passthrough();
const accessDisplayEmailSchema = z.string().email().max(320);
const accessClaimsSchema = z
	.object({
		type: z.literal('app'),
		iss: z.string().min(1).max(2048),
		sub: z.string().min(1).max(256),
		aud: z.union([z.string(), z.array(z.string())]),
		iat: z.number().int().nonnegative(),
		nbf: z.number().int().nonnegative(),
		exp: z.number().int().positive(),
		email: z.unknown().optional(),
	})
	.passthrough();

class CloudflareAccessJwksUnavailableError extends Error {}

export type CloudflareAccessVerification =
	| { readonly kind: 'verified'; readonly human: OAuthAuthenticatedHuman }
	| { readonly kind: 'denied' }
	| { readonly kind: 'verification-unavailable' };

export interface CloudflareAccessIdentityVerifier {
	verifyRequest(request: Request): Promise<CloudflareAccessVerification>;
}

export interface CreateCloudflareAccessIdentityVerifierProps {
	readonly audience: string;
	readonly fetch?: FetchImplementation;
	readonly issuer: string;
	readonly now?: () => number;
}

function boundedJwksFetch(props: {
	readonly expectedUrl: string;
	readonly fetchImplementation: FetchImplementation;
}): FetchImplementation {
	return async (url, options): Promise<Response> => {
		if (url !== props.expectedUrl)
			throw new CloudflareAccessJwksUnavailableError('Unexpected Access JWKS endpoint.');
		let response: Response;
		try {
			response = await props.fetchImplementation(url, options);
		} catch (error) {
			throw new CloudflareAccessJwksUnavailableError('Access JWKS request failed.', {
				cause: error,
			});
		}
		if (response.type === 'opaqueredirect' || response.status !== 200)
			throw new CloudflareAccessJwksUnavailableError('Access JWKS endpoint was unavailable.');
		if (response.body === null)
			throw new CloudflareAccessJwksUnavailableError('Access JWKS response was empty.');
		const responseReader = response.body.getReader();
		const declaredLength = response.headers.get('content-length');
		if (declaredLength !== null && Number(declaredLength) > maximumJwksBytes) {
			try {
				await responseReader.cancel();
			} catch {
				// The response is already rejected for exceeding the configured bound.
			} finally {
				responseReader.releaseLock();
			}
			throw new CloudflareAccessJwksUnavailableError('Access JWKS response exceeded its limit.');
		}
		const responseChunks: Uint8Array[] = [];
		let responseByteLength = 0;
		try {
			while (true) {
				let readResult;
				try {
					// oxlint-disable-next-line no-await-in-loop -- response streams must be consumed in order.
					readResult = await responseReader.read();
				} catch (error) {
					throw new CloudflareAccessJwksUnavailableError('Access JWKS response read failed.', {
						cause: error,
					});
				}
				if (readResult.done) break;
				if (responseByteLength + readResult.value.byteLength > maximumJwksBytes) {
					try {
						// oxlint-disable-next-line no-await-in-loop -- overflow cancellation belongs to this read.
						await responseReader.cancel();
					} catch {
						// The response is already rejected for exceeding the configured bound.
					}
					throw new CloudflareAccessJwksUnavailableError(
						'Access JWKS response exceeded its limit.',
					);
				}
				responseChunks.push(readResult.value);
				responseByteLength += readResult.value.byteLength;
			}
		} finally {
			responseReader.releaseLock();
		}
		const bytes = new Uint8Array(responseByteLength);
		let writeOffset = 0;
		for (const responseChunk of responseChunks) {
			bytes.set(responseChunk, writeOffset);
			writeOffset += responseChunk.byteLength;
		}
		try {
			accessJwksSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
		} catch (error) {
			throw new CloudflareAccessJwksUnavailableError('Access JWKS response was malformed.', {
				cause: error,
			});
		}
		return new Response(bytes, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	};
}

export function createCloudflareAccessIdentityVerifier(
	props: CreateCloudflareAccessIdentityVerifierProps,
): CloudflareAccessIdentityVerifier {
	const issuer = new URL(props.issuer).origin;
	if (issuer !== props.issuer || new URL(issuer).protocol !== 'https:')
		throw new Error('Cloudflare Access issuer must be a canonical HTTPS origin.');
	const jwksUrl = new URL('/cdn-cgi/access/certs', issuer);
	const fetchImplementation = boundedJwksFetch({
		expectedUrl: jwksUrl.toString(),
		fetchImplementation: props.fetch ?? globalThis.fetch,
	});
	const remoteJwks = createRemoteJWKSet(jwksUrl, {
		cacheMaxAge: 10 * 60_000,
		cooldownDuration: 30_000,
		timeoutDuration: 5_000,
		[customFetch]: fetchImplementation,
	});
	const now = props.now ?? Date.now;
	return {
		verifyRequest: async (request): Promise<CloudflareAccessVerification> => {
			const assertions = request.headers.get(accessAssertionHeader);
			if (
				assertions === null ||
				assertions.length === 0 ||
				Buffer.byteLength(assertions, 'utf8') > maximumAssertionBytes ||
				assertions.includes(',')
			)
				return { kind: 'denied' };
			try {
				const currentDate = new Date(now());
				const verified = await jwtVerify(assertions, remoteJwks, {
					algorithms: ['RS256'],
					audience: props.audience,
					clockTolerance: 0,
					currentDate,
					issuer,
					requiredClaims: ['aud', 'exp', 'iat', 'iss', 'nbf', 'sub', 'type'],
				});
				const claims = accessClaimsSchema.safeParse(verified.payload);
				const nowSeconds = Math.floor(currentDate.getTime() / 1000);
				if (
					!claims.success ||
					claims.data.iss !== issuer ||
					claims.data.nbf > nowSeconds ||
					claims.data.iat > nowSeconds ||
					claims.data.exp <= nowSeconds ||
					claims.data.iat > claims.data.exp ||
					claims.data.nbf > claims.data.exp
				)
					return { kind: 'denied' };
				const displayEmail = accessDisplayEmailSchema.safeParse(claims.data.email);
				return {
					kind: 'verified',
					human: oauthAuthenticatedHumanSchema.parse({
						authenticationExpiresAtMs: claims.data.exp * 1000,
						...(displayEmail.success ? { emailAddress: displayEmail.data } : {}),
						identity: { issuer, subject: claims.data.sub },
					}),
				};
			} catch (error) {
				if (
					error instanceof CloudflareAccessJwksUnavailableError ||
					error instanceof errors.JWKSInvalid
				)
					return { kind: 'verification-unavailable' };
				return { kind: 'denied' };
			}
		},
	};
}
