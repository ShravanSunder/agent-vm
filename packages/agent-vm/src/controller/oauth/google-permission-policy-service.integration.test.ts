import { compileOAuthPolicy, googleOAuthApplicationIdSchema } from '@agent-vm/config-contracts';
import {
	createOAuthPolicyEnvelopeCodec,
	oauthPolicyEnvelopeBindingSchema,
} from '@agent-vm/oauth-broker';
import {
	googleAccountPolicySnapshotSchema,
	oauthApplicationIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	facadeIdentity,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { wrappingKey } from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';

const facadeApplicationId = googleOAuthApplicationIdSchema
	.and(oauthApplicationIdSchema)
	.parse('gmail-app');

describe('host account policy and activity resolution', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	async function arrange(): Promise<{
		readonly service: ReturnType<typeof createGooglePermissionPolicyService>;
		readonly target: {
			readonly agentId: string;
			readonly accountId: Awaited<ReturnType<NonNullable<typeof fixture>['enroll']>>['accountId'];
			readonly applicationId: typeof facadeApplicationId;
		};
		readonly compiled: ReturnType<typeof compileOAuthPolicy>;
	}> {
		fixture = await createBrokerFacadeFixture();
		const enrolled = await fixture.enroll('sun');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		fixture.catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const service = createGooglePermissionPolicyService({
			catalog: fixture.catalog,
			compiled,
			configRevision: 'config-1',
			clientBindingRevisionsByApplication: {
				'gmail-app': 'client-binding-1',
				'workspace-app': 'client-binding-2',
				'youtube-app': 'client-binding-3',
			},
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			verifySession: async (identity) => ({ kind: 'verified', identity }),
			containPolicyMaterial: async () => 'contained',
			isAdmissionOpen: () => true,
		});
		return {
			service,
			compiled,
			target: { agentId: 'sun', accountId: enrolled.accountId, applicationId: facadeApplicationId },
		};
	}
	it('joins compiled defaults, real encrypted account policy and real broker enrollment without provider requests', async () => {
		// Arrange
		const { service, target, compiled } = await arrange();
		const requestCount = fixture?.providerRequests.length;
		// Act
		const view = service.readAccountPolicyView({ ...target, identity: facadeIdentity });
		const activity = service.resolveActivityAvailability({
			...target,
			operationId: 'gmail.search',
		});
		// Assert
		expect(view).toMatchObject({
			kind: 'ready',
			canEdit: true,
			snapshot: { overrideRevision: 1 },
			defaults: { gmail: { read: 'allow', write: 'deny' } },
			history: [],
		});
		expect(activity).toEqual({
			kind: 'ready',
			disposition: 'allow',
			overrideRevision: 1,
			defaultsRevision: compiled.defaultsRevision,
		});
		expect(fixture?.providerRequests).toHaveLength(requestCount ?? -1);
		expect(JSON.stringify(view)).not.toMatch(/synthetic-access|synthetic-refresh|ciphertext/u);
	});
	it('binds an exact admitted Gog command to authenticated account policy and display metadata', async () => {
		// Arrange
		const { service, target } = await arrange();
		const request = {
			agentId: 'sun',
			profileId: 'shared',
			namespaceId: 'google',
			operationName: 'gog',
			input: {
				accountId: target.accountId,
				argv: ['gmail', 'search', 'unread'],
				reason: 'Read inbox',
			},
		};
		// Act
		const resolved = service.resolveManagedGoogleInvocation(request);
		// Assert
		expect(resolved).toMatchObject({
			kind: 'ready',
			disposition: 'allow',
			binding: {
				accountId: target.accountId,
				generation: 1,
				overrideRevision: 1,
				gmailWriteAllowed: false,
				operationId: 'gmail.search',
			},
			display: { accountAlias: 'sun mailbox' },
		});
		expect(
			service.resolveManagedGoogleInvocation({ ...request, profileId: 'other-profile' }),
		).toEqual({ kind: 'denied' });
		expect(
			service.resolveManagedGoogleInvocation({
				...request,
				input: { ...request.input, argv: ['gmail', 'send'] },
			}),
		).toEqual({ kind: 'denied' });
		if (resolved.kind !== 'ready') throw new Error('Expected preflight.');
		expect(service.readCurrentPolicyForDispatch({ request, expected: resolved.binding })).toBe(
			true,
		);
		expect(
			service.readCurrentPolicyForDispatch({
				request,
				expected: { ...resolved.binding, overrideRevision: 2 },
			}),
		).toBe(false);
	});
	it('denies a configured editor who is not the account owner before history is read', async () => {
		// Arrange
		const { service, target, compiled } = await arrange();
		compiled.oauthConfig.owners.other = {
			label: 'Other owner',
			clerkUserId: 'other-owner',
			allowedAgentIds: ['sun'],
		};
		compiled.oauthConfig.policyEditors.other = {
			clerkUserId: 'other-owner',
			editableAgentIds: ['sun'],
		};
		if (fixture === undefined) throw new Error('Expected fixture.');
		const history = vi.spyOn(fixture.catalog, 'listAccountPolicyHistory');
		// Act / Assert
		expect(
			service.readAccountPolicyView({
				...target,
				identity: { ...facadeIdentity, userId: 'other-owner' },
			}),
		).toEqual({ kind: 'denied' });
		expect(history).not.toHaveBeenCalled();
	});
	it('keeps the owner view read-only after editor removal and does not load override history', async () => {
		// Arrange
		const { service, target, compiled } = await arrange();
		compiled.oauthConfig.policyEditors = {};
		if (fixture === undefined) throw new Error('Expected fixture.');
		const history = vi.spyOn(fixture.catalog, 'listAccountPolicyHistory');
		// Act / Assert
		expect(service.readAccountPolicyView({ ...target, identity: facadeIdentity })).toMatchObject({
			kind: 'ready',
			canEdit: false,
			history: [],
		});
		expect(history).not.toHaveBeenCalled();
	});
	it('does not turn a missing or corrupt policy into config inheritance', async () => {
		// Arrange
		const { service, target } = await arrange();
		if (fixture === undefined) throw new Error('Expected fixture.');
		const getPolicy = vi.spyOn(fixture.catalog, 'getPolicy').mockReturnValue(undefined);
		// Act / Assert
		expect(service.resolveActivityAvailability({ ...target, operationId: 'gmail.search' })).toEqual(
			{ kind: 'unavailable' },
		);
		expect(service.readAccountPolicyView({ ...target, identity: facadeIdentity })).toEqual({
			kind: 'unavailable',
		});
		getPolicy.mockRestore();
	});
	it('fences activity until active config defaults have a matching durable activation', async () => {
		// Arrange
		const { service, target } = await arrange();
		if (fixture === undefined) throw new Error('Expected fixture.');
		vi.spyOn(fixture.catalog, 'getPolicyDefaultsActivation').mockReturnValue(undefined);
		// Act / Assert
		expect(service.resolveActivityAvailability({ ...target, operationId: 'gmail.search' })).toEqual(
			{ kind: 'unavailable' },
		);
	});
	it('resolves the same Google account separately for Sun and Ember', async () => {
		// Arrange
		const { service, target } = await arrange();
		if (fixture === undefined) throw new Error('Expected fixture.');
		const ember = await fixture.enroll('ember');
		// Act / Assert
		expect(ember.accountId).toBe(target.accountId);
		expect(
			service.resolveActivityAvailability({ ...target, operationId: 'gmail.search' }),
		).toMatchObject({ kind: 'ready', disposition: 'allow' });
		expect(
			service.resolveActivityAvailability({
				...target,
				agentId: 'ember',
				operationId: 'gmail.search',
			}),
		).toMatchObject({ kind: 'ready', disposition: 'ask' });
	});
	it('honors a stored Deny and keeps an applying edit unavailable', async () => {
		// Arrange
		const { service, target, compiled } = await arrange();
		if (fixture === undefined) throw new Error('Expected fixture.');
		const view = service.readAccountPolicyView({ ...target, identity: facadeIdentity });
		if (view.kind !== 'ready') throw new Error('Expected owner view.');
		const after = googleAccountPolicySnapshotSchema.parse({
			...view.snapshot,
			overrideRevision: 2,
			state: 'applying',
			lastEditor: view.snapshot.owner,
			lastEditedAtMs: 1000,
			services: {
				...view.snapshot.services,
				gmail: { read: { kind: 'explicit', disposition: 'deny' }, write: { kind: 'inherit' } },
			},
		});
		const codec = createOAuthPolicyEnvelopeCodec({
			payloadSchema: googleAccountPolicySnapshotSchema,
		});
		const encrypt = (snapshot: typeof after): ReturnType<typeof codec.encrypt> =>
			codec.encrypt({
				binding: oauthPolicyEnvelopeBindingSchema.strip().parse(snapshot),
				payload: snapshot,
				keyEncryptionKey: wrappingKey,
				keyEncryptionKeyVersion: 1,
			});
		const saved = fixture.catalog.saveAccountPolicy({
			before: view.snapshot,
			after,
			envelope: encrypt(after),
			expectedDefaultsRevision: compiled.defaultsRevision,
		});
		if (saved.kind !== 'updated') throw new Error('Expected policy save.');
		// Act / Assert
		expect(service.resolveActivityAvailability({ ...target, operationId: 'gmail.search' })).toEqual(
			{ kind: 'unavailable' },
		);
		const active = { ...after, state: 'active' as const };
		fixture.catalog.activateAccountPolicy({
			before: after,
			after: active,
			envelope: encrypt(active),
			expectedTransitionId: saved.policy.transitionId,
		});
		expect(service.resolveActivityAvailability({ ...target, operationId: 'gmail.search' })).toEqual(
			{ kind: 'denied' },
		);
	});
});
