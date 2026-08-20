import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeApprovalArmDispatchResultSchema,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeGatewayDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import {
	AUTHORITY_CONTEXT,
	STABLE_PRINCIPAL,
	type RecordedBackendInvocation,
	agentATrustedContext,
	createAmbiguousAdmissionResult,
	createApprovalChallenge,
	createApprovalGrant,
	createApprovalReservation,
	createDispatchReservedResult,
	createNotDispatchedAdmissionResult,
	createRecordingApprovalPort,
	createRecordingBackendPort,
	createServiceFixture,
	totalBackendInvocations,
	udsOptions,
} from './tool-portal-service-test-fixture.js';

const MISMATCHED_OPERATION_ID = '40000000-0000-4000-8000-000000000004';

describe('ToolPortalCapabilityCore approval dispatch', () => {
	it('keeps mixed direct, approval-required, and granted calls independently bound and ordered', async () => {
		// Arrange
		const events: string[] = [];
		const callIdByOperationId = new Map<string, string>();
		const approval = createRecordingApprovalPort({
			onArm: (reservation) => {
				events.push(`arm:${callIdByOperationId.get(reservation.operationId) ?? 'unknown'}`);
			},
			onReserve: (intent) => {
				callIdByOperationId.set(intent.operationId, intent.call.id);
				events.push(`reserve:${intent.call.id}`);
			},
			reserveResult: (intent) =>
				intent.call.id === 'approval-required'
					? createApprovalChallenge(intent)
					: createDispatchReservedResult(intent),
		});
		const mcpProvider = createRecordingBackendPort('mcp_provider', 'github', {
			onCall: ({ request }) => {
				events.push(`backend:${request.calls[0]?.id ?? 'missing'}`);
			},
		});
		const fixture = createServiceFixture({ approval, mcpProvider });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{ arguments: {}, id: 'direct', namespace: 'github', name: 'get_issue' },
					{
						arguments: {},
						id: 'approval-required',
						namespace: 'github',
						name: 'create_issue',
					},
					{ arguments: {}, id: 'granted', namespace: 'github', name: 'update_issue' },
				],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: 'direct', status: 'ok' },
			{ id: 'approval-required', status: 'approval_required' },
			{ id: 'granted', status: 'ok' },
		]);
		const callInvocations = mcpProvider.invocations.filter(
			(
				invocation,
			): invocation is Extract<RecordedBackendInvocation, { readonly operation: 'call' }> =>
				invocation.operation === 'call',
		);
		expect(callInvocations.map(({ request }) => request.calls.map(({ id }) => id))).toEqual([
			['direct'],
			['granted'],
		]);
		expect(callInvocations[0]?.options.dispatchAuthority).toMatchObject({
			kind: 'without-approval',
			operationId: result.items[0]?.operationId,
		});
		expect(callInvocations[1]?.options.dispatchAuthority).toMatchObject({
			grant: {
				backendKind: 'mcp_provider',
				operationId: result.items[2]?.operationId,
			},
			kind: 'approval-grant',
		});
		expect(events.indexOf('reserve:granted')).toBeLessThan(events.indexOf('arm:granted'));
		expect(events.indexOf('arm:granted')).toBeLessThan(events.indexOf('backend:granted'));
		expect(events).not.toContain('backend:approval-required');
	});

	it('dispatches an approval-required controller host action with its controller reservation and never arms a Gateway grant', async () => {
		// Arrange
		const approval = createRecordingApprovalPort({
			reserveResult: createDispatchReservedResult,
		});
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{
						arguments: {},
						id: 'controller-host-approval-call',
						name: 'controller_host_probe',
						namespace: 'controller_execution',
					},
				],
			},
			udsOptions(),
		);
		const reserveIntent = approval.reserveInvocations[0];
		if (reserveIntent === undefined) {
			throw new Error('Expected one controller-host approval reservation intent.');
		}
		const expectedReservation = createApprovalReservation(reserveIntent);
		const controllerCallInvocations = fixture.controllerExecution.invocations.filter(
			(
				invocation,
			): invocation is Extract<RecordedBackendInvocation, { readonly operation: 'call' }> =>
				invocation.operation === 'call',
		);

		// Assert
		expect(approval.reserveInvocations).toHaveLength(1);
		expect(approval.armInvocations).toHaveLength(0);
		expect(controllerCallInvocations).toHaveLength(1);
		expect(fixture.mcpProvider.invocations).toHaveLength(0);
		expect(fixture.toolVmRunner.invocations).toHaveLength(0);
		expect(reserveIntent).toMatchObject({
			backendKind: 'controller_execution',
			call: {
				id: 'controller-host-approval-call',
				name: 'controller_host_probe',
				namespace: 'controller_execution',
			},
		});
		expect(expectedReservation).toMatchObject({
			authorityContext: AUTHORITY_CONTEXT,
			backendKind: 'controller_execution',
			operationId: reserveIntent.operationId,
			stablePrincipal: STABLE_PRINCIPAL,
		});
		expect(controllerCallInvocations[0]?.options.dispatchAuthority).toEqual({
			backendKind: 'controller_execution',
			kind: 'controller-approval-reservation',
			reservation: expectedReservation,
		});
		expect(result.items).toMatchObject([
			{
				id: 'controller-host-approval-call',
				operationId: expectedReservation.operationId,
				status: 'ok',
			},
		]);
	});

	it.each([
		{
			expectedOutcomeKind: 'not-dispatched',
			expectedStatus: 'approval_required',
			label: 'approval-required',
			reserveResult: createApprovalChallenge,
		},
		...(['consumed-without-dispatch', 'denied', 'expired', 'revoked'] as const).map((reason) => ({
			expectedOutcomeKind: 'not-dispatched',
			expectedStatus: 'error',
			label: reason,
			reserveResult: (intent: GatewayRuntimeApprovalChallengeIntent) =>
				createNotDispatchedAdmissionResult({ intent, reason }),
		})),
		{
			expectedOutcomeKind: 'ambiguous',
			expectedStatus: 'error',
			label: 'ambiguous',
			reserveResult: createAmbiguousAdmissionResult,
		},
	])('does not dispatch a backend for $label admission', async (testCase) => {
		// Arrange
		const approval = createRecordingApprovalPort({ reserveResult: testCase.reserveResult });
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [{ arguments: {}, id: 'approval-call', namespace: 'github', name: 'create_issue' }],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items[0]).toMatchObject({
			id: 'approval-call',
			outcome: { kind: testCase.expectedOutcomeKind },
			status: testCase.expectedStatus,
		});
		expect(approval.reserveInvocations).toHaveLength(1);
		expect(approval.armInvocations).toHaveLength(0);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it.each([
		{
			expectedOutcomeKind: 'not-dispatched',
			label: 'expired after reservation',
			result: (reservation: GatewayRuntimeGatewayDispatchReservation) =>
				GatewayRuntimeApprovalArmDispatchResultSchema.parse({
					kind: 'not-dispatched',
					operationId: reservation.operationId,
					reason: 'expired',
				}),
		},
		{
			expectedOutcomeKind: 'ambiguous',
			label: 'ambiguous after dispatch arm',
			result: (reservation: GatewayRuntimeGatewayDispatchReservation) =>
				GatewayRuntimeApprovalArmDispatchResultSchema.parse({
					kind: 'ambiguous',
					operationId: reservation.operationId,
					reason: 'dispatch-armed',
				}),
		},
	])('does not dispatch a backend when arm is $label', async (testCase) => {
		// Arrange
		const approval = createRecordingApprovalPort({
			armResult: testCase.result,
			reserveResult: createDispatchReservedResult,
		});
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [{ arguments: {}, id: 'approval-call', namespace: 'github', name: 'create_issue' }],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items[0]).toMatchObject({
			id: 'approval-call',
			outcome: { kind: testCase.expectedOutcomeKind },
			status: 'error',
		});
		expect(approval.reserveInvocations).toHaveLength(1);
		expect(approval.armInvocations).toHaveLength(1);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('rejects a dispatch grant for a different backend as ambiguous without execution', async () => {
		// Arrange
		const approval = createRecordingApprovalPort({
			armResult: (reservation) => ({
				grant: createApprovalGrant(reservation, 'tool_vm_runner'),
				kind: 'dispatch-armed',
			}),
			reserveResult: createDispatchReservedResult,
		});
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [{ arguments: {}, id: 'approval-call', namespace: 'github', name: 'create_issue' }],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items).toMatchObject([
			{
				error: { code: 'execution_failed' },
				id: 'approval-call',
				outcome: { kind: 'ambiguous', retryClass: 'forbidden' },
				status: 'error',
			},
		]);
		expect(approval.reserveInvocations).toHaveLength(1);
		expect(approval.armInvocations).toHaveLength(1);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('rejects a controller reservation for a different operation before host execution', async () => {
		// Arrange
		const approval = createRecordingApprovalPort({
			reserveResult: (intent) => {
				const reservationResult = createDispatchReservedResult(intent);
				if (reservationResult.kind !== 'dispatch-reserved') {
					throw new Error('Expected a dispatch reservation fixture.');
				}
				return {
					kind: 'dispatch-reserved',
					reservation: {
						...reservationResult.reservation,
						operationId: MISMATCHED_OPERATION_ID,
					},
				};
			},
		});
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{
						arguments: {},
						id: 'controller-host-approval-call',
						name: 'controller_host_probe',
						namespace: 'controller_execution',
					},
				],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items[0]).toMatchObject({ outcome: { kind: 'ambiguous' }, status: 'error' });
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it('rejects an armed grant for a different operation before provider execution', async () => {
		// Arrange
		const approval = createRecordingApprovalPort({
			armResult: (reservation) => ({
				grant: {
					...createApprovalGrant(reservation),
					operationId: MISMATCHED_OPERATION_ID,
				},
				kind: 'dispatch-armed',
			}),
			reserveResult: createDispatchReservedResult,
		});
		const fixture = createServiceFixture({ approval });

		// Act
		const result = await fixture.capabilityCore.call(
			{
				calls: [
					{
						arguments: {},
						id: 'approval-call',
						name: 'create_issue',
						namespace: 'github',
					},
				],
			},
			udsOptions(),
		);

		// Assert
		expect(result.items[0]).toMatchObject({ outcome: { kind: 'ambiguous' }, status: 'error' });
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it.each([
		{
			label: 'approval identifier',
			mutate: (grant: ReturnType<typeof createApprovalGrant>) => ({
				...grant,
				approvalId: '50000000-0000-4000-8000-000000000005',
			}),
		},
		{
			label: 'authority context',
			mutate: (grant: ReturnType<typeof createApprovalGrant>) => ({
				...grant,
				authorityContext: { ...grant.authorityContext, runtimeEpoch: 'runtime:mismatch' },
			}),
		},
		{
			label: 'expiry',
			mutate: (grant: ReturnType<typeof createApprovalGrant>) => ({
				...grant,
				expiresAt: '2026-07-13T18:01:00.000Z',
			}),
		},
		{
			label: 'fingerprint',
			mutate: (grant: ReturnType<typeof createApprovalGrant>) => ({
				...grant,
				fingerprint: `sha256:${'b'.repeat(64)}` as const,
			}),
		},
		{
			label: 'stable principal',
			mutate: (grant: ReturnType<typeof createApprovalGrant>) => ({
				...grant,
				stablePrincipal: 'b'.repeat(64),
			}),
		},
	] as const)(
		'rejects an armed grant with mismatched $label before execution',
		async (testCase) => {
			// Arrange
			const approval = createRecordingApprovalPort({
				armResult: (reservation) => ({
					grant: testCase.mutate(createApprovalGrant(reservation)),
					kind: 'dispatch-armed',
				}),
				reserveResult: createDispatchReservedResult,
			});
			const fixture = createServiceFixture({ approval });

			// Act
			const result = await fixture.capabilityCore.call(
				{
					calls: [
						{
							arguments: {},
							id: 'approval-call',
							name: 'create_issue',
							namespace: 'github',
						},
					],
				},
				udsOptions(),
			);

			// Assert
			expect(result.items[0]).toMatchObject({ outcome: { kind: 'ambiguous' }, status: 'error' });
			expect(totalBackendInvocations(fixture)).toBe(0);
		},
	);

	it('rejects public identity and authority injection before visibility or routing', async () => {
		// Arrange
		const fixture = createServiceFixture();
		const injectedFields = {
			agentId: 'agent-b',
			authenticatedSubjectId: 'forged-subject',
			authority: 'controller-admin',
			dispatchAuthority: { kind: 'approval-grant', token: 'forged' },
			backend: 'tool_vm_runner',
			frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
			profileAssignmentRevision: 'forged-revision',
			runId: 'forged-run',
			sessionId: 'forged-session',
			surfaceClass: 'protected_uds',
			toolCallId: 'forged-tool-call',
			toolPortalProfileId: 'admin',
			trustedContext: agentATrustedContext,
		};
		const operations = [
			async () =>
				await fixture.capabilityCore.list(
					PortalListRequestSchema.parse({ requests: [{ id: 'list' }], ...injectedFields }),
					udsOptions(),
				),
			async () =>
				await fixture.capabilityCore.search(
					PortalSearchRequestSchema.parse({
						requests: [{ id: 'search' }],
						...injectedFields,
					}),
					udsOptions(),
				),
			async () =>
				await fixture.capabilityCore.describe(
					PortalDescribeRequestSchema.parse({
						requests: [{ id: 'describe' }],
						...injectedFields,
					}),
					udsOptions(),
				),
			async () =>
				await fixture.capabilityCore.call(
					PortalCallRequestSchema.parse({
						calls: [{ arguments: {}, id: 'call', namespace: 'github', name: 'get_issue' }],
						...injectedFields,
					}),
					udsOptions(),
				),
			async () =>
				await fixture.capabilityCore.call(
					PortalCallRequestSchema.parse({
						calls: [
							{
								arguments: {},
								dispatchAuthority: { kind: 'approval-grant', token: 'forged' },
								id: 'call',
								name: 'get_issue',
								namespace: 'github',
							},
						],
					}),
					udsOptions(),
				),
		];

		// Act / Assert
		await Promise.all(
			operations.map(async (operation) => {
				await expect(operation()).rejects.toThrow();
			}),
		);
		expect(totalBackendInvocations(fixture)).toBe(0);
	});
});
