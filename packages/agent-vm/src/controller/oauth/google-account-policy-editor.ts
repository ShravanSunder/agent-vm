import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { googleOAuthApplicationIdSchema } from '@agent-vm/config-contracts';
import {
	createOAuthPolicyEnvelopeCodec,
	oauthPolicyEnvelopeBindingSchema,
	type OAuthCredentialCatalog,
	type OAuthKeyEncryptionKey,
} from '@agent-vm/oauth-broker';
import {
	googleAccountPolicySnapshotSchema,
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	oauthBrowserSessionIdentitySchema,
	type GoogleAccountPolicySnapshot,
	type OAuthBrowserIdentityVerification,
	type OAuthBrowserSessionIdentity,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import type {
	GoogleAccountPolicyView,
	GooglePermissionPolicyService,
} from './google-permission-policy-service.js';

const editorOpenSchema = z
	.object({
		agentId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
		accountId: oauthAccountIdSchema,
		applicationId: googleOAuthApplicationIdSchema.and(oauthApplicationIdSchema),
		identity: oauthBrowserSessionIdentitySchema,
	})
	.strict();
const opaqueSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const editorFormSchema = z
	.object({
		contextId: opaqueSecretSchema,
		browserBindingSecret: opaqueSecretSchema,
		csrfToken: opaqueSecretSchema,
		identity: oauthBrowserSessionIdentitySchema,
		origin: z.url().max(2048),
	})
	.strict();
const previewFormSchema = editorFormSchema
	.extend({
		expectedConfigRevision: z.string().min(1).max(256),
		expectedOverrideRevision: z.number().int().positive(),
		services: googleAccountPolicySnapshotSchema.shape.services,
	})
	.strict();
type ReadyPolicyView = Extract<GoogleAccountPolicyView, { kind: 'ready' }>;
type EditorFailure = {
	readonly kind:
		| 'denied'
		| 'unavailable'
		| 'expired'
		| 'conflict'
		| 'above-maximum'
		| 'capacity-exhausted';
};
type EditorMutationResult =
	| EditorFailure
	| {
			readonly kind: 'applied' | 'pending' | 'containment-failed';
			readonly overrideRevision: number;
	  };
interface PolicyEditorContext {
	readonly request: z.infer<typeof editorOpenSchema>;
	readonly browserBindingSecret: string;
	readonly expiresAtMs: number;
	readonly view: ReadyPolicyView;
	csrfToken: string;
	phase: 'editing' | 'checking' | 'preview';
	desiredServices?: GoogleAccountPolicySnapshot['services'];
}
export interface GooglePolicyContainmentTarget {
	readonly zoneId: string;
	readonly agentId: string;
	readonly accountId: GoogleAccountPolicySnapshot['accountId'];
	readonly applicationId: GoogleAccountPolicySnapshot['applicationId'];
	readonly authorizationId: GoogleAccountPolicySnapshot['authorizationId'];
	readonly throughGeneration: number;
	readonly throughOverrideRevision: number;
	readonly transitionId: string;
}
export interface GoogleAccountPolicyEditor {
	drain(): Promise<void>;
	cancelBrowserPolicyContexts(identity: OAuthBrowserSessionIdentity): void;
	openPolicyEditor(request: unknown): Promise<
		| EditorFailure
		| {
				readonly kind: 'opened';
				readonly contextId: string;
				readonly browserBindingSecret: string;
				readonly csrfToken: string;
				readonly expiresAtMs: number;
				readonly view: ReadyPolicyView;
		  }
	>;
	previewPolicyChange(request: unknown): Promise<
		| EditorFailure
		| {
				readonly kind: 'preview';
				readonly contextId: string;
				readonly csrfToken: string;
				readonly before: GoogleAccountPolicySnapshot['services'];
				readonly after: GoogleAccountPolicySnapshot['services'];
				readonly defaults: ReadyPolicyView['defaults'];
				readonly view: ReadyPolicyView;
		  }
	>;
	confirmPolicyChange(request: unknown): Promise<EditorMutationResult>;
	clear(): void;
}
export interface GoogleAccountPolicyEditorProps {
	readonly runAuthorityCommit?: <TResult>(commit: () => TResult) => Promise<TResult>;
	readonly catalog: OAuthCredentialCatalog;
	readonly readAccountPolicyView: GooglePermissionPolicyService['readAccountPolicyView'];
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly websiteOrigin: string;
	readonly verifySession: (
		identity: OAuthBrowserSessionIdentity,
	) => Promise<OAuthBrowserIdentityVerification>;
	readonly containPolicyMaterial: (
		target: GooglePolicyContainmentTarget,
	) => Promise<'contained' | 'pending' | 'failed'>;
	readonly now?: () => number;
}

function freshSecret(): string {
	return randomBytes(32).toString('base64url');
}
function sameSecret(left: string, right: string): boolean {
	return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function validateDesiredServices(
	view: ReadyPolicyView,
	services: GoogleAccountPolicySnapshot['services'],
): boolean {
	if (
		!isDeepStrictEqual(
			Object.keys(view.snapshot.services).toSorted(),
			Object.keys(services).toSorted(),
		)
	)
		return false;
	for (const [serviceId, cells] of Object.entries(services)) {
		for (const effect of ['read', 'write'] as const) {
			const cell = cells[effect];
			if (
				cell.kind === 'explicit' &&
				cell.disposition !== 'deny' &&
				!view.maximums[serviceId]?.includes(effect)
			)
				return false;
		}
	}
	return true;
}

/** Bounded website-only drafts. No timer, provider grant mutation, runtime lock or policy fallback. */
export function createGoogleAccountPolicyEditor(
	props: GoogleAccountPolicyEditorProps,
): GoogleAccountPolicyEditor {
	const now = props.now ?? Date.now;
	const contexts = new Map<string, PolicyEditorContext>();
	const inFlight = new Set<Promise<unknown>>();
	let stopped = false;
	const track = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		if (stopped) throw new Error('Account policy editor is stopped.');
		const running = operation();
		inFlight.add(running);
		try {
			return await running;
		} finally {
			inFlight.delete(running);
		}
	};
	const codec = createOAuthPolicyEnvelopeCodec({
		payloadSchema: googleAccountPolicySnapshotSchema,
	});
	const encrypt = (snapshot: GoogleAccountPolicySnapshot): ReturnType<typeof codec.encrypt> =>
		codec.encrypt({
			binding: oauthPolicyEnvelopeBindingSchema.strip().parse(snapshot),
			payload: snapshot,
			keyEncryptionKey: props.keyEncryptionKey,
			keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
		});
	const verifiedSession = async (identity: OAuthBrowserSessionIdentity): Promise<boolean> => {
		try {
			const result = await props.verifySession(identity);
			return result.kind === 'verified' && isDeepStrictEqual(result.identity, identity);
		} catch {
			return false;
		}
	};
	const prune = (): void => {
		for (const [id, context] of contexts) if (context.expiresAtMs <= now()) contexts.delete(id);
	};
	const matchingContext = (
		request: z.infer<typeof editorFormSchema>,
	): PolicyEditorContext | undefined => {
		const context = contexts.get(request.contextId);
		return context !== undefined &&
			request.origin === props.websiteOrigin &&
			isDeepStrictEqual(request.identity, context.request.identity) &&
			sameSecret(request.browserBindingSecret, context.browserBindingSecret) &&
			sameSecret(request.csrfToken, context.csrfToken)
			? context
			: undefined;
	};
	const currentView = (context: PolicyEditorContext): ReadyPolicyView | EditorFailure => {
		if (context.expiresAtMs <= now()) return { kind: 'expired' };
		const view = props.readAccountPolicyView(context.request);
		if (view.kind !== 'ready') return view;
		if (!view.canEdit) return { kind: 'denied' };
		if (
			view.snapshot.state !== 'active' ||
			view.snapshot.overrideRevision !== context.view.snapshot.overrideRevision ||
			view.configRevision !== context.view.configRevision ||
			view.defaultsRevision !== context.view.defaultsRevision ||
			!isDeepStrictEqual(view.snapshot, context.view.snapshot)
		)
			return { kind: 'conflict' };
		return view;
	};
	const editor: GoogleAccountPolicyEditor = {
		drain: async (): Promise<void> => {
			stopped = true;
			contexts.clear();
			await Promise.allSettled(inFlight);
			contexts.clear();
		},
		cancelBrowserPolicyContexts: (identity): void => {
			for (const [id, context] of contexts)
				if (isDeepStrictEqual(context.request.identity, identity)) contexts.delete(id);
		},
		clear: (): void => contexts.clear(),
		openPolicyEditor: async (request) => {
			const parsed = editorOpenSchema.safeParse(request);
			if (!parsed.success) return { kind: 'denied' };
			prune();
			if (contexts.size >= 128) return { kind: 'capacity-exhausted' };
			const view = props.readAccountPolicyView(parsed.data);
			if (view.kind !== 'ready') return view;
			if (!view.canEdit) return { kind: 'denied' };
			if (view.snapshot.state !== 'active') return { kind: 'conflict' };
			prune();
			if (contexts.size >= 128) return { kind: 'capacity-exhausted' };
			const contextId = freshSecret();
			const context: PolicyEditorContext = {
				request: parsed.data,
				view,
				browserBindingSecret: freshSecret(),
				csrfToken: freshSecret(),
				expiresAtMs: now() + 10 * 60_000,
				phase: 'checking',
			};
			contexts.set(contextId, context);
			if (!(await verifiedSession(parsed.data.identity)) || contexts.get(contextId) !== context) {
				contexts.delete(contextId);
				return { kind: 'denied' };
			}
			const current = currentView(context);
			if (current.kind !== 'ready') {
				contexts.delete(contextId);
				return current;
			}
			context.phase = 'editing';
			return {
				kind: 'opened',
				contextId,
				browserBindingSecret: context.browserBindingSecret,
				csrfToken: context.csrfToken,
				expiresAtMs: context.expiresAtMs,
				view: structuredClone(view),
			};
		},
		previewPolicyChange: async (request) => {
			const parsed = previewFormSchema.safeParse(request);
			if (!parsed.success) return { kind: 'denied' };
			const input = parsed.data;
			const context = matchingContext(input);
			if (context === undefined || context.phase !== 'editing') return { kind: 'denied' };
			context.phase = 'checking';
			if (!(await verifiedSession(input.identity))) {
				contexts.delete(input.contextId);
				return { kind: 'denied' };
			}
			if (contexts.get(input.contextId) !== context) return { kind: 'denied' };
			const view = currentView(context);
			if (view.kind !== 'ready') {
				contexts.delete(input.contextId);
				return view;
			}
			if (
				input.expectedConfigRevision !== view.configRevision ||
				input.expectedOverrideRevision !== view.snapshot.overrideRevision
			) {
				contexts.delete(input.contextId);
				return { kind: 'conflict' };
			}
			if (!validateDesiredServices(view, input.services)) {
				context.phase = 'editing';
				return { kind: 'above-maximum' };
			}
			context.desiredServices = input.services;
			context.csrfToken = freshSecret();
			context.phase = 'preview';
			return {
				kind: 'preview',
				contextId: input.contextId,
				csrfToken: context.csrfToken,
				before: structuredClone(view.snapshot.services),
				after: structuredClone(input.services),
				defaults: structuredClone(view.defaults),
				view: structuredClone(view),
			};
		},
		confirmPolicyChange: async (request): Promise<EditorMutationResult> => {
			const parsed = editorFormSchema.safeParse(request);
			if (!parsed.success) return { kind: 'denied' };
			const input = parsed.data;
			const context = matchingContext(input);
			if (
				context === undefined ||
				context.phase !== 'preview' ||
				context.desiredServices === undefined
			)
				return { kind: 'denied' };
			context.phase = 'checking';
			if (!(await verifiedSession(input.identity))) {
				contexts.delete(input.contextId);
				return { kind: 'denied' };
			}
			if (contexts.get(input.contextId) !== context) return { kind: 'denied' };
			contexts.delete(input.contextId);
			const view = currentView(context);
			if (view.kind !== 'ready') return view;
			if (!validateDesiredServices(view, context.desiredServices)) return { kind: 'above-maximum' };
			const before = view.snapshot;
			const authorization = props.catalog.getAuthorization(before.authorizationId);
			if (authorization === undefined) return { kind: 'unavailable' };
			const after = googleAccountPolicySnapshotSchema.parse({
				...before,
				services: context.desiredServices,
				state: 'applying',
				overrideRevision: before.overrideRevision + 1,
				lastEditor: before.owner,
				lastEditedAtMs: now(),
			});
			let saved: ReturnType<OAuthCredentialCatalog['saveAccountPolicy']>;
			try {
				const commit = (): ReturnType<OAuthCredentialCatalog['saveAccountPolicy']> =>
					props.catalog.saveAccountPolicy({
						before,
						after,
						envelope: encrypt(after),
						expectedDefaultsRevision: view.defaultsRevision,
					});
				saved =
					props.runAuthorityCommit === undefined
						? commit()
						: await props.runAuthorityCommit(commit);
			} catch {
				return { kind: 'unavailable' };
			}
			if (saved.kind !== 'updated')
				return {
					kind:
						saved.kind === 'owner-mismatch'
							? 'denied'
							: saved.kind === 'unavailable'
								? 'unavailable'
								: 'conflict',
				};
			let containment: 'contained' | 'pending' | 'failed';
			try {
				containment = await props.containPolicyMaterial({
					zoneId: before.zoneId,
					agentId: before.agentId,
					accountId: before.accountId,
					applicationId: before.applicationId,
					authorizationId: before.authorizationId,
					throughGeneration: authorization.generation,
					throughOverrideRevision: before.overrideRevision,
					transitionId: saved.policy.transitionId,
				});
			} catch {
				containment = 'failed';
			}
			if (containment !== 'contained') {
				try {
					const recorded = props.catalog.recordAccountPolicyContainment({
						snapshot: after,
						expectedTransitionId: saved.policy.transitionId,
						result: containment,
					});
					if (recorded.kind !== 'updated')
						return { kind: 'pending', overrideRevision: after.overrideRevision };
				} catch {
					return { kind: 'pending', overrideRevision: after.overrideRevision };
				}
				return {
					kind: containment === 'pending' ? 'pending' : 'containment-failed',
					overrideRevision: after.overrideRevision,
				};
			}
			const active = googleAccountPolicySnapshotSchema.parse({ ...after, state: 'active' });
			try {
				const activated = props.catalog.activateAccountPolicy({
					before: after,
					after: active,
					envelope: encrypt(active),
					expectedTransitionId: saved.policy.transitionId,
				});
				return {
					kind: activated.kind === 'updated' ? 'applied' : 'pending',
					overrideRevision: after.overrideRevision,
				};
			} catch {
				return { kind: 'pending', overrideRevision: after.overrideRevision };
			}
		},
	};
	return {
		...editor,
		openPolicyEditor: (request) => track(() => editor.openPolicyEditor(request)),
		previewPolicyChange: (request) => track(() => editor.previewPolicyChange(request)),
		confirmPolicyChange: (request) => track(() => editor.confirmPolicyChange(request)),
	};
}
