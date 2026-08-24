import { describe, expect, it } from 'vitest';

import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	GatewayRuntimeApprovalAdmissionResultSchema,
	GatewayRuntimeApprovalArmDispatchCommandSchema,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	GatewayRuntimeApprovalAuthorityContextSchema,
	GatewayRuntimeApprovalChallengeIntentSchema,
	GatewayRuntimeApprovalChallengeSchema,
	GatewayRuntimeApprovalDecisionCommandSchema,
	GatewayRuntimeApprovalDispatchGrantSchema,
	GatewayRuntimeApprovalDispatchReservationSchema,
	GatewayRuntimeApprovalFingerprintSchema,
	GatewayRuntimeApprovalRevokeCommandSchema,
	GatewayRuntimeApprovalSemanticRevisionCohortSchema,
	GatewayRuntimeToolPortalDispatchAuthoritySchema,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
} from './index.js';

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const APPROVAL_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const STABLE_GATEWAY_PRINCIPAL = 'b'.repeat(64);

const validTrustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment-7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'operator-a' },
} as const;

const validSemanticRevisions = {
	activeRevision: 'semantic-12',
	bindingRevision: 'bindings-4',
	catalogRevision: 'catalog-9',
	profilePolicyRevision: 'profile-policy-6',
	providerRevision: 'providers-3',
	schemaRevision: 'portal-schema-1',
} as const;

const validChallengeIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { owner: 'agent-vm', repository: 'runtime' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: OPERATION_ID,
	semanticRevisions: validSemanticRevisions,
	surfaceClass: 'mcp',
	trustedContext: validTrustedContext,
} as const;

const validChallenge = {
	approvalId: APPROVAL_ID,
	createdAt: '2026-07-13T12:00:00.000Z',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	intent: validChallengeIntent,
} as const;

const validAuthorityContext = {
	controllerEpoch: 'controller-epoch-7',
	frameworkEpoch: 'framework-epoch-5',
	gatewayEpoch: 'gateway-epoch-9',
	runtimeEpoch: 'runtime-epoch-3',
	zoneId: 'zone-a',
} as const;

const validDispatchGrant = {
	approvalId: APPROVAL_ID,
	authorityContext: validAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	grantId: GRANT_ID,
	operationId: OPERATION_ID,
	stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
} as const;

const validDispatchReservation = {
	approvalId: APPROVAL_ID,
	authorityContext: validAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	operationId: OPERATION_ID,
	reservationId: RESERVATION_ID,
	stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
} as const;

