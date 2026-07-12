import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmSshAccess } from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import {
	createGatewayOwnershipCoordinator,
	type GatewayOwnershipCoordinator,
	type ToolVmMembershipHandle,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	AgentLeaseCompatibilityConflictError,
	createLeaseManager,
	LeaseActiveUseConflictError,
	type ToolVmLeaseCreateOptions,
	type ToolVmLeaseActiveUseExecutionProof,
	type ToolVmLeaseRequestAuthority,
	type ToolVmProvisioningHandle,
} from './lease-manager.js';
import { createTcpPool, type TcpPool } from './tcp-pool.js';
import { deleteToolVmRuntimeRecord, writeToolVmRuntimeRecord } from './tool-vm-runtime-record.js';

const TEST_GATEWAY_EPOCH = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

interface FakeVmRuntime {
	alive: boolean;
	readonly events: string[];
	sshOpen: boolean;
	sshPort: number | undefined;
	started: boolean;
}

interface LeaseManagerHarness {
	readonly coordinator: GatewayOwnershipCoordinator;
	readonly createManagedVm: ReturnType<
		typeof vi.fn<(options: unknown) => Promise<ManagedVm | ToolVmProvisioningHandle>>
	>;
	readonly events: string[];
	readonly leaseManager: ReturnType<typeof createLeaseManager>;
	readonly runtimes: Map<number, FakeVmRuntime>;
	readonly tcpPool: TcpPool;
	setNow(nowMs: number): void;
}

function createAttachedCoordinator(): GatewayOwnershipCoordinator {
	const coordinator = createGatewayOwnershipCoordinator({
		controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
		createGatewayEpochId: () => TEST_GATEWAY_EPOCH.gatewayEpochId,
	});
	const gateway = coordinator.beginGatewayEpoch({
		bootId: TEST_GATEWAY_EPOCH.bootId,
		gatewayEpochId: TEST_GATEWAY_EPOCH.gatewayEpochId,
		generationId: TEST_GATEWAY_EPOCH.generationId,
		zoneId: TEST_GATEWAY_EPOCH.zoneId,
	});
	gateway.attachGatewayVm(TEST_GATEWAY_EPOCH.gatewayVmId);
	return coordinator;
}

function createManagedVmStub(options: {
	readonly events: string[];
	readonly id: string;
	readonly pid: number;
	readonly runtime: FakeVmRuntime;
	readonly serverHostKey?: ManagedVmSshAccess['serverHostKey'];
	readonly sshFailure?: Error;
}): ManagedVm {
	const sshAccess = {
		async close(): Promise<void> {
			options.events.push(`ssh-close:${options.id}`);
			options.runtime.sshOpen = false;
		},
		command: 'ssh tool.vm',
		host: '127.0.0.1',
		identityFile: '/tmp/tool-vm-key',
		port: 19_000 + options.pid,
		serverHostKey: options.serverHostKey ?? TEST_SSH_SERVER_HOST_KEY,
		user: 'sandbox',
	} satisfies ManagedVmSshAccess;
	return {
		async close(): Promise<void> {
			options.events.push(`vm-close:${options.id}`);
			options.runtime.alive = false;
		},
		async enableIngress() {
			return { close: async () => {}, host: '127.0.0.1', port: 18_791 };
		},
		async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
			options.events.push(`ssh-enable:${options.id}`);
			if (options.sshFailure !== undefined) {
				throw options.sshFailure;
			}
			options.runtime.sshOpen = true;
			options.runtime.sshPort = enableOptions?.listenPort;
			return sshAccess;
		},
		exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0 })),
		configureIngressRoutes: vi.fn(),
		getHostProcessId(): number | null {
			return options.runtime.started && options.runtime.alive ? options.pid : null;
		},
		id: options.id,
		async start(): Promise<void> {
			options.events.push(`vm-start:${options.id}`);
			options.runtime.started = true;
			options.runtime.alive = true;
		},
	};
}

