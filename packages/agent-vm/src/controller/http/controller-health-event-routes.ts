import type {
	AgentVmHealthEvent,
	ZoneHealthIssue,
	ZoneHealthSnapshot,
} from '@agent-vm/gateway-lifecycle';
import { type Hono } from 'hono';

import { stableTelemetryHash } from '../../observability/health-event-telemetry.js';
import type { HealthEventStore } from '../health/health-event-store.js';

export interface RegisterControllerHealthEventRoutesOptions {
	readonly now: () => number;
	readonly store: HealthEventStore;
	readonly zoneIds?: ReadonlySet<string> | undefined;
}

type LeaseRenewHealthEvent = Extract<AgentVmHealthEvent, { readonly kind: 'lease-renew' }>;
type LeaseHeartbeatHealthEvent = Extract<AgentVmHealthEvent, { readonly kind: 'lease-heartbeat' }>;
type ToolVmSshHealthEvent = Extract<AgentVmHealthEvent, { readonly kind: 'tool-vm-ssh' }>;

type PublicLeaseRenewHealthEvent = Omit<LeaseRenewHealthEvent, 'leaseId'> & {
	readonly leaseIdHash: string;
};

type PublicLeaseHeartbeatHealthEvent = Omit<LeaseHeartbeatHealthEvent, 'leaseId' | 'useId'> & {
	readonly leaseIdHash: string;
	readonly useIdHash: string;
};

type PublicToolVmSshHealthEvent = Omit<
	ToolVmSshHealthEvent,
	'activeUseId' | 'leaseId' | 'oldLeaseId' | 'replacementLeaseId' | 'transitionId'
> & {
	readonly activeUseIdHash?: string | undefined;
	readonly leaseIdHash: string;
	readonly oldLeaseIdHash?: string | undefined;
	readonly replacementLeaseIdHash?: string | undefined;
	readonly transitionIdHash?: string | undefined;
};

type PublicAgentVmHealthEvent =
	| Exclude<
			AgentVmHealthEvent,
			LeaseRenewHealthEvent | LeaseHeartbeatHealthEvent | ToolVmSshHealthEvent
	  >
	| PublicLeaseRenewHealthEvent
	| PublicLeaseHeartbeatHealthEvent
	| PublicToolVmSshHealthEvent;

type PublicZoneHealthIssue = Omit<ZoneHealthIssue, 'latestEvent'> & {
	readonly latestEvent: PublicAgentVmHealthEvent;
};

type PublicZoneHealthSnapshot =
	| Extract<ZoneHealthSnapshot, { readonly kind: 'unknown' }>
	| (Omit<Extract<ZoneHealthSnapshot, { readonly kind: 'ok' }>, 'latestEvents'> & {
			readonly latestEvents: readonly PublicAgentVmHealthEvent[];
	  })
	| (Omit<
			Extract<ZoneHealthSnapshot, { readonly kind: 'failed' | 'stale' }>,
			'issues' | 'latestEvents'
	  > & {
			readonly issues: readonly PublicZoneHealthIssue[];
			readonly latestEvents: readonly PublicAgentVmHealthEvent[];
	  });

function redactHealthEventForPublicSnapshot(event: AgentVmHealthEvent): PublicAgentVmHealthEvent {
	switch (event.kind) {
		case 'lease-renew': {
			const { leaseId, ...rest } = event;
			return {
				...rest,
				leaseIdHash: stableTelemetryHash(leaseId),
			};
		}
		case 'lease-heartbeat': {
			const { leaseId, useId, ...rest } = event;
			return {
				...rest,
				leaseIdHash: stableTelemetryHash(leaseId),
				useIdHash: stableTelemetryHash(useId),
			};
		}
		case 'tool-vm-ssh': {
			const { activeUseId, leaseId, oldLeaseId, replacementLeaseId, transitionId, ...rest } = event;
			return {
				...rest,
				...(activeUseId === undefined ? {} : { activeUseIdHash: stableTelemetryHash(activeUseId) }),
				leaseIdHash: stableTelemetryHash(leaseId),
				...(oldLeaseId === undefined ? {} : { oldLeaseIdHash: stableTelemetryHash(oldLeaseId) }),
				...(replacementLeaseId === undefined
					? {}
					: { replacementLeaseIdHash: stableTelemetryHash(replacementLeaseId) }),
				...(transitionId === undefined
					? {}
					: { transitionIdHash: stableTelemetryHash(transitionId) }),
			};
		}
		case 'agent-channel-provider-health':
		case 'caller-context-rejection':
		case 'controller-request':
		case 'gateway-control-session':
		case 'gateway-plugin-health':
		case 'gateway-recovery':
		case 'gateway-recovery-suspended':
		case 'gateway-service-health':
			return event;
	}
	return assertNeverAgentVmHealthEvent(event);
}

function redactZoneHealthIssueForPublicSnapshot(issue: ZoneHealthIssue): PublicZoneHealthIssue {
	return {
		...issue,
		latestEvent: redactHealthEventForPublicSnapshot(issue.latestEvent),
	};
}

function redactZoneHealthSnapshotForPublicResponse(
	snapshot: ZoneHealthSnapshot,
): PublicZoneHealthSnapshot {
	switch (snapshot.kind) {
		case 'unknown':
			return snapshot;
		case 'ok':
			return {
				...snapshot,
				latestEvents: snapshot.latestEvents.map(redactHealthEventForPublicSnapshot),
			};
		case 'failed':
		case 'stale':
			return {
				...snapshot,
				issues: snapshot.issues.map(redactZoneHealthIssueForPublicSnapshot),
				latestEvents: snapshot.latestEvents.map(redactHealthEventForPublicSnapshot),
			};
	}
	return assertNeverZoneHealthSnapshot(snapshot);
}

function assertNeverZoneHealthSnapshot(snapshot: never): never {
	throw new Error(`Unexpected zone health snapshot variant: ${String(snapshot)}`);
}

function assertNeverAgentVmHealthEvent(event: never): never {
	throw new Error(`Unexpected agent VM health event variant: ${String(event)}`);
}

export function registerControllerHealthEventRoutes(
	app: Hono,
	options: RegisterControllerHealthEventRoutesOptions,
): void {
	app.get('/zones/:zoneId/health-snapshot', (context) => {
		const zoneId = context.req.param('zoneId');
		if (options.zoneIds && !options.zoneIds.has(zoneId)) {
			return context.json(
				{
					error: 'unknown-zone',
					message: `Unknown zone '${zoneId}'.`,
				},
				404,
			);
		}
		return context.json(
			redactZoneHealthSnapshotForPublicResponse(
				options.store.deriveSnapshot({
					nowMs: options.now(),
					zoneId,
				}),
			),
		);
	});
}
