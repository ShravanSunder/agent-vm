import { TOOL_VM_WORK_GUEST_ROOT } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import { HealthEventStore } from '../health/health-event-store.js';
import type { Lease, LeaseSnapshot } from '../leases/lease-manager.js';
import { ControllerZoneNotFoundError } from '../zone-runtimes/zone-runtime-errors.js';
import { serializeLeaseForResponse } from './controller-http-route-support.js';
import { createControllerApp } from './controller-http-routes.js';

type ControllerAppOptions = Parameters<typeof createControllerApp>[0];

function createControllerAppForTest(
	options: ControllerAppOptions,
): ReturnType<typeof createControllerApp> {
	const { readIdentityPem = async () => 'pem', ...rest } = options;
	return createControllerApp({
		...rest,
		readIdentityPem,
	});
}

function createLeaseStub(
	leaseId: string,
	tcpSlot: number,
	overrides: Partial<Pick<Lease, 'agentId' | 'profileId' | 'zoneId'>> = {},
): Lease {
	const agentId = overrides.agentId ?? 'main';
	const zoneId = overrides.zoneId ?? 'shravan';
	const lease = {
		agentId,
		createdAt: tcpSlot,
		effectiveIdleTtlMs: 100 * 60 * 1000,
		guestWorkdir: TOOL_VM_WORK_GUEST_ROOT,
		hostGitDirectoryRoot: `/host/${zoneId}/runtime/gitdirs/agents/${agentId}`,
		hostWorkspaceRoot: `/host/${zoneId}/zone-files/agents/${agentId}`,
		id: leaseId,
		lastUsedAt: tcpSlot,
		profileId: overrides.profileId ?? 'standard',
		runtimeRecordId: leaseId,
		sshAccess: {
			close: async () => {},
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000 + tcpSlot,
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			user: 'sandbox',
		},
		tcpSlot,
		vm: {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				host: '127.0.0.1',
				port: 18791,
			})),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				command: 'ssh tool-vm',
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000 + tcpSlot,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			id: `tool-vm-${leaseId}`,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: () => null,
			start: async () => {},
		},
		profileAssignmentRevision: `profile-assignment:${agentId}:1`,
		zoneId,
	} satisfies Lease;
	return lease;
}

