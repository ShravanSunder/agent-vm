import type { Hono } from 'hono';

import {
	type ControllerRouteOperations,
	isDestroyPayload,
} from './controller-http-route-support.js';

export function registerControllerZoneOperationRoutes(
	app: Hono,
	operations: ControllerRouteOperations,
): void {
	app.get('/controller-status', async (context) =>
		context.json(await operations.getStatus()),
	);
	app.get('/zones/:zoneId/logs', async (context) =>
		context.json(await operations.getZoneLogs(context.req.param('zoneId'))),
	);
	app.post('/zones/:zoneId/credentials/refresh', async (context) =>
		context.json(
			await operations.refreshZoneCredentials(context.req.param('zoneId')),
		),
	);
	app.post('/zones/:zoneId/destroy', async (context) => {
		const payload = await context.req.json();
		if (!isDestroyPayload(payload)) {
			return context.json({ error: 'invalid-destroy-request' }, 400);
		}
		return context.json(
			await operations.destroyZone(
				context.req.param('zoneId'),
				payload.purge === true,
			),
		);
	});
	app.post('/zones/:zoneId/upgrade', async (context) =>
		context.json(await operations.upgradeZone(context.req.param('zoneId'))),
	);

	if (operations.enableSshForZone) {
		app.post('/zones/:zoneId/enable-ssh', async (context) =>
			context.json(
				await operations.enableSshForZone?.(context.req.param('zoneId')),
			),
		);
	}

	if (operations.execInZone) {
		app.post('/zones/:zoneId/execute-command', async (context) => {
			const payload = (await context.req.json()) as { command?: string };
			if (typeof payload.command !== 'string') {
				return context.json({ error: 'command is required' }, 400);
			}
			return context.json(
				await operations.execInZone?.(
					context.req.param('zoneId'),
					payload.command,
				),
			);
		});
	}

	if (operations.stopController) {
		app.post('/stop-controller', async (context) =>
			context.json(await operations.stopController?.()),
		);
	}
}