function createHarness(
	options: {
		readonly coordinator?: GatewayOwnershipCoordinator;
		readonly createManagedVm?: (properties: {
			readonly events: string[];
			readonly id: string;
			readonly pid: number;
			readonly runtime: FakeVmRuntime;
		}) => Promise<ManagedVm | ToolVmProvisioningHandle>;
		readonly deleteRuntimeRecord?: NonNullable<
			Parameters<typeof createLeaseManager>[0]['deleteToolVmRuntimeRecord']
		>;
		readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
		readonly now?: number;
		readonly stateDirFor?: (zoneId: string) => string;
		readonly tcpPool?: TcpPool;
		readonly toolVmUsePolicy?: {
			readonly endedUseTombstoneTtlMs: number;
			readonly heartbeatAfterMs: number;
			readonly heartbeatStaleMs: number;
		};
		readonly writeRuntimeRecord?: NonNullable<
			Parameters<typeof createLeaseManager>[0]['writeToolVmRuntimeRecord']
		>;
	} = {},
): LeaseManagerHarness {
	const events: string[] = [];
	let nowMs = options.now ?? 1_000;
	const runtimes = new Map<number, FakeVmRuntime>();
	let nextVmNumber = 1;
	const baseCoordinator = options.coordinator ?? createAttachedCoordinator();
	const coordinator = {
		...baseCoordinator,
		admitProvisionalToolVm(admissionOptions): ToolVmMembershipHandle {
			events.push(`membership-admit:${admissionOptions.agentId}`);
			const membership = baseCoordinator.admitProvisionalToolVm(admissionOptions);
			return {
				...membership,
				attachToolVm(toolVmId): void {
					events.push(`membership-attach:${toolVmId}`);
					membership.attachToolVm(toolVmId);
				},
				beginDestroying(): void {
					events.push(`membership-destroying:${admissionOptions.agentId}`);
					membership.beginDestroying();
				},
				commitCurrent(): void {
					events.push(`membership-current:${admissionOptions.agentId}`);
					membership.commitCurrent();
				},
				recordDestroyed(): void {
					events.push(`membership-destroyed:${admissionOptions.agentId}`);
					membership.recordDestroyed();
				},
				recordUnavailable(): void {
					events.push(`membership-unavailable:${admissionOptions.agentId}`);
					membership.recordUnavailable();
				},
			};
		},
	} satisfies GatewayOwnershipCoordinator;
	const createManagedVm = vi.fn(async (): Promise<ManagedVm | ToolVmProvisioningHandle> => {
		const vmNumber = nextVmNumber;
		nextVmNumber += 1;
		const runtime = {
			alive: false,
			events,
			sshOpen: false,
			sshPort: undefined,
			started: false,
		};
		const pid = 12_000 + vmNumber;
		const id = `tool-vm-${String(vmNumber)}`;
		runtimes.set(pid, runtime);
		events.push(`vm-construct:${id}`);
		return options.createManagedVm === undefined
			? createManagedVmStub({ events, id, pid, runtime })
			: await options.createManagedVm({ events, id, pid, runtime });
	});
	const tcpPool = options.tcpPool ?? createTcpPool({ basePort: 19_000, size: 4 });
	const leaseManager = createLeaseManager({
		controllerPort: 18_800,
		createLeafGeneration: (() => {
			let nextLeaf = 1;
			return () => `tool-leaf-${String(nextLeaf++)}`;
		})(),
		createLeaseId: (() => {
			let nextLease = 1;
			return () => `lease-${String(nextLease++)}`;
		})(),
		createManagedVm,
		createRuntimeRecordId: (() => {
			let nextRecord = 1;
			return () => `00000000-0000-4000-8000-${String(nextRecord++).padStart(12, '0')}`;
		})(),
		deleteToolVmRuntimeRecord:
			options.deleteRuntimeRecord ??
			(async (_stateDirectory, recordId): Promise<void> => {
				events.push(`record-delete:${recordId}`);
			}),
		managedVmKillDependencies: {
			isProcessAlive: (pid) => runtimes.get(pid)?.alive === true,
			killProcess:
				options.killProcess ??
				((pid, signal): void => {
					events.push(`process-${signal}:${String(pid)}`);
					const runtime = runtimes.get(pid);
					if (runtime !== undefined) {
						runtime.alive = false;
					}
				}),
			readProcessCommand: async () => 'qemu-system-aarch64 agent-vm',
			readProcessIdentity: async () => ({
				command: 'qemu-system-aarch64 agent-vm',
				lstart: 'Fri May 22 10:00:00 2026',
			}),
			sleep: async () => {},
		},
		now: () => nowMs,
		ownershipCoordinator: coordinator,
		projectNamespace: 'lease-manager-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-aarch64 agent-vm',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		readTcpListenPortOwner: async (port) => {
			const runtime = [...runtimes.values()].find(
				(candidateRuntime) => candidateRuntime.sshOpen && candidateRuntime.sshPort === port,
			);
			return runtime === undefined ? null : { command: 'node', pid: process.pid };
		},
		stateDirFor: options.stateDirFor ?? ((zoneId) => `/tmp/lease-manager-tests/${zoneId}`),
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool,
		...(options.toolVmUsePolicy === undefined ? {} : { toolVmUsePolicy: options.toolVmUsePolicy }),
		writeToolVmRuntimeRecord:
			options.writeRuntimeRecord ??
			(async (_stateDirectory, record): Promise<void> => {
				const runtimeRecord = record as { readonly recordId: string };
				events.push(`record-write:${runtimeRecord.recordId}`);
			}),
	});
	return {
		coordinator,
		createManagedVm,
		events,
		leaseManager,
		runtimes,
		setNow(nextNowMs): void {
			nowMs = nextNowMs;
		},
		tcpPool,
	};
}

