import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
	googleAccountPolicyBindingSchema,
	type GoogleAccountPolicySnapshot,
} from '@agent-vm/oauth-broker-contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
	googleAccountPoliciesTable,
	permissionChangeEventsTable,
	type oauthCatalogSchema,
} from './catalog-schema.js';
import {
	oauthAccountPolicyActivationInputSchema,
	oauthAccountPolicyContainmentInputSchema,
	oauthAccountPolicyChangeEventSchema,
	oauthAccountPolicySaveInputSchema,
	type OAuthAccountPolicyChangeEvent,
} from './oauth-account-policy-contracts.js';
import {
	oauthPermissionChangeEventSchema,
	type OAuthAccountPolicyMutationResult,
	type OAuthCredentialCatalog,
	type OAuthStoredAuthorization,
	type OAuthStoredPolicy,
} from './oauth-credential-catalog-contracts.js';

type AccountPolicyRepository = Pick<
	OAuthCredentialCatalog,
	| 'saveAccountPolicy'
	| 'activateAccountPolicy'
	| 'recordAccountPolicyContainment'
	| 'listAccountPolicyHistory'
>;

function matchesAuthorization(
	snapshot: GoogleAccountPolicySnapshot,
	authorization: OAuthStoredAuthorization,
): boolean {
	return isDeepStrictEqual(
		googleAccountPolicyBindingSchema.strip().parse(snapshot),
		googleAccountPolicyBindingSchema.strip().parse(authorization),
	);
}

