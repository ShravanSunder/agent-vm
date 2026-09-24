import { compileOAuthPolicy } from '@agent-vm/config-contracts';
import {
	googleAccountPolicySnapshotSchema,
	oauthServiceIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	facadeIdentity,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { wrappingKey } from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import type { createGoogleAccountPolicyEditor } from './google-account-policy-editor.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';

describe('owner account policy preview, save and containment', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	async function arrange(distinctAccounts = false): Promise<{
		readonly reader: ReturnType<typeof createGooglePermissionPolicyService>;
		readonly editor: ReturnType<typeof createGoogleAccountPolicyEditor>;
		readonly opened: Extract<
			Awaited<ReturnType<ReturnType<typeof createGoogleAccountPolicyEditor>['openPolicyEditor']>>,
			{ kind: 'opened' }
		>;
		readonly compiled: ReturnType<typeof compileOAuthPolicy>;
		readonly contain: ReturnType<typeof vi.fn<() => Promise<'contained' | 'pending' | 'failed'>>>;
		readonly now: { value: number };
		readonly admission: { value: boolean };
		readonly authorityGate: { beforeCommit?: (() => void) | undefined };
	}> {
		let subjectSequence = 0;
		fixture = await createBrokerFacadeFixture({
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async (request) => {
					const result = await adapter.exchangeAuthorizationCode(request);
					return distinctAccounts && result.kind === 'authorized'
						? {
								...result,
								authorization: {
									...result.authorization,
									accountSubject: `separate-subject-${++subjectSequence}`,
								},
							}
						: result;
				},
			}),
		});
		const enrollment = await fixture.enroll();
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		fixture.catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const now = { value: 1_000 };
		const admission = { value: true };
		const authorityGate: { beforeCommit?: (() => void) | undefined } = {};
		const contain = vi.fn<() => Promise<'contained' | 'pending' | 'failed'>>(
			async () => 'contained',
		);
		const reader = createGooglePermissionPolicyService({
			runAuthorityCommit: async (commit) => {
				authorityGate.beforeCommit?.();
				return commit();
			},
			catalog: fixture.catalog,
			compiled,
			configRevision: 'config-1',
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			containPolicyMaterial: contain,
			now: () => now.value,
			isAdmissionOpen: () => admission.value,
			clientBindingRevisionsByApplication: {
				'gmail-app': 'client-binding-1',
				'workspace-app': 'client-binding-2',
				'youtube-app': 'client-binding-3',
			},
		});
		const editor = reader;
		const opened = await editor.openPolicyEditor({
			agentId: 'sun',
			accountId: enrollment.accountId,
			applicationId: 'gmail-app',
			identity: facadeIdentity,
		});
		if (opened.kind !== 'opened') throw new Error('Expected editable owner context.');
		return { reader, editor, opened, compiled, contain, now, admission, authorityGate };
	}
	function desiredReadDeny(
		snapshot: ReturnType<typeof googleAccountPolicySnapshotSchema.parse>,
	): typeof snapshot.services {
		return googleAccountPolicySnapshotSchema.parse({
			...snapshot,
			services: {
				...snapshot.services,
				gmail: { read: { kind: 'explicit', disposition: 'deny' }, write: { kind: 'inherit' } },
			},
		}).services;
	}
	it('changes only one of two accounts connected to the same agent', async () => {
		// Arrange
		const input = await arrange(true);
		if (fixture === undefined) throw new Error('Expected fixture.');
		const second = await fixture.enroll('sun');
		const draft = await preview(input);
		const target = {
			agentId: 'sun',
			applicationId: input.opened.view.snapshot.applicationId,
			operationId: 'gmail.search',
		};
		// Act
		const saved = await input.editor.confirmPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		});
		// Assert
		expect(saved.kind).toBe('applied');
		expect(second.accountId).not.toBe(input.opened.view.snapshot.accountId);
		expect(
			input.reader.resolveActivityAvailability({
				...target,
				accountId: input.opened.view.snapshot.accountId,
			}),
		).toEqual({ kind: 'denied' });
		expect(
			input.reader.resolveActivityAvailability({ ...target, accountId: second.accountId }),
		).toMatchObject({ kind: 'ready', disposition: 'allow', overrideRevision: 1 });
	});
	async function preview(
		input: Awaited<ReturnType<typeof arrange>>,
	): Promise<
		Extract<Awaited<ReturnType<typeof input.editor.previewPolicyChange>>, { kind: 'preview' }>
	> {
		const result = await input.editor.previewPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: input.opened.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: input.opened.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
			expectedConfigRevision: 'config-1',
			expectedOverrideRevision: 1,
			services: desiredReadDeny(input.opened.view.snapshot),
		});
		if (result.kind !== 'preview') throw new Error('Expected policy preview.');
		return result;
	}
	it('previews without mutation, saves only the selected account, and consumes confirmation once', async () => {
		// Arrange
		const input = await arrange();
		if (fixture === undefined) throw new Error('Expected fixture.');
		const sibling = await fixture.enroll('ember');
		const requestCount = fixture.providerRequests.length;
		const draft = await preview(input);
		const target = {
			accountId: sibling.accountId,
			applicationId: input.opened.view.snapshot.applicationId,
			operationId: 'gmail.search',
		};
		expect(input.reader.resolveActivityAvailability({ ...target, agentId: 'sun' }).kind).toBe(
			'ready',
		);
		const confirmation = {
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		};
		// Act
		const result = await input.editor.confirmPolicyChange(confirmation);
		// Assert
		expect(result).toMatchObject({ kind: 'applied', overrideRevision: 2 });
		expect(await input.editor.confirmPolicyChange(confirmation)).toEqual({ kind: 'denied' });
		expect(input.reader.resolveActivityAvailability({ ...target, agentId: 'sun' })).toEqual({
			kind: 'denied',
		});
		expect(input.reader.resolveActivityAvailability({ ...target, agentId: 'ember' })).toMatchObject(
			{ kind: 'ready', disposition: 'ask' },
		);
		expect(input.contain).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				authorizationId: input.opened.view.snapshot.authorizationId,
				accountId: sibling.accountId,
				agentId: 'sun',
				throughOverrideRevision: 1,
			}),
		);
		expect(fixture.providerRequests).toHaveLength(requestCount);
	});
	it('allows only one of two concurrent policy confirmations to commit', async () => {
		const input = await arrange();
		const draft = await preview(input);
		const confirmation = {
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		};

		const results = await Promise.all([
			input.editor.confirmPolicyChange(confirmation),
			input.editor.confirmPolicyChange(confirmation),
		]);

		expect(results.map((result) => result.kind).toSorted()).toEqual(['applied', 'denied']);
		expect(input.contain).toHaveBeenCalledOnce();
	});
	it('denies without mutation when admission closes inside the serialized commit', async () => {
		const input = await arrange();
		const draft = await preview(input);
		input.authorityGate.beforeCommit = () => {
			input.admission.value = false;
		};

		const result = await input.editor.confirmPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		});

		expect(result).toEqual({ kind: 'denied' });
		expect(input.contain).not.toHaveBeenCalled();
		expect(fixture?.catalog.getPolicy(input.opened.view.snapshot.authorizationId)).toMatchObject({
			overrideRevision: 1,
			state: 'active',
		});
	});
	it('returns expired when browser authority expires inside the serialized commit', async () => {
		const input = await arrange();
		const draft = await preview(input);
		input.authorityGate.beforeCommit = () => {
			input.now.value = 1_000_001;
		};

		const result = await input.editor.confirmPolicyChange({
			authenticationExpiresAtMs: 1_000_000,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		});

		expect(result).toEqual({ kind: 'expired' });
		expect(input.contain).not.toHaveBeenCalled();
	});
	it('rejects forged origin, session, browser secret and CSRF without changing policy', async () => {
		// Arrange
		const input = await arrange();
		const draft = await preview(input);
		const valid = {
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		};
		// Act / Assert
		for (const forged of [
			{ origin: 'https://attacker.example.test' },
			{ identity: { ...facadeIdentity, subject: 'another-subject' } },
			{ csrfToken: 'x'.repeat(43) },
			{ browserBindingSecret: 'x'.repeat(43) },
		]) {
			// oxlint-disable-next-line no-await-in-loop -- each forged form must independently leave the valid confirmation untouched.
			expect(await input.editor.confirmPolicyChange({ ...valid, ...forged })).toEqual({
				kind: 'denied',
			});
		}
		expect(input.contain).not.toHaveBeenCalled();
		expect(await input.editor.confirmPolicyChange(valid)).toMatchObject({ kind: 'applied' });
	});
	it('never activates a saved policy when containment is unconfirmed', async () => {
		// Arrange
		const input = await arrange();
		input.contain.mockResolvedValueOnce('pending');
		const draft = await preview(input);
		// Act
		const result = await input.editor.confirmPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		});
		// Assert
		expect(result).toMatchObject({ kind: 'pending', overrideRevision: 2 });
		expect(fixture?.catalog.getPolicy(input.opened.view.snapshot.authorizationId)?.state).toBe(
			'applying',
		);
		expect(
			fixture?.catalog.listAccountPolicyHistory(input.opened.view.snapshot.authorizationId),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'policy-containment-pending', newRevision: 2 }),
			]),
		);
	});
	it('rejects explicit access above the executable maximum even with owner consent', async () => {
		// Arrange
		const input = await arrange();
		const services = structuredClone(input.opened.view.snapshot.services);
		services[oauthServiceIdSchema.parse('gmail')] = {
			read: { kind: 'inherit' },
			write: { kind: 'explicit', disposition: 'allow' },
		};
		// Act
		const result = await input.editor.previewPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: input.opened.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: input.opened.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
			expectedConfigRevision: 'config-1',
			expectedOverrideRevision: 1,
			services,
		});
		// Assert
		expect(result).toEqual({ kind: 'above-maximum' });
		expect(input.contain).not.toHaveBeenCalled();
	});
	it('keeps the row fenced and records failure when runtime containment throws', async () => {
		// Arrange
		const input = await arrange();
		input.contain.mockRejectedValueOnce(new Error('Synthetic containment failure'));
		const draft = await preview(input);
		// Act
		const result = await input.editor.confirmPolicyChange({
			authenticationExpiresAtMs: Number.MAX_SAFE_INTEGER,
			contextId: draft.contextId,
			browserBindingSecret: input.opened.browserBindingSecret,
			csrfToken: draft.csrfToken,
			identity: facadeIdentity,
			origin: input.compiled.oauthConfig.browser.publicBaseUrl,
		});
		// Assert
		expect(result).toEqual({ kind: 'containment-failed', overrideRevision: 2 });
		expect(fixture?.catalog.getPolicy(input.opened.view.snapshot.authorizationId)?.state).toBe(
			'applying',
		);
		expect(
			fixture?.catalog.listAccountPolicyHistory(input.opened.view.snapshot.authorizationId),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'policy-containment-failed', state: 'applying' }),
			]),
		);
	});
});
