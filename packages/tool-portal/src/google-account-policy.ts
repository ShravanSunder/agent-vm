import {
	googleAccountInvocationPolicyInputSchema,
	googleAccountPolicySnapshotSchema,
	type GoogleAccountInvocationPolicyInput,
	type GoogleAccountInvocationPolicyResult,
	type GoogleAccountPolicyBinding,
} from '@agent-vm/oauth-broker-contracts';

function bindingsMatch(
	actual: GoogleAccountPolicyBinding,
	expected: GoogleAccountPolicyBinding,
): boolean {
	return (
		actual.zoneId === expected.zoneId &&
		actual.agentId === expected.agentId &&
		actual.accountId === expected.accountId &&
		actual.applicationId === expected.applicationId &&
		actual.authorizationId === expected.authorizationId &&
		actual.owner.issuer === expected.owner.issuer &&
		actual.owner.userId === expected.owner.userId
	);
}

function ownRecordValue<TValue>(
	record: Readonly<Record<string, TValue>>,
	key: string,
): TValue | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function resolveGoogleAccountInvocationPolicy(
	input: GoogleAccountInvocationPolicyInput,
): GoogleAccountInvocationPolicyResult {
	const parsed = googleAccountInvocationPolicyInputSchema.safeParse(input);
	if (!parsed.success) return { kind: 'unavailable' };
	const request = parsed.data;
	if (!request.commandAllowed) return { kind: 'denied', reason: 'command' };
	const snapshot = googleAccountPolicySnapshotSchema.safeParse(request.snapshot);
	if (
		!snapshot.success ||
		snapshot.data.state !== 'active' ||
		!bindingsMatch(snapshot.data, request.binding)
	) {
		return { kind: 'unavailable' };
	}
	let needsConsent = false;
	let needsApproval = false;
	for (const requirement of request.requirements) {
		const overrides = ownRecordValue(snapshot.data.services, requirement.serviceId);
		if (overrides === undefined) return { kind: 'unavailable' };
		for (const effect of requirement.effects) {
			if (!ownRecordValue(request.maximums, requirement.serviceId)?.includes(effect)) {
				return { kind: 'denied', reason: 'hard-limit' };
			}
			const cell = overrides[effect];
			const disposition =
				cell.kind === 'explicit'
					? cell.disposition
					: (ownRecordValue(request.defaults, requirement.serviceId)?.[effect] ?? 'deny');
			if (disposition === 'deny') return { kind: 'denied', reason: 'policy' };
			if (disposition === 'ask') needsApproval = true;
			if (!ownRecordValue(request.grants, requirement.serviceId)?.includes(effect))
				needsConsent = true;
		}
	}
	if (needsConsent) return { kind: 'consent-required' };
	return {
		kind: 'allowed',
		disposition: needsApproval ? 'ask' : 'allow',
		overrideRevision: snapshot.data.overrideRevision,
	};
}
