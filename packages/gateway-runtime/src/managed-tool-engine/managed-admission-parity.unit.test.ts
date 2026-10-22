import { PortalCallRequestSchema } from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeApprovalChallengeIntent } from '@agent-vm/gateway-control-contracts';
import { createManagedToolPortalCapabilityCore } from '@agent-vm/gateway-runtime/managed-tool-engine/managed-portal-facade.js';
import {
	createAmbiguousAdmissionResult,
	createApprovalChallenge,
	createApprovalGrant,
	createDispatchReservedResult,
	createNotDispatchedAdmissionResult,
	createRecordingApprovalPort,
	createServiceFixture,
	mixedBackendConfig,
	semanticSnapshot,
	totalBackendInvocations,
	udsOptions,
} from '@agent-vm/gateway-runtime/managed-tool-engine/test-fixtures/managed-service-test-fixture.js';
import { createManagedToolPortalCapabilityCore as createOldCore } from '@agent-vm/tool-portal';
import { describe, expect, it } from 'vitest';
const scenarios = [
	'reserve-denied',
	'reserve-ambiguous',
	'reserve-wrong-fingerprint',
	'arm-denied',
	'arm-ambiguous',
	'reserve-pending',
	'arm-wrong-fingerprint',
	'approved',
] as const;
const request = PortalCallRequestSchema.parse({
	calls: [
		{
			id: 'admission',
			namespace: 'github',
			name: 'create_issue',
			arguments: { title: 'Admission parity' },
		},
	],
});
describe('managed controller admission public projection', () => {
	it.each(scenarios)('preserves the old %s result and leaf count', async (scenario) => {
		function fixture(): ReturnType<typeof createServiceFixture> {
			let currentIntent: GatewayRuntimeApprovalChallengeIntent | undefined;
			const approval = createRecordingApprovalPort({
				reserveResult: (intent) => {
					currentIntent = intent;
					if (scenario === 'reserve-pending') return createApprovalChallenge(intent);
					if (scenario === 'reserve-denied')
						return createNotDispatchedAdmissionResult({ intent, reason: 'denied' });
					if (scenario === 'reserve-ambiguous') return createAmbiguousAdmissionResult(intent);
					const result = createDispatchReservedResult(intent);
					if (scenario === 'reserve-wrong-fingerprint' && result.kind === 'dispatch-reserved')
						return {
							...result,
							reservation: { ...result.reservation, fingerprint: `sha256:${'f'.repeat(64)}` },
						};
					return result;
				},
				armResult: (reservation) => {
					if (currentIntent === undefined) throw new Error('Expected reserve before arm');
					if (scenario === 'arm-denied')
						return createNotDispatchedAdmissionResult({ intent: currentIntent, reason: 'revoked' });
					if (scenario === 'arm-ambiguous') return createAmbiguousAdmissionResult(currentIntent);

					const grant = createApprovalGrant(reservation);
					return {
						kind: 'dispatch-armed',
						grant:
							scenario === 'arm-wrong-fingerprint'
								? { ...grant, fingerprint: `sha256:${'f'.repeat(64)}` }
								: grant,
					};
				},
			});
			return createServiceFixture({ approval });
		}
		const previous = fixture();
		const current = fixture();
		const old = createOldCore({
			config: mixedBackendConfig,
			semanticSnapshot,
			approvalPort: previous.approval.port,
			backendPorts: {
				controllerExecution: previous.controllerExecution.port,
				mcpProvider: previous.mcpProvider.port,
				toolVmRunner: previous.toolVmRunner.port,
			},
		});
		const core = createManagedToolPortalCapabilityCore({
			config: mixedBackendConfig,
			semanticSnapshot,
			approvalPort: current.approval.port,
			backendPorts: {
				controllerExecution: current.controllerExecution.port,
				mcpProvider: current.mcpProvider.port,
				toolVmRunner: current.toolVmRunner.port,
			},
			now: () => Date.parse('2026-07-13T12:00:00.000Z'),
		});
		const expected = await old.call(request, udsOptions());
		const result = await core.call(request, udsOptions());
		expect(result).toEqual(expected);
		expect(totalBackendInvocations(current)).toBe(scenario === 'approved' ? 1 : 0);
		expect(totalBackendInvocations(previous)).toBe(scenario === 'approved' ? 1 : 0);
	});
});
