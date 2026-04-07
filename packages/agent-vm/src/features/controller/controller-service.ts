import fs from 'node:fs/promises';

import { Hono } from 'hono';

import type { LeaseManager } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';

function isLeaseCreatePayload(value: unknown): value is {
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
} {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { agentWorkspaceDir?: unknown }).agentWorkspaceDir === 'string' &&
		typeof (value as { profileId?: unknown }).profileId === 'string' &&
		typeof (value as { scopeKey?: unknown }).scopeKey === 'string' &&
		typeof (value as { workspaceDir?: unknown }).workspaceDir === 'string' &&
		typeof (value as { zoneId?: unknown }).zoneId === 'string'
	);
}

function isDestroyPayload(value: unknown): value is { readonly purge?: boolean } {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { purge?: unknown };
	return candidate.purge === undefined || typeof candidate.purge === 'boolean';
}

export function createControllerApp(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'listLeases' | 'releaseLease'>;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly operations?: {
		readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
		readonly execInZone?: (zoneId: string, command: string) => Promise<unknown>;
		readonly getStatus: () => Promise<unknown>;
		readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
		readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
		readonly stopController?: () => Promise<unknown>;
		readonly upgradeZone: (zoneId: string) => Promise<unknown>;
	};
}): Hono {
	const app = new Hono();
	const readIdentityPem =
		options.readIdentityPem ??
		(async (identityFilePath: string): Promise<string> =>
			await fs.readFile(identityFilePath, 'utf8'));

	app.post('/lease', async (context) => {
		try {
			const payload = await context.req.json();
			if (!isLeaseCreatePayload(payload)) {
				return context.json({ error: 'invalid-lease-request' }, 400);
			}
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

			const identityPem = lease.sshAccess.identityFile
				? await readIdentityPem(lease.sshAccess.identityFile)
				: '';
			return context.json({
				leaseId: lease.id,
				ssh: {
					host: `tool-${lease.tcpSlot}.vm.host`,
					identityPem,
					knownHostsLine: '', // intentionally empty: Gondolin SSH uses StrictHostKeyChecking=no (local virtio channel)
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

	app.get('/lease/:leaseId', async (context) => {
		const lease = options.leaseManager.getLease(context.req.param('leaseId'));
		if (!lease) {
			return context.json({ error: 'Lease not found' }, 404);
		}

		const identityPem = lease.sshAccess.identityFile
			? await readIdentityPem(lease.sshAccess.identityFile)
			: '';
		return context.json({
			leaseId: lease.id,
			ssh: {
				host: `tool-${lease.tcpSlot}.vm.host`,
				identityPem,
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			tcpSlot: lease.tcpSlot,
			workdir: '/workspace',
		});
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
		const operations = options.operations;
		app.get('/status', async (context) => context.json(await operations.getStatus()));
		app.get('/zones/:zoneId/logs', async (context) =>
			context.json(await operations.getZoneLogs(context.req.param('zoneId'))),
		);
		app.post('/zones/:zoneId/credentials/refresh', async (context) =>
			context.json(await operations.refreshZoneCredentials(context.req.param('zoneId'))),
		);
		app.post('/zones/:zoneId/destroy', async (context) => {
			const payload = await context.req.json();
			if (!isDestroyPayload(payload)) {
				return context.json({ error: 'invalid-destroy-request' }, 400);
			}
			return context.json(
				await operations.destroyZone(context.req.param('zoneId'), payload.purge === true),
			);
		});
		app.post('/zones/:zoneId/upgrade', async (context) =>
			context.json(await operations.upgradeZone(context.req.param('zoneId'))),
		);
		if (operations.execInZone) {
			const execHandler = operations.execInZone;
			app.post('/zones/:zoneId/exec', async (context) => {
				const payload = await context.req.json() as { command?: string };
				if (typeof payload.command !== 'string') {
					return context.json({ error: 'command is required' }, 400);
				}
				return context.json(
					await execHandler(context.req.param('zoneId'), payload.command),
				);
			});
		}
		if (operations.stopController) {
			const stopHandler = operations.stopController;
			app.post('/stop', async (context) => context.json(await stopHandler()));
		}
	}

	return app;
}

export function createControllerService(options: {
	readonly leaseManager: Pick<LeaseManager, 'createLease' | 'getLease' | 'listLeases' | 'releaseLease'>;
	readonly operations?: {
		readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
		readonly execInZone?: (zoneId: string, command: string) => Promise<unknown>;
		readonly getStatus: () => Promise<unknown>;
		readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
		readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
		readonly stopController?: () => Promise<unknown>;
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
