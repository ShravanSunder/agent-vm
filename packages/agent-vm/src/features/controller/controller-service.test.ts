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
			leaseManager: {
				createLease,
				getLease,
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
});
