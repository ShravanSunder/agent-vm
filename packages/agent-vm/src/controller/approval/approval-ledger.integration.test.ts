import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	type GatewayRuntimeApprovalAuthorityContext,
	type GatewayRuntimeApprovalChallenge,
	type GatewayRuntimeApprovalChallengeIntent,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { ControllerApprovalRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import {
	createControllerApprovalLedger,
	type ControllerApprovalLedger,
	type ControllerApprovalOperatorIdentity,
} from './controller-approval-ledger.js';

const BASE_TIME_MS = Date.parse('2026-07-13T12:00:00.000Z');
const CHALLENGE_TTL_MS = 60_000;
const FIRST_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const GENERATED_UUIDS = [
	'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
	'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
	'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
] as const;

const authorityContext = {
	controllerEpoch: 'controller-epoch-1',
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	runtimeEpoch: 'runtime-epoch-1',
	zoneId: 'zone-a',
} satisfies GatewayRuntimeApprovalAuthorityContext;

const successorAuthorityContext = {
	...authorityContext,
	controllerEpoch: 'controller-epoch-2',
} satisfies GatewayRuntimeApprovalAuthorityContext;

const baseIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { issueTitle: 'Durable approval' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: FIRST_OPERATION_ID,
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
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
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
		principal: baseIntent.trustedContext.principal,
	}),
} satisfies ControllerApprovalOperatorIdentity;

const controllerExecutionIntent = {
	...baseIntent,
	backendKind: 'controller_execution',
	call: {
		arguments: {},
		id: 'controller_execution.controller_host_probe',
		name: 'controller_host_probe',
		namespace: 'controller_execution',
	},
	operationId: SECOND_OPERATION_ID,
} satisfies GatewayRuntimeApprovalChallengeIntent;

interface MutableTestClock {
	readonly advance: (milliseconds: number) => void;
	readonly now: () => number;
}

interface TestLedgerHarness {
	readonly clock: MutableTestClock;
	readonly ledger: ControllerApprovalLedger;
	readonly recordsDirectoryPath: string;
}

const temporaryDirectories: string[] = [];

function createMutableTestClock(initialTimeMs = BASE_TIME_MS): MutableTestClock {
	let currentTimeMs = initialTimeMs;
	return {
		advance: (milliseconds) => {
			currentTimeMs += milliseconds;
		},
		now: () => currentTimeMs,
	};
}

function createGeneratedUuidSequence(): () => string {
	let nextUuidIndex = 0;
	return () => {
		const generatedUuid = GENERATED_UUIDS[nextUuidIndex];
		if (generatedUuid === undefined) {
			throw new Error('Approval ledger test exhausted its deterministic UUID sequence.');
		}
		nextUuidIndex += 1;
		return generatedUuid;
	};
}

function createLedgerAtDirectory(props: {
	readonly clock: MutableTestClock;
	readonly currentControllerEpoch: string;
	readonly recordsDirectoryPath: string;
	readonly zoneId?: string;
}): ControllerApprovalLedger {
	const recordsTarget = {
		directoryPath: props.recordsDirectoryPath,
		kind: 'controller-approval-records',
		zoneId: props.zoneId ?? authorityContext.zoneId,
	} satisfies ControllerApprovalRecordsTarget;
	const ledgerOptions = {
		challengeTtlMs: CHALLENGE_TTL_MS,
		currentControllerEpoch: props.currentControllerEpoch,
		generateUuid: createGeneratedUuidSequence(),
		now: props.clock.now,
		recordsTarget,
	};
	return createControllerApprovalLedger(ledgerOptions);
}

async function createTestLedgerHarness(): Promise<TestLedgerHarness> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-approval-ledger-'));
	temporaryDirectories.push(temporaryDirectoryPath);
	const clock = createMutableTestClock();
	const recordsDirectoryPath = path.join(temporaryDirectoryPath, 'approval-records');
	return {
		clock,
		ledger: createLedgerAtDirectory({
			clock,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsDirectoryPath,
		}),
		recordsDirectoryPath,
	};
}

