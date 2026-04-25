import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';

import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import type { Lease } from '../leases/lease-manager.js';
import type { PreparedWorkerTask } from '../worker-task-runner.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
} from './controller-http-route-support.js';
import { createControllerApp } from './controller-http-routes.js';

function createLeaseStub(leaseId: string, tcpSlot: number): Lease {
	return {
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
			workspaceDir: '/tmp/workspace',
		},
		secrets: {},
		allowedHosts: ['github.com'],
		websocketBypass: [],
		toolProfile: 'standard',
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
			workspaceDir: path.join(taskRoot, 'workspace'),
			stateDir,
			environment: {},
			startedResourceProviders: [],
			tcpHosts: {},
			vfsMounts: {},
			repos: [],
			effectiveConfig: workerConfigSchema.parse({
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
				getVmInstance: vi.fn(),
			},
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
		const getLease = vi.fn(() => lease);
		const releaseLease = vi.fn(async () => {});
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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

	it('uses the zone toolProfile instead of trusting the requested profileId', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-gpu', 0));
		const app = createControllerApp({
			leaseManager: {
				createLease,
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			toolProfiles: {
				gpu: { cpus: 4, memory: '8G', workspaceRoot: '/workspaces/gpu', imageProfile: 'default' },
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
			zoneToolProfiles: {
				shravan: 'gpu',
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

		expect(createResponse.status).toBe(200);
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: {
					cpus: 4,
					memory: '8G',
					workspaceRoot: '/workspaces/gpu',
					imageProfile: 'default',
				},
				profileId: 'gpu',
				zoneId: 'shravan',
			}),
		);
	});

	it('rejects lease creation for an unknown zone', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-unknown-zone', 0));
		const app = createControllerApp({
			leaseManager: {
				createLease,
				getLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
			zoneToolProfiles: {
				shravan: 'standard',
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/home/openclaw/workspace',
				profileId: 'standard',
				scopeKey: 'agent:main:session-abc',
				workspaceDir: '/home/openclaw/.openclaw/sandboxes/session/workspace',
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
			toolProfiles: ['standard'],
			zones: [
				{
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressPort: 18791,
					toolProfile: 'standard',
				},
			],
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
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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

		const statusResponse = await app.request('/controller-status');
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
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
			issues: expect.any(Array),
		});
	});

	it('returns 404 when fetching a non-existent lease', async () => {
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
		const listLeases = vi.fn(() => [createLeaseStub('lease-1', 0), createLeaseStub('lease-2', 1)]);
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
		expect(Array.isArray(body)).toBe(true);
		if (!Array.isArray(body)) {
			throw new Error('Expected lease list array');
		}
		expect(body).toHaveLength(2);
		expect(body[0]).toMatchObject({ id: 'lease-1', zoneId: 'shravan' });
	});

	it('gracefully stops the controller via POST /stop', async () => {
		const stopController = vi.fn(async () => ({ ok: true }));
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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

		const response = await app.request('/stop-controller', { method: 'POST' });

		expect(response.status).toBe(200);
		expect(stopController).toHaveBeenCalled();
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
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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

	it('returns schema details for invalid destroy requests', async () => {
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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

	it('returns 400 for malformed JSON bodies on controller operation routes', async () => {
		const app = createControllerApp({
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
					imageProfile: 'default',
				},
			},
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
				execInZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				pullDefaultForTask: vi.fn(async () => ({})),
				pushTaskBranches: vi.fn(async () => ({ results: [] })),
				refreshZoneCredentials: vi.fn(async () => ({})),
				prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-json')),
				executeWorkerTask: vi.fn(async () => ({})),
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
				new Promise<void>((resolve) => {
					executeStarted = true;
					resolveExecute = () => resolve();
				}),
		);
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-failure-sentinel-'));
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
				prepareWorkerTask,
				executeWorkerTask,
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
					await fs.readFile(path.join(taskStateDir, 'tasks', `${taskId}.failed`), 'utf8'),
				) as { readonly status?: string; readonly failureReason?: string };
				expect(sentinel).toMatchObject({
					status: 'failed',
					failureReason: expect.stringContaining('vm-boot-failed'),
				});
			});
		} finally {
			await fs.rm(stateRoot, { recursive: true, force: true });
		}
	});

	it('rejects worker task requests missing requestTaskId', async () => {
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
				prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-3')),
				executeWorkerTask: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
				prepareWorkerTask: vi.fn(async () => {
					throw new ControllerRuntimeAtCapacityError('worker runtime is at capacity');
				}),
				executeWorkerTask: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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

	it('returns task state snapshots via GET /zones/:zoneId/tasks/:taskId', async () => {
		const getTaskState = vi.fn(async () => ({
			taskId: 'worker-task-1',
			status: 'work-agent',
			currentCycle: 1,
			currentMaxCycles: 2,
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
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getTaskState,
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
				getTaskState,
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
				},
			},
		});

		const response = await app.request('/zones/shravan/tasks/missing');

		expect(response.status).toBe(404);
		expect(getTaskState).toHaveBeenCalledWith('shravan', 'missing');
	});

	it('proxies close through the configured close operation', async () => {
		const closeTaskForZone = vi.fn(async () => ({ status: 'closed' as const }));
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
				closeTaskForZone,
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
				closeTaskForZone,
				destroyZone: vi.fn(async () => ({})),
				getStatus: vi.fn(async () => ({})),
				getZoneLogs: vi.fn(async () => ({})),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
			},
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
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
