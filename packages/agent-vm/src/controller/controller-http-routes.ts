import { Hono } from 'hono';

import {
	type ControllerLeaseManager,
	type ControllerRouteOperations,
	readIdentityPemFromFile,
	serializeLeaseForResponse,
} from './controller-http-route-support.js';
import { controllerLeaseCreateRequestSchema } from './controller-request-schemas.js';
import { registerControllerZoneOperationRoutes } from './controller-zone-operation-routes.js';
import type { SystemConfig } from './system-config.js';

export function createControllerApp(options: {
	readonly leaseManager: ControllerLeaseManager;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly toolProfiles?: Record<
		string,
		{ readonly cpus: number; readonly memory: string; readonly workspaceRoot: string }
	>;
	readonly operations?: ControllerRouteOperations;
}): Hono {
	const app = new Hono();
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;

	app.post('/lease', async (context) => {
		try {
			const parsedPayload = controllerLeaseCreateRequestSchema.safeParse(await context.req.json());
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-lease-request',
						issues: parsedPayload.error.issues,
					},
					400,
				);
			}
			const payload = parsedPayload.data;
			const toolProfile = options.toolProfiles?.[payload.profileId];
			if (!toolProfile) {
				return context.json({ error: `Unknown tool profile '${payload.profileId}'` }, 400);
			}
			const lease = await options.leaseManager.createLease({
				agentWorkspaceDir: payload.agentWorkspaceDir,
				profile: toolProfile,
				profileId: payload.profileId,
				scopeKey: payload.scopeKey,
				workspaceDir: payload.workspaceDir,
				zoneId: payload.zoneId,
			});
			return context.json(await serializeLeaseForResponse(lease, readIdentityPem));
		} catch (error) {
			return context.json(
				{
					error: error instanceof Error ? error.message : 'lease-creation-failed',
				},
				503,
			);
		}
	});

	app.get('/lease/:leaseId', async (context) => {
		const lease = options.leaseManager.getLease(context.req.param('leaseId'));
		if (!lease) {
			return context.json({ error: 'Lease not found' }, 404);
		}
		return context.json(await serializeLeaseForResponse(lease, readIdentityPem));
	});

	app.get('/leases', (context) => {
		const leases = options.leaseManager.listLeases().map((lease) => ({
			createdAt: lease.createdAt,
			id: lease.id,
			lastUsedAt: lease.lastUsedAt,
			profileId: lease.profileId,
			scopeKey: lease.scopeKey,
			tcpSlot: lease.tcpSlot,
			zoneId: lease.zoneId,
		}));
		return context.json(leases);
	});

	app.delete('/lease/:leaseId', async (context) => {
		await options.leaseManager.releaseLease(context.req.param('leaseId'));
		return context.body(null, 204);
	});

	if (options.operations) {
		registerControllerZoneOperationRoutes(app, options.operations);
	}

	return app;
}

export function createControllerService(options: {
	readonly leaseManager: ControllerLeaseManager;
	readonly operations?: ControllerRouteOperations;
	readonly systemConfig: SystemConfig;
}): Hono {
	const app = createControllerApp({
		leaseManager: options.leaseManager,
		toolProfiles: options.systemConfig.toolProfiles,
		...(options.operations ? { operations: options.operations } : {}),
	});

	app.get('/health', (context) =>
		context.json({
			ok: true,
			port: options.systemConfig.host.controllerPort,
		}),
	);

	return app;
}
