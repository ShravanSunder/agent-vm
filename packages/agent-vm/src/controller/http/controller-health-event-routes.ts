import { isAgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { type Hono } from 'hono';

import type { HealthEventStore } from '../health/health-event-store.js';

export interface RegisterControllerHealthEventRoutesOptions {
	readonly now: () => number;
	readonly store: HealthEventStore;
	readonly zoneIds?: ReadonlySet<string> | undefined;
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
