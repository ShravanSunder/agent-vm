import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';

import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import { SandboxSeedingError } from '../leases/agent-sandbox-seeding.js';
import { LeaseScopeConflictError, type Lease } from '../leases/lease-manager.js';
import { LeaseWorkMountValidationError } from '../leases/lease-work-mount-paths.js';
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
} from './controller-http-route-support.js';
import { createControllerApp } from './controller-http-routes.js';

type ControllerAppOptions = Parameters<typeof createControllerApp>[0];

function createControllerAppForTest(
	options: Omit<ControllerAppOptions, 'resolveLeaseWorkMountDir'> &
		Partial<Pick<ControllerAppOptions, 'resolveLeaseWorkMountDir'>>,
): ReturnType<typeof createControllerApp> {
	return createControllerApp({
		resolveLeaseWorkMountDir: async ({ workMountDir }) => workMountDir,
		...options,
	});
}

function createLeaseStub(leaseId: string, tcpSlot: number): Lease {
	return {
		agentWorkspaceDir: '/host/agent-work',
		createdAt: tcpSlot,
		id: leaseId,
		lastUsedAt: tcpSlot,
		profileId: 'standard',
		scopeKey: `scope-${leaseId}`,
		sshAccess: {
			host: '127.0.0.1',
			port: 19000 + tcpSlot,
			user: 'sandbox',
		},
		tcpSlot,
		vm: {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				host: '127.0.0.1',
				port: 19000 + tcpSlot,
				user: 'sandbox',
			})),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
			id: `tool-vm-${leaseId}`,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		},
		hostWorkMountDir: '/host/sandbox-work',
		zoneId: 'shravan',
	};
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
		allowedHosts: ['github.com'],
		websocketBypass: [],
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
	it('creates, fetches, and releases leases through the controller api', async () => {
		const lease: Lease = {
			agentWorkspaceDir: '/home/openclaw/work',
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
				getVmInstance: vi.fn(),
			},
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
		const keepLeaseAlive = vi.fn(() => ({
			kind: 'renewed' as const,
			lastUsedAt: lease.lastUsedAt,
			lease,
		}));
		const releaseLease = vi.fn(async () => {});
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			readIdentityPem: async () => 'pem-from-file',
			leaseManager: {
				createLease,
				keepLeaseAlive,
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease,
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
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
			workdir: '/work',
		});
		expect(getResponse.status).toBe(200);
		expect(deleteResponse.status).toBe(204);
		expect(keepLeaseAlive).toHaveBeenCalledWith('lease-123');
		expect(releaseLease).toHaveBeenCalledWith('lease-123');
	});

	it('rejects the old workspaceDir lease field', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-legacy', 0)),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:shravan',
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
				zoneId: 'shravan',
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-lease-request',
		});
	});

	it('rejects requests that include legacy workspaceDir even with workMountDir', async () => {
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-mixed', 0)),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:shravan',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/legacy/work',
				zoneId: 'shravan',
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-lease-request',
		});
	});

	it('normalizes lease workMountDir before creating the lease', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-normalized', 0));
		const resolveLeaseWorkMountDir = vi.fn(async () => '/host/state/shravan/sandboxes/agent/work');
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			readIdentityPem: async () => 'pem-from-file',
			leaseManager: {
				createLease,
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir,
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		expect(resolveLeaseWorkMountDir).toHaveBeenCalledWith({
			scopeKey: 'agent:main',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			zoneId: 'shravan',
		});
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				hostWorkMountDir: '/host/state/shravan/sandboxes/agent/work',
			}),
		);
	});

	it('rejects unsafe lease workMountDir before creating the lease', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-unsafe', 0));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease,
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir: vi.fn(async () => {
				throw new LeaseWorkMountValidationError(
					'outside-allowed-roots',
					'workMountDir outside allowed roots',
				);
			}),
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/../../../etc',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(400);
		await expect(createResponse.json()).resolves.toEqual({
			error: 'workMountDir outside allowed roots',
			kind: 'outside-allowed-roots',
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('returns 503 when the tcp pool is exhausted', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
					throw new Error('No TCP slots available');
				}),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		try {
			const createResponse = await app.request('/lease', {
				body: JSON.stringify({
					agentWorkspaceDir: '/home/openclaw/work',
					profileId: 'standard',
					scopeKey: 'agent:main:session-abc',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
					zoneId: 'shravan',
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});

			expect(createResponse.status).toBe(503);
			await expect(createResponse.json()).resolves.toMatchObject({
				error: 'lease-creation-failed',
				diagnosticId: expect.any(String),
			});
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some(
					(message) =>
						message.includes("lease creation failed diagnosticId='") &&
						message.includes("zone='shravan'") &&
						message.includes("scope='agent:main:session-abc'"),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('returns 500 with a diagnostic id when sandbox seeding fails integrity checks', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-unreachable', 0)),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir: vi.fn(async () => {
				throw new SandboxSeedingError(
					'parent-symlink',
					"Agent sandbox seed parent '/host/work/.config' must not be a symlink.",
				);
			}),
		});

		try {
			const createResponse = await app.request('/lease', {
				body: JSON.stringify({
					agentWorkspaceDir: '/home/openclaw/work',
					profileId: 'standard',
					scopeKey: 'agent:main:session-abc',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
					zoneId: 'shravan',
				}),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});

			expect(createResponse.status).toBe(500);
			await expect(createResponse.json()).resolves.toMatchObject({
				error: 'sandbox-seeding-failed',
				diagnosticId: expect.any(String),
				kind: 'parent-symlink',
			});
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some(
					(message) =>
						message.includes("status='500'") &&
						message.includes("zone='shravan'") &&
						message.includes("scope='agent:main:session-abc'"),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('returns 409 when lease scope conflicts with an existing live lease', async () => {
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
					throw new LeaseScopeConflictError('scope already uses a different workspace');
				}),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(409);
		await expect(createResponse.json()).resolves.toEqual({
			error: 'scope already uses a different workspace',
		});
	});

	it('uses the zone defaultToolVmProfile instead of trusting the requested profileId', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-gpu', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			toolVmProfiles: {
				gpu: { cpus: 4, memory: '8G', imageProfile: 'default' },
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			zoneDefaultToolVmProfiles: {
				shravan: 'gpu',
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: {
					cpus: 4,
					memory: '8G',
					imageProfile: 'default',
				},
				profileId: 'gpu',
				zoneId: 'shravan',
			}),
		);
	});

	it('uses an agent-specific tool VM profile for agent-scoped leases with sub-scope parts', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-agent-profile', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				toolsDev: {
					cpus: 4,
					memory: '8G',
					imageProfile: 'tools-dev',
				},
			},
			zoneAgentToolVmProfiles: {
				shravan: {
					shravan: 'toolsDev',
				},
			},
			zoneDefaultToolVmProfiles: {
				shravan: 'standard',
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/zone/agents/shravan',
				profileId: 'standard',
				scopeKey: 'agent:shravan:discord:channel:123',
				workMountDir: '/zone/agents/shravan',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: {
					cpus: 4,
					memory: '8G',
					imageProfile: 'tools-dev',
				},
				profileId: 'toolsDev',
				scopeKey: 'agent:shravan:discord:channel:123',
			}),
		);
	});

	it('rejects lease creation for an unknown zone', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-unknown-zone', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			zoneDefaultToolVmProfiles: {
				shravan: 'standard',
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/work',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				zoneId: 'bogus-zone',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "Unknown zone 'bogus-zone'",
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('exposes status, logs, credentials refresh, destroy, and upgrade routes', async () => {
		const destroyZone = vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' }));
		const getStatus = vi.fn(async () => ({
			controllerPort: 18800,
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
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			operations: {
				destroyZone,
				getStatus,
				getZoneHealth,
				getZoneStatus,
				getZoneLogs,
				refreshZoneCredentials,
				upgradeZone,
			},
		});

		const statusResponse = await app.request('/controller-status');
		const zoneStatusResponse = await app.request('/zones/shravan/status');
		const zoneHealthResponse = await app.request('/zones/shravan/health');
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
		expect(logsResponse.status).toBe(200);
		expect(refreshResponse.status).toBe(200);
		expect(destroyResponse.status).toBe(200);
		expect(upgradeResponse.status).toBe(200);
		expect(getStatus).toHaveBeenCalled();
		expect(getZoneStatus).toHaveBeenCalledWith('shravan');
		expect(getZoneHealth).toHaveBeenCalledWith('shravan');
		expect(getZoneLogs).toHaveBeenCalledWith('shravan');
		expect(refreshZoneCredentials).toHaveBeenCalledWith('shravan');
		expect(destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(upgradeZone).toHaveBeenCalledWith('shravan');
	});

	it('returns 503 when a zone gateway health probe is unhealthy', async () => {
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
				keepLeaseAlive: vi.fn(),
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
			zoneId: 'shravan',
		});
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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

	it('returns 400 for invalid lease create payload', async () => {
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
					throw new Error('should not be called');
				}),
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
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
			issues: expect.any(Array),
		});
	});

	it('returns 404 when fetching a non-existent lease', async () => {
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
				keepLeaseAlive: vi.fn(() => undefined),
				peekLease: vi.fn(),
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

	it('peeks a lease without using the keepalive path', async () => {
		const lease = createLeaseStub('lease-123', 0);
		const keepLeaseAlive = vi.fn(() => {
			throw new Error('keepalive should not be used for peek');
		});
		const peekLease = vi.fn(() => ({ kind: 'snapshot' as const, lease }));
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
				keepLeaseAlive,
				peekLease,
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease/lease-123/peek');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			createdAt: 0,
			lastUsedAt: 0,
			leaseId: 'lease-123',
			profileId: 'standard',
			scopeKey: 'scope-lease-123',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
			zoneId: 'shravan',
		});
		expect(peekLease).toHaveBeenCalledWith('lease-123');
		expect(keepLeaseAlive).not.toHaveBeenCalled();
	});

	it('returns 404 when peeking a non-existent lease', async () => {
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
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(() => undefined),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease/non-existent-id/peek');

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			error: 'Lease not found',
		});
	});

	it('lists active leases via GET /leases', async () => {
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
				keepLeaseAlive: vi.fn(),
				peekLease: vi.fn(),
				listLeases,
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/leases');

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(Array.isArray(body)).toBe(true);
		if (!Array.isArray(body)) {
			throw new Error('Expected lease list array');
		}
		expect(body).toHaveLength(2);
		expect(body[0]).toMatchObject({ id: 'lease-1', zoneId: 'shravan' });
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
				keepLeaseAlive: vi.fn(),
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
