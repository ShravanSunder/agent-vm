import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	type GatewayRuntimeApprovalAuthorityContext,
	type GatewayRuntimeApprovalChallenge,
	type GatewayRuntimeApprovalChallengeIntent,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createControllerApprovalLedger,
	type ControllerApprovalLedger,
	type ControllerApprovalOperatorIdentity,
} from '../approval/controller-approval-ledger.js';
import type { ControllerApprovalRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import type { ControllerLeaseManager } from './controller-http-route-support.js';
import { createControllerApp } from './controller-http-routes.js';

const ZONE_ID = 'zone-a';
const OTHER_ZONE_ID = 'zone-b';
const CURRENT_APPROVAL_CREDENTIAL = 'current-approval-credential';
const STALE_APPROVAL_CREDENTIAL = 'stale-approval-credential';
const ADMIN_CREDENTIAL = 'zone-admin-credential';
const WRONG_AUDIENCE_CREDENTIAL = 'managed-mcp-credential';
const UNKNOWN_CREDENTIAL = 'unknown-credential';
const STABLE_CREDENTIAL_ID =
	'sha256:8888888888888888888888888888888888888888888888888888888888888888';
const BASE_TIME_MS = Date.parse('2026-07-13T12:00:00.000Z');

const authorityContext = {
	controllerEpoch: 'controller-epoch-1',
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	runtimeEpoch: 'runtime-epoch-1',
	zoneId: ZONE_ID,
} satisfies GatewayRuntimeApprovalAuthorityContext;

const challengeIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { issueTitle: 'Protected operator approval' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: '11111111-1111-4111-8111-111111111111',
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
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'assignment-1',
			toolPortalProfileId: 'profile-a',
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	},
} satisfies GatewayRuntimeApprovalChallengeIntent;

const authenticatedOperator = {
	approverId: 'primary-operator',
	audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	credentialId: STABLE_CREDENTIAL_ID,
	provenance: 'approval-access',
} satisfies ControllerApprovalOperatorIdentity;

interface ApprovalBearerAuthenticationRequest {
	readonly authorizationHeader: string | undefined;
	readonly zoneId: string;
}

type ApprovalBearerAuthenticationResult =
	| {
			readonly kind: 'authenticated';
			readonly operator: ControllerApprovalOperatorIdentity;
	  }
	| {
			readonly kind: 'unauthorized';
			readonly reason: 'malformed' | 'missing' | 'stale' | 'unknown';
	  }
	| {
			readonly kind: 'forbidden';
			readonly reason: 'recognized-non-approval-credential' | 'wrong-audience';
	  };

interface ControllerApprovalRoutePorts {
	readonly authenticateBearer: (
		request: ApprovalBearerAuthenticationRequest,
	) => Promise<ApprovalBearerAuthenticationResult>;
	readonly readCurrentAuthorityContext: (
		zoneId: string,
	) => Promise<GatewayRuntimeApprovalAuthorityContext | null>;
	readonly resolveLedger: (zoneId: string) => ControllerApprovalLedger | null;
}

interface ApprovalRouteTestHarness {
	readonly app: ReturnType<typeof createControllerApp>;
	readonly authenticateBearer: ReturnType<typeof vi.fn>;
	readonly challenge: GatewayRuntimeApprovalChallenge;
	readonly ledger: ControllerApprovalLedger;
	readonly readCurrentAuthorityContext: ReturnType<typeof vi.fn>;
	readonly resolveLedger: ReturnType<typeof vi.fn>;
	readonly setCurrentAuthorityContext: (authority: GatewayRuntimeApprovalAuthorityContext) => void;
}

const temporaryDirectories: string[] = [];

function createLeaseManagerStub(): ControllerLeaseManager {
	return {
		createLease: vi.fn(async () => {
			throw new Error('approval route tests must not create Tool VM leases');
		}),
		listLeases: vi.fn(() => []),
		peekLease: vi.fn(() => undefined),
		releaseLease: vi.fn(async () => {}),
		renewLease: vi.fn(
			async (): ReturnType<ControllerLeaseManager['renewLease']> => ({
				kind: 'not-found',
				reason: 'missing',
			}),
		),
	};
}

function classifyAuthorizationHeader(
	request: ApprovalBearerAuthenticationRequest,
): ApprovalBearerAuthenticationResult {
	if (request.authorizationHeader === undefined) {
		return { kind: 'unauthorized', reason: 'missing' };
	}
	if (!request.authorizationHeader.startsWith('Bearer ')) {
		return { kind: 'unauthorized', reason: 'malformed' };
	}
	const credential = request.authorizationHeader.slice('Bearer '.length);
	switch (credential) {
		case CURRENT_APPROVAL_CREDENTIAL:
			return { kind: 'authenticated', operator: authenticatedOperator };
		case STALE_APPROVAL_CREDENTIAL:
			return { kind: 'unauthorized', reason: 'stale' };
		case ADMIN_CREDENTIAL:
			return { kind: 'forbidden', reason: 'recognized-non-approval-credential' };
		case WRONG_AUDIENCE_CREDENTIAL:
			return { kind: 'forbidden', reason: 'wrong-audience' };
		default:
			return { kind: 'unauthorized', reason: 'unknown' };
	}
}

