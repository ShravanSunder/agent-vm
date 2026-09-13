import { randomUUID } from 'node:crypto';

import { oauthAccountIdSchema, oauthAuthorizationIdSchema } from '@agent-vm/oauth-broker-contracts';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
	googleAccountPoliciesTable,
	oauthAccountsTable,
	oauthAgentAuthorizationsTable,
	type oauthCatalogSchema,
	permissionChangeEventsTable,
} from './catalog-schema.js';
import { createOAuthAccountPolicyRepository } from './oauth-account-policy-repository.js';
import {
	oauthEnrollmentGrantInputSchema,
	oauthAuthorizationChangeEventSchema,
	oauthPermissionChangeEventSchema,
	oauthReplaceGrantEnvelopeInputSchema,
	oauthStoredAccountMetadataSchema,
	oauthStoredAuthorizationSchema,
	oauthStoredGrantSchema,
	oauthStoredPolicySchema,
	type OAuthAccountApplicationQuery,
	type OAuthAuthorizationTransitionResult,
	type OAuthCommitEnrollmentResult,
	type OAuthCredentialCatalog,
	type OAuthEnrollmentGrantInput,
	type OAuthAuthorizationChangeEvent,
	type OAuthStoredAccountMetadata,
	type OAuthStoredAuthorization,
	type OAuthStoredGrant,
} from './oauth-credential-catalog-contracts.js';
import { createOAuthPolicyDefaultsRepository } from './oauth-policy-defaults-repository.js';

type CatalogDatabase = BetterSQLite3Database<typeof oauthCatalogSchema>;
type CatalogRepositories = Omit<
	OAuthCredentialCatalog,
	'close' | 'getStorageDiagnostics' | 'verifyOrInitializeKeyEncryptionKey'
>;

function accountFromRow(row: typeof oauthAccountsTable.$inferSelect): OAuthStoredAccountMetadata {
	const { ownerIssuer, ownerUserId, ...account } = row;
	return oauthStoredAccountMetadataSchema.parse({
		...account,
		owner: { issuer: ownerIssuer, userId: ownerUserId },
	});
}

function authorizationFromRows(rows: {
	readonly account: typeof oauthAccountsTable.$inferSelect;
	readonly authorization: typeof oauthAgentAuthorizationsTable.$inferSelect;
}): OAuthStoredAuthorization {
	return oauthStoredAuthorizationSchema.parse({
		...rows.authorization,
		owner: { issuer: rows.account.ownerIssuer, userId: rows.account.ownerUserId },
		providerId: rows.account.providerId,
		providerSubject: rows.account.providerSubject,
		zoneId: rows.account.zoneId,
	});
}

function connectedGrant(
	authorization: OAuthStoredAuthorization | undefined,
): OAuthStoredGrant | undefined {
	if (authorization?.accessState !== 'connected') return undefined;
	const { accessState: _accessState, ...grant } = authorization;
	return oauthStoredGrantSchema.parse(grant);
}

function sameOwner(
	left: OAuthStoredAccountMetadata['owner'],
	right: OAuthStoredAccountMetadata['owner'],
): boolean {
	return left.issuer === right.issuer && left.userId === right.userId;
}

