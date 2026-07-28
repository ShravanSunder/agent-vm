import { describe, expect, it } from 'vitest';

import { createGatewayVmRecoveryTracker } from './gateway-vm-recovery-policy.js';
import type {
	GatewayVmRecoverySourceKey,
	GatewayVmRecoveryTracker,
} from './gateway-vm-recovery-policy.js';

const policy = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;

const gatewayRecoverySourceKey = {
	bootId: 'gateway-boot-a',
	domain: 'gateway_control',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: 'sunfam',
} satisfies GatewayVmRecoverySourceKey;

const replacementGatewayRecoverySourceKey = {
	...gatewayRecoverySourceKey,
	bootId: 'gateway-boot-b',
	gatewayVmId: 'gateway-vm-b',
	generationId: 'gateway-generation-b',
} satisfies GatewayVmRecoverySourceKey;

function stabilizeGatewayRecovery(
	tracker: GatewayVmRecoveryTracker,
	options: { readonly recoveryFinishedAtMs: number },
): number {
	const stableAtMs = options.recoveryFinishedAtMs + policy.restartTimeoutMs;
	for (let observationIndex = 1; observationIndex <= 3; observationIndex += 1) {
		tracker.recordGatewayControlSessionObservation({
			observedAtMs: stableAtMs + observationIndex,
			result: 'ok',
			sourceKey: replacementGatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
		tracker.recordGatewayServiceProbe({
			observedAtMs: stableAtMs + observationIndex,
			result: 'ok',
			sourceKey: replacementGatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
	}
	return stableAtMs + 3;
}

function primeControlSessionRecoveryDue(
	tracker: GatewayVmRecoveryTracker,
	options: { readonly observedAtMs?: number } = {},
): void {
	const observedAtMs = options.observedAtMs ?? 1_000;
	for (let index = 1; index <= policy.consecutiveFailureThreshold; index += 1) {
		tracker.recordGatewayControlSessionObservation({
			controlSessionDeathGrace: 'recovery-due',
			observedAtMs: observedAtMs + index,
			result: 'stale',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: gatewayRecoverySourceKey.zoneId,
		});
	}
}

describe('createGatewayVmRecoveryTracker', () => {
	it('requests immediate whole-Gateway recovery for terminal attachment loss', () => {
		// Arrange
		const tracker = createGatewayVmRecoveryTracker({ policy });

		// Act
		const decision = tracker.requestTerminalGatewayRecovery({
			observedAtMs: 10_000,
			result: 'failed',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: gatewayRecoverySourceKey.zoneId,
		});

		// Assert
		expect(decision).toEqual({
			consecutiveFailures: policy.consecutiveFailureThreshold,
			kind: 'restart',
			reason: 'gateway-service-unhealthy',
			zoneId: gatewayRecoverySourceKey.zoneId,
		});
	});

	it('retains policy fences for terminal attachment-loss recovery requests', () => {
		// Arrange
		const disabledTracker = createGatewayVmRecoveryTracker({
			policy: { ...policy, enabled: false },
		});
		const activeTracker = createGatewayVmRecoveryTracker({ policy });
		activeTracker.markRecoveryStarted({ observedAtMs: 10_000, zoneId: 'sunfam' });

		// Act
		const disabledDecision = disabledTracker.requestTerminalGatewayRecovery({
			observedAtMs: 10_000,
			result: 'failed',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
		const inFlightDecision = activeTracker.requestTerminalGatewayRecovery({
			observedAtMs: 10_001,
			result: 'failed',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
		activeTracker.markRecoveryFinished({ observedAtMs: 20_000, result: 'ok', zoneId: 'sunfam' });
		const stabilizingDecision = activeTracker.requestTerminalGatewayRecovery({
			observedAtMs: 20_001,
			result: 'failed',
			sourceKey: replacementGatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});

		// Assert
		expect(disabledDecision).toMatchObject({ kind: 'none', reason: 'disabled' });
		expect(inFlightDecision).toMatchObject({ kind: 'none', reason: 'in-flight' });
		expect(stabilizingDecision).toMatchObject({ kind: 'none', reason: 'stabilizing' });
	});

	it('requires control-session death-grace evidence before gateway-service failures can restart', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: index * 10_000,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toEqual({
				consecutiveFailures: index,
				kind: 'none',
				reason: 'missing-source-key',
			});
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 10, kind: 'none', reason: 'missing-source-key' });

		for (let index = 1; index <= 9; index += 1) {
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 100_000 + index,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			});
		}
		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 110_000,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-control-session-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('resets gateway-service failures after an ok probe', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		tracker.recordGatewayServiceProbe({ observedAtMs: 10_000, result: 'failed', zoneId: 'sunfam' });
		tracker.recordGatewayServiceProbe({ observedAtMs: 20_000, result: 'failed', zoneId: 'sunfam' });
		expect(
			tracker.recordGatewayServiceProbe({ observedAtMs: 30_000, result: 'ok', zoneId: 'sunfam' }),
		).toEqual({ consecutiveFailures: 0, kind: 'none' });
		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 40_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 10, kind: 'none', reason: 'needs-corroboration' });
	});

	it('tracks consecutive failures independently per zone', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 9; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 95_000,
				result: 'ok',
				zoneId: 'alevtina',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-control-session-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('resets only old control evidence when the Gateway source changes', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: {
				...policy,
				channelProviderHealth: {
					consecutiveFailureThreshold: 3,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
		});
		for (let failureIndex = 1; failureIndex <= 2; failureIndex += 1) {
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: failureIndex,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			});
			tracker.recordGatewayServiceProbe({
				observedAtMs: failureIndex,
				result: 'failed',
				zoneId: 'sunfam',
			});
			tracker.recordAgentChannelProviderObservation({
				channelProviderHealth: 'unhealthy-recoverable',
				channelProviderId: 'discord-primary',
				observedAtMs: failureIndex,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}

		tracker.recordGatewaySourceChange({
			sourceKey: replacementGatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});

		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 4,
				result: 'stale',
				sourceKey: replacementGatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toMatchObject({ consecutiveFailures: 2, kind: 'none' });
		expect(
			tracker.recordGatewayServiceProbe({ observedAtMs: 4, result: 'failed', zoneId: 'sunfam' }),
		).toMatchObject({ consecutiveFailures: 3, kind: 'none' });
		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderHealth: 'unhealthy-recoverable',
				channelProviderId: 'discord-primary',
				observedAtMs: 4,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toMatchObject({ consecutiveFailures: 3, kind: 'restart' });
	});

	it('honors disabled auto recovery policy without returning restart decisions', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: { ...policy, enabled: false },
		});

		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 110_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'disabled' });
	});

	it('requires controller probe corroboration before control-session observations can restart', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		expect(
			tracker.recordGatewayControlSessionObservation({
				observedAtMs: 10_000,
				result: 'unobserved',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none', reason: 'unobserved' });

		tracker.recordGatewayControlSessionObservation({
			observedAtMs: 20_000,
			result: 'ok',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayControlSessionObservation({
					observedAtMs: 20_000 + index * 10_000,
					result: 'stale',
					sourceKey: gatewayRecoverySourceKey,
					controlSessionDeathGrace: 'recovery-due',
					zoneId: 'sunfam',
				}),
			).toEqual({
				consecutiveFailures: index,
				kind: 'none',
				reason: 'needs-corroboration',
			});
		}

		expect(
			tracker.recordGatewayControlSessionObservation({
				observedAtMs: 120_000,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				controlSessionDeathGrace: 'recovery-due',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 10, kind: 'none', reason: 'needs-corroboration' });

		for (let index = 1; index <= 9; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: 130_000 + index,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 140_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-control-session-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('requires control-session and gateway-service corroboration in the same freshness window', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker, { observedAtMs: 1_000 });
		for (let index = 1; index <= policy.consecutiveFailureThreshold; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: 1_000 + policy.restartTimeoutMs + index,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 1_000 + policy.restartTimeoutMs + policy.consecutiveFailureThreshold + 1,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 11,
			kind: 'none',
			reason: 'needs-corroboration',
		});

		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 1_000 + policy.restartTimeoutMs + policy.consecutiveFailureThreshold + 2,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 11,
			kind: 'restart',
			reason: 'gateway-control-session-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('does not treat older out-of-order control-session evidence as fresh corroboration', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= policy.consecutiveFailureThreshold; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000 + index,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}

		for (let index = 1; index < policy.consecutiveFailureThreshold; index += 1) {
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 90_000 + index,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			});
		}

		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 90_000 + policy.consecutiveFailureThreshold,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'none',
			reason: 'needs-corroboration',
		});
	});

	it('does not treat a within-grace control-session disconnect as recovery evidence', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= policy.consecutiveFailureThreshold; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}

		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'within-grace',
				observedAtMs: 100_000,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 1, kind: 'none', reason: 'within-grace' });

		expect(
			tracker.recordGatewayControlSessionObservation({
				observedAtMs: 101_000,
				result: 'ok',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 102_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'needs-corroboration' });
	});

	it('blocks automatic restart decisions during cooldown', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'failed', zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 140_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'cooldown' });
	});

	it('requires fresh control-session corroboration after a successful recovery', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= policy.consecutiveFailureThreshold; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: 20_000 + index,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'ok', zoneId: 'sunfam' });

		for (let index = 1; index <= policy.consecutiveFailureThreshold - 1; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: 140_000 + index,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toMatchObject({ kind: 'none' });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 150_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 20, kind: 'none', reason: 'stabilizing' });
	});

	it('keeps running restart and failed-runtime cold-start recovery budgets separate', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: {
				...policy,
				consecutiveFailureThreshold: 1,
				maxConsecutiveFailedRecoveries: 1,
			},
		});

		primeControlSessionRecoveryDue(tracker);
		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 10_000,
				recoveryBudgetClass: 'gateway-vm-restart',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toMatchObject({
			kind: 'restart',
			reason: 'gateway-control-session-unhealthy',
		});
		tracker.markRecoveryStarted({
			observedAtMs: 10_000,
			recoveryBudgetClass: 'gateway-vm-restart',
			zoneId: 'sunfam',
		});
		tracker.markRecoveryFinished({
			observedAtMs: 20_000,
			recoveryBudgetClass: 'gateway-vm-restart',
			result: 'failed',
			zoneId: 'sunfam',
		});

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 30_000,
				recoveryBudgetClass: 'gateway-vm-cold-start',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 2,
			kind: 'restart',
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('allows another automatic restart after one failed recovery and the 61 minute cooldown expires', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'failed', zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 130_000 + policy.cooldownMs + 1,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 11,
			kind: 'none',
			reason: 'needs-corroboration',
		});
		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 130_000 + policy.cooldownMs + 2,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toMatchObject({ kind: 'restart', zoneId: 'sunfam' });
	});

	it('suspends automatic restarts after repeated failed recoveries until the reset window expires', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: { ...policy, maxConsecutiveFailedRecoveries: 2 },
		});

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 110_000, result: 'failed', zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 110_000 + policy.cooldownMs + 1,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 11,
			kind: 'none',
			reason: 'needs-corroboration',
		});
		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 110_000 + policy.cooldownMs + 2,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toMatchObject({ kind: 'restart', zoneId: 'sunfam' });
		tracker.markRecoveryStarted({
			observedAtMs: 110_000 + policy.cooldownMs + 2,
			zoneId: 'sunfam',
		});
		tracker.markRecoveryFinished({
			observedAtMs: 120_000 + policy.cooldownMs + 1,
			result: 'failed',
			zoneId: 'sunfam',
		});

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 120_000 + policy.cooldownMs * 2 + 2,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 12,
			kind: 'none',
			reason: 'needs-corroboration',
		});

		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 120_000 + policy.cooldownMs * 2 + 3,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailedRecoveries: 2,
			consecutiveFailures: 12,
			kind: 'suspended',
			outwardEscalationRequired: true,
			reason: 'max-failed-recoveries',
			zoneId: 'sunfam',
		});

		tracker.recordGatewayServiceProbe({
			observedAtMs: 120_000 + policy.cooldownMs + policy.failedRecoveryResetMs + 3,
			result: 'failed',
			zoneId: 'sunfam',
		});
		expect(
			tracker.recordGatewayControlSessionObservation({
				controlSessionDeathGrace: 'recovery-due',
				observedAtMs: 120_000 + policy.cooldownMs + policy.failedRecoveryResetMs + 4,
				result: 'stale',
				sourceKey: gatewayRecoverySourceKey,
				zoneId: 'sunfam',
			}),
		).toMatchObject({ kind: 'restart', zoneId: 'sunfam' });
	});

	it('does not reset automatic restart cooldown after a healthy interlude', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 130_000, result: 'ok', zoneId: 'sunfam' });
		const stabilizedAtMs = stabilizeGatewayRecovery(tracker, { recoveryFinishedAtMs: 130_000 });
		tracker.recordGatewayServiceProbe({
			observedAtMs: stabilizedAtMs + 30 * 60 * 1000,
			result: 'ok',
			sourceKey: replacementGatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
		primeControlSessionRecoveryDue(tracker, {
			observedAtMs: stabilizedAtMs + 31 * 60 * 1000,
		});

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: stabilizedAtMs + 31 * 60 * 1000 + index,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toMatchObject({ kind: 'none' });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: stabilizedAtMs + 31 * 60 * 1000 + 10,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 10, kind: 'none', reason: 'cooldown' });
	});

	it('does not return overlapping restart decisions while recovery is in flight', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		primeControlSessionRecoveryDue(tracker);
		for (let index = 1; index <= 10; index += 1) {
			tracker.recordGatewayServiceProbe({
				observedAtMs: index * 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			});
		}
		tracker.markRecoveryStarted({ observedAtMs: 100_000, zoneId: 'sunfam' });

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 110_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 11, kind: 'none', reason: 'in-flight' });
	});

	it('preserves unrelated provider failures while Gateway recovery awaits sustained stability', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: {
				...policy,
				channelProviderHealth: {
					consecutiveFailureThreshold: 3,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
		});
		const providerFailure = {
			channelProviderHealth: 'unhealthy-recoverable' as const,
			channelProviderId: 'discord-primary',
			result: 'failed' as const,
			zoneId: 'sunfam',
		};

		tracker.recordAgentChannelProviderObservation({ ...providerFailure, observedAtMs: 10_000 });
		tracker.recordAgentChannelProviderObservation({ ...providerFailure, observedAtMs: 20_000 });
		tracker.markRecoveryStarted({ observedAtMs: 30_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 40_000, result: 'ok', zoneId: 'sunfam' });

		expect(
			tracker.recordAgentChannelProviderObservation({
				...providerFailure,
				observedAtMs: 50_000,
			}),
		).toEqual({ consecutiveFailures: 3, kind: 'none', reason: 'stabilizing' });
	});

	it('emits outward escalation once after the failed Gateway recovery budget is exhausted', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: { ...policy, consecutiveFailureThreshold: 1, maxConsecutiveFailedRecoveries: 1 },
		});
		primeControlSessionRecoveryDue(tracker);
		tracker.recordGatewayServiceProbe({ observedAtMs: 10_000, result: 'failed', zoneId: 'sunfam' });
		tracker.markRecoveryStarted({ observedAtMs: 10_000, zoneId: 'sunfam' });
		tracker.markRecoveryFinished({ observedAtMs: 20_000, result: 'failed', zoneId: 'sunfam' });
		const retryAtMs = 20_000 + policy.cooldownMs + 1;
		tracker.recordGatewayServiceProbe({
			observedAtMs: retryAtMs,
			result: 'failed',
			zoneId: 'sunfam',
		});

		const firstSuspension = tracker.recordGatewayControlSessionObservation({
			controlSessionDeathGrace: 'recovery-due',
			observedAtMs: retryAtMs + 1,
			result: 'stale',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});
		const repeatedSuspension = tracker.recordGatewayControlSessionObservation({
			controlSessionDeathGrace: 'recovery-due',
			observedAtMs: retryAtMs + 2,
			result: 'stale',
			sourceKey: gatewayRecoverySourceKey,
			zoneId: 'sunfam',
		});

		expect(firstSuspension).toMatchObject({
			kind: 'suspended',
			outwardEscalationRequired: true,
		});
		expect(repeatedSuspension).toMatchObject({
			kind: 'suspended',
			outwardEscalationRequired: false,
		});
	});

	it('tracks channel-provider failures per provider so healthy providers do not mask unhealthy ones', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: {
				...policy,
				channelProviderHealth: {
					consecutiveFailureThreshold: 3,
					enabled: true,
					restartGatewayOnRecoverable: true,
					restartGatewayOnUnrecoverable: false,
					transitioningTimeoutMs: 120_000,
				},
			},
		});

		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderId: 'primary-channel',
				observedAtMs: 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 1, kind: 'none' });
		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderId: 'secondary-channel',
				observedAtMs: 11_000,
				result: 'ok',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none' });
		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderId: 'primary-channel',
				observedAtMs: 20_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 2, kind: 'none' });

		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderId: 'primary-channel',
				observedAtMs: 30_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 3,
			kind: 'restart',
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('observes recoverable channel-provider failures by default without restarting the gateway VM', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 3; index += 1) {
			expect(
				tracker.recordAgentChannelProviderObservation({
					channelProviderId: 'discord',
					observedAtMs: index * 10_000,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toEqual({
				consecutiveFailures: index,
				kind: 'none',
				reason: 'disabled',
			});
		}
	});

	it('allows unrecoverable channel-provider restart opt-in independently from recoverable restart opt-in', () => {
		const tracker = createGatewayVmRecoveryTracker({
			policy: {
				...policy,
				channelProviderHealth: {
					consecutiveFailureThreshold: 2,
					enabled: true,
					restartGatewayOnRecoverable: false,
					restartGatewayOnUnrecoverable: true,
					transitioningTimeoutMs: 120_000,
				},
			},
		});

		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderHealth: 'unhealthy-recoverable',
				channelProviderId: 'discord',
				observedAtMs: 10_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 1,
			kind: 'none',
			reason: 'disabled',
		});
		expect(
			tracker.recordAgentChannelProviderObservation({
				channelProviderHealth: 'unhealthy-unrecoverable',
				channelProviderId: 'discord',
				observedAtMs: 20_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 2,
			kind: 'restart',
			reason: 'agent-channel-provider-unhealthy',
			zoneId: 'sunfam',
		});
	});
});
