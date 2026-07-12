import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import { HealthEventStore } from '../health/health-event-store.js';
import type { Lease, LeaseSnapshot } from '../leases/lease-manager.js';
import { OPENCLAW_TOOL_VM_WORKSPACE_MOUNT } from '../leases/lease-work-mount-paths.js';
import { OpenClawRuntimeStatusStore } from '../openclaw-runtime-status.js';
import type { PreparedWorkerTask, WorkerTaskResult } from '../worker-task-runner.js';
import {
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
	ControllerZoneTaskNotReadyError,
	ControllerZoneWorkerCloseError,
} from '../zone-runtimes/zone-runtime-errors.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
	serializeLeaseForResponse,
} from './controller-http-route-support.js';
import { createControllerApp } from './controller-http-routes.js';

type ControllerAppOptions = Parameters<typeof createControllerApp>[0];

function createControllerAppForTest(
	options: Omit<ControllerAppOptions, 'resolveLeaseWorkMountDir'> &
		Partial<Pick<ControllerAppOptions, 'resolveLeaseWorkMountDir'>>,
): ReturnType<typeof createControllerApp> {
	const {
		readIdentityPem = async () => 'pem',
		resolveLeaseWorkMountDir = async ({ workMountDir }) => ({
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: workMountDir,
		}),
		...rest
	} = options;
	return createControllerApp({
		...rest,
		readIdentityPem,
		resolveLeaseWorkMountDir,
	});
}

function createLeaseStub(
	leaseId: string,
	tcpSlot: number,
	overrides: Partial<Pick<Lease, 'agentId' | 'profileId' | 'zoneId'>> = {},
): Lease {
	const lease = {
		agentId: overrides.agentId ?? 'main',
		agentWorkspaceDir: '/host/agent-work',
		createdAt: tcpSlot,
		effectiveIdleTtlMs: 100 * 60 * 1000,
		guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
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
		hostWorkMountDir: '/host/sandbox-work',
		zoneId: overrides.zoneId ?? 'shravan',
	} satisfies Lease;
	return lease;
}

function createPreparedWorkerTaskStub(
	taskId: string,
	recordEvent: (event: unknown) => Promise<void> = async () => {},
	stateDir = `/state/tasks/${taskId}/state`,
): PreparedWorkerTask {
	const taskRoot = path.dirname(stateDir);
	const zoneStateDir = path.dirname(path.dirname(taskRoot));
	const taskZoneConfig = {
		id: 'shravan',
		gateway: {
			type: 'worker' as const,
			imageProfile: 'worker',
			memory: '2G',
			cpus: 2,
			port: 18791,
			config: '/tmp/gateway.json',
			stateDir: zoneStateDir,
		},
		secrets: {},
		egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
	};
	return {
		taskId,
		taskRoot,
		zoneId: 'shravan',
		input: {
			requestTaskId: 'request-task-1',
			prompt: 'hi',
			repos: [],
			context: {},
			resources: { externalResources: {} },
		},
		preStartResult: {
			taskId,
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'hi',
				repos: [],
				context: {},
				resources: { externalResources: {} },
			},
			taskRoot,
			taskRuntimeRoot: path.join('/tmp/runtime/worker-tasks/shravan', taskId),
			workDir: path.join(taskRoot, 'work'),
			stateDir,
			environment: {},
			startedResourceProviders: [],
			tcpHosts: {},
			vfsMounts: {},
			repos: [],
			effectiveConfig: workerConfigSchema.parse({
				runtimeInstructions: 'Generated runtime instructions.',
				commonAgentInstructions: null,
				defaults: { provider: 'codex', model: 'latest-medium' },
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
						skills: [],
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
						skills: [],
					},
					wrapup: { instructions: null, skills: [] },
				},
				mcpServers: [],
				verification: [],
				branchPrefix: 'agent/',
				stateDir: '/state',
			}),
		},
		taskZoneConfig,
		zone: taskZoneConfig,
		eventLogPath: path.join(stateDir, 'tasks', `${taskId}.jsonl`),
		recordEvent,
	};
}

