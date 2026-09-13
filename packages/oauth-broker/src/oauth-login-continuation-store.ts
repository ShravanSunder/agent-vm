import {
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	oauthBrowserSessionIdentitySchema,
	oauthTransactionIdSchema,
	type OAuthBrowserSessionIdentity,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { createOAuthOpaqueIdentifier, oauthBrowserSecretsEqual } from './oauth-browser-security.js';

export const oauthLoginContinuationTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('agents') }).strict(),
	z
		.object({
			kind: z.literal('account'),
			agentId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
			accountId: oauthAccountIdSchema,
			applicationId: oauthApplicationIdSchema.optional(),
		})
		.strict(),
	z.object({ kind: z.literal('authorization'), transactionId: oauthTransactionIdSchema }).strict(),
]);
export type OAuthLoginContinuationTarget = z.infer<typeof oauthLoginContinuationTargetSchema>;
interface LoginContinuation {
	readonly expectedIdentity?: Pick<OAuthBrowserSessionIdentity, 'issuer' | 'userId'>;
	readonly target: OAuthLoginContinuationTarget;
	readonly browserBindingSecret: string;
	readonly expiresAtMs: number;
	readonly redirectCount: number;
}
export type OAuthLoginContinuationCreation =
	| { readonly kind: 'capacity-exhausted' }
	| {
			readonly kind: 'created';
			readonly continuationId: string;
			readonly browserBindingSecret: string;
			readonly expiresAtMs: number;
	  };
export type OAuthLoginContinuationConsumption =
	| { readonly kind: 'missing' | 'expired' | 'browser-mismatch' | 'identity-mismatch' }
	| {
			readonly kind: 'accepted';
			readonly target: OAuthLoginContinuationTarget;
			readonly identity: OAuthBrowserSessionIdentity;
	  };

export interface OAuthLoginContinuationStore {
	isActive(props: {
		readonly continuationId: string;
		readonly browserBindingSecret: string;
	}): boolean;
	bindExpectedIdentity(props: {
		readonly continuationId: string;
		readonly browserBindingSecret: string;
		readonly identity: OAuthBrowserSessionIdentity;
	}): boolean;
	acceptRedirect(props: {
		readonly continuationId: string;
		readonly browserBindingSecret: string;
	}): boolean;
	create(target: unknown): OAuthLoginContinuationCreation;
	consume(props: {
		readonly continuationId: string;
		readonly browserBindingSecret: string;
		readonly identity: OAuthBrowserSessionIdentity;
	}): OAuthLoginContinuationConsumption;
	clear(): void;
}

export function createOAuthLoginContinuationStore(
	props: { readonly now?: () => number; readonly capacity?: number } = {},
): OAuthLoginContinuationStore {
	const now = props.now ?? Date.now;
	const capacity = z
		.number()
		.int()
		.min(1)
		.max(1024)
		.parse(props.capacity ?? 128);
	const continuations = new Map<string, LoginContinuation>();
	const readActive = (request: {
		readonly continuationId: string;
		readonly browserBindingSecret: string;
	}): LoginContinuation | undefined => {
		const entry = continuations.get(request.continuationId);
		if (
			entry === undefined ||
			entry.expiresAtMs <= now() ||
			!/^[A-Za-z0-9_-]{43}$/u.test(request.browserBindingSecret) ||
			!oauthBrowserSecretsEqual(entry.browserBindingSecret, request.browserBindingSecret)
		)
			return undefined;
		return entry;
	};
	return {
		isActive: (request) => readActive(request) !== undefined,
		bindExpectedIdentity: (request) => {
			const entry = readActive(request);
			const identity = oauthBrowserSessionIdentitySchema.safeParse(request.identity);
			if (entry === undefined || !identity.success) return false;
			if (
				entry.expectedIdentity !== undefined &&
				(entry.expectedIdentity.issuer !== identity.data.issuer ||
					entry.expectedIdentity.userId !== identity.data.userId)
			)
				return false;
			continuations.set(request.continuationId, {
				...entry,
				expectedIdentity: { issuer: identity.data.issuer, userId: identity.data.userId },
			});
			return true;
		},
		acceptRedirect: (request) => {
			const entry = continuations.get(request.continuationId);
			if (
				entry === undefined ||
				!/^[A-Za-z0-9_-]{43}$/u.test(request.browserBindingSecret) ||
				!oauthBrowserSecretsEqual(entry.browserBindingSecret, request.browserBindingSecret)
			)
				return false;
			if (entry.expiresAtMs <= now() || entry.redirectCount >= 5) {
				continuations.delete(request.continuationId);
				return false;
			}
			continuations.set(request.continuationId, {
				...entry,
				redirectCount: entry.redirectCount + 1,
			});
			return true;
		},
		create: (target) => {
			const parsedTarget = oauthLoginContinuationTargetSchema.parse(target);
			const createdAtMs = now();
			for (const [id, entry] of continuations)
				if (entry.expiresAtMs <= createdAtMs) continuations.delete(id);
			if (continuations.size >= capacity) return { kind: 'capacity-exhausted' };
			const continuationId = createOAuthOpaqueIdentifier();
			if (continuations.has(continuationId))
				throw new Error('OAuth continuation identity collision.');
			const browserBindingSecret = createOAuthOpaqueIdentifier();
			const expiresAtMs = createdAtMs + 10 * 60_000;
			continuations.set(continuationId, {
				redirectCount: 0,
				target: parsedTarget,
				browserBindingSecret,
				expiresAtMs,
			});
			return { kind: 'created', continuationId, browserBindingSecret, expiresAtMs };
		},
		consume: (request) => {
			const entry = continuations.get(request.continuationId);
			if (entry === undefined) return { kind: 'missing' };
			if (entry.expiresAtMs <= now()) {
				continuations.delete(request.continuationId);
				return { kind: 'expired' };
			}
			if (
				!/^[A-Za-z0-9_-]{43}$/u.test(request.browserBindingSecret) ||
				!oauthBrowserSecretsEqual(entry.browserBindingSecret, request.browserBindingSecret)
			) {
				return { kind: 'browser-mismatch' };
			}
			const identity = oauthBrowserSessionIdentitySchema.parse(request.identity);
			if (
				entry.expectedIdentity !== undefined &&
				(entry.expectedIdentity.issuer !== identity.issuer ||
					entry.expectedIdentity.userId !== identity.userId)
			)
				return { kind: 'identity-mismatch' };
			continuations.delete(request.continuationId);
			return { kind: 'accepted', target: structuredClone(entry.target), identity };
		},
		clear: () => continuations.clear(),
	};
}