async function requireChallenge(
	ledger: ControllerApprovalLedger,
): Promise<GatewayRuntimeApprovalChallenge> {
	const result = await ledger.requestApproval({ authorityContext, intent: challengeIntent });
	if (result.kind !== 'approval-required') {
		throw new Error(`Expected approval-required, received ${result.kind}.`);
	}
	return result.challenge;
}

async function createApprovalRouteTestHarness(): Promise<ApprovalRouteTestHarness> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-approval-routes-'));
	temporaryDirectories.push(temporaryDirectoryPath);
	const recordsTarget = {
		directoryPath: path.join(temporaryDirectoryPath, 'approval-records'),
		kind: 'controller-approval-records',
		zoneId: ZONE_ID,
	} satisfies ControllerApprovalRecordsTarget;
	const ledger = createControllerApprovalLedger({
		challengeTtlMs: 60_000,
		currentControllerEpoch: authorityContext.controllerEpoch,
		now: () => BASE_TIME_MS,
		recordsTarget,
	});
	const challenge = await requireChallenge(ledger);
	let currentAuthorityContext = authorityContext;
	const authenticateBearer = vi.fn(
		async (
			request: ApprovalBearerAuthenticationRequest,
		): Promise<ApprovalBearerAuthenticationResult> => classifyAuthorizationHeader(request),
	);
	const readCurrentAuthorityContext = vi.fn(
		async (zoneId: string): Promise<GatewayRuntimeApprovalAuthorityContext | null> =>
			zoneId === ZONE_ID ? currentAuthorityContext : null,
	);
	const resolveLedger = vi.fn((zoneId: string): ControllerApprovalLedger | null =>
		zoneId === ZONE_ID ? ledger : null,
	);
	const approvalRoutes = {
		authenticateBearer,
		readCurrentAuthorityContext,
		resolveLedger,
	} satisfies ControllerApprovalRoutePorts;
	const appOptions = {
		approvalRoutes,
		leaseManager: createLeaseManagerStub(),
		zoneIds: new Set([ZONE_ID]),
	} satisfies Parameters<typeof createControllerApp>[0] & {
		readonly approvalRoutes: ControllerApprovalRoutePorts;
	};

	return {
		app: createControllerApp(appOptions),
		authenticateBearer,
		challenge,
		ledger,
		readCurrentAuthorityContext,
		resolveLedger,
		setCurrentAuthorityContext: (nextAuthorityContext) => {
			currentAuthorityContext = nextAuthorityContext;
		},
	};
}

function approvalAuthorizationHeader(
	credential = CURRENT_APPROVAL_CREDENTIAL,
): Record<string, string> {
	return { authorization: `Bearer ${credential}` };
}