function createWorkerTaskResultStub(taskId: string): WorkerTaskResult {
	return {
		finalState: null,
		taskId,
		taskRoot: `/state/tasks/${taskId}`,
	};
}

describe('createControllerApp', () => {
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
		['POST', '/zones/shravan/worker-tasks'],
		['POST', '/zones/shravan/tasks/task-1/close'],
		['POST', '/zones/shravan/tasks/task-1/push-branches'],
		['POST', '/zones/shravan/tasks/task-1/pull-default'],
		['POST', '/zones/shravan/enable-ssh'],
		['POST', '/zones/shravan/execute-command'],
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
					closeTaskForZone: vi.fn(async () => ({ status: 'closed' as const })),
					destroyZone: vi.fn(async () => ({})),
					enableSshForZone: vi.fn(async () => ({})),
					execInZone: vi.fn(async () => ({})),
					getStatus: vi.fn(async () => ({})),
					getZoneLogs: vi.fn(async () => ({})),
					pushTaskBranches: vi.fn(async () => ({})),
					pullDefaultForTask: vi.fn(async () => ({})),
					refreshZoneCredentials: vi.fn(async () => ({})),
					prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-1')),
					executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
					upgradeZone: vi.fn(async () => ({})),
				},
				openClawRuntimeStatusStore: new OpenClawRuntimeStatusStore(),
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

	it('deletes the old VM-facing OpenClaw runtime-status mutation route', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {},
			openClawRuntimeStatusStore: new OpenClawRuntimeStatusStore(),
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/zones/shravan/openclaw-runtime-status', {
			body: '{',
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(404);
	});

	it('exposes status, logs, credentials refresh, destroy, and upgrade routes', async () => {
		const destroyZone = vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' }));
		const getStatus = vi.fn(async () => ({
			toolVmProfiles: ['standard'],
			zones: [
				{
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressPort: 18791,
					running: true,
					agentToolVmProfiles: {},
				},
			],
		}));
		const getZoneStatus = vi.fn(async () => ({
			gatewayType: 'openclaw',
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

	it('keeps zone Git status diagnostic but deletes the old VM-facing push route', async () => {
		const getZoneGitStatus = vi.fn(async () => ({
			aheadOfRemote: 1,
			behindRemote: 0,
			branch: 'main',
			dirty: false,
			initialized: true,
			localHead: 'abc123',
			remoteHead: 'def456',
		}));
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			remoteHead: 'abc123',
			pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
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
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneGitStatus,
				getZoneLogs: vi.fn(async () => ({})),
				getZoneStatus: vi.fn(async () => ({})),
				pushZoneGit,
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

		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toMatchObject({
			branch: 'main',
			aheadOfRemote: 1,
		});
		expect(pushResponse.status).toBe(404);
		expect(getZoneGitStatus).toHaveBeenCalledWith('sunfam');
		expect(pushZoneGit).not.toHaveBeenCalled();
	});

	it('returns 405 when zone Git status is unavailable while old push route remains deleted', async () => {
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
			body: JSON.stringify({}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(statusResponse.status).toBe(405);
		await expect(statusResponse.json()).resolves.toEqual({
			error: 'zone-git-status-unavailable',
		});
		expect(pushResponse.status).toBe(404);
	});

	it('returns 409 when destroy is requested while a worker task is preparing', async () => {
		const destroyZone = vi.fn(async () => {
			throw new ControllerZoneTaskNotReadyError(
				'worker-zone',
				'task-booting',
				"Task 'task-booting' in zone 'worker-zone' is still preparing and cannot be destroyed safely yet.",
			);
		});
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
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/worker-zone/destroy', {
			body: JSON.stringify({ purge: true }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error:
				"Task 'task-booting' in zone 'worker-zone' is still preparing and cannot be destroyed safely yet.",
			kind: 'task-not-ready',
			taskId: 'task-booting',
			zoneId: 'worker-zone',
		});
	});

	it('returns worker close failure context from destroy routes', async () => {
		const destroyZone = vi.fn(async () => {
			throw new ControllerZoneWorkerCloseError({
				body: 'close failed',
				httpStatus: 503,
				taskId: 'task-1',
				zoneId: 'worker-zone',
			});
		});
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
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/worker-zone/destroy', {
			body: JSON.stringify({ purge: true }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "worker close returned HTTP 503 for task 'task-1'",
			body: 'close failed',
			httpStatus: 503,
			kind: 'worker-close-failed',
			taskId: 'task-1',
			zoneId: 'worker-zone',
		});
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

	it('returns 405 for operations unsupported by the target zone type', async () => {
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
				getZoneLogs: vi.fn(async () => {
					throw new ControllerZoneOperationUnsupportedError(
						'worker-zone',
						'OpenClaw operations',
						'worker',
					);
				}),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/worker-zone/logs');

		expect(response.status).toBe(405);
		await expect(response.json()).resolves.toEqual({
			error: "Zone 'worker-zone' with gateway type 'worker' does not support OpenClaw operations.",
			gatewayType: 'worker',
			operationName: 'OpenClaw operations',
			zoneId: 'worker-zone',
		});
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

	it('pushes branches for an active worker task via POST /zones/:zoneId/tasks/:taskId/push-branches', async () => {
		const pushTaskBranches = vi.fn(async () => ({
			results: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					branchName: 'agent/task-1',
					success: true,
					prUrl: 'https://github.com/acme/widgets/pull/42',
				},
			],
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
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				pushTaskBranches,
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/tasks/task-1/push-branches', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				branches: [
					{
						repoUrl: 'https://github.com/acme/widgets.git',
						branchName: 'agent/task-1',
					},
				],
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			results: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					success: true,
				},
			],
		});
		expect(pushTaskBranches).toHaveBeenCalledWith('shravan', 'task-1', {
			branches: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					branchName: 'agent/task-1',
				},
			],
		});
	});

	it('returns 400 when pull-default rejects the request as invalid', async () => {
		const pullDefaultForTask = vi.fn(async () => {
			throw new PullDefaultValidationError('Repo is not registered for active task.');
		});
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
				pullDefaultForTask,
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/tasks/task-1/pull-default', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				repoUrl: 'https://github.com/acme/widgets.git',
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: 'Repo is not registered for active task.',
		});
	});

	it('scrubs token-bearing pull-default errors from route logs and responses', async () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const pullDefaultForTask = vi.fn(async () => {
			throw new Error('boom https://x-access-token:secret-token@github.com/acme/widgets.git');
		});
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
				pullDefaultForTask,
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
		});

		const response = await app.request('/zones/shravan/tasks/task-1/pull-default', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				repoUrl: 'https://github.com/acme/widgets.git',
			}),
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'boom https://x-access-token:***@github.com/acme/widgets.git',
		});
		expect(stderrSpy.mock.calls.join('\n')).not.toContain('secret-token');
		stderrSpy.mockRestore();
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
				execInZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
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
				execInZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				pullDefaultForTask: vi.fn(async () => ({})),
				pushTaskBranches: vi.fn(async () => ({ results: [] })),
				refreshZoneCredentials: vi.fn(async () => ({})),
				prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-json')),
				executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
				upgradeZone: vi.fn(async () => ({})),
			},
		});
		const operationPaths = [
			'/zones/shravan/worker-tasks',
			'/zones/shravan/tasks/task-1/push-branches',
			'/zones/shravan/tasks/task-1/pull-default',
			'/zones/shravan/execute-command',
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

	it('returns 202 from POST worker-tasks without awaiting background execution', async () => {
		let executeStarted = false;
		let resolveExecute: (() => void) | undefined;
		const prepareWorkerTask = vi.fn(async () => createPreparedWorkerTaskStub('worker-task-1'));
		const executeWorkerTask = vi.fn(
			() =>
				new Promise<WorkerTaskResult>((resolve) => {
					executeStarted = true;
					resolveExecute = () => resolve(createWorkerTaskResultStub('worker-task-1'));
				}),
		);
		const app = createControllerAppForTest({
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const start = Date.now();
		const response = await app.request('/zones/shravan/worker-tasks', {
			body: JSON.stringify({
				requestTaskId: 'request-task-1',
				prompt: 'fix the login bug',
				repos: [
					{
						repoUrl: 'https://github.com/org/repo.git',
						baseBranch: 'main',
					},
				],
				context: { ticket: 'INC-1' },
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		const elapsed = Date.now() - start;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			taskId: 'worker-task-1',
			status: 'accepted',
		});
		expect(prepareWorkerTask).toHaveBeenCalledWith('shravan', {
			requestTaskId: 'request-task-1',
			context: { ticket: 'INC-1' },
			prompt: 'fix the login bug',
			repos: [{ baseBranch: 'main', repoUrl: 'https://github.com/org/repo.git' }],
			resources: { externalResources: {} },
		});
		expect(executeWorkerTask).toHaveBeenCalledTimes(1);
		expect(executeStarted).toBe(true);
		expect(elapsed).toBeLessThan(500);
		resolveExecute?.();
	});

	it('emits task-failed when background worker execution rejects', async () => {
		const emittedEvents: unknown[] = [];
		const prepareWorkerTask = vi.fn(async () =>
			createPreparedWorkerTaskStub('worker-task-2', async (event) => {
				emittedEvents.push(event);
			}),
		);
		const executeWorkerTask = vi.fn(async () => {
			throw new Error('vm-boot-failed');
		});
		const app = createControllerAppForTest({
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const response = await app.request('/zones/shravan/worker-tasks', {
			body: JSON.stringify({
				requestTaskId: 'request-task-2',
				prompt: 'fix the cross-repo bug',
				repos: [
					{
						repoUrl: 'https://github.com/org/frontend.git',
						baseBranch: 'main',
					},
					{
						repoUrl: 'https://github.com/org/backend.git',
						baseBranch: 'develop',
					},
				],
				context: { ticket: 'INC-2' },
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(202);
		await vi.waitFor(() => {
			expect(emittedEvents).toContainEqual(
				expect.objectContaining({
					event: 'task-failed',
					reason: expect.stringContaining('vm-boot-failed'),
				}),
			);
		});
	});

	it('writes a task-failed sentinel when background failure event recording fails', async () => {
		const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'controller-failure-sentinel-'));
		const taskId = 'worker-task-sentinel';
		const taskStateDir = path.join(stateRoot, 'tasks', taskId, 'state');
		const prepareWorkerTask = vi.fn(async () =>
			createPreparedWorkerTaskStub(
				taskId,
				async () => {
					throw new Error('event log unavailable');
				},
				taskStateDir,
			),
		);
		const executeWorkerTask = vi.fn(async () => {
			throw new Error('vm-boot-failed');
		});
		const app = createControllerAppForTest({
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		try {
			const response = await app.request('/zones/shravan/worker-tasks', {
				body: JSON.stringify({
					requestTaskId: 'request-task-sentinel',
					prompt: 'fix the sentinel failure',
					repos: [],
					context: {},
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});

			expect(response.status).toBe(202);
			await vi.waitFor(async () => {
				const sentinel = JSON.parse(
					await readFile(path.join(taskStateDir, 'tasks', `${taskId}.failed`), 'utf8'),
				) as { readonly status?: string; readonly failureReason?: string };
				expect(sentinel).toMatchObject({
					status: 'failed',
					failureReason: expect.stringContaining('vm-boot-failed'),
				});
			});
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it('rejects worker task requests missing requestTaskId', async () => {
		const app = createControllerAppForTest({
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
				prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-3')),
				executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const response = await app.request('/zones/shravan/worker-tasks', {
			body: JSON.stringify({
				prompt: 'missing callback identity',
				repos: [],
				context: {},
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-worker-task-request',
			issues: expect.any(Array),
		});
	});

	it('returns 409 when the worker runtime is at capacity', async () => {
		const app = createControllerAppForTest({
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
				prepareWorkerTask: vi.fn(async () => {
					throw new ControllerRuntimeAtCapacityError('worker runtime is at capacity');
				}),
				executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const response = await app.request('/zones/shravan/worker-tasks', {
			body: JSON.stringify({
				requestTaskId: 'request-task-capacity',
				prompt: 'capacity test',
				repos: [],
				context: {},
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			status: 'at-capacity',
			error: 'worker runtime is at capacity',
		});
	});

	it('returns resource preparation error details when worker task preparation fails', async () => {
		const app = createControllerAppForTest({
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
				prepareWorkerTask: vi.fn(async () => {
					throw new AggregateError(
						[
							new AggregateError(
								[
									new Error('run-setup.sh failed: missing DATABASE_URL'),
									new Error('docker compose up failed: port already allocated'),
								],
								"Failed to start repo resource provider 'repo-1'.",
							),
							new Error('compose cleanup failed', {
								cause: new Error('docker compose down exited 1'),
							}),
						],
						'Failed to start repo resource providers and clean up started providers.',
					);
				}),
				executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const response = await app.request('/zones/shravan/worker-tasks', {
			body: JSON.stringify({
				requestTaskId: 'request-task-resource-error',
				prompt: 'resource error test',
				repos: [],
				context: {},
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'Failed to start repo resource providers and clean up started providers.',
			details: [
				'Failed to start repo resource providers and clean up started providers.',
				"Failed to start repo resource provider 'repo-1'.",
				'run-setup.sh failed: missing DATABASE_URL',
				'docker compose up failed: port already allocated',
				'compose cleanup failed',
				'docker compose down exited 1',
			],
		});
	});

	it('returns error details when task state lookup fails with an aggregate error', async () => {
		const app = createControllerAppForTest({
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
				getTaskState: vi.fn(async () => {
					throw new AggregateError(
						[new Error('state log unreadable'), new Error('task index corrupt')],
						'task state failed',
					);
				}),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/task-1');

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'task state failed',
			details: ['task state failed', 'state log unreadable', 'task index corrupt'],
		});
	});

	it('returns task state snapshots via GET /zones/:zoneId/tasks/:taskId', async () => {
		const getTaskState = vi.fn(async () => ({
			taskId: 'worker-task-1',
			status: 'work-agent',
			currentCycle: 1,
			currentMaxCycles: 2,
		}));
		const app = createControllerAppForTest({
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
				getTaskState,
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/worker-task-1');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			taskId: 'worker-task-1',
			status: 'work-agent',
			currentCycle: 1,
			currentMaxCycles: 2,
		});
		expect(getTaskState).toHaveBeenCalledWith('shravan', 'worker-task-1');
	});

	it('returns 404 when task state is unknown', async () => {
		const getTaskState = vi.fn(async () => null);
		const app = createControllerAppForTest({
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
				getTaskState,
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/missing');

		expect(response.status).toBe(404);
		expect(getTaskState).toHaveBeenCalledWith('shravan', 'missing');
	});

	it('proxies close through the configured close operation', async () => {
		const closeTaskForZone = vi.fn(async () => ({ status: 'closed' as const }));
		const app = createControllerAppForTest({
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
				closeTaskForZone,
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/worker-task-1/close', {
			method: 'POST',
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: 'closed' });
		expect(closeTaskForZone).toHaveBeenCalledWith('shravan', 'worker-task-1');
	});

	it('returns 409 when close is requested before worker ingress is ready', async () => {
		const closeTaskForZone = vi.fn(async () => {
			throw new ControllerTaskNotReadyError('worker ingress is not ready');
		});
		const app = createControllerAppForTest({
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
				closeTaskForZone,
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/worker-task-1/close', {
			method: 'POST',
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			status: 'not-ready',
			error: 'worker ingress is not ready',
		});
	});
});