function createLeaseOptions(agentId = 'beta'): ToolVmLeaseCreateOptions {
	return {
		agentId,
		agentWorkspaceDir: `/host/agents/${agentId}`,
		expectedGateway: TEST_GATEWAY_EPOCH,
		gatewayWorkMountDir: `/gateway/${agentId}/work`,
		guestWorkdir: '/work',
		hostWorkMountDir: `/host/work/${agentId}`,
		profile: { cpus: 1, imageProfile: 'default', memory: '1G' },
		profileId: 'standard',
		zoneId: TEST_GATEWAY_EPOCH.zoneId,
	};
}

function activeUseContext(agentId: string): ToolVmLeaseActiveUseExecutionProof & {
	readonly authority: ToolVmLeaseRequestAuthority;
} {
	return {
		authority: {
			gateway: TEST_GATEWAY_EPOCH,
			principal: { agentId, zoneId: TEST_GATEWAY_EPOCH.zoneId },
		},
		operationPayloadDigest: 'payload-digest',
		processEpoch: 'process-epoch-1',
		semanticOperationId: 'semantic-operation-1',
		sessionAttachmentGeneration: 1,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createLeaseManager stock Gondolin lifecycle', () => {
	it('constructs unstarted, attaches, starts, persists process identity, enables SSH, and commits', async () => {
		const harness = createHarness();

		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		expect(lease.id).toBe('lease-1');
		expect(harness.events).toEqual([
			'membership-admit:beta',
			'vm-construct:tool-vm-1',
			'membership-attach:tool-vm-1',
			'vm-start:tool-vm-1',
			'record-write:00000000-0000-4000-8000-000000000001',
			'ssh-enable:tool-vm-1',
			'membership-current:beta',
		]);
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).children).toEqual([
			{
				agentId: 'beta',
				leafId: 'tool-leaf-1',
				state: 'current',
				toolVmId: 'tool-vm-1',
			},
		]);
	});

	it('prepares a started Tool VM only after membership attachment and runtime-record persistence', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					async prepareStartedVm(): Promise<void> {
						events.push(`vm-prepare:${id}`);
					},
					vm,
				};
			},
		});

		await harness.leaseManager.createLease(createLeaseOptions());

		expect(harness.events).toEqual([
			'membership-admit:beta',
			'vm-construct:tool-vm-1',
			'membership-attach:tool-vm-1',
			'vm-start:tool-vm-1',
			'record-write:00000000-0000-4000-8000-000000000001',
			'vm-prepare:tool-vm-1',
			'ssh-enable:tool-vm-1',
			'membership-current:beta',
		]);
	});

	it('destroys a failed post-start create and returns its slot only after record deletion', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) =>
				createManagedVmStub({
					events,
					id,
					pid,
					runtime,
					sshFailure: new Error('ssh bootstrap failed'),
				}),
		});

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'ssh bootstrap failed',
		);

		expect(harness.events).toEqual(
			expect.arrayContaining([
				'membership-destroying:beta',
				'process-SIGTERM:12001',
				'vm-close:tool-vm-1',
				'record-delete:00000000-0000-4000-8000-000000000001',
				'membership-destroyed:beta',
			]),
		);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('rejects a malformed SSH server identity before lease admission and destroys the VM', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) =>
				createManagedVmStub({
					events,
					id,
					pid,
					runtime,
					serverHostKey: { algorithm: 'ssh-ed25519', publicKeyBase64: 'malformed' },
				}),
		});

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'does not have a valid ssh-ed25519 server host key',
		);
		expect(harness.leaseManager.listLeases()).toEqual([]);
		expect(harness.events).toEqual(
			expect.arrayContaining([
				'membership-destroying:beta',
				'ssh-close:tool-vm-1',
				'process-SIGTERM:12001',
				'membership-destroyed:beta',
			]),
		);
	});

	it('captures fallback runtime evidence when start rejects after spawning a runner', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async start(): Promise<void> {
						runtime.started = true;
						runtime.alive = true;
						events.push(`vm-start-rejected:${id}`);
						throw new Error('start failed after spawn');
					},
				};
			},
		});

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'start failed after spawn',
		);

		expect(harness.events).toEqual(
			expect.arrayContaining([
				'vm-start-rejected:tool-vm-1',
				'record-write:00000000-0000-4000-8000-000000000001',
				'process-SIGTERM:12001',
				'record-delete:00000000-0000-4000-8000-000000000001',
			]),
		);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('releases SSH, exact recorded process, runtime record, membership, then the TCP slot', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.events.length = 0;

		await harness.leaseManager.releaseLease(lease.id);

		expect(harness.events).toEqual([
			'membership-destroying:beta',
			'ssh-close:tool-vm-1',
			'process-SIGTERM:12001',
			'vm-close:tool-vm-1',
			'record-delete:00000000-0000-4000-8000-000000000001',
			'membership-destroyed:beta',
		]);
		expect(harness.leaseManager.listLeases()).toEqual([]);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('preserves the runtime record, quarantines the slot, and marks ownership unsafe on kill failure', async () => {
		const deleteRuntimeRecord = vi.fn(async () => {});
		const harness = createHarness({
			deleteRuntimeRecord,
			killProcess: () => {
				throw new Error('signal refused');
			},
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toThrow('signal refused');

		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(true);
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).state).toBe('owner-unsafe');
		expect(harness.leaseManager.peekLease(lease.id)).toBeDefined();
	});

	it('refuses slot release when the stock SSH listener remains bound after termination', async () => {
		const deleteRuntimeRecord = vi.fn(async () => {});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						const access = await vm.enableSsh(enableOptions);
						return { ...access, close: async () => {} };
					},
				};
			},
			deleteRuntimeRecord,
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toThrow(
			/still held by pid/iu,
		);

		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(true);
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).state).toBe('owner-unsafe');
	});

	it('reuses a live same-agent lease without constructing another VM', async () => {
		const harness = createHarness();
		const first = await harness.leaseManager.createLease(createLeaseOptions());

		const second = await harness.leaseManager.createLease(createLeaseOptions());

		expect(second.id).toBe(first.id);
		expect(harness.createManagedVm).toHaveBeenCalledOnce();
	});

	it('blocks non-forced release during active use and permits exact forced cleanup', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			useId: '01890f00-0000-7000-8000-000000000000',
		});

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toBeInstanceOf(
			LeaseActiveUseConflictError,
		);
		await harness.leaseManager.releaseLease(lease.id, { force: true });

		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('destroys every child of the exact Gateway epoch before retiring lease authority', async () => {
		const harness = createHarness();
		await harness.leaseManager.createLease(createLeaseOptions('alpha'));
		await harness.leaseManager.createLease(createLeaseOptions('beta'));

		await harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);

		expect(harness.leaseManager.listLeases()).toEqual([]);
		expect(harness.events.filter((event) => event.startsWith('membership-destroyed:'))).toEqual([
			'membership-destroyed:alpha',
			'membership-destroyed:beta',
		]);
	});

	it('releases the TCP slot when VM construction fails before a process exists', async () => {
		const tcpPool = createTcpPool({ basePort: 19_000, size: 1 });
		let constructionAttempt = 0;
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				constructionAttempt += 1;
				if (constructionAttempt === 1) throw new Error('constructor failed');
				return createManagedVmStub({ events, id, pid, runtime });
			},
			tcpPool,
		});

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'constructor failed',
		);

		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).children[0]?.state).toBe(
			'destroyed',
		);
		await expect(harness.leaseManager.createLease(createLeaseOptions())).resolves.toEqual(
			expect.objectContaining({ id: 'lease-2', tcpSlot: 0 }),
		);
	});

	it('creates distinct leases for distinct agents and lists both opaque identities', async () => {
		const harness = createHarness();

		const alpha = await harness.leaseManager.createLease(createLeaseOptions('alpha'));
		const beta = await harness.leaseManager.createLease(createLeaseOptions('beta'));

		expect(alpha.id).toBe('lease-1');
		expect(beta.id).toBe('lease-2');
		expect(alpha.id).not.toContain(alpha.agentId);
		expect(harness.leaseManager.listLeases().map((lease) => lease.id)).toEqual([
			'lease-1',
			'lease-2',
		]);
	});

	it('rejects workspace, profile, and idle-policy drift for a live same-agent lease', async () => {
		const harness = createHarness();
		const request = { ...createLeaseOptions(), effectiveIdleTtlMs: 60_000 };
		await harness.leaseManager.createLease(request);

		await expect(
			harness.leaseManager.createLease({ ...request, hostWorkMountDir: '/host/work/changed' }),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
		await expect(
			harness.leaseManager.createLease({ ...request, profileId: 'larger' }),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
		await expect(
			harness.leaseManager.createLease({ ...request, effectiveIdleTtlMs: 120_000 }),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('peek does not touch the lease and release is idempotent for unknown ids', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.setNow(5_000);

		expect(harness.leaseManager.peekLease(lease.id)?.lease.lastUsedAt).toBe(1_000);
		await expect(harness.leaseManager.releaseLease('missing')).resolves.toBeUndefined();
		expect(harness.leaseManager.peekLease(lease.id)?.lease.lastUsedAt).toBe(1_000);
	});

	it('evicts an expired lease during renewal without resurrecting its authority', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease({
			...createLeaseOptions(),
			effectiveIdleTtlMs: 100,
		});
		harness.setNow(1_101);

		await expect(harness.leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'expired',
		});
		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('evicts a dead lease during renewal and dead-idle reaping', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => ({
				...createManagedVmStub({ events, id, pid, runtime }),
				exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 1 })),
			}),
		});
		const first = await harness.leaseManager.createLease(createLeaseOptions('alpha'));

		await expect(harness.leaseManager.renewLease(first.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'dead',
		});
		const second = await harness.leaseManager.createLease(createLeaseOptions('beta'));
		await harness.leaseManager.reapDeadIdleLeases();

		expect(harness.leaseManager.peekLease(second.id)).toBeUndefined();
	});

	it('permits exact release after the parent Gateway is sealed', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.coordinator.sealGatewayEpoch(TEST_GATEWAY_EPOCH);

		await harness.leaseManager.releaseLease(lease.id);

		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('rolls back exact VM ownership when runtime-record persistence fails', async () => {
		const harness = createHarness({
			writeRuntimeRecord: async () => {
				throw new Error('disk full');
			},
		});

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'disk full',
		);

		expect(harness.events).toEqual(
			expect.arrayContaining([
				'membership-destroying:beta',
				'process-SIGTERM:12001',
				'membership-destroyed:beta',
			]),
		);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('serializes concurrent same-agent creates into one live Tool VM', async () => {
		let releaseConstruction: (() => void) | undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				await constructionGate;
				return createManagedVmStub({ events, id, pid, runtime });
			},
		});

		const firstCreate = harness.leaseManager.createLease(createLeaseOptions());
		const secondCreate = harness.leaseManager.createLease(createLeaseOptions());
		releaseConstruction?.();
		const [first, second] = await Promise.all([firstCreate, secondCreate]);

		expect(second.id).toBe(first.id);
		expect(harness.createManagedVm).toHaveBeenCalledOnce();
	});

	it('tracks heartbeat, terminal tombstone, and active-use operation report replacement', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const useId = '01890f00-0000-7000-8000-000000000000';
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			report: { observedAtMs: 1_000, phase: 'starting' },
			useId,
		});
		harness.setNow(2_000);
		harness.leaseManager.heartbeatActiveUse(lease.id, useId, {
			...activeUseContext(lease.agentId),
			report: { observedAtMs: 2_000, phase: 'completed' },
		});

		expect(harness.leaseManager.getActiveUses(lease.id)[0]?.latestReport).toEqual({
			observedAtMs: 2_000,
			phase: 'completed',
		});
		harness.leaseManager.endActiveUse(lease.id, useId, {
			...activeUseContext(lease.agentId),
			outcome: 'completed',
		});
		expect(harness.leaseManager.getActiveUseCount(lease.id)).toBe(0);
		expect(() =>
			harness.leaseManager.startActiveUse(lease.id, {
				...activeUseContext(lease.agentId),
				useId,
			}),
		).toThrow(/ended|terminal/iu);
	});

	it('moves disconnected active work into an observation gap and resumes on a newer attachment', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const useId = '01890f00-0000-7000-8000-000000000000';
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			useId,
		});
		harness.leaseManager.markControlSessionDisconnected({
			gateway: TEST_GATEWAY_EPOCH,
			observedAtMs: 1_100,
			processEpoch: 'process-epoch-1',
			sessionAttachmentGeneration: 1,
		});

		expect(harness.leaseManager.getActiveUses(lease.id)).toEqual([
			expect.objectContaining({ useId }),
		]);
		harness.leaseManager.heartbeatActiveUse(lease.id, useId, {
			...activeUseContext(lease.agentId),
			sessionAttachmentGeneration: 2,
		});
		expect(harness.leaseManager.getActiveUseCount(lease.id)).toBe(1);
	});

	it('returns an empty process-loss barrier for a fresh Gateway epoch with no leases', async () => {
		// Arrange
		const harness = createHarness();

		// Act
		const barrier = harness.leaseManager.beginProcessEpochLoss({
			ambiguousAtMs: 2_000,
			gateway: TEST_GATEWAY_EPOCH,
			processEpoch: 'process-epoch-1',
		});

		// Assert
		expect(barrier.affectedLeaseIds).toEqual([]);
		await expect(barrier.destroyAffectedLeases()).resolves.toBeUndefined();
		expect(harness.createManagedVm).not.toHaveBeenCalled();
	});

	it('fences a lost process epoch and destroys only its affected lease', async () => {
		const harness = createHarness();
		const alpha = await harness.leaseManager.createLease(createLeaseOptions('alpha'));
		const beta = await harness.leaseManager.createLease(createLeaseOptions('beta'));
		const useId = '01890f00-0000-7000-8000-000000000000';
		harness.leaseManager.startActiveUse(alpha.id, {
			...activeUseContext(alpha.agentId),
			useId,
		});

		const barrier = harness.leaseManager.beginProcessEpochLoss({
			ambiguousAtMs: 2_000,
			gateway: TEST_GATEWAY_EPOCH,
			processEpoch: 'process-epoch-1',
		});
		expect(barrier.affectedLeaseIds).toEqual([alpha.id]);
		expect(() =>
			harness.leaseManager.startActiveUse(beta.id, {
				...activeUseContext(beta.agentId),
				useId: '01890f00-0000-7000-8000-000000000001',
			}),
		).toThrow(/was lost/iu);
		await barrier.destroyAffectedLeases();

		expect(harness.leaseManager.peekLease(alpha.id)).toBeUndefined();
		expect(harness.leaseManager.peekLease(beta.id)).toBeDefined();
	});

	it('rolls back current membership and the persisted record when membership commit rejects', async () => {
		const baseCoordinator = createAttachedCoordinator();
		const coordinator = {
			...baseCoordinator,
			admitProvisionalToolVm(options): ToolVmMembershipHandle {
				const membership = baseCoordinator.admitProvisionalToolVm(options);
				return {
					...membership,
					commitCurrent(): void {
						membership.commitCurrent();
						throw new Error('membership commit rejected');
					},
				};
			},
		} satisfies GatewayOwnershipCoordinator;
		const harness = createHarness({ coordinator });

		await expect(harness.leaseManager.createLease(createLeaseOptions())).rejects.toThrow(
			'membership commit rejected',
		);

		expect(harness.events).toContain('record-delete:00000000-0000-4000-8000-000000000001');
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).children[0]?.state).toBe(
			'destroyed',
		);
	});

	it('refuses same-principal reuse under a different Gateway epoch', async () => {
		const harness = createHarness();
		await harness.leaseManager.createLease(createLeaseOptions());
		const successorGateway = {
			...TEST_GATEWAY_EPOCH,
			bootId: 'gateway-boot-2',
			gatewayEpochId: 'gateway-epoch-2',
			gatewayVmId: 'gateway-vm-2',
			generationId: 'gateway-generation-2',
		};

		await expect(
			harness.leaseManager.createLease({
				...createLeaseOptions(),
				expectedGateway: successorGateway,
			}),
		).rejects.toThrow(/different Gateway VM epoch/iu);
	});

	it('keeps an actively heartbeating lease alive past its idle TTL', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease({
			...createLeaseOptions(),
			effectiveIdleTtlMs: 100,
		});
		const useId = '01890f00-0000-7000-8000-000000000000';
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			useId,
		});
		harness.setNow(10_000);
		harness.leaseManager.heartbeatActiveUse(lease.id, useId, activeUseContext(lease.agentId));

		await expect(harness.leaseManager.renewLease(lease.id)).resolves.toEqual(
			expect.objectContaining({ kind: 'renewed' }),
		);
		expect(harness.leaseManager.peekLease(lease.id)).toBeDefined();
	});

	it('prunes a terminal use tombstone without closing the lease', async () => {
		const harness = createHarness({
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 3_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const useId = '01890f00-0000-7000-8000-000000000000';
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			useId,
		});
		harness.leaseManager.endActiveUse(lease.id, useId, {
			...activeUseContext(lease.agentId),
			outcome: 'completed',
		});
		harness.setNow(5_000);

		harness.leaseManager.reapExpiredActiveUses();
		harness.leaseManager.startActiveUse(lease.id, {
			...activeUseContext(lease.agentId),
			operationPayloadDigest: 'replacement-payload',
			semanticOperationId: 'replacement-operation',
			useId,
		});

		expect(harness.leaseManager.getActiveUseCount(lease.id)).toBe(1);
		expect(harness.events).not.toContain('ssh-close:tool-vm-1');
	});

	it('serializes release with same-agent replacement creation', async () => {
		let releaseSshClose: (() => void) | undefined;
		const sshCloseGate = new Promise<void>((resolve) => {
			releaseSshClose = resolve;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						const access = await vm.enableSsh(enableOptions);
						return {
							...access,
							async close(): Promise<void> {
								await sshCloseGate;
								await access.close();
							},
						};
					},
				};
			},
		});
		const first = await harness.leaseManager.createLease(createLeaseOptions());
		const release = harness.leaseManager.releaseLease(first.id);
		const replacement = harness.leaseManager.createLease(createLeaseOptions());
		await Promise.resolve();
		expect(harness.createManagedVm).toHaveBeenCalledOnce();
		releaseSshClose?.();
		await release;

		const second = await replacement;
		expect(second.id).not.toBe(first.id);
		expect(harness.createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('rejects new active work after release fencing begins', async () => {
		let releaseSshClose: (() => void) | undefined;
		let markSshCloseStarted: (() => void) | undefined;
		const sshCloseGate = new Promise<void>((resolve) => {
			releaseSshClose = resolve;
		});
		const sshCloseStarted = new Promise<void>((resolve) => {
			markSshCloseStarted = resolve;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						const access = await vm.enableSsh(enableOptions);
						return {
							...access,
							async close(): Promise<void> {
								markSshCloseStarted?.();
								await sshCloseGate;
								await access.close();
							},
						};
					},
				};
			},
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const release = harness.leaseManager.releaseLease(lease.id);
		await sshCloseStarted;

		expect(() =>
			harness.leaseManager.startActiveUse(lease.id, {
				...activeUseContext(lease.agentId),
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		).toThrow(/not available/iu);
		releaseSshClose?.();
		await release;
	});

	it('bounds exact-Gateway child destruction to four concurrent attempts', async () => {
		let releaseDestruction: (() => void) | undefined;
		let markFourStarted: (() => void) | undefined;
		const destructionGate = new Promise<void>((resolve) => {
			releaseDestruction = resolve;
		});
		const fourStarted = new Promise<void>((resolve) => {
			markFourStarted = resolve;
		});
		const startedAgents: string[] = [];
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						const access = await vm.enableSsh(enableOptions);
						return {
							...access,
							async close(): Promise<void> {
								startedAgents.push(id);
								if (startedAgents.length === 4) markFourStarted?.();
								await destructionGate;
								await access.close();
							},
						};
					},
				};
			},
			tcpPool: createTcpPool({ basePort: 19_000, size: 5 }),
		});
		for (const agentId of ['one', 'two', 'three', 'four', 'five']) {
			// oxlint-disable-next-line no-await-in-loop -- deterministic creation precedes concurrent destruction
			await harness.leaseManager.createLease(createLeaseOptions(agentId));
		}

		const destruction = harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		await fourStarted;
		expect(startedAgents).toHaveLength(4);
		releaseDestruction?.();
		await destruction;

		expect(startedAgents).toHaveLength(5);
	});

	it('stops dequeuing exact-Gateway children when subtree destruction is already aborted', async () => {
		const harness = createHarness();
		await harness.leaseManager.createLease(createLeaseOptions('alpha'));
		await harness.leaseManager.createLease(createLeaseOptions('beta'));
		const abortController = new AbortController();
		abortController.abort();

		await expect(
			harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH, abortController.signal),
		).rejects.toBeInstanceOf(AggregateError);

		expect(harness.events.some((event) => event.startsWith('ssh-close:'))).toBe(false);
		expect(harness.leaseManager.listLeases()).toHaveLength(2);
	});

	it('does not alias matching agent ids across zones', async () => {
		const coordinator = createGatewayOwnershipCoordinator({
			controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
			createGatewayEpochId: () => 'unused-generated-epoch',
		});
		const firstGateway = coordinator.beginGatewayEpoch({
			bootId: TEST_GATEWAY_EPOCH.bootId,
			gatewayEpochId: TEST_GATEWAY_EPOCH.gatewayEpochId,
			generationId: TEST_GATEWAY_EPOCH.generationId,
			zoneId: TEST_GATEWAY_EPOCH.zoneId,
		});
		firstGateway.attachGatewayVm(TEST_GATEWAY_EPOCH.gatewayVmId);
		const secondGatewayIdentity = {
			...TEST_GATEWAY_EPOCH,
			bootId: 'gateway-boot-2',
			gatewayEpochId: 'gateway-epoch-2',
			gatewayVmId: 'gateway-vm-2',
			generationId: 'gateway-generation-2',
			zoneId: 'sunfam',
		};
		const secondGateway = coordinator.beginGatewayEpoch({
			bootId: secondGatewayIdentity.bootId,
			gatewayEpochId: secondGatewayIdentity.gatewayEpochId,
			generationId: secondGatewayIdentity.generationId,
			zoneId: secondGatewayIdentity.zoneId,
		});
		secondGateway.attachGatewayVm(secondGatewayIdentity.gatewayVmId);
		const harness = createHarness({ coordinator });

		const first = await harness.leaseManager.createLease(createLeaseOptions('same-agent'));
		const second = await harness.leaseManager.createLease({
			...createLeaseOptions('same-agent'),
			expectedGateway: secondGatewayIdentity,
			zoneId: secondGatewayIdentity.zoneId,
		});

		expect(first.id).not.toBe(second.id);
		expect(harness.leaseManager.listLeases()).toHaveLength(2);
	});

	it('aggregates exact-Gateway child failures while completing unaffected siblings', async () => {
		const harness = createHarness({
			killProcess: (pid) => {
				if (pid === 12_001) throw new Error('alpha termination failed');
				const runtime = harness.runtimes.get(pid);
				if (runtime !== undefined) runtime.alive = false;
			},
		});
		const alpha = await harness.leaseManager.createLease(createLeaseOptions('alpha'));
		const beta = await harness.leaseManager.createLease(createLeaseOptions('beta'));

		await expect(
			harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH),
		).rejects.toBeInstanceOf(AggregateError);

		expect(harness.leaseManager.peekLease(alpha.id)).toBeDefined();
		expect(harness.leaseManager.peekLease(beta.id)).toBeUndefined();
	});

	it('includes an in-flight same-agent create in exact-Gateway destruction', async () => {
		let releaseConstruction: (() => void) | undefined;
		let markConstructionStarted: (() => void) | undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		const constructionStarted = new Promise<void>((resolve) => {
			markConstructionStarted = resolve;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				markConstructionStarted?.();
				await constructionGate;
				return createManagedVmStub({ events, id, pid, runtime });
			},
		});
		const create = harness.leaseManager.createLease(createLeaseOptions());
		await constructionStarted;
		const gatewayDestruction = harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		releaseConstruction?.();
		const createdLease = await create;

		await gatewayDestruction;

		expect(harness.leaseManager.peekLease(createdLease.id)).toBeUndefined();
		expect(harness.events).toContain('membership-destroyed:beta');
	});

	it('does not release a lease touched after an idle-reaper snapshot', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.setNow(2_000);
		await harness.leaseManager.renewLease(lease.id);

		await harness.leaseManager.releaseLease(lease.id, {
			ifLastUsedAtBeforeOrAt: lease.lastUsedAt,
		});

		expect(harness.leaseManager.peekLease(lease.id)?.lease.lastUsedAt).toBe(2_000);
		expect(harness.events).not.toContain('ssh-close:tool-vm-1');
	});

	it('serializes dead renewal with dead-idle reaping so exact destruction runs once', async () => {
		let releaseProbe: (() => void) | undefined;
		let markProbeStarted: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => ({
				...createManagedVmStub({ events, id, pid, runtime }),
				exec: vi.fn(() =>
					createManagedExecProcessStub({
						beforeResolve: () => markProbeStarted?.(),
						exitCode: 1,
						waitFor: probeGate,
					}),
				),
			}),
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const renewal = harness.leaseManager.renewLease(lease.id);
		await probeStarted;
		const reaping = harness.leaseManager.reapDeadIdleLeases();
		releaseProbe?.();

		await Promise.all([renewal, reaping]);

		expect(harness.events.filter((event) => event === 'process-SIGTERM:12001')).toHaveLength(1);
		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
	});
});

