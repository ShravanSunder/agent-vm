import { describe, expect, it } from 'vitest';

import { createGatewayVmRecoveryTracker } from './gateway-vm-recovery-policy.js';

const policy = {
	cooldownMs: 61 * 60 * 1000,
	consecutiveFailureThreshold: 10,
	enabled: true,
	failedRecoveryResetMs: 24 * 60 * 60 * 1000,
	maxConsecutiveFailedRecoveries: 3,
	restartTimeoutMs: 10 * 60 * 1000,
} as const;

describe('createGatewayVmRecoveryTracker', () => {
	it('waits for 10 consecutive gateway-service failures before returning a restart decision', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayServiceProbe({
					observedAtMs: index * 10_000,
					result: 'failed',
					zoneId: 'sunfam',
				}),
			).toEqual({ consecutiveFailures: index, kind: 'none' });
		}

		expect(
			tracker.recordGatewayServiceProbe({
				observedAtMs: 100_000,
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-service-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('resets gateway-service failures after an ok probe', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

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
		).toEqual({ consecutiveFailures: 1, kind: 'none' });
	});

	it('tracks consecutive failures independently per zone', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

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
			reason: 'gateway-service-unhealthy',
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

	it('waits for 10 degraded gateway-control-link observations before returning a restart decision', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

		expect(
			tracker.recordGatewayControlLinkObservation({
				observedAtMs: 10_000,
				result: 'unobserved',
				zoneId: 'sunfam',
			}),
		).toEqual({ consecutiveFailures: 0, kind: 'none', reason: 'unobserved' });

		tracker.recordGatewayControlLinkObservation({
			observedAtMs: 20_000,
			result: 'ok',
			zoneId: 'sunfam',
		});

		for (let index = 1; index <= 9; index += 1) {
			expect(
				tracker.recordGatewayControlLinkObservation({
					observedAtMs: 20_000 + index * 10_000,
					result: 'stale',
					zoneId: 'sunfam',
				}),
			).toEqual({ consecutiveFailures: index, kind: 'none' });
		}

		expect(
			tracker.recordGatewayControlLinkObservation({
				observedAtMs: 120_000,
				result: 'stale',
				zoneId: 'sunfam',
			}),
		).toEqual({
			consecutiveFailures: 10,
			kind: 'restart',
			reason: 'gateway-control-link-unhealthy',
			zoneId: 'sunfam',
		});
	});

	it('blocks automatic restart decisions during cooldown', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

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

	it('allows another automatic restart after one failed recovery and the 61 minute cooldown expires', () => {
		const tracker = createGatewayVmRecoveryTracker({ policy });

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
});