export function createOAuthCatalogRepositories(props: {
	readonly database: CatalogDatabase;
	readonly now: () => number;
}): CatalogRepositories {
	const { database, now } = props;
	const queryAuthorizations = (predicate: SQL | undefined): readonly OAuthStoredAuthorization[] => {
		if (predicate === undefined) throw new Error('OAuth authorization queries require a scope.');
		return database
			.select({ account: oauthAccountsTable, authorization: oauthAgentAuthorizationsTable })
			.from(oauthAgentAuthorizationsTable)
			.innerJoin(
				oauthAccountsTable,
				eq(oauthAccountsTable.accountId, oauthAgentAuthorizationsTable.accountId),
			)
			.where(predicate)
			.all()
			.map(authorizationFromRows);
	};
	const getAccountMetadata: CatalogRepositories['getAccountMetadata'] = (accountId) => {
		const row = database
			.select()
			.from(oauthAccountsTable)
			.where(eq(oauthAccountsTable.accountId, oauthAccountIdSchema.parse(accountId)))
			.get();
		return row === undefined ? undefined : accountFromRow(row);
	};
	const findAccount: CatalogRepositories['findAccount'] = (query) => {
		const row = database
			.select()
			.from(oauthAccountsTable)
			.where(
				and(
					eq(oauthAccountsTable.zoneId, query.zoneId),
					eq(oauthAccountsTable.providerId, query.providerId),
					eq(oauthAccountsTable.providerSubject, query.providerSubject),
				),
			)
			.get();
		return row === undefined ? undefined : accountFromRow(row);
	};
	const getAuthorization: CatalogRepositories['getAuthorization'] = (authorizationId) =>
		queryAuthorizations(
			eq(
				oauthAgentAuthorizationsTable.authorizationId,
				oauthAuthorizationIdSchema.parse(authorizationId),
			),
		)[0];
	const getAuthorizationForAccountApplication = (
		query: OAuthAccountApplicationQuery,
	): OAuthStoredAuthorization | undefined =>
		queryAuthorizations(
			and(
				eq(oauthAccountsTable.zoneId, query.zoneId),
				eq(oauthAgentAuthorizationsTable.accountId, query.accountId),
				eq(oauthAgentAuthorizationsTable.agentId, query.agentId),
				eq(oauthAgentAuthorizationsTable.applicationId, query.applicationId),
			),
		)[0];
	const listAuthorizationsForAgent: CatalogRepositories['listAuthorizationsForAgent'] = (query) =>
		queryAuthorizations(
			and(
				eq(oauthAccountsTable.zoneId, query.zoneId),
				eq(oauthAgentAuthorizationsTable.agentId, query.agentId),
			),
		);
	const getGrant: CatalogRepositories['getGrant'] = (credentialId) =>
		connectedGrant(
			queryAuthorizations(eq(oauthAgentAuthorizationsTable.credentialId, credentialId))[0],
		);
	const getPolicy: CatalogRepositories['getPolicy'] = (authorizationId) => {
		const row = database
			.select()
			.from(googleAccountPoliciesTable)
			.where(eq(googleAccountPoliciesTable.authorizationId, authorizationId))
			.get();
		return row === undefined ? undefined : oauthStoredPolicySchema.parse(row);
	};

	// All repositories share this connection. These synchronous calls participate
	// in the enclosing transaction; no second connection or async effect is opened.
	const appendEvent = (eventProps: {
		readonly authorization: OAuthStoredAuthorization;
		readonly actor: OAuthAuthorizationChangeEvent['actor'];
		readonly kind: OAuthAuthorizationChangeEvent['kind'];
		readonly oldRevision: number | null;
	}): void => {
		const authorization = eventProps.authorization;
		const event = oauthAuthorizationChangeEventSchema.parse({
			accountId: authorization.accountId,
			agentId: authorization.agentId,
			actor: eventProps.actor,
			authorizationId: authorization.authorizationId,
			eventId: randomUUID(),
			kind: eventProps.kind,
			newRevision: authorization.recordRevision,
			oldRevision: eventProps.oldRevision,
			selectedGroupIds: authorization.selectedGroupIds,
			timestampMs: now(),
			transitionId: authorization.transitionId,
			zoneId: authorization.zoneId,
		});
		database
			.insert(permissionChangeEventsTable)
			.values({
				authorizationId: authorization.authorizationId,
				zoneId: authorization.zoneId,
				eventId: event.eventId,
				event,
				timestampMs: event.timestampMs,
			})
			.run();
	};

	const commit = (
		unparsedInput: OAuthEnrollmentGrantInput,
		mode: 'enroll' | 'replace',
	): OAuthCommitEnrollmentResult => {
		const input = oauthEnrollmentGrantInputSchema.parse(unparsedInput);
		return database.transaction((): OAuthCommitEnrollmentResult => {
			const account = findAccount(input);
			const addressedAccount = getAccountMetadata(input.accountId);
			if (
				(account !== undefined && !sameOwner(account.owner, input.owner)) ||
				(addressedAccount !== undefined && !sameOwner(addressedAccount.owner, input.owner))
			)
				return { kind: 'owner-mismatch' };
			if (
				(account !== undefined && account.accountId !== input.accountId) ||
				(addressedAccount !== undefined && account?.accountId !== addressedAccount.accountId)
			)
				return { kind: 'account-conflict' };
			const existing = getAuthorizationForAccountApplication(input);
			if (mode === 'enroll' && existing !== undefined && existing.accessState !== 'disconnected')
				return { kind: 'duplicate-authorization' };
			if (mode === 'replace' && existing?.accessState !== 'connected') return { kind: 'stale' };
			if (
				(existing?.recordRevision ?? null) !== input.expectedRecordRevision ||
				input.generation !== (existing?.generation ?? 0) + 1 ||
				input.authorizationMetadataRevision !==
					(existing?.authorizationMetadataRevision ?? 0) + 1 ||
				(existing !== undefined && existing.authorizationId !== input.authorizationId)
			)
				return { kind: 'stale' };
			if (existing === undefined && getAuthorization(input.authorizationId) !== undefined)
				return { kind: 'stale' };
			if (existing === undefined && input.initialPolicyEnvelope === undefined)
				throw new Error('First authorization requires an authenticated inherit-policy snapshot.');
			if (
				existing !== undefined &&
				(input.initialPolicyEnvelope !== undefined ||
					getPolicy(existing.authorizationId) === undefined)
			) {
				throw new Error('Existing authorization policy must be retained, not reinitialized.');
			}
			const timestamp = now();
			if (account === undefined) {
				database
					.insert(oauthAccountsTable)
					.values({
						accountId: input.accountId,
						accountLabel: input.accountLabel,
						createdAtMs: timestamp,
						ownerIssuer: input.owner.issuer,
						ownerUserId: input.owner.userId,
						providerId: input.providerId,
						providerSubject: input.providerSubject,
						recordRevision: 1,
						updatedAtMs: timestamp,
						zoneId: input.zoneId,
					})
					.run();
			}
			const values = {
				accountId: input.accountId,
				accountAlias: input.accountAlias,
				accessState: mode === 'replace' ? 'replacing' : 'connected',
				agentId: input.agentId,
				applicationId: input.applicationId,
				authorizationId: input.authorizationId,
				authorizationMetadataRevision: input.authorizationMetadataRevision,
				catalogVersion: input.catalogVersion,
				clientBindingRevision: input.clientBindingRevision,
				clientId: input.clientId,
				credentialId: input.credentialId,
				envelope: input.envelope,
				failureClass: null,
				generation: input.generation,
				grantedScopes: input.grantedScopes,
				lastRefreshAttemptAtMs: null,
				lastRefreshSucceededAtMs: null,
				lifecycleKind: 'active',
				materialRevision: input.materialRevision,
				nextRefreshEligibleAtMs: null,
				providerCredentialVersion: input.providerCredentialVersion,
				reauthorizationReason: null,
				recordRevision: (existing?.recordRevision ?? 0) + 1,
				requestedScopes: input.requestedScopes,
				selectedGroupIds: input.selectedGroupIds,
				transitionId: randomUUID(),
				updatedAtMs: timestamp,
			} satisfies typeof oauthAgentAuthorizationsTable.$inferInsert;
			if (existing === undefined)
				database.insert(oauthAgentAuthorizationsTable).values(values).run();
			else {
				const updated = database
					.update(oauthAgentAuthorizationsTable)
					.set(values)
					.where(
						and(
							eq(oauthAgentAuthorizationsTable.authorizationId, existing.authorizationId),
							eq(oauthAgentAuthorizationsTable.recordRevision, existing.recordRevision),
						),
					)
					.run();
				if (updated.changes !== 1) return { kind: 'stale' };
			}
			if (existing === undefined && input.initialPolicyEnvelope !== undefined) {
				database
					.insert(googleAccountPoliciesTable)
					.values({
						authorizationId: input.authorizationId,
						envelope: input.initialPolicyEnvelope,
						overrideRevision: 1,
						state: 'active',
						transitionId: values.transitionId,
						updatedAtMs: timestamp,
					})
					.run();
			}
			const authorization = getAuthorization(input.authorizationId);
			if (authorization === undefined)
				throw new Error('Committed authorization could not be reloaded.');
			appendEvent({
				authorization,
				actor: { kind: 'owner', identity: input.owner },
				kind: mode === 'replace' ? 'authorization-replaced' : 'authorization-created',
				oldRevision: existing?.recordRevision ?? null,
			});
			if (existing === undefined)
				appendEvent({
					authorization,
					actor: { kind: 'system-initialization' },
					kind: 'policy-initialized',
					oldRevision: null,
				});
			return { authorization, kind: 'committed' };
		});
	};

	const defaultsRepository = createOAuthPolicyDefaultsRepository({ database, now });
	return {
		...defaultsRepository,
		...createOAuthAccountPolicyRepository({
			database,
			now,
			getAuthorization,
			getPolicy,
			getPolicyDefaultsActivation: defaultsRepository.getPolicyDefaultsActivation,
		}),
		commitEnrollmentGrant: (input) => commit(input, 'enroll'),
		replaceAuthorization: (input) => commit(input, 'replace'),
		findAccount,
		getAccountMetadata,
		getAuthorization,
		getAuthorizationForAccountApplication,
		getGrant,
		getPolicy,
		getGrantForAccountApplication: (query) =>
			connectedGrant(getAuthorizationForAccountApplication(query)),
		listAuthorizationsForAgent,
		listGrantsForAgent: (query) =>
			listAuthorizationsForAgent(query).flatMap((authorization) => {
				const grant = connectedGrant(authorization);
				return grant === undefined ? [] : [grant];
			}),
		listAuthorizationHistory: (authorizationId) =>
			database
				.select()
				.from(permissionChangeEventsTable)
				.where(eq(permissionChangeEventsTable.authorizationId, authorizationId))
				.orderBy(
					asc(permissionChangeEventsTable.timestampMs),
					asc(permissionChangeEventsTable.eventId),
				)
				.all()
				.map((row) => oauthPermissionChangeEventSchema.parse(row.event))
				.filter(
					(event): event is OAuthAuthorizationChangeEvent =>
						oauthAuthorizationChangeEventSchema.safeParse(event).success,
				),
		replaceGrantEnvelope: (unparsedInput) => {
			const input = oauthReplaceGrantEnvelopeInputSchema.parse(unparsedInput);
			return database.transaction(() => {
				const current = getGrant(input.credentialId);
				if (current === undefined) return { kind: 'missing' as const };
				if (current.recordRevision !== input.expectedRecordRevision)
					return { currentRecordRevision: current.recordRevision, kind: 'stale' as const };
				const { expectedRecordRevision: _expectedRecordRevision, ...refresh } = input;
				const updated = database
					.update(oauthAgentAuthorizationsTable)
					.set({ ...refresh, recordRevision: current.recordRevision + 1, updatedAtMs: now() })
					.where(
						and(
							eq(oauthAgentAuthorizationsTable.authorizationId, current.authorizationId),
							eq(oauthAgentAuthorizationsTable.recordRevision, current.recordRevision),
						),
					)
					.run();
				if (updated.changes !== 1)
					return { currentRecordRevision: current.recordRevision, kind: 'stale' as const };
				const grant = getGrant(input.credentialId);
				if (grant === undefined) throw new Error('Refreshed authorization could not be reloaded.');
				return { grant, kind: 'updated' as const };
			});
		},
		disconnectAuthorization: (input) =>
			database.transaction((): OAuthAuthorizationTransitionResult => {
				const current = getAuthorization(input.authorizationId);
				if (current === undefined) return { kind: 'missing' };
				if (!sameOwner(current.owner, input.owner)) return { kind: 'owner-mismatch' };
				if (
					current.recordRevision !== input.expectedRecordRevision ||
					(current.accessState !== 'connected' && current.accessState !== 'replacing')
				)
					return { kind: 'stale' };
				const updated = database
					.update(oauthAgentAuthorizationsTable)
					.set({
						accessState: 'disconnecting',
						credentialId: null,
						envelope: null,
						materialRevision: null,
						generation: current.generation + 1,
						authorizationMetadataRevision: current.authorizationMetadataRevision + 1,
						recordRevision: current.recordRevision + 1,
						transitionId: randomUUID(),
						updatedAtMs: now(),
					})
					.where(
						and(
							eq(oauthAgentAuthorizationsTable.authorizationId, current.authorizationId),
							eq(oauthAgentAuthorizationsTable.recordRevision, current.recordRevision),
						),
					)
					.run();
				if (updated.changes !== 1) return { kind: 'stale' };
				const authorization = getAuthorization(current.authorizationId);
				if (authorization === undefined)
					throw new Error('Disconnected authorization could not be reloaded.');
				appendEvent({
					authorization,
					actor: { kind: 'owner', identity: input.owner },
					kind: 'authorization-disconnecting',
					oldRevision: current.recordRevision,
				});
				return { authorization, kind: 'updated' };
			}),
		settleAuthorizationTransition: (input) =>
			database.transaction((): OAuthAuthorizationTransitionResult => {
				const current = getAuthorization(input.authorizationId);
				if (current === undefined) return { kind: 'missing' };
				if (
					current.recordRevision !== input.expectedRecordRevision ||
					current.transitionId !== input.transitionId ||
					(current.accessState !== 'replacing' && current.accessState !== 'disconnecting')
				)
					return { kind: 'stale' };
				const updated = database
					.update(oauthAgentAuthorizationsTable)
					.set({
						accessState: current.accessState === 'replacing' ? 'connected' : 'disconnected',
						recordRevision: current.recordRevision + 1,
						updatedAtMs: now(),
					})
					.where(
						and(
							eq(oauthAgentAuthorizationsTable.authorizationId, current.authorizationId),
							eq(oauthAgentAuthorizationsTable.recordRevision, current.recordRevision),
							eq(oauthAgentAuthorizationsTable.transitionId, current.transitionId),
						),
					)
					.run();
				if (updated.changes !== 1) return { kind: 'stale' };
				const authorization = getAuthorization(current.authorizationId);
				if (authorization === undefined)
					throw new Error('Settled authorization could not be reloaded.');
				appendEvent({
					authorization,
					actor: { kind: 'system-recovery' },
					kind: 'authorization-settled',
					oldRevision: current.recordRevision,
				});
				return { authorization, kind: 'updated' };
			}),
	};
}
