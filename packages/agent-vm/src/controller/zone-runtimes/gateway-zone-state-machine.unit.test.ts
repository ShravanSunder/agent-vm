import { gatewayRecoveryHealthReasons } from '@agent-vm/gateway-lifecycle';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import type { GatewayOwnershipEvidence } from '../../gateway/gateway-ownership-evidence.js';
import { createManagedGatewayBootContract } from '../../gateway/managed-gateway-boot-contract.js';
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

const testManagedGatewayBootContract = createManagedGatewayBootContract({
	bootEntry: 'hermes-gateway',
	configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
	environmentInputPath: '/run/agent-vm/managed-gateway/framework.environment.sh',
	framework: 'hermes',
	ingress: { guestPort: 18_789, kind: 'framework-http' },
	logIdentity: {
		guestPath: '/var/log/agent-vm/openclaw-service.log',
		serviceName: 'agent-vm-hermes-test',
	},
	readiness: { guestPort: 18_789, kind: 'framework-http', path: '/readyz' },
	role: 'framework-service',
});

const testOpenClawZone = {
	agentToolVmProfiles: {},
	defaultToolVmProfile: 'standard',
	egressHosts: [],
	gateway: {
		config: '/config/openclaw.json',
		cpus: 2,
		imageProfile: 'openclaw',
		memory: '2G',
		port: 18_791,
		stateDir: '/state/zone-test',
		type: 'hermes',
		profileSecretProjectionsByAgent: { main: {} },
		profilesByAgent: { main: 'main' },
		zoneFilesDir: '/zone-files/zone-test',
		zoneRuntimeDir: '/runtime/zone-test',
	},
	id: 'zone-test',
	secrets: {
		OPENCLAW_GATEWAY_TOKEN: {
			audience: 'gateway',
			envVar: 'OPENCLAW_GATEWAY_TOKEN',
			injection: 'env',
			source: 'environment',
		},
	},
} satisfies GatewayZoneRuntimeHandle['zone'];

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
			toolVmLeaseState: 'not-applicable',
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

	it('does not classify generic operation failures as secret resolution failures', () => {
		const error = new Error('Bootstrap op failed while starting gateway process.');

		expect(classifyGatewayStartError(error).code).toBe('vm-start-failed');
	});
});

describe('GatewayRecoveryErrorCode', () => {
	it('stays derived from shared recovery reasons instead of loose strings', () => {
		expect(gatewayRecoveryHealthReasons).toEqual([
			'agent-channel-provider-unhealthy',
			'gateway-control-session-unhealthy',
			'gateway-service-unhealthy',
		]);
		expectTypeOf<GatewayRecoveryErrorCode>().toEqualTypeOf<
			| 'agent-channel-provider-unhealthy'
			| 'gateway-control-session-unhealthy'
			| 'gateway-service-unhealthy'
		>();
	});
});

function createGatewayRuntimeHandle(): GatewayZoneRuntimeHandle {
	return {
		bootContract: testManagedGatewayBootContract,
		executionModel: 'managed-gateway',
		expectedCohort: createExpectedAdmissionCohort(),
		destroyGateway: async () => ({ kind: 'destroyed-clean' }),
		gatewayIdentity: createGatewayIdentity('gateway-vm-1'),
		image: {
			built: false,
			fingerprint: 'gateway-image-fingerprint',
			imageReference: '/images/openclaw-gateway',
		},
		ingress: { host: '127.0.0.1', port: 18791 },
		vm: {
			enableSsh: (): never => {
				throw new Error('not used');
			},
			exec: (): never => {
				throw new Error('not used');
			},
			getHostProcessId: (): number => 42,
			id: 'gateway-vm-1',
		},
		zone: testOpenClawZone,
	};
}

function createExpectedAdmissionCohort(): GatewayExpectedAdmissionCohort {
	return {
		controlIdentity: {
			controllerEpoch: 'controller-test',
			generationId: 'generation-test',
			peerId: 'tool-portal-control',
			processEpoch: 'tool-portal-process-test',
		},
		fence: {
			controllerEpoch: 'controller-test',
			gatewayEpoch: 'gateway-epoch-test',
			vmId: 'gateway-vm-1',
			zoneId: 'zone-test',
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['main'],
			frameworkEpoch: 'framework-epoch-test',
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 18_790,
				kind: 'tool-portal-control',
				prefix: '/_agent-vm/control',
				stripPrefix: true,
			},
			frameworkRootRoute: {
				guestPort: 18_789,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: 'provider-revision-test',
		requiredBackendRevision: 'required-backend-revision-test',
		semanticRevision: 'semantic-revision-test',
		toolPortalIdentity: {
			processEpoch: 'tool-portal-process-test',
			role: 'tool-portal',
			runtimeEpoch: 'runtime-epoch-test',
			serviceId: 'tool-portal-service-test',
		},
		udsIdentity: {
			frameworkEpoch: 'framework-epoch-test',
			gatewayEpoch: 'gateway-epoch-test',
			runtimeEpoch: 'runtime-epoch-test',
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

function createGatewayIdentity(vmId: string): GatewayZoneRuntimeHandle['gatewayIdentity'] {
	return {
		bootId: 'boot-test',
		controllerEpoch: 'controller-test',
		gatewayEpochId: 'gateway-epoch-test',
		gatewayVmId: vmId,
		generationId: 'generation-test',
		zoneId: 'zone-test',
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
