import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	type OAuthPermissionSelections,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
} from './google-broker-facade-test-fixture.js';
import {
	type GoogleOAuthRedirectResult,
	type GoogleOAuthConfirmationResult,
} from './google-oauth-broker-contracts.js';

const bothSelections = oauthPermissionSelectionsSchema.parse({
	'gmail-app': ['gmail.read'],
	'workspace-app': ['drive.all-files.read'],
});
describe('Google OAuth broker enrollment ceremonies', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	async function beginSelections(selections: OAuthPermissionSelections): Promise<{
		readonly transactionId: OAuthTransactionId;
		readonly redirect: GoogleOAuthRedirectResult;
	}> {
		if (fixture === undefined) throw new Error('Expected test fixture.');
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected begin.');
		const page = fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		const redirect = fixture.broker.submitPermissions({
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections,
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected consent redirect.');
		return { transactionId: begun.transactionId, redirect };
	}
	async function confirmRedirect(
		redirect: GoogleOAuthRedirectResult,
	): Promise<GoogleOAuthConfirmationResult> {
		if (fixture === undefined) throw new Error('Expected fixture.');
		const callback = await fixture.exchangeRedirect(redirect);
		if (callback.kind !== 'confirmation') throw new Error('Expected confirmation.');
		return await fixture.confirm(callback.confirmation);
	}

	it('runs a Clerk-bound enrollment, advertises verified metadata and resolves only admitted credential material', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		// Act
		const completed = await fixture.enroll();
		const listed = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.list' },
		});
		const read = await fixture.broker.resolveRuntimeCredential({
			agentId: 'sun',
			accountId: completed.accountId,
			applicationId: facadeApplicationId,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		});
		const write = await fixture.broker.resolveRuntimeCredential({
			agentId: 'sun',
			accountId: completed.accountId,
			applicationId: facadeApplicationId,
			operationId: 'gmail.send',
			gmailWriteAllowed: true,
		});
		// Assert
		expect(listed).toMatchObject({
			kind: 'authorization-list',
			accounts: [
				{ applications: [{ metadata: { kind: 'verified', accountAlias: 'sun mailbox' } }] },
			],
		});
		expect(JSON.stringify(listed)).not.toMatch(/synthetic-(access|refresh)/u);
		expect(read).toMatchObject({
			kind: 'ready',
			allowedHosts: ['gmail.googleapis.com'],
			gmailNoSend: true,
		});
		expect(write.kind).toBe('unavailable');
	});

	it('permits an explicitly confirmed scope reduction using a new credential, never provider revocation', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const first = await beginSelections(
			oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read', 'gmail.write'] }),
		);
		const initial = await confirmRedirect(first.redirect);
		if (initial.kind !== 'completed') throw new Error('Expected initial grant.');
		const before = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0];
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountId: initial.accountId,
				applicationId: facadeApplicationId,
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected reauthorization.');
		const page = fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		expect(page.applications[0]?.selectedGroupIds).toContain('gmail.write');
		const redirect = fixture.broker.submitPermissions({
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
			selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
		});
		if (redirect.kind !== 'redirect') throw new Error('Expected narrower consent.');
		// Act
		expect((await confirmRedirect(redirect)).kind).toBe('completed');
		// Assert
		const after = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0];
		expect(after?.grantedScopes).not.toContain('https://www.googleapis.com/auth/gmail.modify');
		expect(after?.credentialId).not.toBe(before?.credentialId);
		expect(after?.generation).toBe(2);
		expect(fixture.providerRequests.some((url) => url.includes('revoke'))).toBe(false);
	});

	it('continues the same public ceremony across two applications for the same subject', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({ includeDocuments: true });
		const first = await beginSelections(bothSelections);
		// Act
		const next = await confirmRedirect(first.redirect);
		if (next.kind !== 'redirect') throw new Error('Expected second application.');
		expect(next.applications).toMatchObject([
			{ applicationId: 'gmail-app', status: 'completed' },
			{ applicationId: 'workspace-app', status: 'authorizing' },
		]);
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: first.transactionId },
			}),
		).toEqual({ kind: 'authorization-pending', transactionId: first.transactionId });
		expect((await confirmRedirect(next)).kind).toBe('completed');
		// Assert
		const grants = fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' });
		expect(grants).toHaveLength(2);
		expect(new Set(grants.map((grant) => grant.accountId)).size).toBe(1);
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: first.transactionId },
			}),
		).toMatchObject({ kind: 'authorization-completed' });
	});

	it('retains the committed first app and reports failure when the next app cannot start', async () => {
		// Arrange
		let calls = 0;
		fixture = await createBrokerFacadeFixture({
			includeDocuments: true,
			transformAdapter: (adapter) => ({
				...adapter,
				buildAuthorizationUrl: (request) => {
					if (++calls === 2) throw new Error('next app failed');
					return adapter.buildAuthorizationUrl(request);
				},
			}),
		});
		const first = await beginSelections(bothSelections);
		// Act
		await expect(confirmRedirect(first.redirect)).rejects.toThrow('next app failed');
		// Assert
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: first.transactionId },
			}),
		).toEqual({ kind: 'authorization-failed', failure: { kind: 'unavailable' } });
	});

	it('cancels a later application through the original public ceremony ID without removing completed grants', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture({ includeDocuments: true });
		const first = await beginSelections(bothSelections);
		const next = await confirmRedirect(first.redirect);
		if (next.kind !== 'redirect') throw new Error('Expected second application.');
		// Act
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.cancel', transactionId: first.transactionId },
			}),
		).toEqual({ kind: 'authorization-cancelled' });
		// Assert
		expect((await fixture.exchangeRedirect(next)).kind).toBe('failed');
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
	});

	it('preserves completed grants and creates a session-bound retry after a later provider failure', async () => {
		// Arrange
		let exchanges = 0;
		fixture = await createBrokerFacadeFixture({
			includeDocuments: true,
			transformAdapter: (adapter) => ({
				...adapter,
				exchangeAuthorizationCode: async (request) =>
					++exchanges === 2
						? { kind: 'failed', failure: { kind: 'provider-unavailable', retryable: true } }
						: await adapter.exchangeAuthorizationCode(request),
			}),
		});
		const first = await beginSelections(bothSelections);
		const next = await confirmRedirect(first.redirect);
		if (next.kind !== 'redirect') throw new Error('Expected second app.');
		// Act
		const partial = await fixture.exchangeRedirect(next);
		// Assert
		if (partial.kind !== 'partial-completion') throw new Error('Expected retry.');
		expect(partial.completed).toEqual(['gmail-app']);
		expect(partial.retryable).toEqual(['workspace-app']);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(() =>
			fixture?.broker.retryApplication({
				identity: { ...facadeIdentity, sessionId: 'other' },
				transactionId: partial.retry.transactionId,
				browserBindingSecret: partial.retry.browserBindingSecret,
				csrfToken: partial.retryCsrfToken,
			}),
		).toThrow();
		expect(
			fixture.broker.retryApplication({
				identity: facadeIdentity,
				transactionId: partial.retry.transactionId,
				browserBindingSecret: partial.retry.browserBindingSecret,
				csrfToken: partial.retryCsrfToken,
			}),
		).toMatchObject({ kind: 'redirect', transactionId: partial.retry.transactionId });
		expect((await confirmRedirect(partial.retry)).kind).toBe('completed');
	});

	it('creates a fresh link after expiry and refuses the old ceremony', async () => {
		// Arrange
		let now = 1_000;
		fixture = await createBrokerFacadeFixture({ now: () => now });
		const first = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (first.kind !== 'authorization-begun') throw new Error('Expected link.');
		// Act
		now += 660_000;
		const second = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		// Assert
		expect(second).toMatchObject({ kind: 'authorization-begun' });
		if (second.kind !== 'authorization-begun') throw new Error('Expected fresh link.');
		expect(second.transactionId).not.toBe(first.transactionId);
		expect(() =>
			fixture?.broker.getPermissionPage({
				identity: facadeIdentity,
				transactionId: first.transactionId,
			}),
		).toThrow();
	});

	it('treats Off as no selection rather than a grant or implicit disconnect', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const connected = await fixture.enroll();
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: {
				actionId: 'oauth_authorization.reauthorize',
				accountId: connected.accountId,
				applicationId: oauthApplicationIdSchema.parse('gmail-app'),
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected ceremony.');
		const page = fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		// Act
		expect(
			fixture.broker.submitPermissions({
				identity: facadeIdentity,
				transactionId: page.transactionId,
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				selections: oauthPermissionSelectionsSchema.parse({}),
			}),
		).toEqual({ kind: 'no-selections' });
		// Assert
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: begun.transactionId },
			}),
		).toEqual({ kind: 'authorization-cancelled' });
	});
});
