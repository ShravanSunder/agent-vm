import { oauthPermissionSelectionsSchema } from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
} from './google-broker-facade-test-fixture.js';

describe('account-based Google broker facade', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	it('admits neither ceremonies nor credential use before the host opens admission', async () => {
		// Arrange
		let admissionOpen = false;
		fixture = await createBrokerFacadeFixture({ isAdmissionOpen: () => admissionOpen });
		// Act / Assert
		await expect(
			fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
			}),
		).rejects.toThrow(/admission/u);
		expect(fixture.providerRequests).toEqual([]);
		admissionOpen = true;
		const enrolled = await fixture.enroll();
		admissionOpen = false;
		await expect(
			fixture.broker.resolveRuntimeCredential({
				accountId: enrolled.accountId,
				agentId: 'sun',
				applicationId: facadeApplicationId,
				operationId: 'gmail.search',
				gmailWriteAllowed: false,
			}),
		).rejects.toThrow(/admission/u);
	});

	it('runs the full begin, consent, callback, confirmation, status and credential path for two agents', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		// Act
		const sun = await fixture.enroll('sun');
		const ember = await fixture.enroll('ember');
		const material = await fixture.broker.resolveRuntimeCredential({
			accountId: ember.accountId,
			agentId: 'ember',
			applicationId: facadeApplicationId,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		});
		// Assert
		expect(sun.accountId).toBe(ember.accountId);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'ember', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(material).toMatchObject({ kind: 'ready', gmailNoSend: true });
		const listing = await fixture.broker.executeAuthorizationAction({
			agentId: 'ember',
			request: { actionId: 'oauth_authorization.list' },
		});
		expect(listing).toMatchObject({
			kind: 'authorization-list',
			accounts: [
				{
					accountId: ember.accountId,
					applications: [{ metadata: { kind: 'verified', accountAlias: 'ember mailbox' } }],
				},
			],
		});
		expect(JSON.stringify(listing)).not.toContain('synthetic-refresh');
	});

	it('requires owner confirmation for local disconnect and preserves the other agent grant', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const sun = await fixture.enroll('sun');
		await fixture.enroll('ember');
		const providerRequestCount = fixture.providerRequests.length;
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: {
				actionId: 'oauth_authorization.disconnect',
				accountId: sun.accountId,
				applicationId: facadeApplicationId,
			},
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected owner ceremony.');
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
		const page = fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		// Act
		const result = await fixture.broker.confirmDisconnect({
			identity: facadeIdentity,
			transactionId: page.transactionId,
			browserBindingSecret: page.browserBindingSecret,
			csrfToken: page.csrfToken,
		});
		// Assert
		expect(result).toEqual({
			kind: 'authorization-disconnected',
			accountId: sun.accountId,
			applicationId: facadeApplicationId,
		});
		expect(fixture.providerRequests).toHaveLength(providerRequestCount);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(0);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'ember', zoneId: 'test-zone' }),
		).toHaveLength(1);
		expect(fixture.containments).toHaveLength(1);
	});

	it('keeps website-initiated ceremonies inaccessible to agent status and cancel', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const begun = fixture.broker.beginWebsiteAuthorization({
			identity: facadeIdentity,
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected website ceremony.');
		// Act / Assert
		const broker = fixture.broker;
		const results = await Promise.all(
			['oauth_authorization.status', 'oauth_authorization.cancel'].map((actionId) =>
				broker.executeAuthorizationAction({
					agentId: 'sun',
					request: {
						actionId:
							actionId === 'oauth_authorization.status'
								? 'oauth_authorization.status'
								: 'oauth_authorization.cancel',
						transactionId: begun.transactionId,
					},
				}),
			),
		);
		expect(results.every((result) => result.kind === 'authorization-failed')).toBe(true);
		expect(
			fixture.broker.getPermissionPage({
				identity: facadeIdentity,
				transactionId: begun.transactionId,
			}).agentId,
		).toBe('sun');
	});

	it('rejects wrong humans, sessions, and above-ceiling selections before Google exchange', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'ember',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected ceremony.');
		expect(() =>
			fixture?.broker.getPermissionPage({
				identity: { ...facadeIdentity, userId: 'other' },
				transactionId: begun.transactionId,
			}),
		).toThrow();
		const page = fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		// Act / Assert
		expect(() =>
			fixture?.broker.submitPermissions({
				identity: { ...facadeIdentity, sessionId: 'other' },
				transactionId: page.transactionId,
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				selections: {},
			}),
		).toThrow();
		expect(page.applications[0]?.selectedGroupIds).toEqual(['gmail.read']);
		expect(() =>
			fixture?.broker.submitPermissions({
				identity: facadeIdentity,
				transactionId: page.transactionId,
				browserBindingSecret: page.browserBindingSecret,
				csrfToken: page.csrfToken,
				selections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.write'] }),
			}),
		).toThrow();
		expect(fixture.providerRequests).toHaveLength(0);
	});

	it('rejects old material at final dispatch after disconnect or account mismatch', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const enrolled = await fixture.enroll('sun');
		const request = {
			accountId: enrolled.accountId,
			agentId: 'sun',
			applicationId: facadeApplicationId,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		};
		const material = await fixture.broker.resolveRuntimeCredential(request);
		if (material.kind !== 'ready') throw new Error('Expected current read credential.');
		const binding = {
			accountId: material.accountId,
			authorizationId: material.authorizationId,
			generation: material.generation,
			authorizationMetadataRevision: material.authorizationMetadataRevision,
			credentialId: material.credentialId,
			materialRevision: material.materialRevision,
		};
		expect(fixture.broker.validateRuntimeCredentialSnapshot({ ...request, ...binding }).kind).toBe(
			'current',
		);
		// Act
		const stored = fixture.catalog.getGrant(material.credentialId);
		if (stored === undefined) throw new Error('Expected stored grant.');
		expect(
			fixture.catalog.disconnectAuthorization({
				authorizationId: stored.authorizationId,
				expectedRecordRevision: stored.recordRevision,
				owner: stored.owner,
			}).kind,
		).toBe('updated');
		// Assert
		expect(fixture.broker.validateRuntimeCredentialSnapshot({ ...request, ...binding }).kind).toBe(
			'stale',
		);
		expect((await fixture.broker.resolveRuntimeCredential(request)).kind).toBe('unavailable');
		expect(
			(await fixture.broker.resolveRuntimeCredential({ ...request, agentId: 'ember' })).kind,
		).toBe('unavailable');
	});

	it('does not admit undeclared or unconsented operations from a valid account credential', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll('ember');
		const count = fixture.providerRequests.length;
		// Act
		const result = await fixture.broker.resolveRuntimeCredential({
			accountId: account.accountId,
			agentId: 'ember',
			applicationId: facadeApplicationId,
			operationId: 'gmail.send',
			gmailWriteAllowed: true,
		});
		// Assert
		expect(result.kind).toBe('unavailable');
		expect(fixture.providerRequests).toHaveLength(count);
	});

	it('updates public status when a browser switch cancels an agent-originated ceremony', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		const begun = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.begin', applicationId: facadeApplicationId },
		});
		if (begun.kind !== 'authorization-begun') throw new Error('Expected ceremony.');
		fixture.broker.getPermissionPage({
			identity: facadeIdentity,
			transactionId: begun.transactionId,
		});
		// Act
		expect(fixture.broker.cancelBrowserCeremonies(facadeIdentity)).toBe(1);
		// Assert
		expect(
			await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.status', transactionId: begun.transactionId },
			}),
		).toEqual({ kind: 'authorization-cancelled' });
	});

	it('keeps authenticated consent visible after a ceiling reduction but does not advertise execution', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		await fixture.enroll('sun');
		const before = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.list' },
		});
		if (before.kind !== 'authorization-list') throw new Error('Expected account list.');
		expect(
			before.accounts[0]?.applications[0]?.activities.find(
				(activity) => activity.operationId === 'gmail.send',
			)?.availability.kind,
		).toBe('consent-required');
		const sun = fixture.config.agents.sun;
		if (sun === undefined) throw new Error('Expected agent.');
		// Act
		sun.applications['gmail-app'] = { ceiling: { kind: 'explicit', groupIds: [] } };
		const after = await fixture.broker.executeAuthorizationAction({
			agentId: 'sun',
			request: { actionId: 'oauth_authorization.list' },
		});
		// Assert
		if (after.kind !== 'authorization-list') throw new Error('Expected account list.');
		expect(after.accounts[0]?.applications[0]?.metadata.kind).toBe('verified');
		expect(
			after.accounts[0]?.applications[0]?.activities.every(
				(activity) => activity.availability.kind === 'unavailable',
			),
		).toBe(true);
	});

	it('does not substitute another agent credential metadata while listing scoped authorizations', async () => {
		// Arrange
		fixture = await createBrokerFacadeFixture();
		await fixture.enroll('sun');
		await fixture.enroll('ember');
		const foreign = fixture.catalog.listGrantsForAgent({
			agentId: 'ember',
			zoneId: 'test-zone',
		})[0];
		if (foreign === undefined) throw new Error('Expected second agent grant.');
		const lookup = vi.spyOn(fixture.catalog, 'getGrant').mockReturnValue(foreign);
		try {
			// Act
			const listed = await fixture.broker.executeAuthorizationAction({
				agentId: 'sun',
				request: { actionId: 'oauth_authorization.list' },
			});
			// Assert
			if (listed.kind !== 'authorization-list') throw new Error('Expected account list.');
			expect(listed.accounts[0]?.applications[0]?.metadata).toMatchObject({
				kind: 'verified',
				accountAlias: 'sun mailbox',
			});
		} finally {
			lookup.mockRestore();
		}
	});
});
