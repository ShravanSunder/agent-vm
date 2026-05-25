import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { OpenClawDeploymentRequirementError } from '../../operations/openclaw-deployment-requirements.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import { SandboxSeedingError } from '../leases/agent-sandbox-seeding.js';
import { AgentLeaseCompatibilityConflictError, type Lease } from '../leases/lease-manager.js';
import {
	OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
	LeaseWorkMountValidationError,
} from '../leases/lease-work-mount-paths.js';
import { OpenClawRuntimeStatusStore } from '../openclaw-runtime-status.js';
import type { PreparedWorkerTask, WorkerTaskResult } from '../worker-task-runner.js';
import { ZoneGitConflictError } from '../zone-git/zone-git-operations.js';
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
import type { controllerLeaseCreateRequestSchema } from './controller-request-schemas.js';

type ControllerAppOptions = Parameters<typeof createControllerApp>[0];
type ControllerLeaseCreateRequestBody = z.input<typeof controllerLeaseCreateRequestSchema>;
type ControllerCreateLeaseOptions = Parameters<
	ControllerAppOptions['leaseManager']['createLease']
>[0];

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
	return {
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
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000 + tcpSlot,
			user: 'sandbox',
		},
		tcpSlot,
		vm: {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000 + tcpSlot,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			id: `tool-vm-${leaseId}`,
			setIngressRoutes: vi.fn(),
			getHostPid: () => null,
			getVmInstance: vi.fn(),
		},
		hostWorkMountDir: '/host/sandbox-work',
		zoneId: overrides.zoneId ?? 'shravan',
	};
}

