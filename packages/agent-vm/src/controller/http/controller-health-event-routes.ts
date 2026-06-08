import { isAgentVmHealthEvent, type AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { type Hono } from 'hono';

import type { HealthEventStore } from '../health/health-event-store.js';

type ExternallyPublishedHealthEvent = Extract<
	AgentVmHealthEvent,
	{
		readonly kind:
			| 'agent-channel-provider-health'
			| 'controller-request'
			| 'gateway-control-link'
			| 'gateway-plugin-health'
			| 'tool-vm-ssh';
	}
>;

export interface RegisterControllerHealthEventRoutesOptions {
	readonly leaseRemediation?:
		| {
				readonly getLeaseOwner:
					| ((leaseId: string) => { readonly agentId: string; readonly zoneId: string } | undefined)
					| undefined;
		  }
		| undefined;
	readonly now: () => number;
	readonly store: HealthEventStore;
	readonly zoneIds?: ReadonlySet<string> | undefined;
}

function writeHealthEventRouteWarning(message: string): void {
	process.stderr.write(`[controller-health-event-routes] ${message}\n`);
}

function isExternallyPublishedHealthEvent(
	event: AgentVmHealthEvent,
): event is ExternallyPublishedHealthEvent {
	switch (event.kind) {
		case 'agent-channel-provider-health':
		case 'controller-request':
		case 'gateway-control-link':
		case 'gateway-plugin-health':
		case 'tool-vm-ssh':
			return true;
		case 'gateway-recovery':
		case 'gateway-recovery-suspended':
		case 'gateway-service-health':
		case 'lease-heartbeat':
		case 'lease-renew':
			return false;
	}
	return assertNeverAgentVmHealthEvent(event);
}

function assertNeverAgentVmHealthEvent(event: never): never {
	throw new Error(`Unhandled health event kind: ${JSON.stringify(event)}`);
}

function shouldRecordToolVmLeaseHealthEvent(
	options: RegisterControllerHealthEventRoutesOptions,
	event: ExternallyPublishedHealthEvent,
): boolean {
	if (event.kind !== 'tool-vm-ssh' || options.leaseRemediation?.getLeaseOwner === undefined) {
		return true;
	}
	const leaseOwner = options.leaseRemediation.getLeaseOwner(event.leaseId);
	if (leaseOwner?.zoneId !== event.zoneId) {
		writeHealthEventRouteWarning(
			leaseOwner === undefined
				? `refusing to record Tool VM SSH health for lease '${event.leaseId}' in zone '${event.zoneId}' because the lease was not found`
				: `refusing to record Tool VM SSH health for lease '${event.leaseId}' in zone '${event.zoneId}' because it belongs to zone '${leaseOwner.zoneId}'`,
		);
		return false;
	}
	if (leaseOwner.agentId !== event.agentId) {
		writeHealthEventRouteWarning(
			`refusing to record Tool VM SSH health for lease '${event.leaseId}' in zone '${event.zoneId}' because it belongs to agent '${leaseOwner.agentId}', not '${event.agentId}'`,
		);
		return false;
	}
	return true;
}

export function registerControllerHealthEventRoutes(
	app: Hono,
	options: RegisterControllerHealthEventRoutesOptions,
): void {
	app.post('/zones/:zoneId/health-events', async (context) => {
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json(
				{
					error: 'invalid-json-request',
					message: 'Request body must be valid JSON.',
				},
				400,
			);
		}
		if (!isAgentVmHealthEvent(body)) {
			return context.json({ error: 'invalid-health-event' }, 400);
		}
		if (!isExternallyPublishedHealthEvent(body)) {
			return context.json(
				{
					error: 'externally-managed-health-event-kind',
					message: `Health event kind '${body.kind}' is recorded by the agent-vm controller and cannot be published through this route.`,
				},
				400,
			);
		}
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
		if (body.zoneId !== zoneId) {
			return context.json(
				{
					error: 'health-event-zone-mismatch',
					message: `Health event zoneId '${body.zoneId}' does not match route zoneId '${zoneId}'.`,
				},
				400,
			);
		}
		if (!shouldRecordToolVmLeaseHealthEvent(options, body)) {
			return context.json({ ignored: true, ok: true });
		}
		options.store.record(body);
		return context.json({ ok: true });
	});

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
			options.store.deriveSnapshot({
				nowMs: options.now(),
				zoneId,
			}),
		);
	});
}