async function requireApprovalChallenge(
	ledger: ControllerApprovalLedger,
	intent: GatewayRuntimeApprovalChallengeIntent = baseIntent,
): Promise<GatewayRuntimeApprovalChallenge> {
	const result = await ledger.requestApproval({ authorityContext, intent });
	if (result.kind !== 'approval-required') {
		throw new Error(`Expected approval-required, received ${result.kind}.`);
	}
	return result.challenge;
}

async function approveChallenge(props: {
	readonly challenge: GatewayRuntimeApprovalChallenge;
	readonly ledger: ControllerApprovalLedger;
}): Promise<void> {
	const decision = await props.ledger.decide({
		approvalId: props.challenge.approvalId,
		authorityContext,
		decision: 'approve',
		operator,
	});
	expect(decision).toMatchObject({ decision: 'approve', kind: 'recorded' });
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('controller approval ledger durability and authority', () => {
	it('writes directly to the typed approval collection without appending a legacy suffix', async () => {
		// Arrange
		const { ledger, recordsDirectoryPath } = await createTestLedgerHarness();

		// Act
		const challenge = await requireApprovalChallenge(ledger);

		// Assert
		expect(await readdir(recordsDirectoryPath)).toEqual([`${challenge.approvalId}.json`]);
	});

	it('fails closed when a stored approval record belongs to another target zone', async () => {
		// Arrange
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-cross-zone-approval-ledger-'),
		);
		temporaryDirectories.push(temporaryDirectoryPath);
		const recordsDirectoryPath = path.join(temporaryDirectoryPath, 'approval-records');
		const clock = createMutableTestClock();
		const foreignAuthorityContext = { ...authorityContext, zoneId: 'zone-b' };
		const foreignLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: foreignAuthorityContext.controllerEpoch,
			recordsDirectoryPath,
			zoneId: foreignAuthorityContext.zoneId,
		});
		const foreignAdmission = await foreignLedger.requestApproval({
			authorityContext: foreignAuthorityContext,
			intent: baseIntent,
		});
		if (foreignAdmission.kind !== 'approval-required') {
			throw new Error(`Expected approval-required, received ${foreignAdmission.kind}.`);
		}
		const localLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsDirectoryPath,
		});

		// Act / Assert
		await expect(localLedger.read(foreignAdmission.challenge.approvalId)).rejects.toThrow(
			/approval record zone.*zone-b.*target zone.*zone-a/iu,
		);
		await expect(localLedger.list()).rejects.toThrow(
			/approval record zone.*zone-b.*target zone.*zone-a/iu,
		);
		await expect(
			localLedger.decide({
				approvalId: foreignAdmission.challenge.approvalId,
				authorityContext,
				decision: 'approve',
				operator,
			}),
		).rejects.toThrow(/approval record zone.*zone-b.*target zone.*zone-a/iu);
	});

	it('rejects cross-zone authority before creating an approval record', async () => {
		// Arrange
		const { ledger, recordsDirectoryPath } = await createTestLedgerHarness();

		// Act / Assert
		await expect(
			ledger.requestApproval({
				authorityContext: { ...authorityContext, zoneId: 'zone-b' },
				intent: baseIntent,
			}),
		).rejects.toThrow(/authority zone.*zone-b.*target zone.*zone-a/iu);
		await expect(readdir(recordsDirectoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('reuses one pending challenge without changing its identity or fingerprint', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();

		// Act
		const firstChallenge = await requireApprovalChallenge(ledger);
		const repeatedChallenge = await requireApprovalChallenge(ledger);
		const storedView = await ledger.read(firstChallenge.approvalId);

		// Assert
		expect(repeatedChallenge).toEqual(firstChallenge);
		expect(firstChallenge.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(storedView).toEqual({ challenge: firstChallenge, kind: 'pending' });
	});

	it('approves, reserves once, and arms one immutable operation-bound grant', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });

		// Act
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}
		const armResult = await ledger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});
		const storedView = await ledger.read(challenge.approvalId);

		// Assert
		expect(reservationResult.reservation).toMatchObject({
			approvalId: challenge.approvalId,
			authorityContext,
			fingerprint: challenge.fingerprint,
			operationId: challenge.intent.operationId,
		});
		expect(armResult).toMatchObject({
			grant: {
				approvalId: challenge.approvalId,
				authorityContext,
				fingerprint: challenge.fingerprint,
				operationId: challenge.intent.operationId,
			},
			kind: 'dispatch-armed',
		});
		expect(storedView).toMatchObject({ challenge, kind: 'dispatch-armed' });
	});

	it('atomically arms one controller-execution reservation and rejects replay', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger, controllerExecutionIntent);
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: controllerExecutionIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind !== 'controller_execution'
		) {
			throw new Error('Expected a controller-execution dispatch reservation.');
		}

		// Act
		const armResult = await ledger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});
		const replayResult = await ledger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(armResult).toMatchObject({
			grant: {
				approvalId: challenge.approvalId,
				authorityContext,
				backendKind: 'controller_execution',
				fingerprint: challenge.fingerprint,
				operationId: controllerExecutionIntent.operationId,
			},
			kind: 'dispatch-armed',
		});
		expect(replayResult).toEqual({
			kind: 'ambiguous',
			operationId: controllerExecutionIntent.operationId,
			reason: 'dispatch-armed',
		});
		expect(await ledger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'dispatch-armed',
		});
	});

	it('retains a denial and never dispatches the denied operation', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);

		// Act
		const decision = await ledger.decide({
			approvalId: challenge.approvalId,
			authorityContext,
			decision: 'deny',
			operator,
		});
		const replay = await ledger.requestApproval({ authorityContext, intent: baseIntent });

		// Assert
		expect(decision).toMatchObject({ decision: 'deny', kind: 'recorded' });
		expect(replay).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'denied',
		});
	});

	it('retains revocation of an approval and rejects later dispatch', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });

		// Act
		const revocation = await ledger.revoke({
			approvalId: challenge.approvalId,
			authorityContext,
			operator,
		});
		const repeatedRevocation = await ledger.revoke({
			approvalId: challenge.approvalId,
			authorityContext,
			operator,
		});
		const replay = await ledger.requestApproval({ authorityContext, intent: baseIntent });

		// Assert
		expect(revocation).toMatchObject({ kind: 'recorded', view: { challenge, kind: 'revoked' } });
		expect(repeatedRevocation).toEqual({ kind: 'rejected', reason: 'already-revoked' });
		expect(replay).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'revoked',
		});
	});

	it('rejects decision and replay at the exact challenge expiry boundary', async () => {
		// Arrange
		const { clock, ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		clock.advance(CHALLENGE_TTL_MS);

		// Act
		const decision = await ledger.decide({
			approvalId: challenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator,
		});
		const replay = await ledger.requestApproval({ authorityContext, intent: baseIntent });

		// Assert
		expect(decision).toEqual({ kind: 'rejected', reason: 'expired' });
		expect(replay).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'expired',
		});
	});

	it('does not arm a reservation that expires before dispatch is armed', async () => {
		// Arrange
		const { clock, ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}
		clock.advance(CHALLENGE_TTL_MS);

		// Act
		const armResult = await ledger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(armResult).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'expired',
		});
		expect(await ledger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('rejects cross-authority decisions and dispatch arming', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);

		// Act
		const staleDecision = await ledger.decide({
			approvalId: challenge.approvalId,
			authorityContext: successorAuthorityContext,
			decision: 'approve',
			operator,
		});
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}
		const staleArm = await ledger.armDispatch({
			authorityContext: successorAuthorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(staleDecision).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		expect(staleArm).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'stale-authority',
		});
		expect(await ledger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it.each([
		{
			changedIntent: {
				...baseIntent,
				call: { ...baseIntent.call, arguments: { issueTitle: 'Changed arguments' } },
			},
			name: 'canonical arguments',
		},
		{
			changedIntent: {
				...baseIntent,
				trustedContext: {
					...baseIntent.trustedContext,
					principal: {
						...baseIntent.trustedContext.principal,
						toolPortalProfileId: 'profile-b',
					},
				},
			},
			name: 'stable profile principal',
		},
		{
			changedIntent: { ...baseIntent, surfaceClass: 'protected_uds' as const },
			name: 'surface class',
		},
	] satisfies readonly {
		readonly changedIntent: GatewayRuntimeApprovalChallengeIntent;
		readonly name: string;
	}[])('requires a distinct approval when $name changes', async ({ changedIntent }) => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const originalChallenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge: originalChallenge, ledger });

		// Act
		const changedChallenge = await requireApprovalChallenge(ledger, changedIntent);

		// Assert
		expect(changedChallenge.approvalId).not.toBe(originalChallenge.approvalId);
		expect(changedChallenge.fingerprint).not.toBe(originalChallenge.fingerprint);
		expect(await ledger.read(originalChallenge.approvalId)).toMatchObject({
			challenge: originalChallenge,
			kind: 'approved',
		});
	});

	it('rejects a changed dispatch fingerprint without mutating the durable reservation', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}

		// Act
		const changedFingerprintResult = await ledger.armDispatch({
			authorityContext,
			reservation: {
				...reservationResult.reservation,
				fingerprint: `sha256:${'b'.repeat(64)}`,
			},
		});

		// Assert
		expect(changedFingerprintResult).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'stale-fingerprint',
		});
		expect(await ledger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('atomically permits only one reservation under concurrent double consume', async () => {
		// Arrange
		const { ledger } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });

		// Act
		const concurrentResults = await Promise.all([
			ledger.requestApproval({ authorityContext, intent: baseIntent }),
			ledger.requestApproval({ authorityContext, intent: baseIntent }),
		]);

		// Assert
		expect(concurrentResults.filter((result) => result.kind === 'dispatch-reserved')).toHaveLength(
			1,
		);
		expect(concurrentResults).toContainEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'consumed-without-dispatch',
		});
		expect(await ledger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('restores exact records after restart and exposes operator list and read views', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const approvedChallenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge: approvedChallenge, ledger });
		const pendingIntent = { ...baseIntent, operationId: SECOND_OPERATION_ID };
		const pendingChallenge = await requireApprovalChallenge(ledger, pendingIntent);

		// Act
		const restartedLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsDirectoryPath,
		});
		const approvedView = await restartedLedger.read(approvedChallenge.approvalId);
		const pendingView = await restartedLedger.read(pendingChallenge.approvalId);
		const operatorViews = await restartedLedger.list();

		// Assert
		expect(approvedView).toMatchObject({ challenge: approvedChallenge, kind: 'approved' });
		expect(pendingView).toEqual({ challenge: pendingChallenge, kind: 'pending' });
		expect(operatorViews).toHaveLength(2);
		expect(operatorViews).toEqual(expect.arrayContaining([approvedView, pendingView]));
		expect(await restartedLedger.read('33333333-3333-4333-8333-333333333333')).toBeNull();
	});

	it.each([
		{ approveBeforeRestart: false, predecessorState: 'pending' },
		{ approveBeforeRestart: true, predecessorState: 'approved' },
	] as const)(
		'does not dispatch a restored predecessor $predecessorState record under a fresh controller epoch',
		async ({ approveBeforeRestart, predecessorState }) => {
			// Arrange
			const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
			const predecessorChallenge = await requireApprovalChallenge(ledger);
			if (approveBeforeRestart) {
				await approveChallenge({ challenge: predecessorChallenge, ledger });
			}

			// Act
			const successorLedger = createLedgerAtDirectory({
				clock,
				currentControllerEpoch: successorAuthorityContext.controllerEpoch,
				recordsDirectoryPath,
			});
			const successorAdmission = await successorLedger.requestApproval({
				authorityContext: successorAuthorityContext,
				intent: baseIntent,
			});

			// Assert
			expect(successorAdmission).toMatchObject({ kind: 'approval-required' });
			if (successorAdmission.kind !== 'approval-required') {
				throw new Error(`Expected approval-required, received ${successorAdmission.kind}.`);
			}
			expect(successorAdmission.challenge).toMatchObject({
				intent: baseIntent,
			});
			expect(successorAdmission.challenge.approvalId).not.toBe(predecessorChallenge.approvalId);
			expect(successorAdmission.challenge.fingerprint).not.toBe(predecessorChallenge.fingerprint);
			expect(await successorLedger.read(predecessorChallenge.approvalId)).toMatchObject({
				challenge: predecessorChallenge,
				kind: predecessorState,
			});
		},
	);

	it('does not arm a restored predecessor reservation under a fresh controller epoch', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const predecessorChallenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge: predecessorChallenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}

		// Act
		const successorLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: successorAuthorityContext.controllerEpoch,
			recordsDirectoryPath,
		});
		const successorArm = await successorLedger.armDispatch({
			authorityContext: successorAuthorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(successorArm).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'stale-authority',
		});
		expect(await successorLedger.read(predecessorChallenge.approvalId)).toMatchObject({
			challenge: predecessorChallenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('rejects a predecessor decision after reopening under the successor controller epoch', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const predecessorChallenge = await requireApprovalChallenge(ledger);
		const successorLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: successorAuthorityContext.controllerEpoch,
			recordsDirectoryPath,
		});

		// Act
		const predecessorDecision = await successorLedger.decide({
			approvalId: predecessorChallenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator,
		});

		// Assert
		expect(predecessorDecision).toEqual({ kind: 'rejected', reason: 'stale-authority' });
		expect(await successorLedger.read(predecessorChallenge.approvalId)).toEqual({
			challenge: predecessorChallenge,
			kind: 'pending',
		});
	});

	it('rejects predecessor approval consumption after reopening under the successor controller epoch', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const predecessorChallenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge: predecessorChallenge, ledger });
		const successorLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: successorAuthorityContext.controllerEpoch,
			recordsDirectoryPath,
		});

		// Act
		const predecessorAdmission = await successorLedger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});

		// Assert
		expect(predecessorAdmission).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'stale-authority',
		});
		expect(await successorLedger.read(predecessorChallenge.approvalId)).toMatchObject({
			challenge: predecessorChallenge,
			kind: 'approved',
		});
	});

	it('rejects predecessor reservation arming after reopening under the successor controller epoch', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const predecessorChallenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge: predecessorChallenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}
		const successorLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: successorAuthorityContext.controllerEpoch,
			recordsDirectoryPath,
		});

		// Act
		const predecessorArm = await successorLedger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(predecessorArm).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'stale-authority',
		});
		expect(await successorLedger.read(predecessorChallenge.approvalId)).toMatchObject({
			challenge: predecessorChallenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('restores consumed-not-dispatched as proven non-dispatch and never auto-replays it', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		expect(reservationResult.kind).toBe('dispatch-reserved');

		// Act
		const restartedLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsDirectoryPath,
		});
		const replay = await restartedLedger.requestApproval({ authorityContext, intent: baseIntent });

		// Assert
		expect(replay).toEqual({
			kind: 'not-dispatched',
			operationId: FIRST_OPERATION_ID,
			reason: 'consumed-without-dispatch',
		});
		expect(await restartedLedger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'consumed-not-dispatched',
		});
	});

	it('restores dispatch-armed as permanently ambiguous and never auto-replays it', async () => {
		// Arrange
		const { clock, ledger, recordsDirectoryPath } = await createTestLedgerHarness();
		const challenge = await requireApprovalChallenge(ledger);
		await approveChallenge({ challenge, ledger });
		const reservationResult = await ledger.requestApproval({
			authorityContext,
			intent: baseIntent,
		});
		if (
			reservationResult.kind !== 'dispatch-reserved' ||
			reservationResult.reservation.backendKind === 'controller_execution'
		) {
			throw new Error(`Expected dispatch-reserved, received ${reservationResult.kind}.`);
		}
		const armResult = await ledger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});
		expect(armResult.kind).toBe('dispatch-armed');
		clock.advance(CHALLENGE_TTL_MS);

		// Act
		const restartedLedger = createLedgerAtDirectory({
			clock,
			currentControllerEpoch: authorityContext.controllerEpoch,
			recordsDirectoryPath,
		});
		const replay = await restartedLedger.requestApproval({ authorityContext, intent: baseIntent });
		const repeatedArm = await restartedLedger.armDispatch({
			authorityContext,
			reservation: reservationResult.reservation,
		});

		// Assert
		expect(replay).toEqual({
			kind: 'ambiguous',
			operationId: FIRST_OPERATION_ID,
			reason: 'dispatch-armed',
		});
		expect(repeatedArm).toEqual({
			kind: 'ambiguous',
			operationId: FIRST_OPERATION_ID,
			reason: 'dispatch-armed',
		});
		expect(await restartedLedger.read(challenge.approvalId)).toMatchObject({
			challenge,
			kind: 'dispatch-armed',
		});
	});
});
