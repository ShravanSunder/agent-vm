import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
	googlePolicyDefaultsActivationTable,
	permissionChangeEventsTable,
	type oauthCatalogSchema,
} from './catalog-schema.js';
import type { OAuthCredentialCatalog } from './oauth-credential-catalog-contracts.js';
import {
	oauthPolicyDefaultsActivationInputSchema,
	oauthPolicyDefaultsChangeEventSchema,
	oauthStoredPolicyDefaultsActivationSchema,
} from './oauth-policy-defaults-contracts.js';

type PolicyDefaultsRepository = Pick<
	OAuthCredentialCatalog,
	'activatePolicyDefaults' | 'getPolicyDefaultsActivation' | 'listPolicyDefaultsHistory'
>;

/** Shares the catalog connection; no listener, background refresh or config-file writer. */
export function createOAuthPolicyDefaultsRepository(props: {
	readonly database: BetterSQLite3Database<typeof oauthCatalogSchema>;
	readonly now: () => number;
}): PolicyDefaultsRepository {
	const { database, now } = props;
	const getPolicyDefaultsActivation: PolicyDefaultsRepository['getPolicyDefaultsActivation'] = (
		zoneId,
	) => {
		const stored = database
			.select()
			.from(googlePolicyDefaultsActivationTable)
			.where(eq(googlePolicyDefaultsActivationTable.zoneId, zoneId))
			.get();
		return stored === undefined
			? undefined
			: oauthStoredPolicyDefaultsActivationSchema.parse(stored);
	};
	return {
		getPolicyDefaultsActivation,
		activatePolicyDefaults: (unparsed) => {
			const input = oauthPolicyDefaultsActivationInputSchema.parse(unparsed);
			return database.transaction(
				(): ReturnType<PolicyDefaultsRepository['activatePolicyDefaults']> => {
					const previous = getPolicyDefaultsActivation(input.zoneId);
					if (previous?.activeDefaultsDigest === input.defaultsRevision) {
						if (!isDeepStrictEqual(previous.snapshot, input.snapshot))
							throw new Error('Recorded defaults revision has an inconsistent snapshot.');
						return { kind: 'unchanged', activation: previous };
					}
					const timestampMs = now();
					const activation = oauthStoredPolicyDefaultsActivationSchema.parse({
						zoneId: input.zoneId,
						activeDefaultsDigest: input.defaultsRevision,
						snapshot: input.snapshot,
						updatedAtMs: timestampMs,
					});
					const event = oauthPolicyDefaultsChangeEventSchema.parse({
						kind: 'defaults-activated',
						actor: { kind: 'operator-config' },
						zoneId: input.zoneId,
						eventId: randomUUID(),
						transitionId: randomUUID(),
						timestampMs,
						oldRevision: previous?.activeDefaultsDigest ?? null,
						newRevision: input.defaultsRevision,
						before: previous?.snapshot ?? null,
						after: input.snapshot,
					});
					if (previous === undefined)
						database.insert(googlePolicyDefaultsActivationTable).values(activation).run();
					else
						database
							.update(googlePolicyDefaultsActivationTable)
							.set(activation)
							.where(eq(googlePolicyDefaultsActivationTable.zoneId, input.zoneId))
							.run();
					database
						.insert(permissionChangeEventsTable)
						.values({
							authorizationId: null,
							zoneId: input.zoneId,
							eventId: event.eventId,
							event,
							timestampMs,
						})
						.run();
					return { kind: 'activated', activation };
				},
			);
		},
		listPolicyDefaultsHistory: (zoneId) =>
			database
				.select()
				.from(permissionChangeEventsTable)
				.where(
					and(
						isNull(permissionChangeEventsTable.authorizationId),
						eq(permissionChangeEventsTable.zoneId, zoneId),
					),
				)
				.orderBy(
					asc(permissionChangeEventsTable.timestampMs),
					asc(permissionChangeEventsTable.eventId),
				)
				.all()
				.map((row) => {
					const event = oauthPolicyDefaultsChangeEventSchema.parse(row.event);
					if (event.zoneId !== zoneId)
						throw new Error('Default history scope does not match its stored metadata.');
					return event;
				}),
	};
}
