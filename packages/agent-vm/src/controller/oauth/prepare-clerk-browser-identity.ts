import {
	clerkBrowserIdentityConfigSchema,
	type ClerkBrowserIdentityConfig,
} from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';

import {
	createConfiguredClerkBrowserIdentityVerifier,
	type ClerkBrowserIdentityVerifier,
} from './clerk-browser-identity-verifier.js';

export async function prepareClerkBrowserIdentity(props: {
	readonly config: ClerkBrowserIdentityConfig;
	readonly publicBaseUrl: string;
	readonly secretResolver: SecretResolver;
}): Promise<ClerkBrowserIdentityVerifier> {
	const config = clerkBrowserIdentityConfigSchema.parse(props.config);
	if (props.publicBaseUrl !== config.fixedLoginReturnOrigin) {
		throw new Error('Clerk login return origin must match the OAuth website origin.');
	}
	let secretKey: string;
	try {
		secretKey = await props.secretResolver.resolve(config.secretKey);
	} catch {
		throw new Error('Clerk backend key could not be resolved.');
	}
	if (!/^sk_(test|live)_[A-Za-z0-9_-]+$/u.test(secretKey) || secretKey.length > 4096) {
		throw new Error('Clerk backend key is invalid.');
	}
	return createConfiguredClerkBrowserIdentityVerifier({
		issuer: config.issuer,
		websiteOrigin: config.fixedLoginReturnOrigin,
		hostedSignInUrl: config.hostedSignInUrl,
		publishableKey: config.publishableKey,
		secretKey,
	});
}