function emptyMutationRequest(credential = CURRENT_APPROVAL_CREDENTIAL): RequestInit {
	return {
		body: '{}',
		headers: {
			...approvalAuthorizationHeader(credential),
			'content-type': 'application/json',
		},
		method: 'POST',
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('controller approval operator routes', () => {
	it('allows an approval-only bearer to list and read zone approval records', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		const headers = approvalAuthorizationHeader();

		// Act
		const listResponse = await harness.app.request(`/zones/${ZONE_ID}/approvals`, { headers });
		const readResponse = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}`,
			{ headers },
		);

		// Assert
		expect(listResponse.status).toBe(200);
		expect(readResponse.status).toBe(200);
		expect(harness.authenticateBearer).toHaveBeenCalledWith({
			authorizationHeader: `Bearer ${CURRENT_APPROVAL_CREDENTIAL}`,
			zoneId: ZONE_ID,
		});
		expect(harness.resolveLedger).toHaveBeenCalledWith(ZONE_ID);
	});

	it('records approve with server-derived approver identity and credential provenance', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();

		// Act
		const response = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/approve`,
			emptyMutationRequest(),
		);
		const storedView = await harness.ledger.read(harness.challenge.approvalId);

		// Assert
		expect(response.status).toBe(200);
		expect(storedView).toMatchObject({
			decision: { decision: 'approve', operator: authenticatedOperator },
			kind: 'approved',
		});
		expect(JSON.stringify(storedView)).not.toContain(CURRENT_APPROVAL_CREDENTIAL);
		expect(harness.readCurrentAuthorityContext).toHaveBeenCalledWith(ZONE_ID);
	});

	it('records deny with the authenticated server-derived operator identity', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();

		// Act
		const response = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/deny`,
			emptyMutationRequest(),
		);
		const storedView = await harness.ledger.read(harness.challenge.approvalId);

		// Assert
		expect(response.status).toBe(200);
		expect(storedView).toMatchObject({
			decision: { decision: 'deny', operator: authenticatedOperator },
			kind: 'denied',
		});
	});

	it('records revoke with the authenticated server-derived operator identity', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();

		// Act
		const response = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/revoke`,
			emptyMutationRequest(),
		);
		const storedView = await harness.ledger.read(harness.challenge.approvalId);

		// Assert
		expect(response.status).toBe(200);
		expect(storedView).toMatchObject({
			kind: 'revoked',
			revocation: { operator: authenticatedOperator },
		});
	});

	it.each([
		['a missing bearer', 401, undefined],
		['a malformed authorization scheme', 401, 'Basic opaque'],
		['an unknown bearer', 401, `Bearer ${UNKNOWN_CREDENTIAL}`],
		['a stale approval bearer', 401, `Bearer ${STALE_APPROVAL_CREDENTIAL}`],
		['an admin bearer', 403, `Bearer ${ADMIN_CREDENTIAL}`],
		['a wrong-audience bearer', 403, `Bearer ${WRONG_AUDIENCE_CREDENTIAL}`],
	] as const)('rejects %s with HTTP %s', async (_caseName, expectedStatus, authorization) => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		const request = authorization === undefined ? {} : { headers: { authorization } };

		// Act
		const response = await harness.app.request(`/zones/${ZONE_ID}/approvals`, request);

		// Assert
		expect(response.status).toBe(expectedStatus);
		expect(harness.authenticateBearer).toHaveBeenCalledWith({
			authorizationHeader: authorization,
			zoneId: ZONE_ID,
		});
	});

	it('does not accept approval credentials from query parameters or request bodies', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		const approvalPath = `/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/approve`;

		// Act
		const queryTokenResponse = await harness.app.request(
			`/zones/${ZONE_ID}/approvals?token=${CURRENT_APPROVAL_CREDENTIAL}`,
		);
		const bodyTokenResponse = await harness.app.request(approvalPath, {
			body: JSON.stringify({ token: CURRENT_APPROVAL_CREDENTIAL }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const storedView = await harness.ledger.read(harness.challenge.approvalId);

		// Assert
		expect(queryTokenResponse.status).toBe(401);
		expect(bodyTokenResponse.status).toBe(401);
		expect(storedView).toMatchObject({ kind: 'pending' });
	});

	it.each([
		['approver identity', { approverId: 'attacker-selected-operator' }],
		['decision provenance', { provenance: 'public-request' }],
		['credential identity', { credentialId: 'attacker-selected-credential' }],
		['approval token', { token: CURRENT_APPROVAL_CREDENTIAL }],
		['authority context', { authorityContext }],
	] as const)(
		'rejects a request-supplied %s field with a strict body schema',
		async (_caseName, body) => {
			// Arrange
			const harness = await createApprovalRouteTestHarness();

			// Act
			const response = await harness.app.request(
				`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/approve`,
				{
					body: JSON.stringify(body),
					headers: {
						...approvalAuthorizationHeader(),
						'content-type': 'application/json',
					},
					method: 'POST',
				},
			);
			const storedView = await harness.ledger.read(harness.challenge.approvalId);

			// Assert
			expect(response.status).toBe(400);
			expect(storedView).toMatchObject({ kind: 'pending' });
		},
	);

	it('returns not found for unknown zones without falling through to another zone ledger', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();

		// Act
		const response = await harness.app.request(`/zones/${OTHER_ZONE_ID}/approvals`, {
			headers: approvalAuthorizationHeader(),
		});

		// Assert
		expect(response.status).toBe(404);
		expect(harness.resolveLedger).toHaveBeenCalledWith(OTHER_ZONE_ID);
		expect(harness.resolveLedger).not.toHaveReturnedWith(harness.ledger);
	});

	it('returns not found for unknown approval records on read and mutation routes', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		const unknownApprovalId = '99999999-9999-4999-8999-999999999999';

		// Act
		const readResponse = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${unknownApprovalId}`,
			{ headers: approvalAuthorizationHeader() },
		);
		const approveResponse = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${unknownApprovalId}/approve`,
			emptyMutationRequest(),
		);

		// Assert
		expect(readResponse.status).toBe(404);
		expect(approveResponse.status).toBe(404);
		expect(harness.authenticateBearer).toHaveBeenCalled();
	});

	it('maps a repeated decision ledger rejection to conflict', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		const approvalPath = `/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/approve`;

		// Act
		const firstResponse = await harness.app.request(approvalPath, emptyMutationRequest());
		const repeatedResponse = await harness.app.request(approvalPath, emptyMutationRequest());

		// Assert
		expect(firstResponse.status).toBe(200);
		expect(repeatedResponse.status).toBe(409);
	});

	it('uses current controller authority and rejects a stale challenge epoch', async () => {
		// Arrange
		const harness = await createApprovalRouteTestHarness();
		harness.setCurrentAuthorityContext({
			...authorityContext,
			controllerEpoch: 'controller-epoch-2',
		});

		// Act
		const response = await harness.app.request(
			`/zones/${ZONE_ID}/approvals/${harness.challenge.approvalId}/approve`,
			emptyMutationRequest(),
		);
		const storedView = await harness.ledger.read(harness.challenge.approvalId);

		// Assert
		expect(response.status).toBe(409);
		expect(storedView).toMatchObject({ kind: 'pending' });
		expect(harness.readCurrentAuthorityContext).toHaveBeenCalledWith(ZONE_ID);
	});
});
