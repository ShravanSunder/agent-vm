import { isAgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import { buildAgentChannelProviderHealthEvent } from './agent-channel-provider-health.js';

describe('buildAgentChannelProviderHealthEvent', () => {
	it('builds a recoverable unhealthy event for a stuck channel provider', () => {
		const event = buildAgentChannelProviderHealthEvent({
			channelProviderId: 'primary-channel',
			details: { providerType: 'discord', sleepResumeSuspected: true },
			health: 'unhealthy-recoverable',
			observedAtMs: 1_000,
			unhealthySinceMs: 900,
			zoneId: 'sunfam',
		});

		expect(event).toEqual({
			channelProviderId: 'primary-channel',
			details: { providerType: 'discord', sleepResumeSuspected: true },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 1_000,
			result: 'failed',
			unhealthySinceMs: 900,
			zoneId: 'sunfam',
		});
		expect(isAgentVmHealthEvent(event)).toBe(true);
	});

	it('builds a transitioning event for reconnecting providers', () => {
		const event = buildAgentChannelProviderHealthEvent({
			channelProviderId: 'primary-channel',
			details: { reconnectAttempt: 2 },
			health: 'transitioning',
			observedAtMs: 2_000,
			transitionStartedAtMs: 1_500,
			zoneId: 'sunfam',
		});

		expect(event).toMatchObject({
			health: 'transitioning',
			result: 'ok',
			transitionStartedAtMs: 1_500,
		});
		expect(isAgentVmHealthEvent(event)).toBe(true);
	});

	it('builds an unrecoverable unhealthy event for provider auth rejection', () => {
		const event = buildAgentChannelProviderHealthEvent({
			channelProviderId: 'primary-channel',
			details: { providerType: 'discord', statusCode: 403 },
			health: 'unhealthy-unrecoverable',
			observedAtMs: 3_000,
			unhealthySinceMs: 2_500,
			zoneId: 'sunfam',
		});

		expect(event).toMatchObject({
			health: 'unhealthy-unrecoverable',
			result: 'failed',
		});
		expect(isAgentVmHealthEvent(event)).toBe(true);
	});

	it('builds a healthy event for ready providers', () => {
		const event = buildAgentChannelProviderHealthEvent({
			channelProviderId: 'primary-channel',
			health: 'healthy',
			observedAtMs: 4_000,
			zoneId: 'sunfam',
		});

		expect(event).toMatchObject({
			health: 'healthy',
			result: 'ok',
		});
		expect(isAgentVmHealthEvent(event)).toBe(true);
	});

	it('rejects sensitive provider detail values on whitelisted fields', () => {
		expect(() =>
			buildAgentChannelProviderHealthEvent({
				channelProviderId: 'primary-channel',
				details: { providerType: 'Authorization: Bearer leaked' },
				health: 'unhealthy-recoverable',
				observedAtMs: 5_000,
				zoneId: 'sunfam',
			}),
		).toThrow('whitelisted and redacted channel-provider health details');
		expect(() =>
			buildAgentChannelProviderHealthEvent({
				channelProviderId: 'primary-channel',
				details: { providerType: 'op://agent-vm/sunfam-gateway-auth/password' },
				health: 'unhealthy-recoverable',
				observedAtMs: 5_000,
				zoneId: 'sunfam',
			}),
		).toThrow('whitelisted and redacted channel-provider health details');
	});
});
