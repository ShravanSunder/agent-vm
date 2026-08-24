import { describe, expect, it } from 'vitest';

import type { GatewayExpectedAdmissionCohort } from '../../gateway/gateway-aggregate-admission-state.js';
import type { GatewayOwnershipEvidence } from '../../gateway/gateway-ownership-evidence.js';
import { createManagedGatewayBootContract } from '../../gateway/managed-gateway-boot-contract.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import type { GatewayZoneRuntimeHandle } from '../zone-runtimes/zone-runtime-types.js';
import {
	classifyGatewayRecoveryAction,
	type GatewayRecoveryDecisionAction,
} from './gateway-recovery-actions.js';
import type { GatewayVmRecoveryDecision } from './gateway-vm-recovery-policy.js';

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
		stateDir: '/storage/zone-test/state',
		type: 'hermes',
		profileSecretProjectionsByAgent: { main: {} },
		profilesByAgent: { main: 'main' },
		zoneFilesDir: '/storage/zone-test/zone-files',
		zoneRuntimeDir: '/storage/zone-test/runtime',
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

describe('classifyGatewayRecoveryAction', () => {
	it('restarts a running gateway when the recovery policy permits action', () => {
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: { kind: 'running', gateway: createGatewayRuntimeHandle() },
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'restart-running-gateway',
			reason: 'gateway-service-unhealthy',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('cold-starts a stopped or cold-start-eligible failed gateway instead of returning old-gateway-not-running', () => {
		const stoppedAction = classifyGatewayRecoveryAction({
			lifecycleState: { kind: 'stopped' },
			recoveryDecision: createRestartDecision(),
		});
		const failedAction = classifyGatewayRecoveryAction({
			lifecycleState: {
				coldStartEligible: true,
				error: { code: 'vm-process-missing', message: 'Gateway VM process is missing.' },
				kind: 'failed',
			},
			recoveryDecision: createRestartDecision(),
		});

		expect(stoppedAction).toEqual({
			kind: 'cold-start-gateway',
			reason: 'gateway-service-unhealthy',
		} satisfies GatewayRecoveryDecisionAction);
		expect(failedAction).toEqual({
			kind: 'cold-start-gateway',
			reason: 'gateway-service-unhealthy',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('refreshes the secret resolver for failed runtimes blocked by secret resolution', () => {
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: {
					coldStartEligible: true,
					error: {
						code: 'secret-resolution-failed',
						message: 'Failed to resolve zone secrets.',
					},
					kind: 'failed',
				},
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'refresh-secret-resolver',
			reason: 'secret-resolution-failed',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('treats later secret-resolution failures as refresh blockers even when provider health triggered recovery', () => {
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: {
					coldStartEligible: true,
					error: {
						code: 'secret-resolution-failed',
						message: 'Failed to resolve zone secrets.',
					},
					kind: 'failed',
				},
				recoveryDecision: {
					consecutiveFailures: 3,
					kind: 'restart',
					reason: 'agent-channel-provider-unhealthy',
					zoneId: 'sunfam',
				},
			}),
		).toEqual({
			kind: 'refresh-secret-resolver',
			reason: 'secret-resolution-failed',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('requires an operator for owner-unsafe or ambiguous failed runtime state', () => {
		const ownershipEvidence: GatewayOwnershipEvidence = {
			kind: 'missing-record-port-owned',
			ownerCommand: 'qemu-system-aarch64',
			ownerPid: 1234,
			port: 18791,
		};

		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: { evidence: ownershipEvidence, kind: 'owner-unsafe' },
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'operator-required',
			reason: 'owner-unsafe',
		} satisfies GatewayRecoveryDecisionAction);
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: {
					coldStartEligible: false,
					error: { code: 'owner-unsafe', message: 'gateway close timed out' },
					kind: 'failed',
				},
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'operator-required',
			reason: 'owner-unsafe',
		} satisfies GatewayRecoveryDecisionAction);
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: {
					coldStartEligible: false,
					error: { code: 'record-write-failed', message: 'Runtime record write failed.' },
					kind: 'failed',
				},
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'operator-required',
			reason: 'ambiguous-runtime-state',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('keeps transitional states and policy cooldowns observe-only without blaming provider health', () => {
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: {
					kind: 'starting',
					operationId: 'op-start',
					startedAtMs: 10,
				},
				recoveryDecision: createRestartDecision(),
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'recovery-in-flight',
		} satisfies GatewayRecoveryDecisionAction);
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: { kind: 'running', gateway: createGatewayRuntimeHandle() },
				recoveryDecision: { consecutiveFailures: 10, kind: 'none', reason: 'cooldown' },
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'cooldown-active',
		} satisfies GatewayRecoveryDecisionAction);
	});

	it('keeps policy none reasons specific instead of labeling them as provider transitions', () => {
		const cases = [
			{ expected: 'recovery-disabled', reason: 'disabled' },
			{ expected: 'recovery-in-flight', reason: 'in-flight' },
			{ expected: 'recovery-unobserved', reason: 'unobserved' },
			{ expected: 'recovery-unobserved', reason: undefined },
		] as const;

		for (const testCase of cases) {
			expect(
				classifyGatewayRecoveryAction({
					lifecycleState: { kind: 'running', gateway: createGatewayRuntimeHandle() },
					recoveryDecision: {
						consecutiveFailures: 10,
						kind: 'none',
						reason: testCase.reason,
					},
				}),
			).toEqual({
				kind: 'observe-only',
				reason: testCase.expected,
			} satisfies GatewayRecoveryDecisionAction);
		}
	});

	it('passes through recovery suspension without making it a lifecycle state', () => {
		expect(
			classifyGatewayRecoveryAction({
				lifecycleState: { kind: 'running', gateway: createGatewayRuntimeHandle() },
				recoveryDecision: {
					consecutiveFailedRecoveries: 3,
					consecutiveFailures: 12,
					kind: 'suspended',
					outwardEscalationRequired: true,
					reason: 'max-failed-recoveries',
					zoneId: 'sunfam',
				},
			}),
		).toEqual({
			errorCode: 'max-failed-recoveries',
			kind: 'suspend-recovery',
		} satisfies GatewayRecoveryDecisionAction);
	});
});

function createRestartDecision(): GatewayVmRecoveryDecision {
	return {
		consecutiveFailures: 10,
		kind: 'restart',
		reason: 'gateway-service-unhealthy',
		zoneId: 'sunfam',
	};
}

function createGatewayRuntimeHandle(): Extract<
	GatewayZoneLifecycleState,
	{ readonly kind: 'running' }
>['gateway'] {
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
			getHostProcessId: () => 42,
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
			gatewayEpoch: 'generation-test',
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
			gatewayEpoch: 'generation-test',
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
