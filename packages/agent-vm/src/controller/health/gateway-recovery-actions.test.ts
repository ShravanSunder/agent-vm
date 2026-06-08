import { describe, expect, it } from 'vitest';

import type { GatewayOwnershipEvidence } from '../../gateway/gateway-ownership-evidence.js';
import type { GatewayZoneLifecycleState } from '../zone-runtimes/gateway-zone-state-machine.js';
import {
	classifyGatewayRecoveryAction,
	type GatewayRecoveryDecisionAction,
} from './gateway-recovery-actions.js';
import type { GatewayVmRecoveryDecision } from './gateway-vm-recovery-policy.js';

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
		ingress: { host: '127.0.0.1', port: 18791 },
		processSpec: {
			bootstrapCommand: 'bootstrap',
			guestListenPort: 18789,
			healthCheck: { path: '/readyz', port: 18789, type: 'http' },
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
			getHostPid: () => 42,
			id: 'gateway-vm-1',
		},
	};
}