/** Synchronous CAS and history writes on the same controller-owned catalog connection. */
export function createOAuthAccountPolicyRepository(props: {
	readonly database: BetterSQLite3Database<typeof oauthCatalogSchema>;
	readonly now: () => number;
	readonly getPolicy: OAuthCredentialCatalog['getPolicy'];
	readonly getAuthorization: OAuthCredentialCatalog['getAuthorization'];
	readonly getPolicyDefaultsActivation: OAuthCredentialCatalog['getPolicyDefaultsActivation'];
}): AccountPolicyRepository {
	const { database, now } = props;
	const persist = (input: {
		readonly before: GoogleAccountPolicySnapshot;
		readonly after: GoogleAccountPolicySnapshot;
		readonly envelope: OAuthStoredPolicy['envelope'];
		readonly current: OAuthStoredPolicy;
		readonly transitionId: string;
		readonly kind: OAuthAccountPolicyChangeEvent['kind'];
		readonly actor: OAuthAccountPolicyChangeEvent['actor'];
	}): OAuthAccountPolicyMutationResult => {
		const timestampMs = now();
		const changed = database
			.update(googleAccountPoliciesTable)
			.set({
				envelope: input.envelope,
				overrideRevision: input.after.overrideRevision,
				state: input.after.state,
				transitionId: input.transitionId,
				updatedAtMs: timestampMs,
			})
			.where(
				and(
					eq(googleAccountPoliciesTable.authorizationId, input.current.authorizationId),
					eq(googleAccountPoliciesTable.overrideRevision, input.current.overrideRevision),
					eq(googleAccountPoliciesTable.state, input.current.state),
					eq(googleAccountPoliciesTable.transitionId, input.current.transitionId),
				),
			)
			.run();
		if (changed.changes !== 1) return { kind: 'stale' };
		const event = oauthAccountPolicyChangeEventSchema.parse({
			kind: input.kind,
			actor: input.actor,
			eventId: randomUUID(),
			transitionId: input.transitionId,
			timestampMs,
			zoneId: input.after.zoneId,
			agentId: input.after.agentId,
			accountId: input.after.accountId,
			applicationId: input.after.applicationId,
			authorizationId: input.after.authorizationId,
			oldRevision: input.before.overrideRevision,
			newRevision: input.after.overrideRevision,
			before: input.before.services,
			after: input.after.services,
			state: input.after.state,
		});
		database
			.insert(permissionChangeEventsTable)
			.values({
				authorizationId: input.after.authorizationId,
				zoneId: input.after.zoneId,
				eventId: event.eventId,
				event,
				timestampMs,
			})
			.run();
		const policy = props.getPolicy(input.after.authorizationId);
		if (policy === undefined) throw new Error('Saved policy could not be reloaded.');
		return { kind: 'updated', policy };
	};
	return {
		saveAccountPolicy: (unparsed) => {
			const input = oauthAccountPolicySaveInputSchema.parse(unparsed);
			return database.transaction((): OAuthAccountPolicyMutationResult => {
				const authorization = props.getAuthorization(input.before.authorizationId);
				const current = props.getPolicy(input.before.authorizationId);
				if (authorization === undefined || current === undefined) return { kind: 'unavailable' };
				if (
					!matchesAuthorization(input.before, authorization) ||
					!matchesAuthorization(input.after, authorization) ||
					!isDeepStrictEqual(input.after.lastEditor, authorization.owner) ||
					input.after.lastEditedAtMs === null
				)
					return { kind: 'owner-mismatch' };
				if (
					current.state !== 'active' ||
					input.before.state !== 'active' ||
					input.after.state !== 'applying' ||
					current.overrideRevision !== input.before.overrideRevision ||
					input.after.overrideRevision !== input.before.overrideRevision + 1
				)
					return { kind: 'stale' };
				if (
					props.getPolicyDefaultsActivation(input.before.zoneId)?.activeDefaultsDigest !==
					input.expectedDefaultsRevision
				)
					return { kind: 'defaults-changed' };
				return persist({
					...input,
					current,
					transitionId: randomUUID(),
					kind: 'policy-saved',
					actor: { kind: 'owner', identity: authorization.owner },
				});
			});
		},
		activateAccountPolicy: (unparsed) => {
			const input = oauthAccountPolicyActivationInputSchema.parse(unparsed);
			return database.transaction((): OAuthAccountPolicyMutationResult => {
				const authorization = props.getAuthorization(input.before.authorizationId);
				const current = props.getPolicy(input.before.authorizationId);
				if (authorization === undefined || current === undefined) return { kind: 'unavailable' };
				if (
					!matchesAuthorization(input.before, authorization) ||
					!matchesAuthorization(input.after, authorization)
				)
					return { kind: 'owner-mismatch' };
				const { state: beforeState, ...before } = input.before;
				const { state: afterState, ...after } = input.after;
				if (
					current.state !== 'applying' ||
					beforeState !== 'applying' ||
					afterState !== 'active' ||
					current.overrideRevision !== before.overrideRevision ||
					current.transitionId !== input.expectedTransitionId ||
					!isDeepStrictEqual(before, after)
				)
					return { kind: 'stale' };
				return persist({
					...input,
					current,
					transitionId: current.transitionId,
					kind: 'policy-activated',
					actor: { kind: 'system-recovery' },
				});
			});
		},
		recordAccountPolicyContainment: (unparsed) => {
			const input = oauthAccountPolicyContainmentInputSchema.parse(unparsed);
			return database.transaction((): OAuthAccountPolicyMutationResult => {
				const authorization = props.getAuthorization(input.snapshot.authorizationId);
				const current = props.getPolicy(input.snapshot.authorizationId);
				if (authorization === undefined || current === undefined) return { kind: 'unavailable' };
				if (!matchesAuthorization(input.snapshot, authorization)) return { kind: 'owner-mismatch' };
				if (
					current.state !== 'applying' ||
					input.snapshot.state !== 'applying' ||
					current.overrideRevision !== input.snapshot.overrideRevision ||
					current.transitionId !== input.expectedTransitionId
				)
					return { kind: 'stale' };
				return persist({
					before: input.snapshot,
					after: input.snapshot,
					envelope: current.envelope,
					current,
					transitionId: current.transitionId,
					kind:
						input.result === 'pending' ? 'policy-containment-pending' : 'policy-containment-failed',
					actor: { kind: 'system-recovery' },
				});
			});
		},
		listAccountPolicyHistory: (authorizationId) =>
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
					(event): event is OAuthAccountPolicyChangeEvent =>
						oauthAccountPolicyChangeEventSchema.safeParse(event).success,
				),
	};
}
