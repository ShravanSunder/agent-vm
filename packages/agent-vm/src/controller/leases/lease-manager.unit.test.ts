import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmHostProcessIdentity,
	ManagedVmSshAccess,
} from '@agent-vm/managed-vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
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
	type ToolVmLeaseRetirementEvent,
	type ToolVmProvisioningHandle,
} from './lease-manager.js';
import { createTcpPool, type TcpPool } from './tcp-pool.js';
import type { StableToolVmLeasePrincipal } from './tool-vm-lease-authority-contracts.js';
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
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
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
	let closePromise: Promise<void> | undefined;
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
		close(): Promise<void> {
			if (closePromise === undefined) {
				options.events.push(`vm-close:${options.id}`);
				closePromise = Promise.resolve();
			}
			return closePromise;
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
		readonly managedVmExactProcessTermination?: ManagedVmExactProcessTerminationCapability;
		readonly now?: number;
		readonly onMembershipDestroyed?: () => void;
		readonly prepareLeasePersistentState?: NonNullable<
			Parameters<typeof createLeaseManager>[0]['prepareLeasePersistentState']
		>;
		readonly tcpPool?: TcpPool;
		readonly toolLeaseRecordsTargetFor?: (zoneId: string) => ControllerToolLeaseRecordsTarget;
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
					options.onMembershipDestroyed?.();
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
	const defaultProcessIdentity = {
		command: 'qemu-system-aarch64 agent-vm',
		lstart: 'Fri May 22 10:00:00 2026',
	};
	const managedVmExactProcessTermination =
		options.managedVmExactProcessTermination ??
		({
			terminateRecordedHostProcess: async ({ identity }) => {
				const runtime = runtimes.get(identity.hostProcessId);
				if (runtime?.alive !== true) {
					return { hostProcessId: identity.hostProcessId, kind: 'already-absent' };
				}
				events.push(`process-SIGTERM:${String(identity.hostProcessId)}`);
				runtime.alive = false;
				return { hostProcessId: identity.hostProcessId, kind: 'terminated' };
			},
		} satisfies ManagedVmExactProcessTerminationCapability);
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
		now: () => nowMs,
		managedVmExactProcessTermination,
		managedVmTerminationSleep: async () => {},
		ownershipCoordinator: coordinator,
		...(options.prepareLeasePersistentState === undefined
			? {}
			: { prepareLeasePersistentState: options.prepareLeasePersistentState }),
		projectNamespace: 'lease-manager-tests',
		readProcessIdentity: async () => defaultProcessIdentity,
		readTcpListenPortOwner: async (port) => {
			const runtime = [...runtimes.values()].find(
				(candidateRuntime) => candidateRuntime.sshOpen && candidateRuntime.sshPort === port,
			);
			return runtime === undefined ? null : { command: 'node', pid: process.pid };
		},
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool,
		toolLeaseRecordsTargetFor:
			options.toolLeaseRecordsTargetFor ??
			((zoneId) =>
				({
					directoryPath: `/tmp/lease-manager-tests/${zoneId}/tool-leases`,
					kind: 'controller-tool-lease-records',
					zoneId,
				}) satisfies ControllerToolLeaseRecordsTarget),
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
		managedVmExactProcessTermination,
		runtimes,
		setNow(nextNowMs): void {
			nowMs = nextNowMs;
		},
		tcpPool,
	};
}

function leasePrincipal(agentId: string): StableToolVmLeasePrincipal {
	return {
		agentId,
		frameworkIdentity: { agentId, kind: 'openclaw' },
		profileAssignmentRevision: `assignment-${agentId}`,
		toolPortalProfileId: 'standard',
	};
}

function createLeaseOptions(agentId = 'beta'): ToolVmLeaseCreateOptions {
	return {
		agentId,
		expectedGateway: TEST_GATEWAY_EPOCH,
		guestWorkdir: '/work',
		hostGitDirectoryRoot: `/host/runtime/zones/${TEST_GATEWAY_EPOCH.zoneId}/gitdirs/agents/${agentId}`,
		hostWorkspaceRoot: `/host/workspace/${agentId}`,
		profile: { cpus: 1, imageProfile: 'default', memory: '1G' },
		profileId: 'standard',
		principal: leasePrincipal(agentId),
		zoneId: TEST_GATEWAY_EPOCH.zoneId,
	};
}