function createLeaseRequestBody(
	overrides: Partial<ControllerLeaseCreateRequestBody> = {},
): ControllerLeaseCreateRequestBody {
	return {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/work',
		profileId: 'standard',
		sessionKey: 'agent:main:session-abc',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
		zoneId: 'shravan',
		...overrides,
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
		egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
	it('returns recovering health while runtime startup is not ready', async () => {
		const app = createControllerAppForTest({
			controllerPort: 18800,
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

	it('returns not-ready for lease creation while runtime is recovering', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
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
				createLease,
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(createLeaseRequestBody()),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: 'controller-not-ready',
			state: 'recovering',
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it.each([
		['POST', '/lease/lease-123/renew'],
		['DELETE', '/lease/lease-123'],
		['POST', '/lease/lease-123/uses'],
		['POST', '/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat'],
		['DELETE', '/lease/lease-123/uses/use_01890f00000070008000000000000000'],
		['POST', '/zones/shravan/zone-git/push'],
		['POST', '/zones/shravan/credentials/refresh'],
		['POST', '/zones/shravan/destroy'],
		['POST', '/zones/shravan/upgrade'],
		['POST', '/zones/shravan/worker-tasks'],
		['POST', '/zones/shravan/tasks/task-1/close'],
		['POST', '/zones/shravan/tasks/task-1/push-branches'],
		['POST', '/zones/shravan/tasks/task-1/pull-default'],
		['POST', '/zones/shravan/enable-ssh'],
		['POST', '/zones/shravan/execute-command'],
		['POST', '/zones/shravan/openclaw-runtime-status'],
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
					pushZoneGit: vi.fn(async () => ({})),
					pullDefaultForTask: vi.fn(async () => ({})),
					refreshZoneCredentials: vi.fn(async () => ({})),
					prepareWorkerTask: vi.fn(async () => createPreparedWorkerTaskStub('worker-task-1')),
					executeWorkerTask: vi.fn(async () => createWorkerTaskResultStub('worker-task-1')),
					upgradeZone: vi.fn(async () => ({})),
					verifyZoneGitPushToken: vi.fn(() => true),
				},
				openClawRuntimeStatusStore: new OpenClawRuntimeStatusStore(),
			});

			const response = await app.request(routePath, {
				...(method === 'DELETE' ? {} : { body: JSON.stringify({}) }),
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

	it('creates, renews, peeks, and releases leases through the controller api', async () => {
		const lease: Lease = {
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			createdAt: 1,
			effectiveIdleTtlMs: 30 * 60 * 1000,
			id: 'lease-123',
			lastUsedAt: 1,
			profileId: 'standard',
			runtimeRecordId: 'lease-123',
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
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => null,
				getVmInstance: vi.fn(),
			},
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		};
		const createLease = vi.fn(async () => lease);
		const renewLease = vi.fn(async () => ({
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
				renewLease,
				peekLease: vi.fn(() => ({ kind: 'snapshot' as const, lease })),
				listLeases: vi.fn(() => []),
				releaseLease,
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify(createLeaseRequestBody()),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		const getResponse = await app.request('/lease/lease-123');
		const renewResponse = await app.request('/lease/lease-123/renew', {
			method: 'POST',
		});
		const peekResponse = await app.request('/lease/lease-123/peek');
		const deleteResponse = await app.request('/lease/lease-123', {
			method: 'DELETE',
		});

		expect(createResponse.status).toBe(200);
		await expect(createResponse.json()).resolves.toMatchObject({
			agentId: 'main',
			idleTtlMs: 6_000_000,
			leaseId: 'lease-123',
			ssh: {
				identityPem: 'pem-from-file',
			},
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toMatchObject({
			agentId: 'main',
			leaseId: 'lease-123',
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});
		expect(renewResponse.status).toBe(200);
		expect(peekResponse.status).toBe(200);
		await expect(peekResponse.json()).resolves.toMatchObject({
			agentId: 'main',
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
		});
		expect(deleteResponse.status).toBe(204);
		expect(renewLease).toHaveBeenCalledTimes(1);
		expect(releaseLease).toHaveBeenCalledWith('lease-123', { force: false });
	});

	it('returns a refreshable 404 when lease renewal finds a dead lease', async () => {
		const renewLease = vi.fn(async () => ({
			kind: 'not-found' as const,
			reason: 'dead' as const,
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
				renewLease,
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease/01890f00-0000-7000-8000-000000000000/renew', {
			method: 'POST',
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: 'Lease not found',
			reason: 'dead',
			refreshable: true,
		});
	});

	it('creates an agent-scoped lease without accepting or returning scopeKey or sandbox', async () => {
		const lease = createLeaseStub('01890f00-0000-7000-8000-000000000000', 0);
		const createLease = vi.fn(async (_options: ControllerCreateLeaseOptions) => lease);
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
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(async () => {}),
				renewLease: vi.fn(),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				profileId: 'standard',
				sessionKey: 'agent:main:manual',
				workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				zoneId: 'shravan',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).not.toHaveProperty('scopeKey');
		expect(body).not.toHaveProperty('sandbox');
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				profileId: 'standard',
				zoneId: 'shravan',
			}),
		);
		const createLeaseOptions = createLease.mock.calls[0]?.[0];
		expect(createLeaseOptions).not.toHaveProperty('scopeKey');
		expect(createLeaseOptions).not.toHaveProperty('sandbox');
	});

	it('rejects Tool VM guest /workspace when it leaks back as lease request input', async () => {
		const createLease = vi.fn(async (_options: ControllerCreateLeaseOptions) =>
			createLeaseStub('01890f00-0000-7000-8000-000000000000', 0),
		);
		const resolveLeaseWorkMountDir = vi.fn(
			async ({ workMountDir }: { readonly workMountDir: string }) => {
				expect(workMountDir).toBe('/workspace');
				throw new LeaseWorkMountValidationError(
					'outside-allowed-roots',
					"Lease workMountDir '/workspace' must be under /home/openclaw/.openclaw/state/sandboxes or /zone.",
				);
			},
		);
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
			leaseManager: {
				createLease,
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(async () => {}),
				renewLease: vi.fn(),
			},
			resolveLeaseWorkMountDir,
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({
				agentId: 'main',
				agentWorkspaceDir: '/zone/agents/main',
				profileId: 'standard',
				sessionKey: 'agent:main:manual',
				workMountDir: '/workspace',
				zoneId: 'shravan',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			kind: 'outside-allowed-roots',
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('passes optional idleTtlMs through lease creation and rejects invalid values', async () => {
		const createLease = vi.fn(async () => ({
			...createLeaseStub('lease-ttl', 0),
			effectiveIdleTtlMs: 60_000,
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
				createLease,
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			leaseIdleTtlPolicy: {
				defaultMs: 30_000,
				minRequestedMs: 5_000,
				maxRequestedMs: 120_000,
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					idleTtlMs: 60_000,
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		const invalidResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					idleTtlMs: 1_000,
					sessionKey: 'agent:main:session-def',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				effectiveIdleTtlMs: 60_000,
			}),
		);
		expect(invalidResponse.status).toBe(400);
		await expect(invalidResponse.json()).resolves.toMatchObject({
			error: 'invalid-lease-idle-ttl',
		});
	});

	it('exposes active-use controller routes with UUIDv7 validation and idempotent cleanup', async () => {
		const startActiveUse = vi.fn(() => ({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		}));
		const heartbeatActiveUse = vi.fn(() => ({
			expiresAt: 6_000,
			heartbeatAfterMs: 1_000,
		}));
		const endActiveUse = vi.fn(() => ({ kind: 'ended' as const }));
		const app = createControllerAppForTest({
			toolVmProfiles: {},
			leaseManager: {
				createLease: vi.fn(async () => createLeaseStub('lease-123', 0)),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
				startActiveUse,
				heartbeatActiveUse,
				endActiveUse,
			},
		});

		const startResponse = await app.request('/lease/lease-123/uses', {
			body: JSON.stringify({
				useId: '01890f00-0000-7000-8000-000000000000',
				correlation: { toolName: 'shell' },
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const badStartResponse = await app.request('/lease/lease-123/uses', {
			body: JSON.stringify({
				useId: '1b5c5d78-91b4-4c8e-a15e-f475dced59ef',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const heartbeatResponse = await app.request(
			'/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000/heartbeat',
			{ method: 'POST' },
		);
		const endResponse = await app.request(
			'/lease/lease-123/uses/01890f00-0000-7000-8000-000000000000',
			{
				body: JSON.stringify({ outcome: 'completed' }),
				headers: { 'content-type': 'application/json' },
				method: 'DELETE',
			},
		);

		expect(startResponse.status).toBe(200);
		await expect(startResponse.json()).resolves.toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(badStartResponse.status).toBe(400);
		expect(heartbeatResponse.status).toBe(200);
		expect(endResponse.status).toBe(204);
		expect(startActiveUse).toHaveBeenCalledWith('lease-123', {
			correlation: { toolName: 'shell' },
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(heartbeatActiveUse).toHaveBeenCalledWith(
			'lease-123',
			'01890f00-0000-7000-8000-000000000000',
			{},
		);
		expect(endActiveUse).toHaveBeenCalledWith('lease-123', '01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});
	});

	it('accepts bounded active-use heartbeat operation reports', async () => {
		const heartbeatActiveUse = vi.fn(() => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
		}));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease: vi.fn(),
				endActiveUse: vi.fn(),
				getActiveUseCount: vi.fn(() => 1),
				heartbeatActiveUse,
				listLeases: vi.fn(() => []),
				peekLease: vi.fn(),
				releaseLease: vi.fn(async () => {}),
				renewLease: vi.fn(),
				startActiveUse: vi.fn(),
			},
		});

		const response = await app.request(
			'/lease/01890f00-0000-7000-8000-000000000000/uses/01890f00-0000-7000-8000-000000000001/heartbeat',
			{
				body: JSON.stringify({
					report: {
						observedAtMs: 1_000,
						phase: 'failed',
						ssh: {
							failure: {
								kind: 'ssh-command-timed-out',
								message: 'runShellCommand exceeded 30000ms.',
							},
						},
					},
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);

		expect(response.status).toBe(200);
		expect(heartbeatActiveUse).toHaveBeenCalledWith(
			'01890f00-0000-7000-8000-000000000000',
			'01890f00-0000-7000-8000-000000000001',
			{
				report: {
					observedAtMs: 1_000,
					phase: 'failed',
					ssh: {
						failure: {
							kind: 'ssh-command-timed-out',
							message: 'runShellCommand exceeded 30000ms.',
						},
					},
				},
			},
		);
	});

	it('passes agentId while keeping channel-shaped session provenance out of the lease', async () => {
		const createLease = vi.fn(async (options: ControllerCreateLeaseOptions) =>
			createLeaseStub('shravan-beta-100', 0, {
				agentId: options.agentId,
			}),
		);
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'beta',
					sessionKey: 'agent:beta:discord:channel:123',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(200);
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'beta',
			}),
		);
		const responseBody = await response.json();
		expect(responseBody).toMatchObject({
			agentId: 'beta',
			leaseId: 'shravan-beta-100',
		});
		expect(responseBody).not.toHaveProperty('scopeKey');
	});

	it('rejects deprecated scopeKey and sandbox fields before creating a lease', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify({
				...createLeaseRequestBody(),
				sandbox: {
					backend: 'gondolin',
					mode: 'all',
					scope: 'agent',
					workspaceAccess: 'rw',
				},
				scopeKey: 'agent:main:discord:channel:123',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-lease-request',
			issues: expect.arrayContaining([
				expect.objectContaining({
					code: 'unrecognized_keys',
					keys: expect.arrayContaining(['sandbox', 'scopeKey']),
				}),
			]),
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('rejects mismatched lease agent and session identity before creating a lease', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'beta',
					sessionKey: 'agent:main:session-abc',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'tool-vm-lease-agent-mismatch',
			message: "Lease agentId 'beta' does not match sessionKey agent 'main'.",
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('rejects agent-shaped session keys that belong to another agent', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'beta',
					sessionKey: 'agent:laura:discord:channel:123',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'tool-vm-lease-agent-mismatch',
			message: "Lease agentId 'beta' does not match sessionKey agent 'laura'.",
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('warns when legacy lease session keys fall back to the main agent', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		try {
			const response = await app.request('/lease', {
				body: JSON.stringify(
					createLeaseRequestBody({
						sessionKey: 'session-abc',
					}),
				),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});

			expect(response.status).toBe(200);
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some(
					(message) =>
						message.includes('[WARN]') &&
						message.includes("sessionKey 'session-abc'") &&
						message.includes('defaulting agentId=main') &&
						message.includes("zone='shravan'"),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('rejects non-agent-shaped session keys when the payload agent is not main', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
		const resolveLeaseWorkMountDir = vi.fn(
			async ({ workMountDir }: { readonly workMountDir: string }) => ({
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: workMountDir,
			}),
		);
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir,
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'beta',
					sessionKey: 'legacy-session-abc',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'tool-vm-lease-agent-mismatch',
			message: "Lease agentId 'beta' does not match sessionKey agent 'main'.",
		});
		expect(resolveLeaseWorkMountDir).not.toHaveBeenCalled();
		expect(createLease).not.toHaveBeenCalled();
	});

	it('rejects Tool VM leases until the OpenClaw plugin reports fresh runtime status', async () => {
		let nowMs = 1_000;
		const runtimeStatusStore = new OpenClawRuntimeStatusStore({
			maxAgeMs: 500,
			nowMs: () => nowMs,
		});
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			openClawRuntimeStatusStore: runtimeStatusStore,
			validateToolVmLeaseRequirements: async (zoneId) => runtimeStatusStore.assertFreshOk(zoneId),
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const missingStatusResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(missingStatusResponse.status).toBe(409);
		await expect(missingStatusResponse.json()).resolves.toMatchObject({
			kind: 'openclaw-runtime-status-unavailable',
		});
		expect(createLease).not.toHaveBeenCalled();

		const statusResponse = await app.request('/zones/shravan/openclaw-runtime-status', {
			body: JSON.stringify({
				pluginId: 'gondolin',
				zoneId: 'shravan',
				findings: [
					{
						id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
						ok: true,
						hint: 'agents.defaults.sandbox.backend=gondolin',
					},
				],
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(statusResponse.status).toBe(200);
		const leaseResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(leaseResponse.status).toBe(200);
		expect(createLease).toHaveBeenCalledTimes(1);

		nowMs = 2_000;
		const staleStatusResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					sessionKey: 'agent:main:later',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(staleStatusResponse.status).toBe(409);
		await expect(staleStatusResponse.json()).resolves.toMatchObject({
			kind: 'openclaw-runtime-status-unavailable',
		});
		expect(createLease).toHaveBeenCalledTimes(1);
	});

	it('returns structured JSON for malformed OpenClaw runtime status requests', async () => {
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

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: 'invalid-json-request',
			message: 'Request body must be valid JSON.',
		});
	});

	it('rejects Tool VM leases when plugin-reported OpenClaw runtime status is unsafe', async () => {
		const runtimeStatusStore = new OpenClawRuntimeStatusStore({ nowMs: () => 1_000 });
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			openClawRuntimeStatusStore: runtimeStatusStore,
			validateToolVmLeaseRequirements: async (zoneId) => runtimeStatusStore.assertFreshOk(zoneId),
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const statusResponse = await app.request('/zones/shravan/openclaw-runtime-status', {
			body: JSON.stringify({
				pluginId: 'gondolin',
				zoneId: 'shravan',
				findings: [
					{
						id: 'openclaw-tool-vm-agents-defaults-sandbox-mode-shravan-defaults',
						ok: false,
						hint: 'Set agents.defaults.sandbox.mode to "all" for OpenClaw Tool VM mediation.',
					},
				],
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(statusResponse.status).toBe(200);
		const leaseResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(leaseResponse.status).toBe(400);
		await expect(leaseResponse.json()).resolves.toMatchObject({
			kind: 'openclaw-tool-vm-requirements-failed',
		});
		expect(createLease).not.toHaveBeenCalled();
	});

	it('rejects Tool VM leases when OpenClaw deployment requirements fail', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-123', 0));
		const validateToolVmLeaseRequirements = vi.fn(async () => {
			throw new OpenClawDeploymentRequirementError('shravan', [
				{
					id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
					ok: false,
					hint: 'Set agents.defaults.sandbox.backend to "gondolin" for OpenClaw Tool VM mediation.',
				},
			]);
		});
		const app = createControllerAppForTest({
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			validateToolVmLeaseRequirements,
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			kind: 'openclaw-tool-vm-requirements-failed',
		});
		expect(validateToolVmLeaseRequirements).toHaveBeenCalledWith('shravan');
		expect(createLease).not.toHaveBeenCalled();
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...createLeaseRequestBody({
					agentId: 'shravan',
					agentWorkspaceDir: '/home/openclaw/work',
					sessionKey: 'agent:shravan:session-abc',
				}),
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...createLeaseRequestBody({
					agentId: 'shravan',
					agentWorkspaceDir: '/home/openclaw/work',
					sessionKey: 'agent:shravan:session-abc',
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent-shravan/work',
				}),
				workspaceDir: '/home/openclaw/.openclaw/state/sandboxes/legacy/work',
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid-lease-request',
		});
	});

	it('normalizes lease workMountDir before creating the lease', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-normalized', 0));
		const resolveLeaseWorkMountDir = vi.fn(async () => ({
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/state/shravan/sandboxes/agent/work',
		}));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir,
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		expect(resolveLeaseWorkMountDir).toHaveBeenCalledWith({
			agentId: 'main',
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
			zoneId: 'shravan',
		});
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				hostWorkMountDir: '/host/state/shravan/sandboxes/agent/work',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			}),
		);
	});

	it('returns the resolved zone Git guest workdir and passes zone Git mounts to leases', async () => {
		const zoneGitMount = {
			hostZoneFilesDir: '/host/zone-files/shravan',
			hostZoneGitRoot: '/host/runtime/zones/shravan/zone-git',
		};
		const lease: Lease = {
			...createLeaseStub('lease-zone-git', 0),
			guestWorkdir: '/zone/agents/shravan',
			hostWorkMountDir: '/host/zone-files/shravan/agents/shravan',
			zoneGitMount,
		};
		const createLease = vi.fn(async () => lease);
		const resolveLeaseWorkMountDir = vi.fn(async () => ({
			guestWorkdir: '/zone/agents/shravan',
			hostWorkMountDir: '/host/zone-files/shravan/agents/shravan',
			zoneGitMount,
		}));
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
			resolveLeaseWorkMountDir,
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'shravan',
					agentWorkspaceDir: '/zone/agents/shravan',
					sessionKey: 'agent:shravan:discord:channel:123',
					workMountDir: '/zone/agents/shravan',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(200);
		await expect(createResponse.json()).resolves.toMatchObject({
			leaseId: 'lease-zone-git',
			tcpSlot: 0,
			workdir: '/zone/agents/shravan',
		});
		expect(createLease).toHaveBeenCalledWith(
			expect.objectContaining({
				guestWorkdir: '/zone/agents/shravan',
				hostWorkMountDir: '/host/zone-files/shravan/agents/shravan',
				zoneGitMount,
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
				renewLease: vi.fn(),
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
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/../../../etc',
				}),
			),
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
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		try {
			const createResponse = await app.request('/lease', {
				body: JSON.stringify(createLeaseRequestBody()),
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
						message.includes("agent='main'"),
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
				renewLease: vi.fn(),
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
				body: JSON.stringify(createLeaseRequestBody()),
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
						message.includes("agent='main'"),
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
					throw new AgentLeaseCompatibilityConflictError(
						"existing Tool VM lease for agent 'main' is not compatible with this request; mismatched fields: hostWorkMountDir",
						['hostWorkMountDir'],
					);
				}),
				renewLease: vi.fn(),
				peekLease: vi.fn(),
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const createResponse = await app.request('/lease', {
			body: JSON.stringify(
				createLeaseRequestBody({
					workMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				}),
			),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		expect(createResponse.status).toBe(409);
		await expect(createResponse.json()).resolves.toEqual({
			error: 'agent-tool-vm-lease-compatibility-conflict',
			message:
				"existing Tool VM lease for agent 'main' is not compatible with this request; mismatched fields: hostWorkMountDir",
			guidance:
				'Managed OpenClaw/Gondolin reuses one Tool VM per zone and agent. Release the existing lease or use a compatible profile/workspace/workdir.',
			refreshable: false,
			received: {
				agentId: 'main',
				mismatchedFields: ['hostWorkMountDir'],
				zoneId: 'shravan',
			},
		});
	});

	it('uses the zone defaultToolVmProfile instead of trusting the requested profileId', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-gpu', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
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
			body: JSON.stringify(createLeaseRequestBody()),
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

	it('uses an agent-specific tool VM profile for agent-scoped leases', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-agent-profile', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
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
			body: JSON.stringify(
				createLeaseRequestBody({
					agentId: 'shravan',
					agentWorkspaceDir: '/zone/agents/shravan',
					sessionKey: 'agent:shravan:discord:channel:123',
					workMountDir: '/zone/agents/shravan',
				}),
			),
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
			}),
		);
	});

	it('rejects lease creation for an unknown zone', async () => {
		const createLease = vi.fn(async () => createLeaseStub('lease-unknown-zone', 0));
		const app = createControllerAppForTest({
			leaseManager: {
				createLease,
				renewLease: vi.fn(),
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
			body: JSON.stringify(
				createLeaseRequestBody({
					zoneId: 'bogus-zone',
				}),
			),
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
				renewLease: vi.fn(),
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

	it('serves zone Git status and push through controller operations', async () => {
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
				verifyZoneGitPushToken: vi.fn(
					(zoneId, token) => zoneId === 'sunfam' && token === 'push-token',
				),
			},
		});

		const statusResponse = await app.request('/zones/sunfam/zone-git/status');
		const pushResponse = await app.request('/zones/sunfam/zone-git/push', {
			body: JSON.stringify({ expectedHead: 'abc123' }),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-zone-git-token': 'push-token',
			},
			method: 'POST',
		});

		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toMatchObject({
			branch: 'main',
			aheadOfRemote: 1,
		});
		expect(pushResponse.status).toBe(200);
		await expect(pushResponse.json()).resolves.toMatchObject({
			branch: 'main',
			pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
		});
		expect(getZoneGitStatus).toHaveBeenCalledWith('sunfam');
		expect(pushZoneGit).toHaveBeenCalledWith('sunfam', { expectedHead: 'abc123' });
	});

	it('returns 405 when zone Git operations are unavailable', async () => {
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
		expect(pushResponse.status).toBe(405);
		await expect(pushResponse.json()).resolves.toEqual({
			error: 'zone-git-push-unavailable',
		});
	});

	it('returns 403 when zone Git push token is missing or invalid', async () => {
		const pushZoneGit = vi.fn(async () => ({}));
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
				pushZoneGit,
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
				verifyZoneGitPushToken: vi.fn(
					(zoneId, token) => zoneId === 'sunfam' && token === 'push-token',
				),
			},
		});

		const response = await app.request('/zones/sunfam/zone-git/push', {
			body: JSON.stringify({ expectedHead: 'abc123' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({ error: 'zone-git-push-forbidden' });
		expect(pushZoneGit).not.toHaveBeenCalled();
	});

	it('returns 409 when zone Git push expectedHead is stale', async () => {
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
				pushZoneGit: vi.fn(async () => {
					throw new ZoneGitConflictError('expectedHead is stale');
				}),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
				verifyZoneGitPushToken: vi.fn(
					(zoneId, token) => zoneId === 'sunfam' && token === 'push-token',
				),
			},
		});

		const response = await app.request('/zones/sunfam/zone-git/push', {
			body: JSON.stringify({ expectedHead: 'abc123' }),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-zone-git-token': 'push-token',
			},
			method: 'POST',
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: 'zone-git-push-conflict',
			message: 'expectedHead is stale',
		});
	});

	it('scrubs GitHub tokens from zone Git operation errors', async () => {
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
				pushZoneGit: vi.fn(async () => {
					throw new Error(
						'git push failed https://x-access-token:ghp_secret123@github.com/org/repo.git',
					);
				}),
				refreshZoneCredentials: vi.fn(async () => ({})),
				upgradeZone: vi.fn(async () => ({})),
				verifyZoneGitPushToken: vi.fn(
					(zoneId, token) => zoneId === 'sunfam' && token === 'push-token',
				),
			},
		});

		const response = await app.request('/zones/sunfam/zone-git/push', {
			body: JSON.stringify({ expectedHead: 'abc123' }),
			headers: {
				'content-type': 'application/json',
				'x-agent-vm-zone-git-token': 'push-token',
			},
			method: 'POST',
		});

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(JSON.stringify(body)).not.toContain('ghp_secret123');
		expect(body).toMatchObject({
			error: expect.stringContaining('https://x-access-token:***@github.com/org/repo.git'),
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
				renewLease: vi.fn(),
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
				renewLease: vi.fn(async () => ({ kind: 'not-found' as const, reason: 'missing' as const })),
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

	it('peeks a lease without using the renew path', async () => {
		const lease = createLeaseStub('lease-123', 0);
		const renewLease = vi.fn(() => {
			throw new Error('renew should not be used for peek');
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
				renewLease,
				peekLease,
				listLeases: vi.fn(() => []),
				releaseLease: vi.fn(async () => {}),
			},
		});

		const response = await app.request('/lease/lease-123/peek');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			agentId: 'main',
			createdAt: 0,
			idleTtlMs: 100 * 60 * 1000,
			lastUsedAt: 0,
			leaseId: 'lease-123',
			profileId: 'standard',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			zoneId: 'shravan',
		});
		expect(peekLease).toHaveBeenCalledWith('lease-123');
		expect(renewLease).not.toHaveBeenCalled();
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
				renewLease: vi.fn(),
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
				renewLease: vi.fn(),
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
		expect(body[0]).toMatchObject({ agentId: 'main', id: 'lease-1', zoneId: 'shravan' });
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
