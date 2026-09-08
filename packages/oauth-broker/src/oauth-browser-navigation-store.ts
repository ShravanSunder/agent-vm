import {
	oauthBrowserSessionIdentitySchema,
	type OAuthBrowserSessionIdentity,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { createOAuthOpaqueIdentifier, oauthBrowserSecretsEqual } from './oauth-browser-security.js';
import {
	oauthLoginContinuationTargetSchema,
	type OAuthLoginContinuationTarget,
} from './oauth-login-continuation-store.js';

interface BrowserNavigationContext {
	readonly identity: OAuthBrowserSessionIdentity;
	readonly target: OAuthLoginContinuationTarget;
	readonly browserBindingSecret: string;
	readonly csrfToken: string;
	readonly expiresAtMs: number;
}
export type OAuthBrowserNavigationCreation =
	| { readonly kind: 'capacity-exhausted' }
	| {
			readonly kind: 'created';
			readonly contextId: string;
			readonly browserBindingSecret: string;
			readonly csrfToken: string;
			readonly expiresAtMs: number;
	  };
export interface OAuthBrowserNavigationStore {
	create(props: {
		readonly identity: OAuthBrowserSessionIdentity;
		readonly target: OAuthLoginContinuationTarget;
	}): OAuthBrowserNavigationCreation;
	read(props: {
		readonly contextId: string;
		readonly browserBindingSecret: string;
	}): BrowserNavigationContext | undefined;
	cancelSession(identity: OAuthBrowserSessionIdentity): void;
	clear(): void;
}

/** Fixed-lifetime page context after verified login; no renewal or independent login authority. */
export function createOAuthBrowserNavigationStore(
	props: { readonly now?: () => number; readonly capacity?: number } = {},
): OAuthBrowserNavigationStore {
	const now = props.now ?? Date.now;
	const capacity = z
		.number()
		.int()
		.min(1)
		.max(1024)
		.parse(props.capacity ?? 128);
	const contexts = new Map<string, BrowserNavigationContext>();
	return {
		create: (input) => {
			const identity = oauthBrowserSessionIdentitySchema.parse(input.identity);
			const target = oauthLoginContinuationTargetSchema.parse(input.target);
			const createdAtMs = now();
			for (const [id, entry] of contexts) if (entry.expiresAtMs <= createdAtMs) contexts.delete(id);
			if (contexts.size >= capacity) return { kind: 'capacity-exhausted' };
			const contextId = createOAuthOpaqueIdentifier();
			const entry = {
				identity,
				target,
				browserBindingSecret: createOAuthOpaqueIdentifier(),
				csrfToken: createOAuthOpaqueIdentifier(),
				expiresAtMs: createdAtMs + 10 * 60_000,
			};
			contexts.set(contextId, entry);
			return {
				kind: 'created',
				contextId,
				browserBindingSecret: entry.browserBindingSecret,
				csrfToken: entry.csrfToken,
				expiresAtMs: entry.expiresAtMs,
			};
		},
		read: (input) => {
			const entry = contexts.get(input.contextId);
			if (entry === undefined) return undefined;
			if (entry.expiresAtMs <= now()) {
				contexts.delete(input.contextId);
				return undefined;
			}
			if (
				!/^[A-Za-z0-9_-]{43}$/u.test(input.browserBindingSecret) ||
				!oauthBrowserSecretsEqual(entry.browserBindingSecret, input.browserBindingSecret)
			)
				return undefined;
			return structuredClone(entry);
		},
		cancelSession: (identity) => {
			for (const [id, entry] of contexts)
				if (
					entry.identity.issuer === identity.issuer &&
					entry.identity.userId === identity.userId &&
					entry.identity.sessionId === identity.sessionId
				)
					contexts.delete(id);
		},
		clear: (): void => contexts.clear(),
	};
}