describe('createControllerApp', () => {
	it('does not expose external controller approval HTTP routes', async () => {
		const app = createControllerAppForTest({
			leaseManager: {
				createLease: vi.fn(),
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
			},
		});

		const requests = [
			new Request('http://localhost/zones/hermes/approvals'),
			new Request('http://localhost/zones/hermes/approvals/challenge'),
			new Request('http://localhost/zones/hermes/approvals/challenge/approve', {
				method: 'POST',
			}),
			new Request('http://localhost/zones/hermes/approvals/challenge/deny', {
				method: 'POST',
			}),
			new Request('http://localhost/zones/hermes/approvals/challenge/revoke', {
				method: 'POST',
			}),
		];

		const responses = await Promise.all(
			requests.map(async (request) => await app.request(request)),
		);

		expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
	});

	it('serializes the exact Tool VM SSH server identity for private HTTP lease responses', async () => {
		const lease = createLeaseStub('lease-ssh-identity', 3);

		const serializedLease = await serializeLeaseForResponse(lease, async () => 'identity-pem', {
			idleTtlMs: lease.effectiveIdleTtlMs,
		});

		expect(serializedLease.ssh.knownHostsLine).toBe(
			`tool-3.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
		);
		expect(serializedLease.ssh.knownHostsLine).not.toHaveLength(0);
	});

	it.each([
		['missing', undefined],
		['malformed algorithm', { algorithm: 'ssh-rsa', publicKeyBase64: 'not-base64!' }],
	] as const)(
		'fails closed for a %s SSH server identity in private HTTP lease serialization',
		async (_identityKind, serverHostKey) => {
			const lease = createLeaseStub('lease-invalid-ssh-identity', 4);
			if (serverHostKey === undefined) {
				Reflect.deleteProperty(lease.sshAccess, 'serverHostKey');
			} else {
				Reflect.set(lease.sshAccess, 'serverHostKey', serverHostKey);
			}

			await expect(
				serializeLeaseForResponse(lease, async () => 'identity-pem', {
					idleTtlMs: lease.effectiveIdleTtlMs,
				}),
			).rejects.toThrow(
				"Lease 'lease-invalid-ssh-identity' does not have a valid ssh-ed25519 server host key.",
			);
		},
	);

	it('returns recovering health while runtime startup is not ready', async () => {
		const app = createControllerAppForTest({
			runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/health');

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			state: 'recovering',
		});
	});

	it('deletes old VM-facing health-event mutation routes from the controller app', async () => {
		const releaseLease = vi.fn(async () => {});
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
				renewLease: vi.fn(),
				peekLease: vi.fn<() => LeaseSnapshot>(() => ({
					kind: 'snapshot',
					lease: createLeaseStub('lease-123', 0, { zoneId: 'beta' }),
				})),
				listLeases: vi.fn(() => []),
				releaseLease,
			},
		});

		const response = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				domain: 'gateway_control',
				elapsedMs: 12,
				kind: 'gateway-control-session',
				observedAtMs: Date.now(),
				operation: 'control-session-heartbeat',
				peerId: 'gateway-beta',
				result: 'ok',
				zoneId: 'beta',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(404);

		const toolVmSshResponse = await app.request('/zones/beta/health-events', {
			body: JSON.stringify({
				agentId: 'main',
				elapsedMs: 5_000,
				errorCode: 'ssh-command-failed',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-123',
				observedAtMs: Date.now(),
				operation: 'command',
				result: 'failed',
				zoneId: 'beta',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(toolVmSshResponse.status).toBe(404);
		expect(releaseLease).not.toHaveBeenCalled();
	});

	it.each([
		['POST', '/lease'],
		['GET', '/lease/lease-123'],
		['GET', '/lease/lease-123/peek'],
		['POST', '/lease/lease-123/renew'],
		['DELETE', '/lease/lease-123'],
		['POST', '/lease/lease-123/uses'],
		['POST', '/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat'],
		['DELETE', '/lease/lease-123/uses/use_01890f00000070008000000000000000'],
	] as const)('deletes the old VM-facing lease route %s %s', async (method, routePath) => {
		const app = createControllerAppForTest({
			runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
				renewLease: vi.fn(),
				peekLease: vi.fn(() => ({
					kind: 'snapshot' as const,
					lease: createLeaseStub('lease-123', 0),
				})),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
				startActiveUse: vi.fn(),
				heartbeatActiveUse: vi.fn(),
				endActiveUse: vi.fn(),
			},
		});

		const response = await app.request(routePath, {
			...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({}) }),
			headers: { 'content-type': 'application/json' },
			method,
		});

		expect(response.status).toBe(404);
	});

	it.each([
		['POST', '/zones/shravan/credentials/refresh'],
		['POST', '/zones/shravan/destroy'],
		['POST', '/zones/shravan/upgrade'],
		['POST', '/zones/shravan/enable-ssh'],
		['POST', '/zones/shravan/execute-command'],
		['POST', '/zones/shravan/credentialed-runtime/retire'],
	] as const)(
		'returns not-ready for %s %s while runtime is recovering',
		async (method, routePath) => {
			const app = createControllerAppForTest({
				runtimeReadiness: () => ({ ready: false, state: 'recovering' }),
				toolVmProfiles: {
					standard: {
						cpus: 1,
						memory: '1G',
						imageProfile: 'default',
					},
				},
				leaseManager: {
					createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
					renewLease: vi.fn(),
					peekLease: vi.fn(() => ({
						kind: 'snapshot' as const,
						lease: createLeaseStub('lease-123', 0),
					})),
					listLeases: vi.fn(() => []),
					releaseLease: vi.fn(async () => {}),
					startActiveUse: vi.fn(),
					heartbeatActiveUse: vi.fn(),
					endActiveUse: vi.fn(),
				},
				operations: {
					destroyZone: vi.fn(async () => ({})),
					enableSshForZone: vi.fn(async () => ({})),
					execInZone: vi.fn(async () => ({})),
					getStatus: vi.fn(async () => ({})),
					getZoneLogs: vi.fn(async () => ({})),
					refreshZoneCredentials: vi.fn(async () => ({})),
					retireCredentialedRuntime: vi.fn(async () => ({})),
					upgradeZone: vi.fn(async () => ({})),
				},
			});

			const response = await app.request(routePath, {
				body: JSON.stringify({}),
				headers: { 'content-type': 'application/json' },
				method,
			});

			expect(response.status).toBe(503);
			await expect(response.json()).resolves.toMatchObject({
				error: 'controller-not-ready',
				state: 'recovering',
			});
		},
	);

	it('exposes status, logs, credentials refresh, destroy, and upgrade routes', async () => {
		const destroyZone = vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' }));
		const getStatus = vi.fn(async () => ({
			toolVmProfiles: ['standard'],
			zones: [
				{
					gatewayType: 'hermes',
					id: 'shravan',
					ingressPort: 18791,
					running: true,
					agentToolVmProfiles: {},
				},
			],
		}));
		const getZoneStatus = vi.fn(async () => ({
			gatewayType: 'hermes',
			id: 'shravan',
			ingressPort: 18791,
			running: true,
			agentToolVmProfiles: {},
		}));
		const getZoneHealth = vi.fn(async () => ({
			ok: true,
			observation: 'http 200',
			zoneId: 'shravan',
		}));
		const getZoneServiceHealth = vi.fn(async () => ({
			ok: true,
			observation: 'http 200',
			zoneId: 'shravan',
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
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone,
				getStatus,
				getZoneHealth,
				getZoneServiceHealth,
				getZoneStatus,
				getZoneLogs,
				refreshZoneCredentials,
				upgradeZone,
			},
		});

		const statusResponse = await app.request('/controller-status');
		const zoneStatusResponse = await app.request('/zones/shravan/status');
		const zoneHealthResponse = await app.request('/zones/shravan/health');
		const zoneServiceHealthResponse = await app.request('/zones/shravan/service-health');
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
		expect(zoneStatusResponse.status).toBe(200);
		expect(zoneHealthResponse.status).toBe(200);
		expect(zoneServiceHealthResponse.status).toBe(200);
		expect(logsResponse.status).toBe(200);
		expect(refreshResponse.status).toBe(200);
		expect(destroyResponse.status).toBe(200);
		expect(upgradeResponse.status).toBe(200);
		expect(getStatus).toHaveBeenCalled();
		expect(getZoneStatus).toHaveBeenCalledWith('shravan');
		expect(getZoneHealth).toHaveBeenCalledWith('shravan');
		expect(getZoneServiceHealth).toHaveBeenCalledWith('shravan');
		expect(getZoneLogs).toHaveBeenCalledWith('shravan');
		expect(refreshZoneCredentials).toHaveBeenCalledWith('shravan');
		expect(destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(upgradeZone).toHaveBeenCalledWith('shravan');
	});

	it('returns 503 for unhealthy readiness without recording service health', async () => {
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const app = createControllerAppForTest({
			healthEventStore,
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneHealth: vi.fn(async () => ({
					ok: false,
					observation: 'http 503',
					path: '/readyz',
					port: 18789,
					statusCode: 503,
					zoneId: 'shravan',
				})),
				getZoneLogs: vi.fn(async () => ({})),
				getZoneStatus: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/health');

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			observation: 'http 503',
			path: '/readyz',
			port: 18789,
			statusCode: 503,
			zoneId: 'shravan',
		});
		expect(healthEventStore.listLatestEventsForZone('shravan')).toEqual([]);
	});

	it('records service health only from the service-health route', async () => {
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 20,
			staleAfterMs: 30_000,
		});
		const app = createControllerAppForTest({
			healthEventStore,
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneHealth: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
				getZoneLogs: vi.fn(async () => ({})),
				getZoneServiceHealth: vi.fn(async () => ({
					ok: false,
					observation: 'http 503',
					path: '/health',
					port: 18789,
					statusCode: 503,
					zoneId: 'shravan',
				})),
				getZoneStatus: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/service-health');

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			observation: 'http 503',
			path: '/health',
			port: 18789,
			statusCode: 503,
			zoneId: 'shravan',
		});
		expect(healthEventStore.listLatestEventsForZone('shravan')).toEqual([
			expect.objectContaining({
				kind: 'gateway-service-health',
				path: '/health',
				port: 18789,
				result: 'failed',
				statusCode: 503,
				zoneId: 'shravan',
			}),
		]);
	});

	it('does not expose retired whole-zone Git routes', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				getZoneStatus: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const statusResponse = await app.request('/zones/sunfam/zone-git/status');
		const pushResponse = await app.request('/zones/sunfam/zone-git/push', {
			body: JSON.stringify({ expectedHead: 'abc123' }),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(statusResponse.status).toBe(404);
		expect(pushResponse.status).toBe(404);
	});

	it('does not expose active leases via GET /leases', async () => {
		const listLeases = vi.fn(() => [createLeaseStub('lease-1', 0), createLeaseStub('lease-2', 1)]);
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases,
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/leases');

		expect(response.status).toBe(404);
		expect(listLeases).not.toHaveBeenCalled();
	});

	it('gracefully stops the controller via POST /stop', async () => {
		const stopController = vi.fn(async () => ({ ok: true }));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
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

		const response = await app.request('/stop-controller', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(stopController).toHaveBeenCalled();
	});

	it('returns 404 when zone status is requested for an unknown zone', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				getZoneStatus: vi.fn(async () => {
					throw new ControllerZoneNotFoundError('missing-zone');
				}),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/missing-zone/status');

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: "Unknown zone 'missing-zone'.",
		});
	});

	it('returns schema details for invalid destroy requests', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/destroy', {
			body: JSON.stringify({ purge: 'yes' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-destroy-request',
			issues: expect.any(Array),
		});
	});

	it('returns schema details for invalid execute-command requests', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				enableSshForZone: vi.fn(async () => ({})),
				execInZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				retireCredentialedRuntime: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/execute-command', {
			body: JSON.stringify({ command: '' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-execute-command-request',
			issues: expect.any(Array),
		});
	});

	it('passes admin tokens through execute-command requests', async () => {
		const execInZone = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: 'ok' }));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				execInZone,
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/execute-command', {
			body: JSON.stringify({ adminToken: 'admin-token', command: 'pwd' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(200);
		expect(execInZone).toHaveBeenCalledWith('shravan', 'pwd', { adminToken: 'admin-token' });
	});

	it('routes exact credentialed runtime retirement authority without VM or secret fields', async () => {
		const retireCredentialedRuntime = vi.fn(async () => ({ kind: 'retired' as const }));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(async () => {}),
				renewLease: vi.fn(),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				retireCredentialedRuntime,
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/credentialed-runtime/retire', {
			body: JSON.stringify({ adminToken: 'admin-token', agentId: 'sun', force: true }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ kind: 'retired' });
		expect(retireCredentialedRuntime).toHaveBeenCalledWith('shravan', {
			adminToken: 'admin-token',
			agentId: 'sun',
			force: true,
		});
		const removedRoute = await app.request(
			'/zones/shravan/credentialed-runtimes/google-workspace/retire',
			{ method: 'POST' },
		);
		expect(removedRoute.status).toBe(404);
	});

	it('returns 400 for malformed JSON bodies on controller operation routes', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => {
					throw new Error('not used');
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				enableSshForZone: vi.fn(async () => ({})),
				execInZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				retireCredentialedRuntime: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});
		const operationPaths = [
			'/zones/shravan/enable-ssh',
			'/zones/shravan/execute-command',
			'/zones/shravan/credentialed-runtime/retire',
			'/zones/shravan/destroy',
		];

		await Promise.all(
			operationPaths.map(async (operationPath) => {
				const response = await app.request(operationPath, {
					body: '{',
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				});

				expect(response.status, operationPath).toBe(400);
				await expect(response.json(), operationPath).resolves.toEqual({
					error: 'invalid-json-request',
					message: 'Request body must be valid JSON.',
				});
			}),
		);
	});

	it('leaves removed Worker task paths unmatched without invoking obsolete callbacks', async () => {
		const obsoleteCallbacks = {
			closeTaskForZone: vi.fn(),
			getTaskState: vi.fn(),
			prepareWorkerTask: vi.fn(),
			pullDefaultForTask: vi.fn(),
			pushTaskBranches: vi.fn(),
		};
		const app = createControllerAppForTest({
			leaseManager: {
				createLease: vi.fn(),
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(),
				renewLease: vi.fn(),
			},
			operations: {
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
				...obsoleteCallbacks,
			},
		});

		const [
			createTaskResponse,
			getTaskResponse,
			closeTaskResponse,
			pushBranchesResponse,
			pullDefaultResponse,
		] = await Promise.all([
			app.request('/zones/shravan/worker-tasks', { method: 'POST' }),
			app.request('/zones/shravan/tasks/task-1'),
			app.request('/zones/shravan/tasks/task-1/close', { method: 'POST' }),
			app.request('/zones/shravan/tasks/task-1/push-branches', { method: 'POST' }),
			app.request('/zones/shravan/tasks/task-1/pull-default', { method: 'POST' }),
		]);

		expect(createTaskResponse.status).toBe(404);
		expect(getTaskResponse.status).toBe(404);
		expect(closeTaskResponse.status).toBe(404);
		expect(pushBranchesResponse.status).toBe(404);
		expect(pullDefaultResponse.status).toBe(404);
		for (const obsoleteCallback of Object.values(obsoleteCallbacks)) {
			expect(obsoleteCallback).not.toHaveBeenCalled();
		}
	});
});
