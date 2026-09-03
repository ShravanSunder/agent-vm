import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createOAuthOpaqueIdentifier(): string {
	return randomBytes(32).toString('base64url');
}

export function createOAuthPkcePair(): {
	readonly challenge: string;
	readonly verifier: string;
} {
	const verifier = createOAuthOpaqueIdentifier();
	return {
		challenge: createHash('sha256').update(verifier).digest('base64url'),
		verifier,
	};
}

export function oauthBrowserSecretsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
