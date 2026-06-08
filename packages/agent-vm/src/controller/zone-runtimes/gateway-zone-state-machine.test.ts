import { gatewayRecoveryHealthReasons } from '@agent-vm/gateway-interface';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GatewayOwnershipEvidence } from '../../gateway/gateway-ownership-evidence.js';
import type { ControllerZoneLifecycleState } from '../../operations/controller-status.js';
import {
	classifyGatewayStartError,
	deriveGatewayDiagnosisSnapshot,
	projectGatewayZoneLifecycleStateForStatus,
	type GatewayDiagnosisSnapshot,
	type GatewayLifecycleErrorCode,
	type GatewayRecoveryErrorCode,
	type GatewayZoneLifecycleState,
} from './gateway-zone-state-machine.js';
import type { GatewayZoneRuntimeHandle } from './zone-runtime-types.js';

describe('projectGatewayZoneLifecycleStateForStatus', () => {
	it('keeps the public controller status projection backward-compatible', () => {
		const gateway = createGatewayRuntimeHandle();
		const ownerEvidence = createOwnershipEvidence();

		const cases: readonly {
			readonly expected: ControllerZoneLifecycleState;
			readonly state: GatewayZoneLifecycleState;
		}[] = [
			{ expected: 'stopped', state: { kind: 'stopped' } },
			{
				expected: 'stopped',
				state: { kind: 'starting', operationId: 'op-start', startedAtMs: 100 },
			},
			{ expected: 'running', state: { gateway, kind: 'running' } },
			{
				expected: 'running',
				state: { gateway, kind: 'running-degraded', reason: 'gateway-service-unhealthy' },
			},
			{
				expected: 'stopped',
				state: {
					kind: 'stopping',
					next: 'stopped',
					operationId: 'op-stop',
					previousGateway: gateway,
				},
			},
			{
				expected: 'stopped',
				state: { kind: 'restarting', operationId: 'op-restart', previousGateway: gateway },
			},
			{
				expected: 'failed',
				state: {
					coldStartEligible: true,
					error: { code: 'secret-resolution-failed', message: 'failed to resolve secrets' },
					kind: 'failed',
				},
			},
			{ expected: 'failed', state: { evidence: ownerEvidence, kind: 'owner-unsafe' } },
		];

		for (const testCase of cases) {
			expect(projectGatewayZoneLifecycleStateForStatus(testCase.state)).toBe(testCase.expected);
		}
	});
});

