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
		).toEqual({
			consecutiveFailures: 10,
			kind: 'none',
			reason: 'missing-source-key',
		});

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
		).toEqual({
			consecutiveFailures: 10,
			kind: 'none',
			reason: 'missing-source-key',
		});
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
				observedAtMs: 100_000 + policy.cooldownMs + 1,
				result: 'failed',
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
				observedAtMs: 100_000 + policy.cooldownMs + 1,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toMatchObject({ kind: 'restart', zoneId: 'sunfam' });
		tracker.markRecoveryStarted({
			observedAtMs: 100_000 + policy.cooldownMs + 1,
			zoneId: 'sunfam',
		});
		tracker.markRecoveryFinished({
			observedAtMs: 110_000 + policy.cooldownMs + 1,
			result: 'failed',
			zoneId: 'sunfam',
		});

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000 + policy.cooldownMs * 2 + 2,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailedRecoveries: 2,
			consecutiveFailures: 12,
			kind: 'suspended',
			reason: 'max-failed-recoveries',
			zoneId: 'sunfam',
		});

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 110_000 + policy.cooldownMs + policy.failedRecoveryResetMs + 2,
				result: 'failed',
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
		tracker.recordGatewayServiceProbe({
			observedAtMs: 30 * 60 * 1000,
			result: 'ok',
			zoneId: 'sunfam',
		});
		primeControlSessionRecoveryDue(tracker, { observedAtMs: 31 * 60 * 1000 });

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: 31 * 60 * 1000 + index,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toMatchObject({ kind: 'none' });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 31 * 60 * 1000 + 10,
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