function activeUseContext(agentId: string): ToolVmLeaseActiveUseExecutionProof & {
	readonly authority: ToolVmLeaseRequestAuthority;
} {
	return {
		authority: {
			gateway: TEST_GATEWAY_EPOCH,
			principal: leasePrincipal(agentId),
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
				'record-delete:00000000-0000-4000-8000-000000000001',
			]),
		);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('closes the VM and SSH, deletes the runtime record and membership, then releases the TCP slot', async () => {
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.events.length = 0;

		await harness.leaseManager.releaseLease(lease.id);

		expect(harness.events).toEqual([
			'membership-destroying:beta',
			'process-SIGTERM:12001',
			'vm-close:tool-vm-1',
			'ssh-close:tool-vm-1',
			'record-delete:00000000-0000-4000-8000-000000000001',
			'membership-destroyed:beta',
		]);
		expect(harness.leaseManager.listLeases()).toEqual([]);
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('starts async retirement acknowledgement after logical fencing without delaying exact termination', async () => {
		// Arrange
		const retainedCleanup = Promise.withResolvers<void>();
		const retainedCleanupStarted = Promise.withResolvers<void>();
		const retirementAcknowledgement = Promise.withResolvers<void>();
		const exactProcessIdentities: ManagedVmHostProcessIdentity[] = [];
		const retirementEvents: ToolVmLeaseRetirementEvent[] = [];
		let predecessorRuntime: FakeVmRuntime | undefined;
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				predecessorRuntime = runtime;
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async close(): Promise<void> {
						retainedCleanupStarted.resolve();
						await retainedCleanup.promise;
						await vm.close();
					},
				};
			},
			managedVmExactProcessTermination: {
				terminateRecordedHostProcess: async ({ identity }) => {
					exactProcessIdentities.push(identity);
					if (predecessorRuntime !== undefined) predecessorRuntime.alive = false;
					return { hostProcessId: identity.hostProcessId, kind: 'terminated' };
				},
			},
		});
		harness.leaseManager.subscribeLeaseRetirement(async (event) => {
			harness.events.push('retirement-notification-started');
			retirementEvents.push(event);
			await retirementAcknowledgement.promise;
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		harness.events.length = 0;

		// Act
		const release = harness.leaseManager.releaseLease(lease.id);
		await retainedCleanupStarted.promise;

		// Assert
		expect(exactProcessIdentities).toEqual([
			{
				command: 'qemu-system-aarch64 agent-vm',
				hostProcessId: 12_001,
				processStartIdentity: 'Fri May 22 10:00:00 2026',
				vmId: 'tool-vm-1',
			},
		]);
		expect(retirementEvents).toEqual([{ leaseId: lease.id, reason: 'released' }]);
		expect(harness.events.indexOf('membership-destroying:beta')).toBeGreaterThanOrEqual(0);
		expect(harness.events.indexOf('retirement-notification-started')).toBeGreaterThan(
			harness.events.indexOf('membership-destroying:beta'),
		);
		expect(harness.createManagedVm).toHaveBeenCalledOnce();

		// Cleanup
		retainedCleanup.resolve();
		retirementAcknowledgement.resolve();
		await release;
	});

	it('propagates an async retirement acknowledgement failure after retained cleanup', async () => {
		// Arrange
		const acknowledgementFailure = new Error('retirement acknowledgement failed');
		const retirementAcknowledgement = Promise.withResolvers<void>();
		void retirementAcknowledgement.promise.catch(() => {});
		const retirementAcknowledgementStarted = Promise.withResolvers<void>();
		const harness = createHarness();
		harness.leaseManager.subscribeLeaseRetirement(() => {
			retirementAcknowledgementStarted.resolve();
			return retirementAcknowledgement.promise;
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		// Act
		const release = harness.leaseManager.releaseLease(lease.id);
		await retirementAcknowledgementStarted.promise;
		retirementAcknowledgement.reject(acknowledgementFailure);

		// Assert
		await expect(release).rejects.toBe(acknowledgementFailure);
		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
		expect(harness.tcpPool.allocate()).toBe(0);
	});

	it('preserves cleanup debt without restoring predecessor authority after close failure', async () => {
		const deleteRuntimeRecord = vi.fn(async () => {});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => ({
				...createManagedVmStub({ events, id, pid, runtime }),
				close: () => Promise.reject(new Error('close failed')),
			}),
			deleteRuntimeRecord,
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');

		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(true);
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH)).toMatchObject({
			children: [expect.objectContaining({ state: 'retiring' })],
			state: 'admitting',
		});
		expect(harness.leaseManager.peekLease(lease.id)).toBeDefined();
	});

	it('admits a successor after the exact fence despite predecessor close cleanup debt', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => ({
				...createManagedVmStub({ events, id, pid, runtime }),
				close: () => Promise.reject(new Error('containment unavailable')),
			}),
		});
		const firstLease = await harness.leaseManager.createLease(createLeaseOptions());

		await expect(harness.leaseManager.releaseLease(firstLease.id)).rejects.toThrow(
			'containment unavailable',
		);
		expect(harness.leaseManager.getCurrentLeaseBinding(firstLease.id)).toBeUndefined();
		expect(harness.leaseManager.getLeaseAuthority(firstLease.id)).toBeUndefined();

		const successor = await harness.leaseManager.createLease(createLeaseOptions());
		expect(successor.id).not.toBe(firstLease.id);
		expect(harness.createManagedVm).toHaveBeenCalledTimes(2);
		expect(harness.leaseManager.peekLease(firstLease.id)).toBeDefined();
		expect(harness.leaseManager.getCurrentLeaseBinding(successor.id)).toBeDefined();
	});

	it('closes VM resources after exact fencing when the adapter retains an absent runner pid', async () => {
		// Arrange
		let closeRequested = false;
		const close = vi.fn(async (): Promise<void> => {
			closeRequested = true;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					close,
					getHostProcessId: (): number | null => (closeRequested ? null : pid),
				};
			},
			managedVmExactProcessTermination: {
				terminateRecordedHostProcess: async ({ identity }) => ({
					hostProcessId: identity.hostProcessId,
					kind: 'already-absent',
				}),
			},
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());

		// Act
		await harness.leaseManager.releaseLease(lease.id);

		// Assert
		expect(close).toHaveBeenCalledOnce();
		expect(harness.leaseManager.peekLease(lease.id)).toBeUndefined();
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(false);
	});

	it('boots a provisional successor but blocks its admission while predecessor absence is unproven', async () => {
		// Arrange
		const releaseTerminationWait = Promise.withResolvers<void>();
		const rolloverOrder: string[] = [];
		let predecessorExactIdentityPresent = true;
		let predecessorRuntime: FakeVmRuntime | undefined;
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				rolloverOrder.push(`construct:${id}`);
				if (id === 'tool-vm-1') {
					predecessorRuntime = runtime;
				}
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						rolloverOrder.push(`ssh-enable:${id}`);
						return await vm.enableSsh(enableOptions);
					},
				};
			},
			managedVmExactProcessTermination: {
				terminateRecordedHostProcess: async ({ identity }) => {
					rolloverOrder.push(`SIGTERM:${String(identity.hostProcessId)}`);
					await releaseTerminationWait.promise;
					return {
						hostProcessId: identity.hostProcessId,
						kind: predecessorExactIdentityPresent ? 'terminated' : 'already-absent',
					};
				},
			},
			prepareLeasePersistentState: async (): Promise<void> => {
				rolloverOrder.push('prepare-persistent');
			},
		});
		const predecessor = await harness.leaseManager.createLease(createLeaseOptions());
		rolloverOrder.length = 0;

		// Act
		const reacquire = harness.leaseManager.reacquireLease(predecessor.id, createLeaseOptions());
		await vi.waitFor(() => {
			expect(rolloverOrder).toContain('construct:tool-vm-2');
			expect(rolloverOrder).toContain('SIGTERM:12001');
		});

		// Assert
		expect(harness.createManagedVm).toHaveBeenCalledTimes(2);
		expect(rolloverOrder).toHaveLength(2);
		expect(harness.events).not.toContain('process-SIGKILL:12001');
		expect(harness.events).not.toContain('ssh-enable:tool-vm-2');
		expect(rolloverOrder).not.toContain('prepare-persistent');
		expect(harness.events.filter((event) => event === 'membership-current:beta')).toHaveLength(1);
		expect(harness.leaseManager.getCurrentLeaseBinding(predecessor.id)).toBeUndefined();

		// Act
		predecessorExactIdentityPresent = false;
		if (predecessorRuntime !== undefined) {
			predecessorRuntime.alive = false;
		}
		releaseTerminationWait.resolve();
		const successor = await reacquire;

		// Assert
		expect(successor.id).not.toBe(predecessor.id);
		expect(successor.tcpSlot).not.toBe(predecessor.tcpSlot);
		expect(harness.events).toContain('ssh-enable:tool-vm-2');
		expect(rolloverOrder.indexOf('prepare-persistent')).toBeGreaterThan(
			rolloverOrder.indexOf('SIGTERM:12001'),
		);
		expect(rolloverOrder.indexOf('prepare-persistent')).toBeLessThan(
			rolloverOrder.indexOf('ssh-enable:tool-vm-2'),
		);
		expect(harness.events.filter((event) => event === 'membership-current:beta')).toHaveLength(2);
		expect(harness.leaseManager.getLeaseAuthority(predecessor.id)).toBeUndefined();
		expect(harness.leaseManager.getCurrentLeaseBinding(predecessor.id)).toBeUndefined();
		expect(harness.leaseManager.getLeaseAuthority(successor.id)).toBeDefined();
		expect(harness.leaseManager.getCurrentLeaseBinding(successor.id)).toBeDefined();
	});

	it('keeps a successor current when predecessor close cleanup fails after exact fencing', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				if (id !== 'tool-vm-1') {
					return vm;
				}
				const closeFailure = Promise.reject(new Error('predecessor cleanup failed'));
				void closeFailure.catch(() => {});
				return { ...vm, close: () => closeFailure };
			},
		});
		const predecessor = await harness.leaseManager.createLease(createLeaseOptions());

		const successor = await harness.leaseManager.reacquireLease(
			predecessor.id,
			createLeaseOptions(),
		);

		expect(harness.leaseManager.peekLease(predecessor.id)).toBeDefined();
		expect(harness.leaseManager.getLeaseAuthority(predecessor.id)).toBeUndefined();
		expect(harness.createManagedVm).toHaveBeenCalledTimes(2);
		expect(harness.leaseManager.getCurrentLeaseBinding(successor.id)).toBeDefined();
		expect(harness.events).not.toContain('process-SIGKILL:12001');
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH)).toMatchObject({
			children: expect.arrayContaining([
				expect.objectContaining({ state: 'retiring', toolVmId: predecessor.vm.id }),
				expect.objectContaining({ state: 'current', toolVmId: successor.vm.id }),
			]),
		});
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).state).toBe('admitting');
	});

	it('closes the fenced predecessor when its adapter pid clears during ManagedVm.close', async () => {
		// Arrange
		let predecessorCloseRequested = false;
		const predecessorClose = vi.fn(async (): Promise<void> => {
			predecessorCloseRequested = true;
		});
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				if (id !== 'tool-vm-1') {
					return vm;
				}
				return {
					...vm,
					close: predecessorClose,
					getHostProcessId: () => (predecessorCloseRequested ? null : pid),
				};
			},
		});
		const predecessor = await harness.leaseManager.createLease(createLeaseOptions());

		// Act
		const successor = await harness.leaseManager.reacquireLease(
			predecessor.id,
			createLeaseOptions(),
		);

		// Assert
		expect(predecessorClose).toHaveBeenCalledOnce();
		expect(harness.tcpPool.isQuarantined(predecessor.tcpSlot)).toBe(false);
		expect(harness.leaseManager.peekLease(predecessor.id)).toBeUndefined();
		expect(harness.leaseManager.getCurrentLeaseBinding(successor.id)).toBeDefined();
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH)).toMatchObject({
			children: expect.arrayContaining([
				expect.objectContaining({ state: 'destroyed', toolVmId: predecessor.vm.id }),
				expect.objectContaining({ state: 'current', toolVmId: successor.vm.id }),
			]),
		});
	});

	it('admits a successor after dead-leaf fencing while predecessor cleanup continues', async () => {
		// Arrange
		const predecessorCleanup = Promise.withResolvers<void>();
		const predecessorCloseStarted = Promise.withResolvers<void>();
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				if (id !== 'tool-vm-1') {
					return vm;
				}
				return {
					...vm,
					close: async (): Promise<void> => {
						predecessorCloseStarted.resolve();
						await predecessorCleanup.promise;
					},
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 1 })),
				};
			},
		});
		const predecessor = await harness.leaseManager.createLease(createLeaseOptions());

		// Act
		const reaping = harness.leaseManager.reapDeadIdleLeases();
		await predecessorCloseStarted.promise;
		const successorCreation = harness.leaseManager.createLease(createLeaseOptions());
		await vi.waitFor(() => expect(harness.createManagedVm).toHaveBeenCalledTimes(2));

		// Assert
		expect(harness.leaseManager.getCurrentLeaseBinding(predecessor.id)).toBeUndefined();
		const successor = await successorCreation;
		expect(harness.leaseManager.getCurrentLeaseBinding(successor.id)).toBeDefined();
		expect(harness.leaseManager.peekLease(predecessor.id)).toBeDefined();

		// Cleanup and final assertion
		predecessorCleanup.resolve();
		await reaping;
		await vi.waitFor(() => expect(harness.leaseManager.peekLease(predecessor.id)).toBeUndefined());
	});

	it('drains current and retiring generations before retiring the Gateway', async () => {
		const firstSshCleanup = Promise.withResolvers<void>();
		let constructionCount = 0;
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				constructionCount += 1;
				const vm = createManagedVmStub({ events, id, pid, runtime });
				if (constructionCount !== 1) {
					return vm;
				}
				return {
					...vm,
					async enableSsh(enableOptions): Promise<ManagedVmSshAccess> {
						const access = await vm.enableSsh(enableOptions);
						return {
							...access,
							async close(): Promise<void> {
								await firstSshCleanup.promise;
								await access.close();
							},
						};
					},
				};
			},
		});
		const predecessor = await harness.leaseManager.createLease(createLeaseOptions());
		const successor = await harness.leaseManager.reacquireLease(
			predecessor.id,
			createLeaseOptions(),
		);
		expect(harness.leaseManager.peekLease(predecessor.id)).toBeDefined();
		expect(harness.leaseManager.getLeaseAuthority(successor.id)).toBeDefined();

		const gatewayDestruction = harness.leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		firstSshCleanup.resolve();
		await gatewayDestruction;

		expect(harness.leaseManager.peekLease(predecessor.id)).toBeUndefined();
		expect(harness.leaseManager.peekLease(successor.id)).toBeUndefined();
		expect(harness.leaseManager.listLeases()).toEqual([]);
		expect(harness.events.filter((event) => event === 'membership-destroyed:beta')).toHaveLength(2);
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
		expect(harness.coordinator.snapshotGateway(TEST_GATEWAY_EPOCH).state).toBe('admitting');
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
			harness.leaseManager.createLease({
				...request,
				hostWorkspaceRoot: '/host/workspace/changed',
			}),
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
			expect.arrayContaining(['membership-destroying:beta', 'membership-destroyed:beta']),
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

	it('accepts only exact same-leaf semantic retries for an existing active-use id', async () => {
		// Arrange
		const harness = createHarness();
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const useId = '01890f00-0000-7000-8000-000000000000';
		const initialRequest = {
			...activeUseContext(lease.agentId),
			useId,
		};
		const initialResponse = harness.leaseManager.startActiveUse(lease.id, initialRequest);
		harness.setNow(2_000);

		// Act / Assert
		expect(harness.leaseManager.startActiveUse(lease.id, initialRequest)).toEqual(initialResponse);
		for (const changedRequest of [
			{ ...initialRequest, processEpoch: 'process-epoch-2' },
			{ ...initialRequest, semanticOperationId: 'semantic-operation-2' },
			{ ...initialRequest, operationPayloadDigest: 'payload-digest-2' },
		]) {
			expect(() => harness.leaseManager.startActiveUse(lease.id, changedRequest)).toThrow(
				/changed process or semantic meaning/iu,
			);
		}
		expect(harness.leaseManager.getActiveUses(lease.id)).toEqual([
			expect.objectContaining({ useId }),
		]);
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

	it('projects the one running use with its heartbeat expiry', async () => {
		// Arrange
		const harness = createHarness({
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 10_000,
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

		// Act / Assert
		expect(harness.leaseManager.getCurrentNonterminalUses(lease.id)).toEqual([
			{
				expiresAtMs: 5_000,
				useId,
			},
		]);
	});

	it('projects an observation gap until its exact resume deadline', async () => {
		// Arrange
		const harness = createHarness({
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 10_000,
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
		harness.leaseManager.markControlSessionDisconnected({
			gateway: TEST_GATEWAY_EPOCH,
			observedAtMs: 1_100,
			processEpoch: 'process-epoch-1',
			sessionAttachmentGeneration: 1,
		});

		// Act / Assert
		expect(harness.leaseManager.getCurrentNonterminalUses(lease.id)).toEqual([
			{
				expiresAtMs: 5_100,
				useId,
			},
		]);
	});

	it('excludes terminal and ambiguous retained uses from the current-use projection', async () => {
		// Arrange
		const terminalHarness = createHarness();
		const terminalLease = await terminalHarness.leaseManager.createLease(createLeaseOptions());
		const terminalUseId = '01890f00-0000-7000-8000-000000000000';
		terminalHarness.leaseManager.startActiveUse(terminalLease.id, {
			...activeUseContext(terminalLease.agentId),
			useId: terminalUseId,
		});
		terminalHarness.leaseManager.endActiveUse(terminalLease.id, terminalUseId, {
			...activeUseContext(terminalLease.agentId),
			outcome: 'completed',
		});
		const ambiguousHarness = createHarness({
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 10_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const ambiguousLease = await ambiguousHarness.leaseManager.createLease(createLeaseOptions());
		const ambiguousUseId = '01890f00-0000-7000-8000-000000000001';
		ambiguousHarness.leaseManager.startActiveUse(ambiguousLease.id, {
			...activeUseContext(ambiguousLease.agentId),
			useId: ambiguousUseId,
		});
		ambiguousHarness.leaseManager.markControlSessionDisconnected({
			gateway: TEST_GATEWAY_EPOCH,
			observedAtMs: 1_100,
			processEpoch: 'process-epoch-1',
			sessionAttachmentGeneration: 1,
		});
		ambiguousHarness.setNow(5_100);
		ambiguousHarness.leaseManager.reapExpiredActiveUses();

		// Act / Assert
		expect(terminalHarness.leaseManager.getCurrentNonterminalUses(terminalLease.id)).toEqual([]);
		expect(ambiguousHarness.leaseManager.getCurrentNonterminalUses(ambiguousLease.id)).toEqual([]);
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
		).rejects.toThrow(/gateway-identity-mismatch/iu);
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

	it('releases the same-agent lock after exact absence while cleanup and acknowledgement remain held', async () => {
		// Arrange
		const retainedCleanup = Promise.withResolvers<void>();
		const retainedCleanupStarted = Promise.withResolvers<void>();
		const membershipDestroyed = Promise.withResolvers<void>();
		const retirementAcknowledgement = Promise.withResolvers<void>();
		const retirementEvents: ToolVmLeaseRetirementEvent[] = [];
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				if (id !== 'tool-vm-1') return vm;
				return {
					...vm,
					async close(): Promise<void> {
						retainedCleanupStarted.resolve();
						await retainedCleanup.promise;
						await vm.close();
					},
				};
			},
			onMembershipDestroyed: () => membershipDestroyed.resolve(),
		});
		harness.leaseManager.subscribeLeaseRetirement(async (event) => {
			retirementEvents.push(event);
			await retirementAcknowledgement.promise;
		});
		const first = await harness.leaseManager.createLease(createLeaseOptions());
		let releaseSettled = false;

		// Act
		const release = harness.leaseManager.releaseLease(first.id);
		void release.then(
			() => {
				releaseSettled = true;
			},
			() => {
				releaseSettled = true;
			},
		);
		await retainedCleanupStarted.promise;
		const replacement = harness.leaseManager.createLease(createLeaseOptions());
		const second = await replacement;

		// Assert
		expect(second.id).not.toBe(first.id);
		expect(harness.createManagedVm).toHaveBeenCalledTimes(2);
		expect(retirementEvents).toEqual([{ leaseId: first.id, reason: 'released' }]);
		expect(releaseSettled).toBe(false);
		expect(harness.leaseManager.getCurrentLeaseBinding(second.id)).toBeDefined();

		// Cleanup and final assertion
		retainedCleanup.resolve();
		await membershipDestroyed.promise;
		expect(harness.events).toContain('membership-destroyed:beta');
		expect(releaseSettled).toBe(false);
		retirementAcknowledgement.resolve();
		await release;
		expect(releaseSettled).toBe(true);
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

	it('rolls over distinct profile assignments for the same agent and Gateway', async () => {
		const harness = createHarness();
		const standardProfileRequest = createLeaseOptions('same-agent');
		const privilegedProfileRequest = {
			...standardProfileRequest,
			principal: {
				...standardProfileRequest.principal,
				profileAssignmentRevision: 'assignment-same-agent-privileged',
				toolPortalProfileId: 'privileged',
			},
		} satisfies ToolVmLeaseCreateOptions;

		const standardLease = await harness.leaseManager.createLease(standardProfileRequest);
		const privilegedLease = await harness.leaseManager.createLease(privilegedProfileRequest);

		expect(standardLease.id).not.toBe(privilegedLease.id);
		expect(harness.leaseManager.listLeases()).toEqual([
			expect.objectContaining({ id: privilegedLease.id }),
		]);
		expect(harness.leaseManager.getLeaseAuthority(standardLease.id)).toBeUndefined();
		expect(harness.leaseManager.getLeaseAuthority(privilegedLease.id)).toMatchObject({
			authority: { principal: { toolPortalProfileId: 'privileged' } },
		});
	});

	it('rejects persistent-root rebinds that are not accompanied by a new assignment revision', async () => {
		const harness = createHarness();
		const currentRequest = createLeaseOptions('same-agent');
		await harness.leaseManager.createLease(currentRequest);

		await expect(
			harness.leaseManager.createLease({
				...currentRequest,
				hostWorkspaceRoot: '/host/workspace/same-agent-other',
			}),
		).rejects.toMatchObject({
			mismatchedFields: ['hostWorkspaceRoot'],
		});
		await expect(
			harness.leaseManager.createLease({
				...currentRequest,
				hostGitDirectoryRoot: '/host/runtime/zones/shravan/gitdirs/agents/same-agent-other',
			}),
		).rejects.toMatchObject({
			mismatchedFields: ['hostGitDirectoryRoot'],
		});
		expect(harness.createManagedVm).toHaveBeenCalledOnce();
	});

	it('aggregates exact-Gateway child failures while completing unaffected siblings', async () => {
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => {
				const vm = createManagedVmStub({ events, id, pid, runtime });
				return id === 'tool-vm-1'
					? { ...vm, close: () => Promise.reject(new Error('alpha close failed')) }
					: vm;
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

		expect(harness.events.filter((event) => event === 'vm-close:tool-vm-1')).toHaveLength(1);
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
			managedVmExactProcessTermination: harness.managedVmExactProcessTermination,
			managedVmTerminationSleep: async () => {},
			now: () => 1_000,
			ownershipCoordinator: harness.coordinator,
			projectNamespace: 'lease-manager-tests',
			readProcessIdentity: async () => ({
				command: 'qemu-system-aarch64 agent-vm',
				lstart: 'Fri May 22 10:00:00 2026',
			}),
			readTcpListenPortOwner: async () => null,
			systemConfigPath: '/etc/agent-vm/system.json',
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
			toolLeaseRecordsTargetFor: (zoneId) =>
				({
					directoryPath: path.join(stateDirectory, 'tool-leases'),
					kind: 'controller-tool-lease-records',
					zoneId,
				}) satisfies ControllerToolLeaseRecordsTarget,
		});

		const lease = await manager.createLease(createLeaseOptions());
		const recordDirectory = path.join(stateDirectory, 'tool-leases');
		expect(await readdir(recordDirectory)).toEqual(['00000000-0000-4000-8000-000000000099.json']);

		await manager.releaseLease(lease.id);

		expect(await readdir(recordDirectory)).toEqual([]);
	});

	it('preserves the schema-v2 runtime record on ManagedVm close failure', async () => {
		const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'lease-manager-runtime-failure-'));
		temporaryDirectories.push(stateDirectory);
		const harness = createHarness({
			createManagedVm: async ({ events, id, pid, runtime }) => ({
				...createManagedVmStub({ events, id, pid, runtime }),
				close: () => Promise.reject(new Error('close denied')),
			}),
			deleteRuntimeRecord: deleteToolVmRuntimeRecord,
			tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
			toolLeaseRecordsTargetFor: (zoneId) =>
				({
					directoryPath: path.join(stateDirectory, 'tool-leases'),
					kind: 'controller-tool-lease-records',
					zoneId,
				}) satisfies ControllerToolLeaseRecordsTarget,
			writeRuntimeRecord: writeToolVmRuntimeRecord,
		});
		const lease = await harness.leaseManager.createLease(createLeaseOptions());
		const recordDirectory = path.join(stateDirectory, 'tool-leases');

		await expect(harness.leaseManager.releaseLease(lease.id)).rejects.toThrow(/close denied/iu);

		expect(await readdir(recordDirectory)).toEqual(['00000000-0000-4000-8000-000000000001.json']);
		expect(harness.tcpPool.isQuarantined(lease.tcpSlot)).toBe(true);
	});
});