describe('deriveGatewayDiagnosisSnapshot', () => {
	it('keeps later secret resolution failures as recovery blockers, not original outage causes', () => {
		const diagnosis = deriveGatewayDiagnosisSnapshot({
			channelProviderPlane: 'unknown',
			controllerLiveness: 'ok',
			lastOperation: 'credentials-refresh',
			state: {
				coldStartEligible: true,
				error: {
					code: 'secret-resolution-failed',
					message: 'Failed to resolve zone secrets.',
				},
				kind: 'failed',
			},
			toolVmPlane: 'unknown',
		});

		expect(diagnosis).toEqual({
			channelProviderPlane: 'unknown',
			controllerLiveness: 'ok',
			currentRecoveryBlocker: 'secret-resolution-failed',
			gatewayInfrastructure: 'failed',
			lastOperation: 'credentials-refresh',
			originalOutageCause: { kind: 'unknown' },
			selectedZoneReadiness: 'failed',
			toolVmPlane: 'unknown',
		});
	});

	it('does not turn channel-provider degradation into gateway infrastructure failure', () => {
		const diagnosis = deriveGatewayDiagnosisSnapshot({
			channelProviderPlane: 'degraded',
			controllerLiveness: 'ok',
			state: {
				gateway: createGatewayRuntimeHandle(),
				kind: 'running-degraded',
				reason: 'gateway-service-unhealthy',
			},
			toolVmPlane: 'ok',
		});

		expect(diagnosis.gatewayInfrastructure).toBe('running-degraded');
		expect(diagnosis.channelProviderPlane).toBe('degraded');
		expect(diagnosis.currentRecoveryBlocker).toBe('gateway-service-unhealthy');
		expect(diagnosis.originalOutageCause).toEqual({ kind: 'unknown' });
		expect(diagnosis.selectedZoneReadiness).toBe('degraded');
	});

	it('can preserve a proven original secret failure when durable operation timing proves it', () => {
		const diagnosis = deriveGatewayDiagnosisSnapshot({
			channelProviderPlane: 'unknown',
			controllerLiveness: 'ok',
			lastOperation: 'start',
			originalOutageCause: {
				errorCode: 'secret-resolution-failed',
				eventKind: 'gateway-lifecycle-operation',
				kind: 'proven',
			},
			state: {
				coldStartEligible: true,
				error: {
					code: 'secret-resolution-failed',
					message: 'Failed to resolve zone secrets.',
				},
				kind: 'failed',
			},
			toolVmPlane: 'unknown',
		});

		expect(diagnosis.originalOutageCause).toEqual({
			errorCode: 'secret-resolution-failed',
			eventKind: 'gateway-lifecycle-operation',
			kind: 'proven',
		});
		expect(diagnosis.currentRecoveryBlocker).toBe('secret-resolution-failed');
	});

	it('reports selected-zone failure as failed readiness while controller liveness stays ok', () => {
		const diagnosis = deriveGatewayDiagnosisSnapshot({
			channelProviderPlane: 'unknown',
			controllerLiveness: 'ok',
			state: {
				coldStartEligible: true,
				error: {
					code: 'vm-process-missing',
					message: 'Gateway VM process is missing.',
				},
				kind: 'failed',
			},
			toolVmPlane: 'unknown',
		});

		expect(diagnosis.controllerLiveness).toBe('ok');
		expect(diagnosis.selectedZoneReadiness).toBe('failed');
	});

	it('keeps status-facing diagnosis as the precise canonical snapshot type', () => {
		expectTypeOf<GatewayDiagnosisSnapshot>().toMatchTypeOf<{
			readonly currentRecoveryBlocker: GatewayLifecycleErrorCode | 'none';
			readonly lastOperation:
				| 'cold-start'
				| 'credentials-refresh'
				| 'none'
				| 'restart'
				| 'start'
				| 'stop';
		}>();
		expectTypeOf<
			Extract<
				GatewayDiagnosisSnapshot['originalOutageCause'],
				{ readonly kind: 'proven' }
			>['errorCode']
		>().toEqualTypeOf<GatewayLifecycleErrorCode | undefined>();
		expectTypeOf<{
			readonly errorCode: 'discord-403';
			readonly eventKind: 'gateway-lifecycle-operation';
			readonly kind: 'proven';
		}>().not.toMatchTypeOf<GatewayDiagnosisSnapshot['originalOutageCause']>();
	});
});

describe('classifyGatewayStartError', () => {
	it('classifies secret resolution failures without requiring OpenClaw-specific knowledge', () => {
		const error = new Error('Failed to resolve zone secrets for zone sunfam: op failed');

		expect(classifyGatewayStartError(error).code).toBe('secret-resolution-failed');
	});
});

describe('GatewayRecoveryErrorCode', () => {
	it('stays derived from shared recovery reasons instead of loose strings', () => {
		expect(gatewayRecoveryHealthReasons).toEqual([
			'agent-channel-provider-unhealthy',
			'gateway-control-link-unhealthy',
			'gateway-service-unhealthy',
		]);
		expectTypeOf<GatewayRecoveryErrorCode>().toEqualTypeOf<
			| 'agent-channel-provider-unhealthy'
			| 'gateway-control-link-unhealthy'
			| 'gateway-service-unhealthy'
		>();
	});
});

function createGatewayRuntimeHandle(): GatewayZoneRuntimeHandle {
	return {
		ingress: { host: '127.0.0.1', port: 18791 },
		processSpec: {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 8080,
			healthCheck: { path: '/readyz', port: 8080, type: 'http' },
			logPath: '/logs/gateway.log',
			startCommand: 'start',
		},
		vm: {
			close: async (): Promise<void> => {},
			enableSsh: (): never => {
				throw new Error('not used');
			},
			exec: (): never => {
				throw new Error('not used');
			},
			getHostPid: (): number => 42,
			id: 'gateway-vm-1',
		},
	};
}

function createOwnershipEvidence(): GatewayOwnershipEvidence {
	return {
		kind: 'missing-record-port-owned',
		ownerCommand: 'qemu-system-aarch64',
		ownerPid: 1234,
		port: 18791,
	};
}
