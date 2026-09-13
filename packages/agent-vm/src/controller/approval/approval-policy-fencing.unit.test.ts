import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	type GatewayRuntimeApprovalChallengeIntent,
} from '@agent-vm/gateway-control-contracts';
import { managedGoogleReadyPreflightSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { createControllerApprovalLedger } from './controller-approval-ledger.js';

type LedgerOptions = Parameters<typeof createControllerApprovalLedger>[0];
type ApprovalStore = NonNullable<LedgerOptions['store']>;
type ApprovalRecord = NonNullable<Awaited<ReturnType<ApprovalStore['loadRecord']>>>;

const authorityContext = {
	controllerEpoch: 'controller-1',
	frameworkEpoch: 'framework-1',
	gatewayEpoch: 'gateway-1',
	runtimeEpoch: 'runtime-1',
	zoneId: 'zone-a',
};
const managedGoogle = managedGoogleReadyPreflightSchema.parse({
	kind: 'ready',
	disposition: 'ask',
	binding: {
		accountId: '11111111-1111-4111-8111-111111111111',
		applicationId: 'gmail-app',
		authorizationId: '22222222-2222-4222-8222-222222222222',
		generation: 1,
		authorizationMetadataRevision: 1,
		overrideRevision: 1,
		defaultsRevision: 'a'.repeat(64),
		configRevision: 'config-1',
		clientBindingRevision: 'client-1',
		catalogVersion: 'catalog-1',
		commandTableRevision: 'b'.repeat(64),
		operationId: 'gmail.search',
		gmailWriteAllowed: false,
	},
	display: {
		accountId: '11111111-1111-4111-8111-111111111111',
		authorizationId: '22222222-2222-4222-8222-222222222222',
		accountAlias: 'Personal mailbox',
		applicationLabel: 'Gmail, Calendar & Contacts',
		authorizationMetadataRevision: 1,
	},
});
const intent = {
	backendKind: 'controller_execution',
	call: {
		arguments: { accountId: managedGoogle.binding.accountId, argv: ['gmail', 'search', 'unread'] },
		id: 'google-call',
		name: 'gog',
		namespace: 'google',
	},
	managedGoogle,
	operationId: '33333333-3333-4333-8333-333333333333',
	semanticRevisions: {
		activeRevision: 'active-1',
		bindingRevision: 'binding-1',
		catalogRevision: 'catalog-1',
		profilePolicyRevision: 'policy-1',
		providerRevision: 'provider-1',
		schemaRevision: 'schema-1',
	},
	surfaceClass: 'mcp',
	trustedContext: {
		correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
		principal: {
			agentId: 'sun',
			frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
			profileAssignmentRevision: 'assignment-1',
			toolPortalProfileId: 'profile-a',
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	},
} satisfies GatewayRuntimeApprovalChallengeIntent;
const operator = {
	approverId: 'operator-a',
	audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	provenance: 'managed-gateway',
	stablePrincipal: deriveGatewayControlStablePrincipal({
		principal: intent.trustedContext.principal,
	}),
} as const;

/** Inject only durable I/O completion; the ledger parses every stored record. */
function arrange(
	options: {
		readonly validateIntent?: LedgerOptions['validateIntent'];
		readonly afterPersist?: (record: ApprovalRecord) => void;
	} = {},
): ReturnType<typeof createControllerApprovalLedger> {
	const records = new Map<string, ApprovalRecord>();
	const store: ApprovalStore = {
		loadRecord: async (recordId) => records.get(recordId) ?? null,
		listRecords: async () => [...records.values()],
		mutateRecord: async (recordId, mutate) => {
			const mutation = await mutate(records.get(recordId) ?? null);
			if (mutation.nextRecord !== null) {
				records.set(recordId, mutation.nextRecord);
				options.afterPersist?.(mutation.nextRecord);
			}
			return mutation.result;
		},
	};
	return createControllerApprovalLedger({
		challengeTtlMs: 60_000,
		currentControllerEpoch: authorityContext.controllerEpoch,
		generateUuid: () => '44444444-4444-4444-8444-444444444444',
		now: () => Date.parse('2026-09-06T12:00:00.000Z'),
		recordsTarget: {
			kind: 'controller-approval-records',
			directoryPath: '/unused-unit-store',
			zoneId: authorityContext.zoneId,
		},
		store,
		validateIntent: options.validateIntent,
	});
}

async function requestChallenge(ledger: ReturnType<typeof arrange>): Promise<string> {
	const result = await ledger.requestApproval({ authorityContext, intent });
	if (result.kind !== 'approval-required') throw new Error('Expected approval challenge.');
	return result.challenge.approvalId;
}

async function approve(ledger: ReturnType<typeof arrange>, approvalId: string): Promise<void> {
	expect(
		await ledger.decide({ approvalId, authorityContext, decision: 'approve', operator }),
	).toMatchObject({ kind: 'recorded' });
}

describe('account-policy fencing at approval lifecycle boundaries', () => {
	it.each(['absent', 'throws', 'stale'] as const)(
		'refuses managed approval when current-policy validation is %s',
		async (mode) => {
			// Arrange
			const ledger = arrange({
				validateIntent:
					mode === 'absent'
						? undefined
						: () => {
								if (mode === 'throws') throw new Error('Policy unavailable.');
								return false;
							},
			});
			// Act
			const result = await ledger.requestApproval({ authorityContext, intent });
			// Assert
			expect(result).toMatchObject({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
			expect(await ledger.list()).toEqual([]);
		},
	);

	it('does not return a challenge that became stale while its record was persisted', async () => {
		// Arrange
		let current = true;
		const ledger = arrange({
			validateIntent: () => current,
			afterPersist: () => {
				current = false;
			},
		});
		// Act
		const result = await ledger.requestApproval({ authorityContext, intent });
		// Assert
		expect(result).toMatchObject({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
	});

	it('rejects a pending human decision after an account-policy change', async () => {
		// Arrange
		let current = true;
		const ledger = arrange({ validateIntent: () => current });
		const approvalId = await requestChallenge(ledger);
		current = false;
		// Act
		const result = await ledger.decide({
			approvalId,
			authorityContext,
			decision: 'approve',
			operator,
		});
		// Assert
		expect(result).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		expect(await ledger.read(approvalId)).toMatchObject({ kind: 'pending' });
	});

	it('does not report a current approval if policy changes while the decision is persisted', async () => {
		// Arrange
		let current = true;
		const ledger = arrange({
			validateIntent: () => current,
			afterPersist: (record) => {
				if (record.kind === 'approved') current = false;
			},
		});
		const approvalId = await requestChallenge(ledger);
		// Act
		const result = await ledger.decide({
			approvalId,
			authorityContext,
			decision: 'approve',
			operator,
		});
		// Assert
		expect(result).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		expect(await ledger.requestApproval({ authorityContext, intent })).toMatchObject({
			kind: 'not-dispatched',
			reason: 'stale-fingerprint',
		});
	});

	it('does not return a reservation that became stale during durable consumption', async () => {
		// Arrange
		let current = true;
		const ledger = arrange({
			validateIntent: () => current,
			afterPersist: (record) => {
				if (record.kind === 'consumed-not-dispatched') current = false;
			},
		});
		const approvalId = await requestChallenge(ledger);
		await approve(ledger, approvalId);
		// Act
		const result = await ledger.requestApproval({ authorityContext, intent });
		// Assert
		expect(result).toMatchObject({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
		expect(await ledger.read(approvalId)).toMatchObject({ kind: 'consumed-not-dispatched' });
	});

	it.each(['before-arm', 'during-arm'] as const)(
		'refuses a dispatch grant when policy becomes stale %s',
		async (stage) => {
			// Arrange
			let current = true;
			const ledger = arrange({
				validateIntent: () => current,
				afterPersist: (record) => {
					if (stage === 'during-arm' && record.kind === 'dispatch-armed') current = false;
				},
			});
			const approvalId = await requestChallenge(ledger);
			await approve(ledger, approvalId);
			const admission = await ledger.requestApproval({ authorityContext, intent });
			if (admission.kind !== 'dispatch-reserved') throw new Error('Expected reservation.');
			if (stage === 'before-arm') current = false;
			// Act
			const result = await ledger.armDispatch({
				authorityContext,
				reservation: admission.reservation,
			});
			// Assert
			expect(result).toMatchObject({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
			expect(await ledger.read(approvalId)).toMatchObject({
				kind: stage === 'during-arm' ? 'dispatch-armed' : 'consumed-not-dispatched',
			});
			if (stage === 'during-arm') {
				expect(await ledger.requestApproval({ authorityContext, intent })).toMatchObject({
					kind: 'ambiguous',
					reason: 'dispatch-armed',
				});
			}
		},
	);

	it('preserves armed ambiguity after policy changes instead of claiming the operation never ran', async () => {
		// Arrange
		let current = true;
		const ledger = arrange({ validateIntent: () => current });
		const approvalId = await requestChallenge(ledger);
		await approve(ledger, approvalId);
		const admission = await ledger.requestApproval({ authorityContext, intent });
		if (admission.kind !== 'dispatch-reserved') throw new Error('Expected reservation.');
		expect(
			await ledger.armDispatch({ authorityContext, reservation: admission.reservation }),
		).toMatchObject({ kind: 'dispatch-armed' });
		current = false;
		// Act / Assert
		expect(await ledger.requestApproval({ authorityContext, intent })).toMatchObject({
			kind: 'ambiguous',
		});
		expect(
			await ledger.armDispatch({ authorityContext, reservation: admission.reservation }),
		).toMatchObject({ kind: 'ambiguous' });
	});
});