describe('Gateway runtime approval contracts', () => {
	it('uses the controller-only approval audience', () => {
		// Arrange / Act / Assert
		expect(GATEWAY_RUNTIME_APPROVAL_AUDIENCE).toBe('agent-vm-controller-approval');
	});

	it('derives one deterministic approval fingerprint and identifier from authority plus intent', () => {
		// Arrange / Act
		const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
			authorityContext: validAuthorityContext,
			intent: validChallengeIntent,
		});
		const approvalId = deriveGatewayRuntimeApprovalId(fingerprint);
		const changedFingerprint = deriveGatewayRuntimeApprovalFingerprint({
			authorityContext: validAuthorityContext,
			intent: {
				...validChallengeIntent,
				call: {
					...validChallengeIntent.call,
					arguments: { owner: 'agent-vm', repository: 'different-runtime' },
				},
			},
		});

		// Assert
		expect(GatewayRuntimeApprovalFingerprintSchema.parse(fingerprint)).toBe(fingerprint);
		expect(approvalId).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
		);
		expect(
			deriveGatewayRuntimeApprovalFingerprint({
				authorityContext: validAuthorityContext,
				intent: validChallengeIntent,
			}),
		).toBe(fingerprint);
		expect(changedFingerprint).not.toBe(fingerprint);
	});

	it('parses a complete approval challenge with exact authority-binding inputs', () => {
		// Arrange / Act
		const parsed = GatewayRuntimeApprovalChallengeSchema.parse(validChallenge);

		// Assert
		expect(parsed).toEqual(validChallenge);
	});

	it.each(['mcp_provider', 'controller_execution', 'tool_vm_runner'] as const)(
		'accepts the %s backend kind in the challenge intent',
		(backendKind) => {
			// Arrange
			const intent = { ...validChallengeIntent, backendKind };

			// Act / Assert
			expect(GatewayRuntimeApprovalChallengeIntentSchema.parse(intent)).toEqual(intent);
		},
	);

	it.each(['mcp_provider', 'controller_execution', 'tool_vm_runner'] as const)(
		'accepts fingerprint-bound direct dispatch authority for the %s backend',
		(backendKind) => {
			// Arrange
			const authority = {
				backendKind,
				fingerprint: APPROVAL_FINGERPRINT,
				kind: 'without-approval',
				operationId: OPERATION_ID,
			} as const;

			// Act / Assert
			expect(GatewayRuntimeToolPortalDispatchAuthoritySchema.parse(authority)).toEqual(authority);
		},
	);

	it('rejects direct dispatch authority without an exact-intent fingerprint', () => {
		// Arrange
		const authority = {
			backendKind: 'mcp_provider',
			kind: 'without-approval',
			operationId: OPERATION_ID,
		};

		// Act / Assert
		expect(GatewayRuntimeToolPortalDispatchAuthoritySchema.safeParse(authority).success).toBe(
			false,
		);
	});

	it('rejects approval authority whose top-level backend discriminant contradicts its grant', () => {
		// Arrange
		const authority = {
			backendKind: 'tool_vm_runner',
			grant: validDispatchGrant,
			kind: 'approval-grant',
		};

		// Act / Assert
		expect(GatewayRuntimeToolPortalDispatchAuthoritySchema.safeParse(authority).success).toBe(
			false,
		);
	});

	it('accepts approval authority whose backend discriminant matches its grant', () => {
		// Arrange
		const authority = {
			backendKind: 'mcp_provider',
			grant: validDispatchGrant,
			kind: 'approval-grant',
		} as const;

		// Act / Assert
		expect(GatewayRuntimeToolPortalDispatchAuthoritySchema.parse(authority)).toEqual(authority);
	});

	it.each(['mcp', 'protected_uds'] as const)(
		'accepts the server-derived %s surface class in the challenge intent',
		(surfaceClass) => {
			// Arrange
			const intent = { ...validChallengeIntent, surfaceClass };

			// Act / Assert
			expect(GatewayRuntimeApprovalChallengeIntentSchema.parse(intent)).toEqual(intent);
		},
	);

	it.each(['mcp_provider', 'controller_execution', 'tool_vm_runner'] as const)(
		'parses a complete %s dispatch reservation',
		(backendKind) => {
			// Arrange
			const reservation = {
				...validDispatchReservation,
				backendKind,
				...(backendKind === 'controller_execution'
					? { bindingRevision: validSemanticRevisions.bindingRevision }
					: {}),
			};

			// Act / Assert
			expect(GatewayRuntimeApprovalDispatchReservationSchema.parse(reservation)).toEqual(
				reservation,
			);
		},
	);

	it.each(['mcp_provider', 'tool_vm_runner'] as const)(
		'parses a complete %s one-use Gateway dispatch grant',
		(backendKind) => {
			// Arrange
			const grant = { ...validDispatchGrant, backendKind };

			// Act / Assert
			expect(GatewayRuntimeApprovalDispatchGrantSchema.parse(grant)).toEqual(grant);
		},
	);

	it('rejects a controller-execution Gateway dispatch grant', () => {
		// Arrange
		const grant = { ...validDispatchGrant, backendKind: 'controller_execution' };

		// Act / Assert
		expect(GatewayRuntimeApprovalDispatchGrantSchema.safeParse(grant).success).toBe(false);
	});

	it.each([
		{
			challenge: validChallenge,
			kind: 'approval-required',
		},
		{
			kind: 'dispatch-reserved',
			reservation: validDispatchReservation,
		},
		{
			kind: 'ambiguous',
			operationId: OPERATION_ID,
			reason: 'dispatch-armed',
		},
	] as const)('parses the $kind approval admission branch', (admissionResult) => {
		// Arrange / Act
		const parsed = GatewayRuntimeApprovalAdmissionResultSchema.parse(admissionResult);

		// Assert
		expect(parsed).toEqual(admissionResult);
	});

	it.each([
		'consumed-without-dispatch',
		'denied',
		'expired',
		'revoked',
		'stale-authority',
		'stale-fingerprint',
	] as const)('parses not-dispatched admission reason %s', (reason) => {
		// Arrange
		const admissionResult = {
			kind: 'not-dispatched',
			operationId: OPERATION_ID,
			reason,
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalAdmissionResultSchema.parse(admissionResult)).toEqual(
			admissionResult,
		);
	});

	it.each(['mcp_provider', 'tool_vm_runner'] as const)(
		'parses the exact %s reservation arm command',
		(backendKind) => {
			// Arrange
			const armCommand = {
				reservation: { ...validDispatchReservation, backendKind },
			};

			// Act / Assert
			expect(GatewayRuntimeApprovalArmDispatchCommandSchema.parse(armCommand)).toEqual(armCommand);
		},
	);

	it('rejects a controller-execution reservation arm command', () => {
		// Arrange
		const armCommand = {
			reservation: {
				...validDispatchReservation,
				backendKind: 'controller_execution',
			},
		};

		// Act / Assert
		expect(GatewayRuntimeApprovalArmDispatchCommandSchema.safeParse(armCommand).success).toBe(
			false,
		);
	});

	it('parses the exact dispatch-armed result branch', () => {
		// Arrange
		const armResult = { grant: validDispatchGrant, kind: 'dispatch-armed' } as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalArmDispatchResultSchema.parse(armResult)).toEqual(armResult);
	});

	it.each([
		'consumed-without-dispatch',
		'denied',
		'expired',
		'revoked',
		'stale-authority',
		'stale-fingerprint',
	] as const)('parses not-dispatched arm reason %s', (reason) => {
		// Arrange
		const armResult = {
			kind: 'not-dispatched',
			operationId: OPERATION_ID,
			reason,
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalArmDispatchResultSchema.parse(armResult)).toEqual(armResult);
	});

	it('parses dispatch-armed as an explicit ambiguous crash result', () => {
		// Arrange
		const ambiguousResult = {
			kind: 'ambiguous',
			operationId: OPERATION_ID,
			reason: 'dispatch-armed',
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalArmDispatchResultSchema.parse(ambiguousResult)).toEqual(
			ambiguousResult,
		);
	});

	it.each([
		[
			'approval-required with a reservation',
			{
				challenge: validChallenge,
				kind: 'approval-required',
				reservation: validDispatchReservation,
			},
		],
		[
			'dispatch-reserved with a challenge',
			{
				challenge: validChallenge,
				kind: 'dispatch-reserved',
				reservation: validDispatchReservation,
			},
		],
		[
			'not-dispatched with a grant',
			{
				grant: validDispatchGrant,
				kind: 'not-dispatched',
				operationId: OPERATION_ID,
				reason: 'denied',
			},
		],
		[
			'ambiguous with a reservation',
			{
				kind: 'ambiguous',
				operationId: OPERATION_ID,
				reason: 'dispatch-armed',
				reservation: validDispatchReservation,
			},
		],
		['unknown admission kind', { kind: 'approved', operationId: OPERATION_ID }],
	] as const)('rejects an inexact admission branch: %s', (_caseName, invalidAdmissionResult) => {
		// Arrange / Act
		const result = GatewayRuntimeApprovalAdmissionResultSchema.safeParse(invalidAdmissionResult);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		[
			'dispatch-armed with an operation outside its grant',
			{ grant: validDispatchGrant, kind: 'dispatch-armed', operationId: OPERATION_ID },
		],
		[
			'not-dispatched with a grant',
			{
				grant: validDispatchGrant,
				kind: 'not-dispatched',
				operationId: OPERATION_ID,
				reason: 'denied',
			},
		],
		[
			'ambiguous with a grant',
			{
				grant: validDispatchGrant,
				kind: 'ambiguous',
				operationId: OPERATION_ID,
				reason: 'dispatch-armed',
			},
		],
		['admission-only branch', { kind: 'dispatch-reserved', reservation: validDispatchReservation }],
	] as const)('rejects an inexact arm branch: %s', (_caseName, invalidArmResult) => {
		// Arrange / Act
		const result = GatewayRuntimeApprovalArmDispatchResultSchema.safeParse(invalidArmResult);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		['approvalId', { approvalId: undefined }],
		['createdAt', { createdAt: undefined }],
		['expiresAt', { expiresAt: undefined }],
		['fingerprint', { fingerprint: undefined }],
		['intent', { intent: undefined }],
	] as const)('requires challenge field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteChallenge = { ...validChallenge, ...missingField };

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeSchema.safeParse(incompleteChallenge).success).toBe(
			false,
		);
	});

	it.each([
		['backendKind', { backendKind: undefined }],
		['call', { call: undefined }],
		['operationId', { operationId: undefined }],
		['semanticRevisions', { semanticRevisions: undefined }],
		['surfaceClass', { surfaceClass: undefined }],
		['trustedContext', { trustedContext: undefined }],
	] as const)('requires challenge intent field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteIntent = { ...validChallengeIntent, ...missingField };

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeIntentSchema.safeParse(incompleteIntent).success).toBe(
			false,
		);
	});

	it.each([
		['arguments', { arguments: undefined }],
		['id', { id: undefined }],
		['name', { name: undefined }],
		['namespace', { namespace: undefined }],
	] as const)('requires call field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteIntent = {
			...validChallengeIntent,
			call: { ...validChallengeIntent.call, ...missingField },
		};

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeIntentSchema.safeParse(incompleteIntent).success).toBe(
			false,
		);
	});

	it.each([
		['activeRevision', { activeRevision: undefined }],
		['bindingRevision', { bindingRevision: undefined }],
		['catalogRevision', { catalogRevision: undefined }],
		['profilePolicyRevision', { profilePolicyRevision: undefined }],
		['providerRevision', { providerRevision: undefined }],
		['schemaRevision', { schemaRevision: undefined }],
	] as const)('requires semantic revision field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteRevisions = { ...validSemanticRevisions, ...missingField };

		// Act / Assert
		expect(
			GatewayRuntimeApprovalSemanticRevisionCohortSchema.safeParse(incompleteRevisions).success,
		).toBe(false);
	});

	it.each([
		['controllerEpoch', { controllerEpoch: undefined }],
		['frameworkEpoch', { frameworkEpoch: undefined }],
		['gatewayEpoch', { gatewayEpoch: undefined }],
		['runtimeEpoch', { runtimeEpoch: undefined }],
		['zoneId', { zoneId: undefined }],
	] as const)('requires dispatch authority field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteAuthority = { ...validAuthorityContext, ...missingField };

		// Act / Assert
		expect(
			GatewayRuntimeApprovalAuthorityContextSchema.safeParse(incompleteAuthority).success,
		).toBe(false);
	});

	it.each([
		['approvalId', { approvalId: undefined }],
		['authorityContext', { authorityContext: undefined }],
		['backendKind', { backendKind: undefined }],
		['expiresAt', { expiresAt: undefined }],
		['fingerprint', { fingerprint: undefined }],
		['operationId', { operationId: undefined }],
		['reservationId', { reservationId: undefined }],
		['stablePrincipal', { stablePrincipal: undefined }],
	] as const)('requires dispatch reservation field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteReservation = { ...validDispatchReservation, ...missingField };

		// Act / Assert
		expect(
			GatewayRuntimeApprovalDispatchReservationSchema.safeParse(incompleteReservation).success,
		).toBe(false);
	});

	it.each([
		['approvalId', { approvalId: undefined }],
		['authorityContext', { authorityContext: undefined }],
		['backendKind', { backendKind: undefined }],
		['expiresAt', { expiresAt: undefined }],
		['fingerprint', { fingerprint: undefined }],
		['grantId', { grantId: undefined }],
		['operationId', { operationId: undefined }],
		['stablePrincipal', { stablePrincipal: undefined }],
	] as const)('requires dispatch grant field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteGrant = { ...validDispatchGrant, ...missingField };

		// Act / Assert
		expect(GatewayRuntimeApprovalDispatchGrantSchema.safeParse(incompleteGrant).success).toBe(
			false,
		);
	});

	it('requires the trusted context principal', () => {
		// Arrange
		const incompleteIntent = { ...validChallengeIntent, trustedContext: {} };

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeIntentSchema.safeParse(incompleteIntent).success).toBe(
			false,
		);
	});

	it.each([
		['agentId', { agentId: undefined }],
		['frameworkIdentity', { frameworkIdentity: undefined }],
		['profileAssignmentRevision', { profileAssignmentRevision: undefined }],
		['toolPortalProfileId', { toolPortalProfileId: undefined }],
	] as const)('requires trusted principal field %s', (_fieldName, missingField) => {
		// Arrange
		const incompleteIntent = {
			...validChallengeIntent,
			trustedContext: {
				...validTrustedContext,
				principal: { ...validTrustedContext.principal, ...missingField },
			},
		};

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeIntentSchema.safeParse(incompleteIntent).success).toBe(
			false,
		);
	});

	it.each([
		[
			'challenge approvalId',
			GatewayRuntimeApprovalChallengeSchema,
			{ ...validChallenge, approvalId: 'approval-1' },
		],
		[
			'intent operationId',
			GatewayRuntimeApprovalChallengeIntentSchema,
			{ ...validChallengeIntent, operationId: 'operation-1' },
		],
		[
			'reservationId',
			GatewayRuntimeApprovalDispatchReservationSchema,
			{ ...validDispatchReservation, reservationId: 'reservation-1' },
		],
		[
			'reservation approvalId',
			GatewayRuntimeApprovalDispatchReservationSchema,
			{ ...validDispatchReservation, approvalId: 'approval-1' },
		],
		[
			'reservation operationId',
			GatewayRuntimeApprovalDispatchReservationSchema,
			{ ...validDispatchReservation, operationId: 'operation-1' },
		],
		[
			'grantId',
			GatewayRuntimeApprovalDispatchGrantSchema,
			{ ...validDispatchGrant, grantId: 'grant-1' },
		],
		[
			'grant approvalId',
			GatewayRuntimeApprovalDispatchGrantSchema,
			{ ...validDispatchGrant, approvalId: 'approval-1' },
		],
		[
			'grant operationId',
			GatewayRuntimeApprovalDispatchGrantSchema,
			{ ...validDispatchGrant, operationId: 'operation-1' },
		],
	] as const)('rejects an invalid %s UUID', (_fieldName, schema, invalidValue) => {
		// Arrange / Act
		const result = schema.safeParse(invalidValue);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		'not-a-fingerprint',
		'a'.repeat(64),
		`sha256:${'a'.repeat(63)}`,
		`sha256:${'A'.repeat(64)}`,
		`sha512:${'a'.repeat(64)}`,
	])('rejects invalid fingerprint %s', (fingerprint) => {
		// Arrange / Act
		const result = GatewayRuntimeApprovalFingerprintSchema.safeParse(fingerprint);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		['challenge createdAt', { ...validChallenge, createdAt: '2026-07-13' }],
		['challenge expiresAt', { ...validChallenge, expiresAt: 'not-a-date' }],
		['reservation expiresAt', { ...validDispatchReservation, expiresAt: '2026-13-99T99:99:99Z' }],
		['grant expiresAt', { ...validDispatchGrant, expiresAt: '2026-13-99T99:99:99Z' }],
	] as const)('rejects invalid datetime in %s', (fieldName, invalidValue) => {
		// Arrange / Act
		const result = fieldName.startsWith('grant')
			? GatewayRuntimeApprovalDispatchGrantSchema.safeParse(invalidValue)
			: fieldName.startsWith('reservation')
				? GatewayRuntimeApprovalDispatchReservationSchema.safeParse(invalidValue)
				: GatewayRuntimeApprovalChallengeSchema.safeParse(invalidValue);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		['challenge', { ...validChallenge, approvalToken: 'public-approval-token' }],
		['intent', { ...validChallengeIntent, principal: 'public-principal' }],
		['call', { ...validChallengeIntent.call, approvalProof: 'public-proof' }],
		['call credentials', { ...validChallengeIntent.call, bearerToken: 'public-token' }],
		['trusted context', { ...validTrustedContext, credentialProfileId: 'credential-profile-a' }],
		['semantic revisions', { ...validSemanticRevisions, policyOverride: 'allow' }],
		['dispatch reservation', { ...validDispatchReservation, bearerToken: 'public-dispatch-token' }],
		['dispatch grant', { ...validDispatchGrant, dispatchToken: 'public-dispatch-token' }],
		['authority context', { ...validAuthorityContext, sshIdentityPem: 'private-key' }],
	] as const)('rejects unknown or public authority at the %s level', (level, invalidValue) => {
		// Arrange / Act
		let success: boolean;
		if (level === 'challenge') {
			success = GatewayRuntimeApprovalChallengeSchema.safeParse(invalidValue).success;
		} else if (level === 'intent') {
			success = GatewayRuntimeApprovalChallengeIntentSchema.safeParse(invalidValue).success;
		} else if (level === 'call' || level === 'call credentials') {
			success = GatewayRuntimeApprovalChallengeIntentSchema.safeParse({
				...validChallengeIntent,
				call: invalidValue,
			}).success;
		} else if (level === 'trusted context') {
			success = GatewayRuntimeApprovalChallengeIntentSchema.safeParse({
				...validChallengeIntent,
				trustedContext: invalidValue,
			}).success;
		} else if (level === 'semantic revisions') {
			success = GatewayRuntimeApprovalChallengeIntentSchema.safeParse({
				...validChallengeIntent,
				semanticRevisions: invalidValue,
			}).success;
		} else if (level === 'dispatch reservation') {
			success = GatewayRuntimeApprovalDispatchReservationSchema.safeParse(invalidValue).success;
		} else if (level === 'dispatch grant') {
			success = GatewayRuntimeApprovalDispatchGrantSchema.safeParse(invalidValue).success;
		} else {
			success = GatewayRuntimeApprovalDispatchGrantSchema.safeParse({
				...validDispatchGrant,
				authorityContext: invalidValue,
			}).success;
		}

		// Assert
		expect(success).toBe(false);
	});

	it.each([
		['missing reservation', {}],
		[
			'unknown credential',
			{ reservation: validDispatchReservation, routeToken: 'public-route-token' },
		],
	] as const)('rejects arm command with %s', (_caseName, invalidCommand) => {
		// Arrange / Act
		const result = GatewayRuntimeApprovalArmDispatchCommandSchema.safeParse(invalidCommand);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each([
		[
			'admission ambiguous reason',
			GatewayRuntimeApprovalAdmissionResultSchema,
			{ kind: 'ambiguous', operationId: OPERATION_ID, reason: 'dispatch-started' },
		],
		[
			'arm ambiguous reason',
			GatewayRuntimeApprovalArmDispatchResultSchema,
			{ kind: 'ambiguous', operationId: OPERATION_ID, reason: 'dispatch-started' },
		],
		[
			'not-dispatched ambiguity',
			GatewayRuntimeApprovalArmDispatchResultSchema,
			{ kind: 'not-dispatched', operationId: OPERATION_ID, reason: 'dispatch-armed' },
		],
	] as const)('rejects invalid %s', (_caseName, schema, invalidResult) => {
		// Arrange / Act
		const result = schema.safeParse(invalidResult);

		// Assert
		expect(result.success).toBe(false);
	});

	it.each(['approve', 'deny'] as const)('parses the exact %s decision command', (decision) => {
		// Arrange
		const command = { challengeId: APPROVAL_ID, decision } as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalDecisionCommandSchema.parse(command)).toEqual(command);
	});

	it('parses the exact revoke command', () => {
		// Arrange
		const command = { approvalId: APPROVAL_ID } as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalRevokeCommandSchema.parse(command)).toEqual(command);
	});

	it.each([
		[
			'decision UUID',
			GatewayRuntimeApprovalDecisionCommandSchema,
			{ challengeId: 'approval-1', decision: 'approve' },
		],
		[
			'decision spelling',
			GatewayRuntimeApprovalDecisionCommandSchema,
			{ challengeId: APPROVAL_ID, decision: 'approved' },
		],
		[
			'decision authority',
			GatewayRuntimeApprovalDecisionCommandSchema,
			{ challengeId: APPROVAL_ID, approverToken: 'operator-token', decision: 'approve' },
		],
		['revoke UUID', GatewayRuntimeApprovalRevokeCommandSchema, { approvalId: 'approval-1' }],
		[
			'revoke authority',
			GatewayRuntimeApprovalRevokeCommandSchema,
			{ approvalId: APPROVAL_ID, credential: 'operator-token' },
		],
	] as const)('rejects invalid %s command input', (_caseName, schema, invalidCommand) => {
		// Arrange / Act
		const result = schema.safeParse(invalidCommand);

		// Assert
		expect(result.success).toBe(false);
	});
});
