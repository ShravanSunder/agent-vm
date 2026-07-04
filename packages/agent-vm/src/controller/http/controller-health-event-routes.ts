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
