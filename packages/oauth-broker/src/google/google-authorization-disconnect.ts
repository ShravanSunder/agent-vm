import { type OAuthAuthorizationActionResult } from '@agent-vm/oauth-broker-contracts';

import { type OAuthCeremonyTransaction } from '../oauth-ceremony-contracts.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { type OAuthAuthorizationContainmentTarget } from './google-authorization-commit.js';

/** A claimed owner confirmation fences SQLite before awaiting runtime containment. */
export async function disconnectConfirmedGoogleAuthorization(props: {
	readonly runAuthorityCommit?: <TResult>(commit: () => TResult) => Promise<TResult>;
	readonly catalog: OAuthCredentialCatalog;
	readonly transaction: Extract<OAuthCeremonyTransaction, { kind: 'committing-disconnect' }>;
	readonly containAuthorizationMaterial: (
		target: OAuthAuthorizationContainmentTarget,
	) => Promise<'contained' | 'pending' | 'failed'>;
	readonly isAdmissionOpen: () => boolean;
	readonly zoneId: string;
}): Promise<OAuthAuthorizationActionResult> {
	const { transaction, catalog } = props;
	const target = transaction.target;
	const current = catalog.getAuthorization(target.authorizationId);
	if (
		!props.isAdmissionOpen() ||
		current === undefined ||
		current.zoneId !== props.zoneId ||
		current.accountId !== target.accountId ||
		current.agentId !== transaction.agentId ||
		current.applicationId !== target.applicationId ||
		current.providerSubject !== target.providerSubject ||
		current.generation !== target.generation ||
		current.authorizationMetadataRevision !== target.authorizationMetadataRevision
	)
		return { kind: 'authorization-failed', failure: { kind: 'stale-authorization' } };
	const commit = (): ReturnType<typeof catalog.disconnectAuthorization> =>
		catalog.disconnectAuthorization({
			authorizationId: target.authorizationId,
			expectedRecordRevision: current.recordRevision,
			owner: { issuer: transaction.identity.issuer, userId: transaction.identity.userId },
		});
	const disconnected =
		props.runAuthorityCommit === undefined ? commit() : await props.runAuthorityCommit(commit);
	if (disconnected.kind !== 'updated')
		return { kind: 'authorization-failed', failure: { kind: 'stale-authorization' } };
	const authorization = disconnected.authorization;
	let containment: 'contained' | 'pending' | 'failed';
	try {
		containment = await props.containAuthorizationMaterial({
			accountId: current.accountId,
			agentId: current.agentId,
			applicationId: current.applicationId,
			authorizationId: current.authorizationId,
			throughGeneration: current.generation,
			zoneId: current.zoneId,
		});
	} catch {
		containment = 'failed';
	}
	let kind:
		| 'authorization-disconnected'
		| 'authorization-disconnecting'
		| 'authorization-containment-failed' = 'authorization-disconnecting';
	if (containment === 'failed') kind = 'authorization-containment-failed';
	else if (containment === 'contained' && props.isAdmissionOpen()) {
		try {
			const settled = catalog.settleAuthorizationTransition({
				authorizationId: authorization.authorizationId,
				expectedRecordRevision: authorization.recordRevision,
				transitionId: authorization.transitionId,
			});
			if (settled.kind === 'updated') kind = 'authorization-disconnected';
		} catch {
			/* The durable fence remains until recovery can record completion. */
		}
	}
	return { kind, accountId: target.accountId, applicationId: target.applicationId };
}
