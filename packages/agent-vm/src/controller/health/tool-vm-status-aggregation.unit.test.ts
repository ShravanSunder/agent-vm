import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it } from 'vitest';

import type { GatewayToolVmPlane } from '../zone-runtimes/gateway-zone-state-machine.js';
import {
	classifyLifecycleAwareToolVmPlane,
	classifyLifecycleAwareToolVmStatus,
	type ToolVmStatusActiveUseView,
	type ToolVmStatusLeaseView,
} from './tool-vm-status-aggregation.js';

const defaultNowMs = 100_000;
const defaultStaleAfterMs = 30_000;

function leaseView(
	leaseId: string,
	options: {
		readonly effectiveIdleTtlMs?: number;
		readonly lastUsedAt?: number;
		readonly zoneId?: string;
	} = {},
): ToolVmStatusLeaseView {
	return {
		effectiveIdleTtlMs: options.effectiveIdleTtlMs ?? 600_000,
		id: leaseId,
		lastUsedAt: options.lastUsedAt ?? 90_000,
		zoneId: options.zoneId ?? 'sunfam',
	};
}

function activeUseView(
	leaseId: string,
	useId: string,
	options: {
		readonly expiresAt?: number;
	} = {},
): ToolVmStatusActiveUseView {
	return {
		expiresAt: options.expiresAt ?? 160_000,
		leaseId,
		useId,
	};
}

function leaseRenewEvent(
	leaseId: string,
	options: {
		readonly observedAtMs?: number;
		readonly result?: 'failed' | 'ok' | 'stale' | 'timeout';
	} = {},
): AgentVmHealthEvent {
	return {
		agentId: 'shravan',
		elapsedMs: 10,
		kind: 'lease-renew',
		leaseId,
		observedAtMs: options.observedAtMs ?? 95_000,
		result: options.result ?? 'ok',
		zoneId: 'sunfam',
	};
}

function leaseHeartbeatEvent(
	leaseId: string,
	useId: string,
	options: {
		readonly observedAtMs?: number;
		readonly result?: 'failed' | 'ok' | 'stale' | 'timeout';
	} = {},
): AgentVmHealthEvent {
	return {
		agentId: 'shravan',
		elapsedMs: 10,
		kind: 'lease-heartbeat',
		leaseId,
		observedAtMs: options.observedAtMs ?? 95_000,
		result: options.result ?? 'ok',
		useId,
		zoneId: 'sunfam',
	};
}

function toolVmSshEvent(
	leaseId: string,
	operation: 'command' | 'file-bridge' | 'finalize' | 'probe',
	options: {
		readonly observedAtMs?: number;
		readonly result?: 'failed' | 'ok' | 'stale' | 'timeout';
	} = {},
): AgentVmHealthEvent {
	return {
		agentId: 'shravan',
		elapsedMs: 10,
		kind: 'tool-vm-ssh',
		leaseId,
		observedAtMs: options.observedAtMs ?? 95_000,
		operation,
		result: options.result ?? 'ok',
		zoneId: 'sunfam',
	};
}

function classify(options: {
	readonly activeUses?: readonly ToolVmStatusActiveUseView[];
	readonly events?: readonly AgentVmHealthEvent[];
	readonly leases?: readonly ToolVmStatusLeaseView[];
	readonly nowMs?: number;
}): GatewayToolVmPlane {
	return classifyLifecycleAwareToolVmPlane({
		activeUses: options.activeUses ?? [],
		events: options.events ?? [],
		leases: options.leases ?? [],
		nowMs: options.nowMs ?? defaultNowMs,
		staleAfterMs: defaultStaleAfterMs,
	});
}

