import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
	createStandaloneToolPortalApprovalCoordinator,
	createStandaloneToolPortalApprovalToken,
	deriveStandaloneToolPortalApprovalBatchFingerprint,
	STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE,
	type StandaloneToolPortalApprovalBatchIntent,
	type StandaloneToolPortalApprovalCoordinator,
} from './standalone-tool-portal-approval.js';

const serviceGeneration = 'standalone-service:1';
const principal = {
	agentId: 'agent-a',
	credentialVersion: 1,
	profileAssignmentRevision: 'profile-assignment:1',
	toolPortalProfileId: 'builder',
} as const;
const authenticatedEnvelope = {
	audience: 'tool-portal:mcp',
	principal,
	serviceGeneration,
} as const;
const semanticRevisions = {
	activeRevision: 'active:1',
	bindingRevision: 'binding:1',
	catalogRevision: 'catalog:1',
	profilePolicyRevision: 'policy:1',
	providerRevision: 'provider:1',
	schemaRevision: 'schema:1',
} as const;
const firstProtectedCall = {
	call: {
		arguments: { issue: 42 },
		id: 'call-a',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: 'operation-a',
} as const;
const secondProtectedCall = {
	call: {
		arguments: { branch: 'main' },
		id: 'call-b',
		name: 'delete_branch',
		namespace: 'github',
	},
	operationId: 'operation-b',
} as const;
const intent = {
	authenticatedEnvelope,
	protectedCalls: [firstProtectedCall, secondProtectedCall],
	semanticRevisions,
	surfaceClass: 'mcp',
} as const satisfies StandaloneToolPortalApprovalBatchIntent;

const now = new Date('2026-07-16T18:00:00.000Z');
const hmacKey = 'standalone-tool-portal-approval-secret';

interface CreateCoordinatorProps {
	readonly credentials?: readonly {
		readonly agentId: string;
		readonly hmacKey: string;
		readonly keyVersion: number;
	}[];
	readonly maximumConsumedTokens?: number;
	readonly maximumTokenLifetimeMs?: number;
	readonly now?: () => Date;
	readonly serviceGeneration?: string;
}

function createCoordinator(
	props: CreateCoordinatorProps = {},
): StandaloneToolPortalApprovalCoordinator {
	return createStandaloneToolPortalApprovalCoordinator({
		credentials: props.credentials ?? [{ agentId: 'agent-a', hmacKey, keyVersion: 1 }],
		...(props.maximumConsumedTokens === undefined
			? {}
			: { maximumConsumedTokens: props.maximumConsumedTokens }),
		...(props.maximumTokenLifetimeMs === undefined
			? {}
			: { maximumTokenLifetimeMs: props.maximumTokenLifetimeMs }),
		now: props.now ?? (() => now),
		serviceGeneration: props.serviceGeneration ?? serviceGeneration,
	});
}

interface CreateTokenProps {
	readonly expiresAt?: string;
	readonly hmacKey?: string;
	readonly intent?: StandaloneToolPortalApprovalBatchIntent;
	readonly keyVersion?: number;
	readonly override?: Readonly<Record<string, unknown>>;
	readonly tokenId: string;
}

interface SubmittedToolCall {
	readonly call: {
		readonly arguments: Readonly<Record<string, unknown>>;
		readonly id: string;
		readonly name: string;
		readonly namespace: string;
	};
	readonly operationId: string;
	readonly requiresApproval: boolean;
}

function createToken(props: CreateTokenProps): string {
	return createStandaloneToolPortalApprovalToken({
		expiresAt: props.expiresAt ?? '2026-07-16T18:05:00.000Z',
		hmacKey: props.hmacKey ?? hmacKey,
		intent: props.intent ?? intent,
		keyVersion: props.keyVersion ?? 1,
		...(props.override === undefined ? {} : { override: props.override }),
		tokenId: props.tokenId,
	});
}

describe('standalone Tool Portal ordered-batch HMAC approval', () => {
	it('reserves and arms one token for the exact ordered protected-call subset', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '10000000-0000-4000-8000-000000000001',
		});

		// Act
		const reservationResult = coordinator.reserveDispatch(intent, approvalToken);
		if (reservationResult.kind !== 'dispatch-reserved') {
			throw new Error(`Expected dispatch reservation, received ${reservationResult.kind}.`);
		}
		const armResult = coordinator.armDispatch(reservationResult.reservation);

		// Assert
		expect(reservationResult.reservation.operationIds).toEqual(['operation-a', 'operation-b']);
		expect(armResult).toMatchObject({
			authority: {
				kind: 'standalone-hmac-batch',
				operationIds: ['operation-a', 'operation-b'],
				serviceGeneration,
			},
			kind: 'dispatch-authorized',
		});
	});

	it('rejects the same protected calls in a different order', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '20000000-0000-4000-8000-000000000002',
		});
		const reorderedIntent = {
			...intent,
			protectedCalls: [secondProtectedCall, firstProtectedCall],
		} satisfies StandaloneToolPortalApprovalBatchIntent;

		// Act
		const result = coordinator.reserveDispatch(reorderedIntent, approvalToken);

		// Assert
		expect(result).toEqual({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
	});

	it('binds the approval fingerprint to the direct HTTP or MCP surface', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '21000000-0000-4000-8000-000000000002',
		});
		const directHttpIntent = {
			...intent,
			surfaceClass: 'http',
		} satisfies StandaloneToolPortalApprovalBatchIntent;

		// Act
		const result = coordinator.reserveDispatch(directHttpIntent, approvalToken);

		// Assert
		expect(result).toEqual({ kind: 'not-dispatched', reason: 'stale-fingerprint' });
	});

	it('excludes unprotected submitted calls from the approval fingerprint', () => {
		// Arrange
		const unprotectedCallBeforeChange: SubmittedToolCall = {
			call: {
				arguments: { query: 'before' },
				id: 'call-unprotected',
				name: 'search',
				namespace: 'github',
			},
			operationId: 'operation-unprotected',
			requiresApproval: false,
		};
		const unprotectedCallAfterChange: SubmittedToolCall = {
			...unprotectedCallBeforeChange,
			call: {
				...unprotectedCallBeforeChange.call,
				arguments: { query: 'after' },
			},
		};
		const submittedCallsBeforeApproval: readonly SubmittedToolCall[] = [
			{ ...firstProtectedCall, requiresApproval: true },
			unprotectedCallBeforeChange,
			{ ...secondProtectedCall, requiresApproval: true },
		];
		const submittedCallsAfterUnprotectedChange: readonly SubmittedToolCall[] = [
			{ ...firstProtectedCall, requiresApproval: true },
			unprotectedCallAfterChange,
			{ ...secondProtectedCall, requiresApproval: true },
		];
		const toIntent = (
			submittedCalls: readonly SubmittedToolCall[],
		): StandaloneToolPortalApprovalBatchIntent => ({
			authenticatedEnvelope,
			protectedCalls: submittedCalls
				.filter(({ requiresApproval }) => requiresApproval)
				.map(({ call, operationId }) => ({ call, operationId })),
			semanticRevisions,
			surfaceClass: 'mcp',
		});

		// Act
		const beforeFingerprint = deriveStandaloneToolPortalApprovalBatchFingerprint(
			toIntent(submittedCallsBeforeApproval),
		);
		const afterFingerprint = deriveStandaloneToolPortalApprovalBatchFingerprint(
			toIntent(submittedCallsAfterUnprotectedChange),
		);

		// Assert
		expect(afterFingerprint).toBe(beforeFingerprint);
	});

	it('returns a fingerprinted challenge when no approval token is provided', () => {
		// Arrange
		const coordinator = createCoordinator();

		// Act
		const result = coordinator.reserveDispatch(intent);

		// Assert
		expect(result).toMatchObject({
			challenge: {
				createdAt: now.toISOString(),
				fingerprint: deriveStandaloneToolPortalApprovalBatchFingerprint(intent),
			},
			kind: 'approval-required',
		});
	});

	it('reports consumed-without-dispatch when a reserved token is replayed before arming', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '30000000-0000-4000-8000-000000000003',
		});
		expect(coordinator.reserveDispatch(intent, approvalToken).kind).toBe('dispatch-reserved');

		// Act
		const replay = coordinator.reserveDispatch(intent, approvalToken);

		// Assert
		expect(replay).toEqual({
			kind: 'not-dispatched',
			reason: 'consumed-without-dispatch',
		});
	});

	it('reports ambiguous when an armed token is replayed', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '40000000-0000-4000-8000-000000000004',
		});
		const reservationResult = coordinator.reserveDispatch(intent, approvalToken);
		if (reservationResult.kind !== 'dispatch-reserved') {
			throw new Error(`Expected dispatch reservation, received ${reservationResult.kind}.`);
		}
		expect(coordinator.armDispatch(reservationResult.reservation).kind).toBe('dispatch-authorized');

		// Act
		const replay = coordinator.reserveDispatch(intent, approvalToken);

		// Assert
		expect(replay).toEqual({ kind: 'ambiguous', reason: 'dispatch-armed' });
	});

	it('records positive non-dispatch proof only before dispatch is armed', () => {
		// Arrange
		const coordinator = createCoordinator();
		const approvalToken = createToken({
			tokenId: '50000000-0000-4000-8000-000000000005',
		});
		const reservationResult = coordinator.reserveDispatch(intent, approvalToken);
		if (reservationResult.kind !== 'dispatch-reserved') {
			throw new Error(`Expected dispatch reservation, received ${reservationResult.kind}.`);
		}

		// Act
		const firstProof = coordinator.proveNotDispatched(reservationResult.reservation);
		const repeatedProof = coordinator.proveNotDispatched(reservationResult.reservation);
		const armResult = coordinator.armDispatch(reservationResult.reservation);

		// Assert
		expect(firstProof).toBe(true);
		expect(repeatedProof).toBe(false);
		expect(armResult).toEqual({
			kind: 'not-dispatched',
			reason: 'consumed-without-dispatch',
		});
	});

	it('rejects an old token after restart with a new service generation', () => {
		// Arrange
		const oldToken = createToken({
			tokenId: '60000000-0000-4000-8000-000000000006',
		});
		const restartedGeneration = 'standalone-service:2';
		const restartedIntent = {
			...intent,
			authenticatedEnvelope: {
				...authenticatedEnvelope,
				serviceGeneration: restartedGeneration,
			},
		} satisfies StandaloneToolPortalApprovalBatchIntent;
		const restartedCoordinator = createCoordinator({
			serviceGeneration: restartedGeneration,
		});

		// Act
		const result = restartedCoordinator.reserveDispatch(restartedIntent, oldToken);

		// Assert
		expect(result).toEqual({ kind: 'not-dispatched', reason: 'stale-generation' });
	});

	it('rejects excessive token lifetime without consuming bounded capacity', () => {
		// Arrange
		const coordinator = createCoordinator({
			maximumConsumedTokens: 1,
			maximumTokenLifetimeMs: 60_000,
		});
		const farFutureToken = createToken({
			expiresAt: '2026-07-16T18:02:00.000Z',
			tokenId: '70000000-0000-4000-8000-000000000007',
		});
		const validToken = createToken({
			expiresAt: '2026-07-16T18:01:00.000Z',
			tokenId: '80000000-0000-4000-8000-000000000008',
		});

		// Act
		const farFutureResult = coordinator.reserveDispatch(intent, farFutureToken);
		const validResult = coordinator.reserveDispatch(intent, validToken);

		// Assert
		expect(farFutureResult).toEqual({ kind: 'not-dispatched', reason: 'invalid-proof' });
		expect(validResult.kind).toBe('dispatch-reserved');
	});

	it('saturates bounded token state until expired tombstones are pruned', () => {
		// Arrange
		let currentTime = now;
		const coordinator = createCoordinator({
			maximumConsumedTokens: 1,
			now: () => currentTime,
		});
		const firstToken = createToken({
			expiresAt: '2026-07-16T18:01:00.000Z',
			tokenId: '90000000-0000-4000-8000-000000000009',
		});
		const secondToken = createToken({
			expiresAt: '2026-07-16T18:03:00.000Z',
			tokenId: 'a0000000-0000-4000-8000-00000000000a',
		});
		expect(coordinator.reserveDispatch(intent, firstToken).kind).toBe('dispatch-reserved');

		// Act
		const saturatedResult = coordinator.reserveDispatch(intent, secondToken);
		currentTime = new Date('2026-07-16T18:01:01.000Z');
		const afterPruneResult = coordinator.reserveDispatch(intent, secondToken);

		// Assert
		expect(saturatedResult).toEqual({ kind: 'not-dispatched', reason: 'saturated' });
		expect(afterPruneResult.kind).toBe('dispatch-reserved');
	});

	it('retains the highest credential version across removal and rejects rollback on re-add', () => {
		// Arrange
		const coordinator = createCoordinator();
		coordinator.activateCredentials([]);

		// Act
		const reAddOldVersion = (): void =>
			coordinator.activateCredentials([{ agentId: 'agent-a', hmacKey, keyVersion: 1 }]);
		const addNewVersion = (): void =>
			coordinator.activateCredentials([
				{ agentId: 'agent-a', hmacKey: 'rotated-approval-secret', keyVersion: 2 },
			]);

		// Assert
		expect(reAddOldVersion).toThrow(/must increase/u);
		expect(addNewVersion).not.toThrow();
	});

	it('sorts canonical object keys by UTF-8 bytes rather than locale', () => {
		// Arrange
		const byteOrderIntent = {
			...intent,
			protectedCalls: [
				{
					...firstProtectedCall,
					call: {
						...firstProtectedCall.call,
						arguments: { ä: 'utf8-second', z: 'ascii-first' },
					},
				},
			],
		} satisfies StandaloneToolPortalApprovalBatchIntent;
		const canonicalIntentJson =
			'{"authenticatedEnvelope":{"audience":"tool-portal:mcp","principal":{"agentId":"agent-a","credentialVersion":1,"profileAssignmentRevision":"profile-assignment:1","toolPortalProfileId":"builder"},"serviceGeneration":"standalone-service:1"},"protectedCalls":[{"call":{"arguments":{"z":"ascii-first","ä":"utf8-second"},"id":"call-a","name":"create_issue","namespace":"github"},"operationId":"operation-a"}],"semanticRevisions":{"activeRevision":"active:1","bindingRevision":"binding:1","catalogRevision":"catalog:1","profilePolicyRevision":"policy:1","providerRevision":"provider:1","schemaRevision":"schema:1"},"surfaceClass":"mcp"}';
		const expectedFingerprint = `sha256:${createHash('sha256')
			.update('standalone-tool-portal-protected-batch-v1', 'utf8')
			.update('\0')
			.update(canonicalIntentJson, 'utf8')
			.digest('hex')}`;

		// Act
		const fingerprint = deriveStandaloneToolPortalApprovalBatchFingerprint(byteOrderIntent);

		// Assert
		expect(fingerprint).toBe(expectedFingerprint);
	});

	it('uses a Tool-Portal-only approval audience', () => {
		// Arrange / Act / Assert
		expect(STANDALONE_TOOL_PORTAL_APPROVAL_AUDIENCE).toBe('tool-portal:approval:v1');
	});
});
