import { describe, expect, it, vi } from 'vitest';

import { createControllerApp } from './controller-service.js';
import type { Lease } from './lease-manager.js';

describe('createControllerApp', () => {
	it('creates, fetches, and releases leases through the controller api', async () => {
		const lease: Lease = {
			createdAt: 1,
			id: 'lease-123',
			lastUsedAt: 1,
			profileId: 'standard',
			scopeKey: 'agent:main:session-abc',
			sshAccess: {
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			},
			tcpSlot: 0,
			vm: {
				close: vi.fn(async () => {}),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
			},
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
		const getLease = vi.fn(() => lease);
		const releaseLease = vi.fn(async () => {});
		const app = createControllerApp({
			readIdentityPem: async () => 'pem-from-file',
			leaseManager: {
				createLease,
				getLease,
				listLeases: vi.fn(() => []),
				releaseLease,
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/workspace',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		const getResponse = await app.request('/lease/lease-123');
		const deleteResponse = await app.request('/lease/lease-123', {
			method: 'DELETE',
		});

		expect(createResponse.status).toBe(200);
		await expect(createResponse.json()).resolves.toMatchObject({
			leaseId: 'lease-123',
			ssh: {
				identityPem: 'pem-from-file',
			},
			tcpSlot: 0,
			workdir: '/workspace',
		});
		expect(getResponse.status).toBe(200);
		expect(deleteResponse.status).toBe(204);
		expect(releaseLease).toHaveBeenCalledWith('lease-123');
	});

	it('returns 503 when the tcp pool is exhausted', async () => {
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('No TCP slots available');
				}),
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/workspace',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(503);
		await expect(createResponse.json()).resolves.toMatchObject({
			error: 'No TCP slots available',
		});
	});

	it('exposes status, logs, credentials refresh, destroy, and upgrade routes', async () => {
		const destroyZone = vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' }));
		const getStatus = vi.fn(async () => ({
			controllerPort: 18800,
			toolProfiles: ['standard'],
			zones: [{ id: 'shravan', ingressPort: 18791, toolProfile: 'standard' }],
		}));
		const getZoneLogs = vi.fn(async () => ({
			output: 'gateway log line',
			zoneId: 'shravan',
		}));
		const refreshZoneCredentials = vi.fn(async () => ({
			ok: true,
			zoneId: 'shravan',
		}));
		const upgradeZone = vi.fn(async () => ({
			ok: true,
			zoneId: 'shravan',
		}));
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone,
				getStatus,
				getZoneLogs,
				refreshZoneCredentials,
				upgradeZone,
			},
		});

		const statusResponse = await app.request('/status');
		const logsResponse = await app.request('/zones/shravan/logs');
		const refreshResponse = await app.request('/zones/shravan/credentials/refresh', {
			method: 'POST',
		});
		const destroyResponse = await app.request('/zones/shravan/destroy', {
			body: JSON.stringify({ purge: true }),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		const upgradeResponse = await app.request('/zones/shravan/upgrade', {
			method: 'POST',
		});

		expect(statusResponse.status).toBe(200);
		expect(logsResponse.status).toBe(200);
		expect(refreshResponse.status).toBe(200);
		expect(destroyResponse.status).toBe(200);
		expect(upgradeResponse.status).toBe(200);
		expect(getStatus).toHaveBeenCalled();
		expect(getZoneLogs).toHaveBeenCalledWith('shravan');
		expect(refreshZoneCredentials).toHaveBeenCalledWith('shravan');
		expect(destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(upgradeZone).toHaveBeenCalledWith('shravan');
	});

	it('returns 400 for invalid lease create payload', async () => {
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('should not be called');
				}),
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({ incomplete: true }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-lease-request',
		});
	});

	it('returns 404 when fetching a non-existent lease', async () => {
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				getLease: vi.fn(() => undefined),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease/non-existent-id');

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			error: 'Lease not found',
		});
	});

	it('lists active leases via GET /leases', async () => {
		const listLeases = vi.fn(() => [
			{
				id: 'lease-1',
				zoneId: 'shravan',
				scopeKey: 'agent:main',
				tcpSlot: 0,
				createdAt: 100,
				lastUsedAt: 100,
				profileId: 'standard',
			},
			{
				id: 'lease-2',
				zoneId: 'shravan',
				scopeKey: 'agent:tool',
				tcpSlot: 1,
				createdAt: 200,
				lastUsedAt: 200,
				profileId: 'standard',
			},
		]);
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				getLease: vi.fn(),
				listLeases,
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/leases');

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toHaveLength(2);
		expect(body[0]).toMatchObject({ id: 'lease-1', zoneId: 'shravan' });
	});

	it('gracefully stops the controller via POST /stop', async () => {
		const stopController = vi.fn(async () => ({ ok: true }));
		const app = createControllerApp({
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				stopController,
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/stop', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(stopController).toHaveBeenCalled();
	});
});
