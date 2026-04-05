import { Hono } from 'hono';

import type { LeaseManager } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';

export function createControllerApp(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'releaseLease'>;
}): Hono {
	const app = new Hono();

	app.post('/lease', async (context) => {
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

	return app;
}

export function createControllerService(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'releaseLease'>;
	readonly systemConfig: SystemConfig;
}): Hono {
	const app = createControllerApp({
		leaseManager: options.leaseManager,
	});

	app.get('/health', (context) =>
		context.json({
			ok: true,
			port: options.systemConfig.host.controllerPort,
		}),
	);

	return app;
}
