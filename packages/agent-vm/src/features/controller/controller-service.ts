import { Hono } from 'hono';

import type { LeaseManager } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';

export function createControllerApp(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'releaseLease'>;
	readonly operations?: {
		readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
		readonly getStatus: () => Promise<unknown>;
		readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
		readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
		readonly upgradeZone: (zoneId: string) => Promise<unknown>;
	};
}): Hono {
	const app = new Hono();

	app.post('/lease', async (context) => {
		try {
			const payload = (await context.req.json()) as {
				readonly agentWorkspaceDir: string;
				readonly profileId: string;
				readonly scopeKey: string;
				readonly workspaceDir: string;
				readonly zoneId: string;
			};
			const lease = await options.leaseManager.createLease({
				agentWorkspaceDir: payload.agentWorkspaceDir,
				profile: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspace',
				},
				profileId: payload.profileId,
				scopeKey: payload.scopeKey,
				workspaceDir: payload.workspaceDir,
				zoneId: payload.zoneId,
			});

			return context.json({
				leaseId: lease.id,
				ssh: {
					host: `tool-${lease.tcpSlot}.vm.host`,
					identityPem: '',
					knownHostsLine: '',
					port: 22,
					user: 'sandbox',
				},
				tcpSlot: lease.tcpSlot,
				workdir: '/workspace',
			});
		} catch (error) {
			return context.json(
				{
					error: error instanceof Error ? error.message : 'lease-creation-failed',
				},
				503,
			);
		}
	});

	app.get('/lease/:leaseId', (context) => {
		const lease = options.leaseManager.getLease(context.req.param('leaseId'));
		if (!lease) {
			return context.json({ error: 'Lease not found' }, 404);
		}

		return context.json({
			leaseId: lease.id,
			ssh: {
				host: `tool-${lease.tcpSlot}.vm.host`,
				identityPem: '',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: lease.tcpSlot,
			workdir: '/workspace',
		});
	});

	app.delete('/lease/:leaseId', async (context) => {
		await options.leaseManager.releaseLease(context.req.param('leaseId'));
		return context.body(null, 204);
	});

	if (options.operations) {
		const operations = options.operations;
		app.get('/status', async (context) => context.json(await operations.getStatus()));
		app.get('/zones/:zoneId/logs', async (context) =>
			context.json(await operations.getZoneLogs(context.req.param('zoneId'))),
		);
		app.post('/zones/:zoneId/credentials/refresh', async (context) =>
			context.json(await operations.refreshZoneCredentials(context.req.param('zoneId'))),
		);
		app.post('/zones/:zoneId/destroy', async (context) => {
			const payload = (await context.req.json()) as { readonly purge?: boolean };
			return context.json(
				await operations.destroyZone(context.req.param('zoneId'), payload.purge === true),
			);
		});
		app.post('/zones/:zoneId/upgrade', async (context) =>
			context.json(await operations.upgradeZone(context.req.param('zoneId'))),
		);
	}

	return app;
}

export function createControllerService(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'releaseLease'>;
	readonly operations?: {
		readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
		readonly getStatus: () => Promise<unknown>;
		readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
		readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
		readonly upgradeZone: (zoneId: string) => Promise<unknown>;
	};
	readonly systemConfig: SystemConfig;
}): Hono {
	const app = createControllerApp({
		leaseManager: options.leaseManager,
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