describe('createLeaseManager runtime record integration', () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories
				.splice(0)
				.map(async (directory) => await rm(directory, { force: true, recursive: true })),
		);
	});

	it('writes schema-v2 runtime evidence before publication and deletes it after exact release', async () => {
		const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'lease-manager-runtime-'));
		temporaryDirectories.push(stateDirectory);
		const harness = createHarness();
		const manager = createLeaseManager({
			controllerPort: 18_800,
			createLeafGeneration: () => 'tool-leaf-disk',
			createLeaseId: () => 'lease-disk',
			createManagedVm: harness.createManagedVm,
			createRuntimeRecordId: () => '00000000-0000-4000-8000-000000000099',
			managedVmKillDependencies: {
				isProcessAlive: (pid) => harness.runtimes.get(pid)?.alive === true,
				killProcess: (pid) => {
					const runtime = harness.runtimes.get(pid);
					if (runtime !== undefined) runtime.alive = false;
				},
				readProcessCommand: async () => 'qemu-system-aarch64 agent-vm',
				readProcessIdentity: async () => ({
					command: 'qemu-system-aarch64 agent-vm',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				sleep: async () => {},
			},
			now: () => 1_000,
			ownershipCoordinator: harness.coordinator,
			projectNamespace: 'lease-manager-tests',
			readProcessIdentity: async () => ({
				command: 'qemu-system-aarch64 agent-vm',
				lstart: 'Fri May 22 10:00:00 2026',
			}),
			readTcpListenPortOwner: async () => null,
			stateDirFor: () => stateDirectory,
			systemConfigPath: '/etc/agent-vm/system.json',
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
		});

		const lease = await manager.createLease(createLeaseOptions());
		const recordDirectory = path.join(stateDirectory, 'tool-leases');
		expect(await readdir(recordDirectory)).toEqual(['00000000-0000-4000-8000-000000000099.json']);

		await manager.releaseLease(lease.id);

		expect(await readdir(recordDirectory)).toEqual([]);
	});

	it('preserves the schema-v2 runtime record on exact termination failure', async () => {
		const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'lease-manager-runtime-failure-'));
		temporaryDirectories.push(stateDirectory);
		const harness = createHarness({
			deleteRuntimeRecord: deleteToolVmRuntimeRecord,
			killProcess: () => {
				throw new Error('termination denied');
			},
			stateDirFor: () => stateDirectory,
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
			writeRuntimeRecord: writeToolVmRuntimeRecord,
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const recordDirectory = path.join(stateDirectory, 'tool-leases');

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toThrow(
			/termination denied/iu,
		);

		expect(await readdir(recordDirectory)).toEqual(['00000000-0000-4000-8000-000000000001.json']);
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(true);
	});
});
