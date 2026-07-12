import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it } from 'vitest';

import {
	scanOpenClawStabilityEvents,
	scanOpenClawStabilityLogs,
} from './openclaw-stability-classification.js';

function gatewayServiceEvent(props: {
	readonly observedAtMs: number;
	readonly result: 'failed' | 'ok' | 'stale' | 'timeout';
}): AgentVmHealthEvent {
	return {
		kind: 'gateway-service-health',
		observedAtMs: props.observedAtMs,
		path: '/health',
		port: 18789,
		result: props.result,
		zoneId: 'openclaw-stability',
	};
}

function gatewayRecoveryEvent(): AgentVmHealthEvent {
	return {
		action: 'gateway-vm-restart',
		consecutiveFailures: 3,
		cooldownMs: 60_000,
		elapsedMs: 1_000,
		kind: 'gateway-recovery',
		leaseReleaseFailureCount: 0,
		newBootedAt: '2026-06-19T00:00:01.000Z',
		newHostPid: 124,
		newVmId: 'new-vm',
		observedAtMs: 2_000,
		oldBootedAt: '2026-06-19T00:00:00.000Z',
		oldHostPid: 123,
		oldVmId: 'old-vm',
		reason: 'gateway-service-unhealthy',
		result: 'ok',
		zoneId: 'openclaw-stability',
	};
}

describe('OpenClaw stability classification', () => {
	it('treats any post-readiness gateway recovery as a stability failure', () => {
		const scan = scanOpenClawStabilityEvents({
			events: [gatewayServiceEvent({ observedAtMs: 1_000, result: 'ok' }), gatewayRecoveryEvent()],
			readyAtMs: 1_500,
		});

		expect(scan.gatewayRecoveryEvents).toBe(1);
		expect(scan.failures).toContain('gateway-recovery event observed after readiness');
	});

	it('allows one transient health failure but fails sustained post-readiness health degradation', () => {
		const scan = scanOpenClawStabilityEvents({
			events: [
				gatewayServiceEvent({ observedAtMs: 1_000, result: 'ok' }),
				gatewayServiceEvent({ observedAtMs: 2_000, result: 'timeout' }),
				gatewayServiceEvent({ observedAtMs: 3_000, result: 'failed' }),
			],
			readyAtMs: 1_500,
		});

		expect(scan.gatewayServiceFailureEvents).toBe(2);
		expect(scan.failures).toContain('gateway-service-health had 2 non-ok events after readiness');
	});

	it('matches crash signatures without failing on benign undici package mentions', () => {
		const scan = scanOpenClawStabilityLogs(`
installed undici dependency path
gateway-supervisor: openclaw gateway exited code=134
AssertionError [ERR_ASSERTION]: assert(!this.paused)
`);

		expect(scan.crashSignatureMatches).toBe(2);
		expect(scan.benignUndiciMentions).toBe(1);
		expect(scan.failures).toEqual([
			'gateway-supervisor child exit signature found in logs',
			'Node assertion crash signature found in logs',
		]);
	});
});