describe('classifyLifecycleAwareToolVmPlane', () => {
	it('reports no current lease as an explicit none state with a neutral plane', () => {
		expect(
			classifyLifecycleAwareToolVmStatus({
				activeUses: [],
				events: [],
				leases: [],
				nowMs: defaultNowMs,
				staleAfterMs: defaultStaleAfterMs,
			}),
		).toEqual({
			leaseState: 'none',
			plane: 'ok',
		});
	});

	it('reports a current idle lease separately from an active use', () => {
		expect(
			classifyLifecycleAwareToolVmStatus({
				activeUses: [],
				events: [],
				leases: [leaseView('lease-1')],
				nowMs: defaultNowMs,
				staleAfterMs: defaultStaleAfterMs,
			}),
		).toEqual({
			leaseState: 'idle',
			plane: 'ok',
		});

		expect(
			classifyLifecycleAwareToolVmStatus({
				activeUses: [activeUseView('lease-1', 'use-1')],
				events: [],
				leases: [leaseView('lease-1')],
				nowMs: defaultNowMs,
				staleAfterMs: defaultStaleAfterMs,
			}),
		).toEqual({
			leaseState: 'active',
			plane: 'ok',
		});
	});

	it('reports expired only when a known lease or active use crossed its expiry boundary', () => {
		expect(
			classifyLifecycleAwareToolVmStatus({
				activeUses: [],
				events: [],
				leases: [
					leaseView('lease-1', {
						effectiveIdleTtlMs: 30_000,
						lastUsedAt: 10_000,
					}),
				],
				nowMs: defaultNowMs,
				staleAfterMs: defaultStaleAfterMs,
			}),
		).toEqual({
			leaseState: 'expired',
			plane: 'ok',
		});

		expect(
			classifyLifecycleAwareToolVmStatus({
				activeUses: [activeUseView('lease-1', 'use-1', { expiresAt: 99_999 })],
				events: [],
				leases: [leaseView('lease-1')],
				nowMs: defaultNowMs,
				staleAfterMs: defaultStaleAfterMs,
			}),
		).toEqual({
			leaseState: 'expired',
			plane: 'degraded',
		});
	});

	it('ignores retained events for leases that are no longer current', () => {
		expect(
			classify({
				events: [
					leaseRenewEvent('released-lease', {
						observedAtMs: 1_000,
						result: 'failed',
					}),
					toolVmSshEvent('released-lease', 'probe', {
						observedAtMs: 1_000,
						result: 'failed',
					}),
				],
				leases: [leaseView('current-lease')],
			}),
		).toBe('ok');
	});

	it('ignores idle-expired leases that are still present before the reaper runs', () => {
		expect(
			classify({
				events: [toolVmSshEvent('expired-lease', 'probe', { result: 'failed' })],
				leases: [
					leaseView('expired-lease', {
						effectiveIdleTtlMs: 30_000,
						lastUsedAt: 10_000,
					}),
				],
			}),
		).toBe('ok');
	});

	it('treats stale successful idle renew and probe evidence as neutral', () => {
		expect(
			classify({
				events: [
					leaseRenewEvent('lease-1', { observedAtMs: 1_000, result: 'ok' }),
					toolVmSshEvent('lease-1', 'probe', { observedAtMs: 1_000, result: 'ok' }),
				],
				leases: [leaseView('lease-1')],
			}),
		).toBe('ok');
	});

	it('keeps use-local SSH failures diagnostic-only for v1 readiness', () => {
		expect(
			classify({
				events: [
					toolVmSshEvent('lease-1', 'command', { result: 'failed' }),
					toolVmSshEvent('lease-1', 'file-bridge', { result: 'failed' }),
					toolVmSshEvent('lease-1', 'finalize', { result: 'failed' }),
				],
				leases: [leaseView('lease-1')],
			}),
		).toBe('ok');
	});

	it('degrades for failed lease-scoped renew and probe evidence on a current lease', () => {
		expect(
			classify({
				events: [leaseRenewEvent('lease-1', { result: 'failed' })],
				leases: [leaseView('lease-1')],
			}),
		).toBe('failed');

		expect(
			classify({
				events: [toolVmSshEvent('lease-1', 'probe', { result: 'failed' })],
				leases: [leaseView('lease-1')],
			}),
		).toBe('failed');
	});

	it('uses same-kind success or release to clear renew and probe failures', () => {
		expect(
			classify({
				events: [
					leaseRenewEvent('lease-1', { observedAtMs: 95_000, result: 'failed' }),
					leaseRenewEvent('lease-1', { observedAtMs: 96_000, result: 'ok' }),
					toolVmSshEvent('lease-1', 'probe', { observedAtMs: 97_000, result: 'failed' }),
					toolVmSshEvent('lease-1', 'probe', { observedAtMs: 98_000, result: 'ok' }),
				],
				leases: [leaseView('lease-1')],
			}),
		).toBe('ok');

		expect(
			classify({
				events: [
					leaseRenewEvent('released-lease', { result: 'failed' }),
					toolVmSshEvent('released-lease', 'probe', { result: 'failed' }),
				],
				leases: [],
			}),
		).toBe('ok');
	});

	it('degrades for expired active uses even when no health events exist', () => {
		expect(
			classify({
				activeUses: [activeUseView('lease-1', 'use-1', { expiresAt: 99_999 })],
				events: [],
				leases: [leaseView('lease-1')],
			}),
		).toBe('degraded');
	});

	it('does not degrade active uses solely from global health event staleness', () => {
		expect(
			classify({
				activeUses: [activeUseView('lease-1', 'use-1', { expiresAt: 160_000 })],
				events: [leaseHeartbeatEvent('lease-1', 'use-1', { observedAtMs: 1_000, result: 'ok' })],
				leases: [leaseView('lease-1')],
			}),
		).toBe('ok');
	});

	it('degrades for failed heartbeat on the exact current active use', () => {
		expect(
			classify({
				activeUses: [activeUseView('lease-1', 'use-1')],
				events: [leaseHeartbeatEvent('lease-1', 'use-1', { result: 'failed' })],
				leases: [leaseView('lease-1')],
			}),
		).toBe('failed');

		expect(
			classify({
				activeUses: [activeUseView('lease-1', 'current-use')],
				events: [leaseHeartbeatEvent('lease-1', 'old-use', { result: 'failed' })],
				leases: [leaseView('lease-1')],
			}),
		).toBe('ok');
	});
});
