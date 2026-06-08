import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import { deriveChannelProviderRecoveryObservation } from './channel-provider-recovery-observation.js';

describe('deriveChannelProviderRecoveryObservation', () => {
	it('maps healthy provider events to ok recovery observations', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({ health: 'healthy', result: 'ok' }),
				nowMs: 10_000,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 30_000,
			}),
		).toEqual({
			kind: 'record-observation',
			observation: {
				channelProviderId: 'primary-channel',
				observedAtMs: 1_000,
				result: 'ok',
				zoneId: 'sunfam',
			},
		});
	});

	it('keeps transitioning providers observe-only until the timeout expires', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({
					health: 'transitioning',
					result: 'ok',
					transitionStartedAtMs: 1_000,
				}),
				nowMs: 20_000,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 30_000,
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'channel-provider-transitioning',
		});
	});

	it('turns expired transitioning providers into generic channel-provider unhealthy observations', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({
					health: 'transitioning',
					result: 'ok',
					transitionStartedAtMs: 1_000,
				}),
				nowMs: 40_001,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 30_000,
			}),
		).toEqual({
			kind: 'record-observation',
			observation: {
				channelProviderId: 'primary-channel',
				observedAtMs: 40_001,
				result: 'failed',
				zoneId: 'sunfam',
			},
			reason: 'agent-channel-provider-unhealthy',
		});
	});

	it('classifies recoverable provider failures through health, not provider-specific details', () => {
		const discordClose = deriveChannelProviderRecoveryObservation({
			event: channelProviderEvent({
				details: { closeCode: 1006, providerType: 'discord' },
				health: 'unhealthy-recoverable',
				result: 'failed',
			}),
			nowMs: 10_000,
			staleAfterMs: 30_000,
			transitioningTimeoutMs: 30_000,
		});
		const discordForbidden = deriveChannelProviderRecoveryObservation({
			event: channelProviderEvent({
				details: { providerType: 'discord', statusCode: 403 },
				health: 'unhealthy-recoverable',
				result: 'failed',
			}),
			nowMs: 10_000,
			staleAfterMs: 30_000,
			transitioningTimeoutMs: 30_000,
		});

		expect(discordClose).toEqual(discordForbidden);
		expect(discordClose).toEqual({
			kind: 'record-observation',
			observation: {
				channelProviderId: 'primary-channel',
				observedAtMs: 1_000,
				result: 'failed',
				zoneId: 'sunfam',
			},
			reason: 'agent-channel-provider-unhealthy',
		});
	});

	it('keeps recoverable provider failures observe-only when restart is disabled by policy', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({
					health: 'unhealthy-recoverable',
					result: 'failed',
				}),
				nowMs: 10_000,
				restartGatewayOnRecoverable: false,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 30_000,
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'channel-provider-restart-disabled',
		});
	});

	it('keeps unrecoverable provider failures observe-only by default', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({
					health: 'unhealthy-unrecoverable',
					result: 'failed',
				}),
				nowMs: 10_000,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 30_000,
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'channel-provider-unrecoverable',
		});
	});

	it('keeps stale unrecoverable provider failures observe-only by default', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({
					health: 'unhealthy-unrecoverable',
					observedAtMs: 1_000,
					result: 'failed',
					unhealthySinceMs: 1_000,
				}),
				nowMs: 31_001,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 120_000,
			}),
		).toEqual({
			kind: 'observe-only',
			reason: 'channel-provider-unrecoverable',
		});
	});

	it('turns stale healthy provider events into generic channel-provider unhealthy observations', () => {
		expect(
			deriveChannelProviderRecoveryObservation({
				event: channelProviderEvent({ health: 'healthy', observedAtMs: 1_000, result: 'ok' }),
				nowMs: 31_001,
				staleAfterMs: 30_000,
				transitioningTimeoutMs: 120_000,
			}),
		).toEqual({
			kind: 'record-observation',
			observation: {
				channelProviderId: 'primary-channel',
				observedAtMs: 31_001,
				result: 'stale',
				zoneId: 'sunfam',
			},
			reason: 'agent-channel-provider-unhealthy',
		});
	});
});

function channelProviderEvent(
	overrides: Partial<
		Extract<AgentVmHealthEvent, { readonly kind: 'agent-channel-provider-health' }>
	>,
): Extract<AgentVmHealthEvent, { readonly kind: 'agent-channel-provider-health' }> {
	return {
		channelProviderId: 'primary-channel',
		health: 'healthy',
		kind: 'agent-channel-provider-health',
		observedAtMs: 1_000,
		result: 'ok',
		zoneId: 'sunfam',
		...overrides,
	};
}
