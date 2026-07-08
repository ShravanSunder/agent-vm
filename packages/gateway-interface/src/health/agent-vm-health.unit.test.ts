import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	deriveZoneHealthSnapshot,
	healthEventBucketKey,
	isAgentVmHealthEvent,
	type AgentChannelProviderHealthDetailKey,
	type AgentChannelProviderHealthDetails,
	type AgentVmHealthEvent,
} from './agent-vm-health.js';

describe('agent-vm health events', () => {
	it('accepts zone-scoped gateway control-session events with control-session identity', () => {
		const event = {
			domain: 'gateway_control',
			elapsedMs: 12,
			kind: 'gateway-control-session',
			observedAtMs: 1_000,
			operation: 'control-session-heartbeat',
			peerId: 'gateway-beta',
			result: 'ok',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(
			isAgentVmHealthEvent({
				...event,
				peerId: '',
			}),
		).toBe(false);
	});

	it('keeps gateway plugin health generic over gateway type', () => {
		const workerEvent = {
			gatewayService: 'worker',
			kind: 'gateway-plugin-health',
			observedAtMs: 2_000,
			result: 'ok',
			state: 'ready',
			zoneId: 'worker-zone',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(workerEvent)).toBe(true);
	});

	it('treats gateway service health as one zone-level bucket', () => {
		const failedUnknownServiceHealth = {
			kind: 'gateway-service-health',
			observedAtMs: 1_000,
			path: '(unknown)',
			port: 0,
			result: 'failed',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const okServiceHealth = {
			kind: 'gateway-service-health',
			observedAtMs: 34_000,
			path: '/readyz',
			port: 18789,
			result: 'ok',
			statusCode: 200,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		expect(healthEventBucketKey(failedUnknownServiceHealth)).toBe('beta:gateway-service-health');
		expect(healthEventBucketKey(okServiceHealth)).toBe('beta:gateway-service-health');
		expect(
			deriveZoneHealthSnapshot([failedUnknownServiceHealth, okServiceHealth], {
				nowMs: 35_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}),
		).toEqual({
			kind: 'ok',
			latestEvents: [okServiceHealth],
			zoneId: 'beta',
		});
	});

	it('accepts generic agent channel-provider health events with provider details only in payload', () => {
		const event = {
			channelProviderId: 'primary-channel',
			details: { closeCode: 1006, providerType: 'discord', reconnecting: true },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 2_000,
			result: 'failed',
			unhealthySinceMs: 1_500,
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe(
			'sunfam:agent-channel-provider-health:primary-channel',
		);
	});

	it('validates Tool VM lease lifecycle fields when they are present', () => {
		const event = {
			activeUseId: '66666666-6666-4666-8666-666666666666',
			agentId: 'main',
			callerContextState: 'stale',
			elapsedMs: 25,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			leaseRejectionReason: 'caller_context_stale',
			lifecycleEventRole: 'controller_final',
			lifecycleTransition: 'stale_to_reacquired',
			observedAtMs: 1_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			operation: 'file-bridge',
			replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
			result: 'ok',
			transitionId: '77777777-7777-4777-8777-777777777777',
			zoneId: 'beta',
		};

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(isAgentVmHealthEvent({ ...event, lifecycleEventRole: 'operator_guess' })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, lifecycleTransition: 'same_id_stale_current' })).toBe(
			false,
		);
		expect(isAgentVmHealthEvent({ ...event, callerContextState: 'maybe' })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, leaseRejectionReason: 'raw-controller-error' })).toBe(
			false,
		);
		expect(isAgentVmHealthEvent({ ...event, activeUseId: '' })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, transitionId: '' })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, transitionId: undefined })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, lifecycleTransition: undefined })).toBe(false);
		expect(isAgentVmHealthEvent({ ...event, replacementLeaseId: undefined })).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				lifecycleEventRole: undefined,
			}),
		).toBe(false);
	});

	it('dedupes Tool VM lifecycle observations by transition id with controller final authority', () => {
		const pluginObservation = {
			agentId: 'main',
			callerContextState: 'stale',
			elapsedMs: 25,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			leaseRejectionReason: 'caller_context_stale',
			lifecycleEventRole: 'plugin_observation',
			lifecycleTransition: 'current_to_stale',
			observedAtMs: 1_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			operation: 'file-bridge',
			result: 'failed',
			transitionId: '77777777-7777-4777-8777-777777777777',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const controllerFinal = {
			agentId: 'main',
			callerContextState: 'ok',
			elapsedMs: 10,
			kind: 'tool-vm-ssh',
			leaseId: '01890f00-0000-7000-8000-000000000002',
			lifecycleEventRole: 'controller_final',
			lifecycleTransition: 'stale_to_reacquired',
			observedAtMs: 2_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			operation: 'file-bridge',
			replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
			result: 'ok',
			transitionId: '77777777-7777-4777-8777-777777777777',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		expect(healthEventBucketKey(pluginObservation)).toBe(
			'beta:tool-vm-ssh:lifecycle:77777777-7777-4777-8777-777777777777',
		);
		expect(healthEventBucketKey(controllerFinal)).toBe(
			'beta:tool-vm-ssh:lifecycle:77777777-7777-4777-8777-777777777777',
		);
		expect(
			deriveZoneHealthSnapshot([pluginObservation, controllerFinal], {
				nowMs: 2_500,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}),
		).toEqual({
			kind: 'ok',
			latestEvents: [controllerFinal],
			zoneId: 'beta',
		});
	});

	it('rejects channel-provider health details outside the operational whitelist', () => {
		const event = {
			channelProviderId: 'primary-channel',
			details: { message: 'websocket closed' },
			health: 'unhealthy-recoverable',
			kind: 'agent-channel-provider-health',
			observedAtMs: 2_000,
			result: 'failed',
			unhealthySinceMs: 1_500,
			zoneId: 'sunfam',
		};

		expect(isAgentVmHealthEvent(event)).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				details: { error: 'Authorization: Bearer leaked-token' },
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				details: { ref: 'op://agent-vm/sunfam-gateway-auth/password' },
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				details: { providerType: true },
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				details: { statusCode: '403' },
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...event,
				details: { statusCode: null },
			}),
		).toBe(false);
		expectTypeOf<AgentChannelProviderHealthDetails>().toEqualTypeOf<
			Readonly<Partial<Record<AgentChannelProviderHealthDetailKey, boolean | number | string>>>
		>();
	});

	it('rejects channel-provider health events whose base result contradicts health', () => {
		const transitioningEvent = {
			channelProviderId: 'primary-channel',
			health: 'transitioning',
			kind: 'agent-channel-provider-health',
			observedAtMs: 2_000,
			result: 'failed',
			transitionStartedAtMs: 1_500,
			zoneId: 'sunfam',
		};

		expect(isAgentVmHealthEvent(transitioningEvent)).toBe(false);
		expect(
			isAgentVmHealthEvent({
				...transitioningEvent,
				health: 'healthy',
			}),
		).toBe(false);
	});

	it('accepts gateway recovery health events', () => {
		const event = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-control-session-unhealthy',
			result: 'ok',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe('sunfam:gateway-recovery:gateway-vm-restart');
	});

	it('accepts operation ids on gateway recovery health events as evidence join keys', () => {
		const event = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			operationId: 'sunfam-restart-018f',
			reason: 'gateway-control-session-unhealthy',
			result: 'ok',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
	});

	it('accepts cold-start gateway recovery events without old gateway identity', () => {
		const event = {
			action: 'gateway-vm-cold-start',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			reason: 'gateway-control-session-unhealthy',
			result: 'ok',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe('sunfam:gateway-recovery:gateway-vm-cold-start');
	});

	it('rejects malformed gateway recovery health events', () => {
		const okEvent = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-control-session-unhealthy',
			result: 'ok',
			zoneId: 'sunfam',
		};

		expect(isAgentVmHealthEvent({ ...okEvent, result: 'stale' })).toBe(false);
		expect(isAgentVmHealthEvent({ ...okEvent, newVmId: undefined })).toBe(false);
		expect(
			isAgentVmHealthEvent({
				action: 'gateway-vm-restart',
				cooldownMs: 3_660_000,
				consecutiveFailures: 10,
				elapsedMs: 45_000,
				kind: 'gateway-recovery',
				observedAtMs: 1_000,
				reason: 'gateway-service-unhealthy',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				action: 'gateway-vm-restart',
				cooldownMs: 3_660_000,
				consecutiveFailures: 10,
				elapsedMs: 45_000,
				errorCode: 'restart-threw',
				kind: 'gateway-recovery',
				observedAtMs: 1_000,
				reason: 'gateway-service-unhealthy',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toBe(false);
		expect(
			isAgentVmHealthEvent({
				action: 'gateway-vm-restart',
				cooldownMs: 3_660_000,
				consecutiveFailures: 10,
				elapsedMs: 45_000,
				errorCode: 'recovery-timeout',
				kind: 'gateway-recovery',
				observedAtMs: 1_000,
				reason: 'gateway-service-unhealthy',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toBe(true);
		expect(
			isAgentVmHealthEvent({
				action: 'gateway-vm-cold-start',
				cooldownMs: 3_660_000,
				consecutiveFailures: 10,
				elapsedMs: 45_000,
				errorCode: 'cold-start-threw',
				kind: 'gateway-recovery',
				observedAtMs: 1_000,
				oldVmId: 'old-gateway-vm',
				reason: 'gateway-service-unhealthy',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		).toBe(false);
	});

	it('surfaces failed gateway recovery as a zone health issue', () => {
		const event = {
			action: 'gateway-vm-restart',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			errorCode: 'restart-verification-failed',
			kind: 'gateway-recovery',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		const snapshot = deriveZoneHealthSnapshot([event], {
			nowMs: 2_000,
			staleAfterMs: 30_000,
			zoneId: 'sunfam',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('Expected failed snapshot.');
		}
		expect(snapshot.issues[0]?.kind).toBe('gateway-recovery-failed');
	});

	it('accepts operator-required failed gateway recovery events without pretending restart failed', () => {
		const event = {
			action: 'operator-required',
			cooldownMs: 3_660_000,
			consecutiveFailures: 10,
			elapsedMs: 45_000,
			errorCode: 'owner-unsafe',
			kind: 'gateway-recovery',
			observedAtMs: 1_000,
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe('sunfam:gateway-recovery:operator-required');
	});

	it('accepts suspended gateway recovery events and surfaces them as distinct issues', () => {
		const event = {
			action: 'gateway-vm-restart',
			consecutiveFailedRecoveries: 3,
			consecutiveFailures: 12,
			cooldownMs: 3_660_000,
			errorCode: 'max-failed-recoveries',
			failedRecoveryResetMs: 86_400_000,
			kind: 'gateway-recovery-suspended',
			observedAtMs: 1_000,
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe(
			'sunfam:gateway-recovery-suspended:gateway-vm-restart',
		);

		const snapshot = deriveZoneHealthSnapshot([event], {
			nowMs: 2_000,
			staleAfterMs: 30_000,
			zoneId: 'sunfam',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('Expected failed snapshot.');
		}
		expect(snapshot.issues[0]?.kind).toBe('gateway-recovery-suspended');
	});

	it('preserves cold-start action on suspended gateway recovery events', () => {
		const event = {
			action: 'gateway-vm-cold-start',
			consecutiveFailedRecoveries: 3,
			consecutiveFailures: 12,
			cooldownMs: 3_660_000,
			errorCode: 'max-failed-recoveries',
			failedRecoveryResetMs: 86_400_000,
			kind: 'gateway-recovery-suspended',
			observedAtMs: 1_000,
			reason: 'gateway-service-unhealthy',
			result: 'failed',
			zoneId: 'sunfam',
		} satisfies AgentVmHealthEvent;

		expect(isAgentVmHealthEvent(event)).toBe(true);
		expect(healthEventBucketKey(event)).toBe(
			'sunfam:gateway-recovery-suspended:gateway-vm-cold-start',
		);
	});

	it('rejects ISO observedAt strings because stale math uses observedAtMs', () => {
		expect(
			isAgentVmHealthEvent({
				kind: 'gateway-service-health',
				observedAt: '2026-05-26T00:00:00.000Z',
				path: '/readyz',
				port: 18789,
				result: 'ok',
				zoneId: 'beta',
			}),
		).toBe(false);
	});

	it('derives unknown, ok, failed, and stale zone snapshots', () => {
		expect(
			deriveZoneHealthSnapshot([], {
				nowMs: 10_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}),
		).toEqual({ kind: 'unknown', reason: 'no-events', zoneId: 'beta' });

		const okEvent = {
			kind: 'gateway-service-health',
			observedAtMs: 9_000,
			path: '/health',
			port: 18789,
			result: 'ok',
			statusCode: 200,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		expect(
			deriveZoneHealthSnapshot([okEvent], {
				nowMs: 10_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}).kind,
		).toBe('ok');

		const failedEvent = {
			...okEvent,
			result: 'failed',
			statusCode: 503,
		} satisfies AgentVmHealthEvent;
		const failedSnapshot = deriveZoneHealthSnapshot([failedEvent], {
			nowMs: 10_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});
		expect(failedSnapshot.kind).toBe('failed');
		if (failedSnapshot.kind !== 'failed') {
			throw new Error('expected failed snapshot');
		}
		expect(failedSnapshot.issues[0]?.kind).toBe('gateway-service-unhealthy');

		const staleSnapshot = deriveZoneHealthSnapshot([okEvent], {
			nowMs: 50_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});
		expect(staleSnapshot.kind).toBe('stale');
		if (staleSnapshot.kind !== 'stale') {
			throw new Error('expected stale snapshot');
		}
		expect(staleSnapshot.issues[0]?.kind).toBe('health-event-stale');
	});

	it('does not let old successful recovery evidence stale an otherwise healthy zone', () => {
		const oldSuccessfulRecovery = {
			action: 'gateway-vm-restart',
			consecutiveFailures: 10,
			cooldownMs: 3_660_000,
			elapsedMs: 45_000,
			kind: 'gateway-recovery',
			leaseReleaseFailureCount: 0,
			newBootedAt: '2026-05-27T13:01:00.000Z',
			newHostPid: 2222,
			newVmId: 'new-gateway-vm',
			observedAtMs: 1_000,
			oldBootedAt: '2026-05-27T12:00:00.000Z',
			oldHostPid: 1111,
			oldVmId: 'old-gateway-vm',
			reason: 'gateway-service-unhealthy',
			result: 'ok',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const freshServiceHealth = {
			kind: 'gateway-service-health',
			observedAtMs: 50_000,
			path: '/health',
			port: 18789,
			result: 'ok',
			statusCode: 200,
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		expect(
			deriveZoneHealthSnapshot([oldSuccessfulRecovery, freshServiceHealth], {
				nowMs: 51_000,
				staleAfterMs: 30_000,
				zoneId: 'beta',
			}).kind,
		).toBe('ok');
	});

	it('does not double-record rich lease operations as generic controller requests', () => {
		expect(
			isAgentVmHealthEvent({
				attempt: 1,
				elapsedMs: 5,
				kind: 'controller-request',
				maxAttempts: 1,
				observedAtMs: 1_000,
				operation: 'lease-heartbeat',
				result: 'ok',
				zoneId: 'beta',
			}),
		).toBe(false);
	});

	it('keeps different lease heartbeat buckets visible in the zone snapshot', () => {
		const failedLeaseHeartbeat = {
			agentId: 'agent-a',
			elapsedMs: 5_000,
			errorCode: 'controller-request-timeout',
			kind: 'lease-heartbeat',
			leaseId: 'lease-a',
			observedAtMs: 1_000,
			result: 'timeout',
			useId: 'use-a',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;
		const okLeaseHeartbeat = {
			agentId: 'agent-b',
			elapsedMs: 12,
			kind: 'lease-heartbeat',
			leaseId: 'lease-b',
			observedAtMs: 2_000,
			result: 'ok',
			useId: 'use-b',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		const snapshot = deriveZoneHealthSnapshot([failedLeaseHeartbeat, okLeaseHeartbeat], {
			nowMs: 3_000,
			staleAfterMs: 30_000,
			zoneId: 'beta',
		});

		expect(snapshot.kind).toBe('failed');
		if (snapshot.kind !== 'failed') {
			throw new Error('expected failed snapshot');
		}
		expect(snapshot.latestEvents).toHaveLength(2);
		expect(snapshot.issues).toHaveLength(1);
		expect(snapshot.issues[0]?.latestEvent).toEqual(failedLeaseHeartbeat);
	});
});
