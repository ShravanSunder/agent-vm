import { describe, expect, it, vi } from 'vitest';

import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import { createLeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';

const callerContext = {
	agentId: 'main',
	agentWorkspaceDir: '/home/openclaw/workspace',
	bootId: 'gateway-boot-a',
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	purpose: 'tool_vm_lease',
	sessionId: '33333333-3333-4333-8333-333333333333',
	sessionKeyDigest: '0123456789abcdef0123456789abcdef',
	workMountDir: '/host/sandbox-work',
	zoneId: 'zone-a',
} satisfies GatewayControlTrustedCallerContext;

const otherCallerContext = {
	...callerContext,
	agentId: 'other',
	callerContextId: '55555555-5555-4555-8555-555555555555',
	sessionKeyDigest: 'fedcba9876543210fedcba9876543210',
} satisfies GatewayControlTrustedCallerContext;

const refreshedCallerContext = {
	...callerContext,
	callerContextId: '66666666-6666-4666-8666-666666666666',
	connectionId: '77777777-7777-4777-8777-777777777777',
	sessionId: '88888888-8888-4888-8888-888888888888',
} satisfies GatewayControlTrustedCallerContext;

const callerContextPayload = {
	callerContext: {
		callerContextId: callerContext.callerContextId,
	},
};

function withCallerContextPayload<TPayload>(
	payload: TPayload,
	context: GatewayControlTrustedCallerContext = callerContext,
): {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly payload: TPayload;
} {
	return {
		callerContext: context,
		payload,
	};
}

function createManagedVmStub(): Parameters<typeof createLeaseManager>[0]['createManagedVm'] {
	return vi.fn(async () => {
		const vm = {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				host: '127.0.0.1',
				identityFile: '/tmp/tool-vm-key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			getHostPid: () => 12345,
			getVmInstance: () => vm,
			id: 'tool-vm-1',
			setIngressRoutes: vi.fn(),
		};
		return vm;
	});
}

function createTestLeaseManager(): ReturnType<typeof createLeaseManager> {
	return createLeaseManager({
		controllerPort: 18800,
		createLeaseId: () => 'lease-main',
		createManagedVm: createManagedVmStub(),
		deleteToolVmRuntimeRecord: vi.fn(async () => {}),
		now: () => 1_000,
		projectNamespace: 'gateway-control-lease-rpc-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		stateDirFor: (zoneId) => `/tmp/gateway-control-lease-rpc-tests/${zoneId}`,
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		toolVmUsePolicy: {
			endedUseTombstoneTtlMs: 10_000,
			heartbeatAfterMs: 1_000,
			heartbeatStaleMs: 4_000,
		},
		writeToolVmRuntimeRecord: vi.fn(async () => {}),
	});
}

describe('createGatewayControlLeaseRpcOperations', () => {
	it('creates and serializes leases through controller-owned create options', async () => {
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			agentWorkspaceDir: callerContext.agentWorkspaceDir,
			effectiveIdleTtlMs: 60_000,
			guestWorkdir: '/workspace',
			hostWorkMountDir: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const observedLeaseCreateRequests: unknown[] = [];
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			onLeaseCreateRequest: (request) => {
				observedLeaseCreateRequests.push(request);
			},
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});

		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const peeked = await leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'public' },
		);
		const renewed = await leaseRpc.renewLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
		);
		const released = await leaseRpc.releaseLease(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
			}),
		);

		expect(resolveLeaseCreateOptions).toHaveBeenCalledWith({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		expect(observedLeaseCreateRequests).toEqual([
			{
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/workspace',
				idleTtlMs: 60_000,
				profileId: 'standard',
				sessionKeyDigest: '0123456789abcdef0123456789abcdef',
				workMountDir: '/host/sandbox-work',
				zoneId: 'zone-a',
			},
		]);
		expect(lease).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity-pem',
				knownHostsLine: '',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
		expect(peeked).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
		expect(renewed).toEqual(lease);
		expect(released).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			state: 'released',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'zone-a',
		});
	});

	it('maps active-use lifecycle through the lease manager with sanitized correlation', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const started = await leaseRpc.startLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				correlation: {
					runId: 'run-a',
					sessionKeyDigest: callerContext.sessionKeyDigest,
					toolCallId: 'tool-call-a',
					traceId: 'fedcba9876543210fedcba9876543210',
				},
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const heartbeat = await leaseRpc.heartbeatLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const ended = await leaseRpc.endLeaseUse(
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				reason: 'completed',
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);

		expect(started).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(heartbeat).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(ended).toEqual({
			leaseId: 'lease-main',
			state: 'ended',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([]);
	});

	it('rejects post-create lease reads and mutations from a different caller context', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const crossCallerLeasePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			leaseRpc.getLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext), {
				includeSsh: 'private',
			}),
		).resolves.toBeUndefined();
		await expect(
			leaseRpc.renewLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext)),
		).resolves.toBeUndefined();
		await expect(
			leaseRpc.releaseLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext)),
		).resolves.toBeUndefined();
	});

	it('keeps leases reachable after reconnect refreshes the caller context id', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const refreshedCallerContextPayload = {
			callerContext: {
				callerContextId: refreshedCallerContext.callerContextId,
			},
		};
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const peeked = await leaseRpc.getLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContext,
			),
			{ includeSsh: 'public' },
		);
		const renewed = await leaseRpc.renewLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContext,
			),
		);
		const released = await leaseRpc.releaseLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContext,
			),
		);

		expect(peeked).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(renewed).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(released).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'released',
			}),
		);
	});

	it('rejects active-use lifecycle from a different caller context', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await leaseRpc.createLease({
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const useId = '01890f00-0000-7000-8000-000000000000';
		await expect(
			leaseRpc.startLeaseUse(
				withCallerContextPayload({
					callerContext: {
						callerContextId: callerContext.callerContextId,
					},
					leaseId: lease.leaseId,
					useId,
				}),
			),
		).resolves.toEqual(
			expect.objectContaining({
				state: 'active',
				useId,
			}),
		);
		const crossCallerUsePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
			useId,
		};

		await expect(
			leaseRpc.heartbeatLeaseUse(
				withCallerContextPayload(crossCallerUsePayload, otherCallerContext),
			),
		).resolves.toBeUndefined();
		await expect(
			leaseRpc.endLeaseUse(
				withCallerContextPayload(
					{
						...crossCallerUsePayload,
						reason: 'completed',
					},
					otherCallerContext,
				),
			),
		).resolves.toBeUndefined();
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([expect.objectContaining({ useId })]);
	});
});
