import { healthEventBucketKey, type AgentVmHealthEvent } from '@agent-vm/gateway-contracts';

import type { GatewayToolVmPlane } from '../zone-runtimes/gateway-zone-state-machine.js';
import type { GatewayToolVmLeaseState } from '../zone-runtimes/gateway-zone-state-machine.js';

export interface ToolVmStatusLeaseView {
	readonly effectiveIdleTtlMs: number;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly zoneId: string;
}

export interface ToolVmStatusActiveUseView {
	readonly expiresAt: number;
	readonly leaseId: string;
	readonly useId: string;
}

export interface ClassifyLifecycleAwareToolVmPlaneOptions {
	readonly activeUses: readonly ToolVmStatusActiveUseView[];
	readonly events: readonly AgentVmHealthEvent[];
	readonly leases: readonly ToolVmStatusLeaseView[];
	readonly nowMs: number;
	readonly staleAfterMs: number;
}

export interface LifecycleAwareToolVmStatus {
	readonly leaseState: GatewayToolVmLeaseState;
	readonly plane: GatewayToolVmPlane;
}

type ToolVmPlaneHealthEvent = Extract<
	AgentVmHealthEvent,
	{ readonly kind: 'lease-heartbeat' | 'lease-renew' | 'tool-vm-ssh' }
>;

function assertNeverToolVmHealthResult(result: never): never {
	throw new Error(`Unhandled Tool VM health result: ${String(result)}`);
}

function assertNeverToolVmPlane(plane: never): never {
	throw new Error(`Unhandled Tool VM plane: ${String(plane)}`);
}

function isToolVmPlaneHealthEvent(event: AgentVmHealthEvent): event is ToolVmPlaneHealthEvent {
	return (
		event.kind === 'lease-heartbeat' || event.kind === 'lease-renew' || event.kind === 'tool-vm-ssh'
	);
}

function toolVmPlaneForResult(result: ToolVmPlaneHealthEvent['result']): GatewayToolVmPlane {
	switch (result) {
		case 'ok':
			return 'ok';
		case 'failed':
			return 'failed';
		case 'stale':
		case 'timeout':
			return 'degraded';
	}
	return assertNeverToolVmHealthResult(result);
}

function toolVmPlaneRank(plane: GatewayToolVmPlane): number {
	switch (plane) {
		case 'failed':
			return 3;
		case 'degraded':
			return 2;
		case 'ok':
			return 1;
		case 'unknown':
			return 0;
	}
	return assertNeverToolVmPlane(plane);
}

function highestRankedToolVmPlane(planes: readonly GatewayToolVmPlane[]): GatewayToolVmPlane {
	return (
		planes.toSorted(
			(leftPlane, rightPlane) => toolVmPlaneRank(rightPlane) - toolVmPlaneRank(leftPlane),
		)[0] ?? 'ok'
	);
}

function latestEventsByBucket(
	events: readonly ToolVmPlaneHealthEvent[],
): readonly ToolVmPlaneHealthEvent[] {
	const latestByBucket = new Map<string, ToolVmPlaneHealthEvent>();
	for (const event of events) {
		const key = healthEventBucketKey(event);
		const previous = latestByBucket.get(key);
		if (!previous || previous.observedAtMs <= event.observedAtMs) {
			latestByBucket.set(key, event);
		}
	}
	return [...latestByBucket.values()];
}

function isIdleExpired(
	lease: ToolVmStatusLeaseView,
	activeUseCount: number,
	nowMs: number,
): boolean {
	return activeUseCount === 0 && lease.lastUsedAt + lease.effectiveIdleTtlMs < nowMs;
}

function isStaleSuccessfulEvent(
	event: ToolVmPlaneHealthEvent,
	options: Pick<ClassifyLifecycleAwareToolVmPlaneOptions, 'nowMs' | 'staleAfterMs'>,
): boolean {
	return event.result === 'ok' && options.nowMs - event.observedAtMs > options.staleAfterMs;
}

export function classifyLifecycleAwareToolVmPlane(
	options: ClassifyLifecycleAwareToolVmPlaneOptions,
): GatewayToolVmPlane {
	return classifyLifecycleAwareToolVmStatus(options).plane;
}

export function classifyLifecycleAwareToolVmStatus(
	options: ClassifyLifecycleAwareToolVmPlaneOptions,
): LifecycleAwareToolVmStatus {
	const activeUseKeySet = new Set(
		options.activeUses.map((activeUse) => `${activeUse.leaseId}:${activeUse.useId}`),
	);
	const activeUseCountByLeaseId = new Map<string, number>();
	for (const activeUse of options.activeUses) {
		activeUseCountByLeaseId.set(
			activeUse.leaseId,
			(activeUseCountByLeaseId.get(activeUse.leaseId) ?? 0) + 1,
		);
	}
	const currentLeaseIdSet = new Set(
		options.leases
			.filter(
				(lease) => !isIdleExpired(lease, activeUseCountByLeaseId.get(lease.id) ?? 0, options.nowMs),
			)
			.map((lease) => lease.id),
	);
	const planes: GatewayToolVmPlane[] = [];
	let expiredActiveUseCount = 0;
	let currentActiveUseCount = 0;
	for (const activeUse of options.activeUses) {
		if (!currentLeaseIdSet.has(activeUse.leaseId)) {
			continue;
		}
		if (activeUse.expiresAt < options.nowMs) {
			expiredActiveUseCount += 1;
			planes.push('degraded');
			continue;
		}
		currentActiveUseCount += 1;
	}
	for (const event of latestEventsByBucket(options.events.filter(isToolVmPlaneHealthEvent))) {
		if (!currentLeaseIdSet.has(event.leaseId)) {
			continue;
		}
		if (event.kind === 'lease-heartbeat') {
			if (!activeUseKeySet.has(`${event.leaseId}:${event.useId}`)) {
				continue;
			}
			if (isStaleSuccessfulEvent(event, options)) {
				continue;
			}
			planes.push(toolVmPlaneForResult(event.result));
			continue;
		}
		if (event.kind === 'lease-renew') {
			if (isStaleSuccessfulEvent(event, options)) {
				continue;
			}
			planes.push(toolVmPlaneForResult(event.result));
			continue;
		}
		if (event.lifecycleEventRole === 'controller_final') {
			if (isStaleSuccessfulEvent(event, options)) {
				continue;
			}
			planes.push(toolVmPlaneForResult(event.result));
			continue;
		}
		if (event.operation !== 'probe') {
			continue;
		}
		if (isStaleSuccessfulEvent(event, options)) {
			continue;
		}
		planes.push(toolVmPlaneForResult(event.result));
	}
	const idleExpiredLeaseCount = options.leases.length - currentLeaseIdSet.size;
	const leaseState: GatewayToolVmLeaseState =
		expiredActiveUseCount > 0 || idleExpiredLeaseCount > 0
			? 'expired'
			: currentActiveUseCount > 0
				? 'active'
				: currentLeaseIdSet.size > 0
					? 'idle'
					: 'none';
	return {
		leaseState,
		plane: highestRankedToolVmPlane(planes),
	};
}
